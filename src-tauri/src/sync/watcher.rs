use crate::fs_trait::RemoteFileSystem;
use crate::sftp::manager::SftpSessionManager;
use crate::sync::diff::target_join_rel;
use crate::transfer::engine::{apply_local_timestamp, ensure_remote_dir_all};
use crate::transfer::resume::matches_transfer_mask;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::sync::{watch, Mutex};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepUpToDateRequest {
    pub session_id: Option<String>,
    pub local_dir: String,
    pub remote_dir: String,
    pub target_is_remote: bool,
    pub delete_files: bool,
    pub existing_files_only: bool,
    pub recursive: bool,
    pub selected_only: bool,
    pub selected_paths: Vec<String>,
    pub file_mask: String,
    pub synchronize_on_start: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepUpToDateLogEntry {
    pub timestamp_ms: u64,
    pub action: String,
    pub relative_path: String,
    pub detail: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepUpToDateStatus {
    pub running: bool,
    pub started_at_ms: Option<u64>,
    pub local_dir: String,
    pub remote_dir: String,
    pub synced_count: usize,
    pub error_count: usize,
    pub logs: Vec<KeepUpToDateLogEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalSnapEntry {
    pub full_path: PathBuf,
    pub size: u64,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchChangeKind {
    Upload,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalWatchChange {
    pub rel_path: String,
    pub kind: WatchChangeKind,
    pub entry: Option<LocalSnapEntry>,
}

struct WatcherRuntime {
    status: KeepUpToDateStatus,
    cancel_tx: Option<watch::Sender<bool>>,
}

impl Default for WatcherRuntime {
    fn default() -> Self {
        Self {
            status: KeepUpToDateStatus {
                running: false,
                started_at_ms: None,
                local_dir: String::new(),
                remote_dir: String::new(),
                synced_count: 0,
                error_count: 0,
                logs: Vec::new(),
            },
            cancel_tx: None,
        }
    }
}

#[derive(Default)]
pub struct KeepUpToDateManager {
    runtime: Arc<Mutex<WatcherRuntime>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn scan_local_tree_snapshot(
    root: &Path,
    recursive: bool,
    file_mask: &str,
    selected_set: &HashSet<String>,
) -> Result<HashMap<String, LocalSnapEntry>, String> {
    if !root.exists() {
        return Err(format!("Watch directory does not exist: {}", root.display()));
    }
    let mut map = HashMap::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];

    while let Some((dir, prefix)) = stack.pop() {
        let Ok(read_dir) = fs::read_dir(&dir) else {
            continue;
        };
        let mut subdirs = Vec::new();
        for entry_res in read_dir {
            let Ok(entry) = entry_res else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            let is_dir = meta.is_dir();
            if !matches_transfer_mask(&name, is_dir, file_mask) {
                continue;
            }
            let rel = if prefix.is_empty() {
                name
            } else {
                format!("{}/{}", prefix, name)
            };

            if is_dir {
                if recursive {
                    subdirs.push((path, rel));
                }
                continue;
            }

            if !selected_set.is_empty() && !selected_set.contains(&rel.to_lowercase()) {
                continue;
            }

            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);

            map.insert(
                rel,
                LocalSnapEntry {
                    full_path: path,
                    size: meta.len(),
                    mtime_ms,
                },
            );
        }
        subdirs.reverse();
        stack.extend(subdirs);
    }

    Ok(map)
}

pub fn diff_local_snapshots(
    prev: &HashMap<String, LocalSnapEntry>,
    next: &HashMap<String, LocalSnapEntry>,
    delete_files: bool,
    existing_only: bool,
) -> Vec<LocalWatchChange> {
    let mut changes = Vec::new();

    for (rel, new_entry) in next {
        match prev.get(rel) {
            None => {
                if !existing_only {
                    changes.push(LocalWatchChange {
                        rel_path: rel.clone(),
                        kind: WatchChangeKind::Upload,
                        entry: Some(new_entry.clone()),
                    });
                }
            }
            Some(old_entry) => {
                if old_entry.size != new_entry.size || old_entry.mtime_ms != new_entry.mtime_ms {
                    changes.push(LocalWatchChange {
                        rel_path: rel.clone(),
                        kind: WatchChangeKind::Upload,
                        entry: Some(new_entry.clone()),
                    });
                }
            }
        }
    }

    if delete_files {
        for rel in prev.keys() {
            if !next.contains_key(rel) {
                changes.push(LocalWatchChange {
                    rel_path: rel.clone(),
                    kind: WatchChangeKind::Delete,
                    entry: None,
                });
            }
        }
    }

    changes.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    changes
}

async fn apply_watch_change(
    sftp_manager: &SftpSessionManager,
    req: &KeepUpToDateRequest,
    change: &LocalWatchChange,
) -> Result<(), String> {
    let target_full = target_join_rel(&req.remote_dir, &change.rel_path, req.target_is_remote);

    match change.kind {
        WatchChangeKind::Upload => {
            let entry = change
                .entry
                .as_ref()
                .ok_or_else(|| "Missing entry for upload".to_string())?;
            if req.target_is_remote {
                let sid = req
                    .session_id
                    .as_deref()
                    .ok_or_else(|| "Missing remote sessionId".to_string())?;
                let remote_fs = sftp_manager.get_remote_fs(sid).await?;
                if let Some(sftp) = remote_fs.as_sftp() {
                    if let Some((parent, _)) = target_full.rsplit_once('/') {
                        if !parent.is_empty() {
                            ensure_remote_dir_all(sftp, parent).await?;
                        }
                    }
                    let mut src = tokio::fs::File::open(&entry.full_path)
                        .await
                        .map_err(|e| format!("Failed opening {}: {}", entry.full_path.display(), e))?;
                    let mut dst = sftp
                        .open_with_flags(
                            &target_full,
                            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
                        )
                        .await
                        .map_err(|e| format!("Failed opening remote {}: {}", target_full, e))?;
                    tokio::io::copy(&mut src, &mut dst)
                        .await
                        .map_err(|e| format!("Failed uploading {}: {}", target_full, e))?;
                    dst.flush()
                        .await
                        .map_err(|e| format!("Failed flushing {}: {}", target_full, e))?;
                    dst.shutdown()
                        .await
                        .map_err(|e| format!("Failed closing {}: {}", target_full, e))?;
                    let secs = (entry.mtime_ms / 1000) as u32;
                    let mut attrs = FileAttributes::empty();
                    attrs.atime = Some(secs);
                    attrs.mtime = Some(secs);
                    let _ = sftp.set_metadata(&target_full, attrs).await;
                } else {
                    if let Some((parent, _)) = target_full.rsplit_once('/') {
                        if !parent.is_empty() {
                            let _ = remote_fs.ensure_dir_all(parent).await;
                        }
                    }
                    let bytes = tokio::fs::read(&entry.full_path)
                        .await
                        .map_err(|e| format!("Failed reading {}: {}", entry.full_path.display(), e))?;
                    remote_fs
                        .write_bytes(&target_full, &bytes, Some(entry.mtime_ms))
                        .await?;
                }
            } else {
                let dst_path = PathBuf::from(&target_full);
                if let Some(parent) = dst_path.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                tokio::fs::copy(&entry.full_path, &dst_path)
                    .await
                    .map_err(|e| format!("Failed copying to {}: {}", dst_path.display(), e))?;
                apply_local_timestamp(&dst_path, Some(entry.mtime_ms)).await;
            }
        }
        WatchChangeKind::Delete => {
            if req.target_is_remote {
                let sid = req
                    .session_id
                    .as_deref()
                    .ok_or_else(|| "Missing remote sessionId".to_string())?;
                if let Ok(remote_fs) = sftp_manager.get_remote_fs(sid).await {
                    let _ = remote_fs.delete(&[target_full]).await;
                }
            } else {
                let _ = tokio::fs::remove_file(&target_full).await;
            }
        }
    }

    Ok(())
}

fn push_log(status: &mut KeepUpToDateStatus, entry: KeepUpToDateLogEntry) {
    status.logs.insert(0, entry);
    if status.logs.len() > 200 {
        status.logs.truncate(200);
    }
}

#[tauri::command]
pub async fn sync_keep_up_to_date_start(
    app: AppHandle,
    watcher_state: tauri::State<'_, KeepUpToDateManager>,
    sftp_manager: tauri::State<'_, SftpSessionManager>,
    request: KeepUpToDateRequest,
) -> Result<KeepUpToDateStatus, String> {
    let selected_set: HashSet<String> = if request.selected_only {
        request
            .selected_paths
            .iter()
            .map(|p| p.trim_matches('/').to_lowercase())
            .collect()
    } else {
        HashSet::new()
    };

    let local_root = PathBuf::from(&request.local_dir);
    let initial_snap = scan_local_tree_snapshot(
        &local_root,
        request.recursive,
        &request.file_mask,
        &selected_set,
    )?;

    let (cancel_tx, mut cancel_rx) = watch::channel(false);

    let initial_status = {
        let mut guard = watcher_state.runtime.lock().await;
        if let Some(prev_tx) = guard.cancel_tx.take() {
            let _ = prev_tx.send(true);
        }
        guard.status = KeepUpToDateStatus {
            running: true,
            started_at_ms: Some(now_ms()),
            local_dir: request.local_dir.clone(),
            remote_dir: request.remote_dir.clone(),
            synced_count: 0,
            error_count: 0,
            logs: vec![KeepUpToDateLogEntry {
                timestamp_ms: now_ms(),
                action: "start".to_string(),
                relative_path: "*".to_string(),
                detail: format!(
                    "Watching {} -> {} ({} tracked files)",
                    request.local_dir,
                    request.remote_dir,
                    initial_snap.len()
                ),
                status: "done".to_string(),
            }],
        };
        guard.cancel_tx = Some(cancel_tx);
        guard.status.clone()
    };
    let _ = app.emit("sync://keep-up-to-date", &initial_status);

    let runtime_arc = watcher_state.runtime.clone();
    let sftp_arc = sftp_manager.inner().clone();

    tokio::spawn(async move {
        let mut prev_snap = initial_snap;

        if request.synchronize_on_start {
            let empty_map = HashMap::new();
            let startup_changes = diff_local_snapshots(
                &empty_map,
                &prev_snap,
                false,
                request.existing_files_only,
            );
            for ch in startup_changes {
                if *cancel_rx.borrow() {
                    return;
                }
                let res = apply_watch_change(&sftp_arc, &request, &ch).await;
                let snap = {
                    let mut guard = runtime_arc.lock().await;
                    match res {
                        Ok(()) => {
                            guard.status.synced_count += 1;
                            push_log(
                                &mut guard.status,
                                KeepUpToDateLogEntry {
                                    timestamp_ms: now_ms(),
                                    action: "upload".to_string(),
                                    relative_path: ch.rel_path.clone(),
                                    detail: format!("Initial sync: {}", ch.rel_path),
                                    status: "done".to_string(),
                                },
                            );
                        }
                        Err(err) => {
                            guard.status.error_count += 1;
                            push_log(
                                &mut guard.status,
                                KeepUpToDateLogEntry {
                                    timestamp_ms: now_ms(),
                                    action: "error".to_string(),
                                    relative_path: ch.rel_path.clone(),
                                    detail: err,
                                    status: "error".to_string(),
                                },
                            );
                        }
                    }
                    guard.status.clone()
                };
                let _ = app.emit("sync://keep-up-to-date", &snap);
            }
        }

        loop {
            tokio::select! {
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() {
                        break;
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(300)) => {}
            }
            if *cancel_rx.borrow() {
                break;
            }

            let Ok(next_snap) = scan_local_tree_snapshot(
                &local_root,
                request.recursive,
                &request.file_mask,
                &selected_set,
            ) else {
                continue;
            };

            let changes = diff_local_snapshots(
                &prev_snap,
                &next_snap,
                request.delete_files,
                request.existing_files_only,
            );
            if changes.is_empty() {
                continue;
            }

            // Brief settle for editors doing write + rename
            tokio::time::sleep(Duration::from_millis(80)).await;
            let settled_snap = scan_local_tree_snapshot(
                &local_root,
                request.recursive,
                &request.file_mask,
                &selected_set,
            )
            .unwrap_or(next_snap);
            let final_changes = diff_local_snapshots(
                &prev_snap,
                &settled_snap,
                request.delete_files,
                request.existing_files_only,
            );

            for ch in final_changes {
                if *cancel_rx.borrow() {
                    break;
                }
                let action_str = match ch.kind {
                    WatchChangeKind::Upload => "upload",
                    WatchChangeKind::Delete => "delete",
                };
                let res = apply_watch_change(&sftp_arc, &request, &ch).await;
                let snap = {
                    let mut guard = runtime_arc.lock().await;
                    match res {
                        Ok(()) => {
                            guard.status.synced_count += 1;
                            push_log(
                                &mut guard.status,
                                KeepUpToDateLogEntry {
                                    timestamp_ms: now_ms(),
                                    action: action_str.to_string(),
                                    relative_path: ch.rel_path.clone(),
                                    detail: format!(
                                        "{} {}",
                                        if action_str == "upload" {
                                            "Synced to target:"
                                        } else {
                                            "Removed from target:"
                                        },
                                        ch.rel_path
                                    ),
                                    status: "done".to_string(),
                                },
                            );
                        }
                        Err(err) => {
                            guard.status.error_count += 1;
                            push_log(
                                &mut guard.status,
                                KeepUpToDateLogEntry {
                                    timestamp_ms: now_ms(),
                                    action: "error".to_string(),
                                    relative_path: ch.rel_path.clone(),
                                    detail: err,
                                    status: "error".to_string(),
                                },
                            );
                        }
                    }
                    guard.status.clone()
                };
                let _ = app.emit("sync://keep-up-to-date", &snap);
            }

            prev_snap = settled_snap;
        }
    });

    Ok(initial_status)
}

#[tauri::command]
pub async fn sync_keep_up_to_date_stop(
    app: AppHandle,
    watcher_state: tauri::State<'_, KeepUpToDateManager>,
) -> Result<KeepUpToDateStatus, String> {
    let snap = {
        let mut guard = watcher_state.runtime.lock().await;
        if let Some(tx) = guard.cancel_tx.take() {
            let _ = tx.send(true);
        }
        guard.status.running = false;
        push_log(
            &mut guard.status,
            KeepUpToDateLogEntry {
                timestamp_ms: now_ms(),
                action: "stop".to_string(),
                relative_path: "*".to_string(),
                detail: "Keep Remote Directory up to Date stopped.".to_string(),
                status: "done".to_string(),
            },
        );
        guard.status.clone()
    };
    let _ = app.emit("sync://keep-up-to-date", &snap);
    Ok(snap)
}

#[tauri::command]
pub async fn sync_keep_up_to_date_status(
    watcher_state: tauri::State<'_, KeepUpToDateManager>,
) -> Result<KeepUpToDateStatus, String> {
    let guard = watcher_state.runtime.lock().await;
    Ok(guard.status.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_snap(name: &str, size: u64, mtime_ms: u64) -> LocalSnapEntry {
        LocalSnapEntry {
            full_path: PathBuf::from(name),
            size,
            mtime_ms,
        }
    }

    #[test]
    fn local_snapshot_diff_detects_create_modify_and_delete() {
        let mut prev = HashMap::new();
        prev.insert("unchanged.txt".into(), mk_snap("unchanged.txt", 10, 1000));
        prev.insert("edited.txt".into(), mk_snap("edited.txt", 10, 1000));
        prev.insert("removed.txt".into(), mk_snap("removed.txt", 10, 1000));

        let mut next = HashMap::new();
        next.insert("unchanged.txt".into(), mk_snap("unchanged.txt", 10, 1000));
        next.insert("edited.txt".into(), mk_snap("edited.txt", 22, 2000));
        next.insert("created.txt".into(), mk_snap("created.txt", 5, 3000));

        let changes = diff_local_snapshots(&prev, &next, true, false);
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].rel_path, "created.txt");
        assert_eq!(changes[0].kind, WatchChangeKind::Upload);
        assert_eq!(changes[1].rel_path, "edited.txt");
        assert_eq!(changes[1].kind, WatchChangeKind::Upload);
        assert_eq!(changes[2].rel_path, "removed.txt");
        assert_eq!(changes[2].kind, WatchChangeKind::Delete);

        let existing_only_changes = diff_local_snapshots(&prev, &next, false, true);
        assert_eq!(existing_only_changes.len(), 1);
        assert_eq!(existing_only_changes[0].rel_path, "edited.txt");
    }
}
