use crate::fs_trait::{AnyRemoteFs, RemoteFileSystem};
use crate::sftp::manager::SftpSessionManager;
use crate::sftp::ops::{
    compute_bytes_checksums, compute_remote_checksums, delete_remote_dir_recursive,
    join_remote_path, normalize_remote_path,
};
use crate::transfer::engine::{apply_local_timestamp, ensure_remote_dir_all};
use crate::transfer::resume::matches_transfer_mask;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MTIME_TOLERANCE_MS: u64 = 1500;
const MAX_SEARCH_CONTENT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncDirection {
    Both,
    Remote,
    Local,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncMode {
    SynchronizeFiles,
    MirrorFiles,
    SynchronizeTimestamps,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncActionKind {
    UploadNew,
    UploadUpdate,
    DownloadNew,
    DownloadUpdate,
    UpdateRemoteTimestamp,
    UpdateLocalTimestamp,
    DeleteRemote,
    DeleteLocal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEntryMeta {
    pub relative_path: String,
    pub name: String,
    pub full_path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: Option<u64>,
    pub checksum: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncChecklistItem {
    pub id: String,
    pub checked: bool,
    pub relative_path: String,
    pub name: String,
    pub local_path: String,
    pub remote_path: String,
    pub local_size: Option<u64>,
    pub remote_size: Option<u64>,
    pub local_mtime_ms: Option<u64>,
    pub remote_mtime_ms: Option<u64>,
    pub action: SyncActionKind,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCompareRequest {
    pub session_id: Option<String>,
    pub local_dir: String,
    pub remote_dir: String,
    pub target_is_remote: bool,
    pub direction: SyncDirection,
    pub mode: SyncMode,
    pub delete_files: bool,
    pub existing_files_only: bool,
    pub selected_files_only: bool,
    pub selected_rel_paths: Vec<String>,
    pub by_time: bool,
    pub by_size: bool,
    pub by_checksum: bool,
    pub case_sensitive: bool,
    pub file_mask: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCompareSummary {
    pub local_dir: String,
    pub remote_dir: String,
    pub target_is_remote: bool,
    pub items: Vec<SyncChecklistItem>,
    pub new_local_count: usize,
    pub new_remote_count: usize,
    pub updated_local_count: usize,
    pub updated_remote_count: usize,
    pub obsolete_local_count: usize,
    pub obsolete_remote_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncExecuteRequest {
    pub session_id: Option<String>,
    pub local_dir: String,
    pub remote_dir: String,
    pub target_is_remote: bool,
    pub items: Vec<SyncChecklistItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgressEvent {
    pub completed: usize,
    pub total: usize,
    pub current_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFindRequest {
    pub pane: String,
    pub session_id: Option<String>,
    pub is_remote: bool,
    pub base_dir: String,
    pub file_mask: String,
    pub content_keyword: String,
    pub case_sensitive: bool,
    pub recursive: bool,
    pub max_results: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFindMatch {
    pub name: String,
    pub directory: String,
    pub full_path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: Option<u64>,
    pub matched_line: Option<usize>,
    pub matched_preview: Option<String>,
}

fn system_time_to_ms(st: std::time::SystemTime) -> Option<u64> {
    st.duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

pub fn local_join_rel(base_dir: &Path, rel_posix: &str) -> String {
    let mut path = base_dir.to_path_buf();
    for seg in rel_posix.split('/').filter(|s| !s.is_empty()) {
        path.push(seg);
    }
    path.to_string_lossy().to_string()
}

pub fn target_join_rel(base_dir: &str, rel_posix: &str, is_remote: bool) -> String {
    if is_remote {
        join_remote_path(base_dir, rel_posix)
    } else {
        local_join_rel(Path::new(base_dir), rel_posix)
    }
}

pub fn collect_local_tree(base_dir: &Path, file_mask: &str) -> Result<Vec<SyncEntryMeta>, String> {
    if !base_dir.exists() {
        return Err(format!("Local directory does not exist: {}", base_dir.display()));
    }
    let mut results = Vec::new();
    let mut stack: Vec<(PathBuf, String)> = vec![(base_dir.to_path_buf(), String::new())];

    while let Some((dir, rel_prefix)) = stack.pop() {
        let read_dir = fs::read_dir(&dir)
            .map_err(|e| format!("Failed reading local directory {}: {}", dir.display(), e))?;
        let mut children = Vec::new();
        for entry_res in read_dir {
            let Ok(entry) = entry_res else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().to_string();
            let full = entry.path();
            let Ok(meta) = fs::metadata(&full) else {
                continue;
            };
            let is_dir = meta.is_dir();
            if !matches_transfer_mask(&name, is_dir, file_mask) {
                continue;
            }
            let rel = if rel_prefix.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", rel_prefix, name)
            };
            let mtime_ms = meta.modified().ok().and_then(system_time_to_ms);
            results.push(SyncEntryMeta {
                relative_path: rel.clone(),
                name,
                full_path: full.to_string_lossy().to_string(),
                is_dir,
                size: if is_dir { 0 } else { meta.len() },
                modified_ms: mtime_ms,
                checksum: None,
            });
            if is_dir {
                children.push((full, rel));
            }
        }
        children.reverse();
        stack.extend(children);
    }

    Ok(results)
}

pub async fn collect_remote_tree(
    sftp: &SftpSession,
    base_dir: &str,
    file_mask: &str,
) -> Result<Vec<SyncEntryMeta>, String> {
    let root = normalize_remote_path(base_dir);
    let mut results = Vec::new();
    let mut stack: Vec<(String, String)> = vec![(root, String::new())];
    let mut visited: HashSet<String> = HashSet::new();

    while let Some((dir, rel_prefix)) = stack.pop() {
        if !visited.insert(dir.clone()) {
            continue;
        }
        let entries = sftp
            .read_dir(&dir)
            .await
            .map_err(|e| format!("Failed reading remote directory {}: {}", dir, e))?;
        let mut children = Vec::new();
        for item in entries {
            let name = item.file_name();
            if name == "." || name == ".." || name.is_empty() {
                continue;
            }
            let full = join_remote_path(&dir, &name);
            let meta = item.metadata();
            let is_dir = meta.is_dir();
            if !matches_transfer_mask(&name, is_dir, file_mask) {
                continue;
            }
            let rel = if rel_prefix.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", rel_prefix, name)
            };
            results.push(SyncEntryMeta {
                relative_path: rel.clone(),
                name,
                full_path: full.clone(),
                is_dir,
                size: if is_dir { 0 } else { meta.len() },
                modified_ms: meta.mtime.map(|s| (s as u64) * 1000),
                checksum: None,
            });
            if is_dir && !meta.is_symlink() {
                children.push((full, rel));
            }
        }
        children.reverse();
        stack.extend(children);
    }

    Ok(results)
}

pub async fn collect_remote_tree_fs(
    fs: &AnyRemoteFs,
    base_dir: &str,
    file_mask: &str,
) -> Result<Vec<SyncEntryMeta>, String> {
    if let Some(sftp) = fs.as_sftp() {
        return collect_remote_tree(sftp, base_dir, file_mask).await;
    }

    let root = normalize_remote_path(base_dir);
    let mut results = Vec::new();
    let mut stack: Vec<(String, String)> = vec![(root, String::new())];
    let mut visited: HashSet<String> = HashSet::new();

    while let Some((dir, rel_prefix)) = stack.pop() {
        if !visited.insert(dir.clone()) {
            continue;
        }
        let listing = fs.list_dir(&dir).await?;
        let mut children = Vec::new();
        for item in listing.entries {
            let is_dir = item.file_type == "dir" || item.file_type == "symlink_dir";
            if !matches_transfer_mask(&item.name, is_dir, file_mask) {
                continue;
            }
            let rel = if rel_prefix.is_empty() {
                item.name.clone()
            } else {
                format!("{}/{}", rel_prefix, item.name)
            };
            results.push(SyncEntryMeta {
                relative_path: rel.clone(),
                name: item.name,
                full_path: item.path.clone(),
                is_dir,
                size: if is_dir { 0 } else { item.size },
                modified_ms: item.modified_ms,
                checksum: None,
            });
            if is_dir {
                children.push((item.path, rel));
            }
        }
        children.reverse();
        stack.extend(children);
    }

    Ok(results)
}

fn key_for_rel(rel: &str, case_sensitive: bool) -> String {
    if case_sensitive {
        rel.to_string()
    } else {
        rel.to_lowercase()
    }
}

fn is_selected_scope(rel: &str, request: &SyncCompareRequest) -> bool {
    if !request.selected_files_only || request.selected_rel_paths.is_empty() {
        return true;
    }
    let rel_norm = key_for_rel(rel.trim_matches('/'), request.case_sensitive);
    request.selected_rel_paths.iter().any(|sel| {
        let s = key_for_rel(sel.trim_matches('/'), request.case_sensitive);
        rel_norm == s || rel_norm.starts_with(&format!("{}/", s))
    })
}

fn times_significantly_differ(a: Option<u64>, b: Option<u64>) -> bool {
    match (a, b) {
        (Some(x), Some(y)) => x.abs_diff(y) > MTIME_TOLERANCE_MS,
        _ => false,
    }
}

fn a_is_newer(a: Option<u64>, b: Option<u64>) -> bool {
    match (a, b) {
        (Some(x), Some(y)) => x > y.saturating_add(MTIME_TOLERANCE_MS),
        (Some(_), None) => true,
        _ => false,
    }
}

pub fn compute_sync_checklist(
    local_entries: Vec<SyncEntryMeta>,
    remote_entries: Vec<SyncEntryMeta>,
    request: &SyncCompareRequest,
) -> SyncCompareSummary {
    let mut local_map: HashMap<String, SyncEntryMeta> = HashMap::new();
    for entry in local_entries {
        if !entry.is_dir && is_selected_scope(&entry.relative_path, request) {
            local_map.insert(key_for_rel(&entry.relative_path, request.case_sensitive), entry);
        }
    }

    let mut remote_map: HashMap<String, SyncEntryMeta> = HashMap::new();
    for entry in remote_entries {
        if !entry.is_dir && is_selected_scope(&entry.relative_path, request) {
            remote_map.insert(key_for_rel(&entry.relative_path, request.case_sensitive), entry);
        }
    }

    let mut all_keys: Vec<String> = local_map
        .keys()
        .chain(remote_map.keys())
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    all_keys.sort();

    let mut items = Vec::new();
    let mut new_local_count = 0usize;
    let mut new_remote_count = 0usize;
    let mut updated_local_count = 0usize;
    let mut updated_remote_count = 0usize;
    let mut obsolete_local_count = 0usize;
    let mut obsolete_remote_count = 0usize;

    let base_local = Path::new(&request.local_dir);

    for (idx, key) in all_keys.iter().enumerate() {
        let local_opt = local_map.get(key);
        let remote_opt = remote_map.get(key);

        let action_opt: Option<SyncActionKind> = match (local_opt, remote_opt) {
            (Some(_l), None) => match request.direction {
                SyncDirection::Both | SyncDirection::Remote => {
                    if request.existing_files_only
                        || matches!(request.mode, SyncMode::SynchronizeTimestamps)
                    {
                        None
                    } else {
                        new_remote_count += 1;
                        Some(SyncActionKind::UploadNew)
                    }
                }
                SyncDirection::Local => {
                    if request.delete_files {
                        obsolete_local_count += 1;
                        Some(SyncActionKind::DeleteLocal)
                    } else {
                        None
                    }
                }
            },
            (None, Some(_r)) => match request.direction {
                SyncDirection::Both | SyncDirection::Local => {
                    if request.existing_files_only
                        || matches!(request.mode, SyncMode::SynchronizeTimestamps)
                    {
                        None
                    } else {
                        new_local_count += 1;
                        Some(SyncActionKind::DownloadNew)
                    }
                }
                SyncDirection::Remote => {
                    if request.delete_files {
                        obsolete_remote_count += 1;
                        Some(SyncActionKind::DeleteRemote)
                    } else {
                        None
                    }
                }
            },
            (Some(l), Some(r)) => {
                let time_diff = request.by_time && times_significantly_differ(l.modified_ms, r.modified_ms);
                let size_diff = request.by_size && l.size != r.size;
                let hash_diff = match (&l.checksum, &r.checksum) {
                    (Some(hc1), Some(hc2)) if request.by_checksum => hc1 != hc2,
                    _ => false,
                };

                if matches!(request.mode, SyncMode::SynchronizeTimestamps) {
                    if time_diff {
                        if request.direction == SyncDirection::Local
                            || (request.direction == SyncDirection::Both
                                && a_is_newer(r.modified_ms, l.modified_ms))
                        {
                            updated_local_count += 1;
                            Some(SyncActionKind::UpdateLocalTimestamp)
                        } else {
                            updated_remote_count += 1;
                            Some(SyncActionKind::UpdateRemoteTimestamp)
                        }
                    } else {
                        None
                    }
                } else {
                    let mirror_diff = matches!(request.mode, SyncMode::MirrorFiles)
                        && (size_diff || hash_diff || time_diff);
                    let content_diff = size_diff || hash_diff;

                    match request.direction {
                        SyncDirection::Remote => {
                            if a_is_newer(l.modified_ms, r.modified_ms) || content_diff || mirror_diff {
                                updated_remote_count += 1;
                                Some(SyncActionKind::UploadUpdate)
                            } else {
                                None
                            }
                        }
                        SyncDirection::Local => {
                            if a_is_newer(r.modified_ms, l.modified_ms) || content_diff || mirror_diff {
                                updated_local_count += 1;
                                Some(SyncActionKind::DownloadUpdate)
                            } else {
                                None
                            }
                        }
                        SyncDirection::Both => {
                            if a_is_newer(l.modified_ms, r.modified_ms) {
                                updated_remote_count += 1;
                                Some(SyncActionKind::UploadUpdate)
                            } else if a_is_newer(r.modified_ms, l.modified_ms) {
                                updated_local_count += 1;
                                Some(SyncActionKind::DownloadUpdate)
                            } else if content_diff {
                                updated_remote_count += 1;
                                Some(SyncActionKind::UploadUpdate)
                            } else {
                                None
                            }
                        }
                    }
                }
            }
            (None, None) => None,
        };

        if let Some(action) = action_opt {
            let rel = local_opt
                .map(|e| e.relative_path.clone())
                .or_else(|| remote_opt.map(|e| e.relative_path.clone()))
                .unwrap_or_else(|| key.clone());
            let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
            let local_path = local_opt
                .map(|e| e.full_path.clone())
                .unwrap_or_else(|| local_join_rel(base_local, &rel));
            let remote_path = remote_opt
                .map(|e| e.full_path.clone())
                .unwrap_or_else(|| target_join_rel(&request.remote_dir, &rel, request.target_is_remote));

            items.push(SyncChecklistItem {
                id: format!("sync_{}", idx),
                checked: true,
                relative_path: rel,
                name,
                local_path,
                remote_path,
                local_size: local_opt.map(|e| e.size),
                remote_size: remote_opt.map(|e| e.size),
                local_mtime_ms: local_opt.and_then(|e| e.modified_ms),
                remote_mtime_ms: remote_opt.and_then(|e| e.modified_ms),
                action,
                is_dir: false,
            });
        }
    }

    SyncCompareSummary {
        local_dir: request.local_dir.clone(),
        remote_dir: request.remote_dir.clone(),
        target_is_remote: request.target_is_remote,
        items,
        new_local_count,
        new_remote_count,
        updated_local_count,
        updated_remote_count,
        obsolete_local_count,
        obsolete_remote_count,
    }
}

fn sha256_local_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut f = fs::File::open(path)
        .map_err(|e| format!("Failed opening {} for checksum: {}", path.display(), e))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| format!("Failed reading {}: {}", path.display(), e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect())
}

#[tauri::command]
pub async fn sync_compare_directories(
    sftp_manager: tauri::State<'_, SftpSessionManager>,
    request: SyncCompareRequest,
) -> Result<SyncCompareSummary, String> {
    let mut local_entries = collect_local_tree(Path::new(&request.local_dir), &request.file_mask)?;

    let (mut remote_entries, remote_fs_opt) = if request.target_is_remote {
        let sid = request
            .session_id
            .as_deref()
            .ok_or_else(|| "Missing remote sessionId for directory sync".to_string())?;
        let fs = sftp_manager.get_remote_fs(sid).await?;
        let entries = collect_remote_tree_fs(&fs, &request.remote_dir, &request.file_mask).await?;
        (entries, Some(fs))
    } else {
        let entries = collect_local_tree(Path::new(&request.remote_dir), &request.file_mask)?;
        (entries, None)
    };

    if request.by_checksum {
        let mut remote_idx: HashMap<String, usize> = HashMap::new();
        for (idx, item) in remote_entries.iter().enumerate() {
            if !item.is_dir {
                remote_idx.insert(
                    key_for_rel(&item.relative_path, request.case_sensitive),
                    idx,
                );
            }
        }
        for l_item in &mut local_entries {
            if l_item.is_dir {
                continue;
            }
            let k = key_for_rel(&l_item.relative_path, request.case_sensitive);
            if let Some(&r_i) = remote_idx.get(&k) {
                if l_item.size == remote_entries[r_i].size {
                    if let Ok(lh) = sha256_local_file(Path::new(&l_item.full_path)) {
                        l_item.checksum = Some(lh);
                    }
                    if let Some(ref fs) = remote_fs_opt {
                        if let Some(sftp) = fs.as_sftp() {
                            if let Ok(cks) =
                                compute_remote_checksums(sftp, &remote_entries[r_i].full_path, "sha-256")
                                    .await
                            {
                                remote_entries[r_i].checksum = cks.into_iter().next().map(|c| c.value);
                            }
                        } else if let Ok((bytes, _)) =
                            fs.read_bytes(&remote_entries[r_i].full_path, Some(64 * 1024 * 1024)).await
                        {
                            remote_entries[r_i].checksum = compute_bytes_checksums(&bytes, "sha-256")
                                .into_iter()
                                .next()
                                .map(|c| c.value);
                        }
                    } else if let Ok(rh) =
                        sha256_local_file(Path::new(&remote_entries[r_i].full_path))
                    {
                        remote_entries[r_i].checksum = Some(rh);
                    }
                }
            }
        }
    }

    Ok(compute_sync_checklist(local_entries, remote_entries, &request))
}

async fn upload_single_file(
    sftp: &SftpSession,
    local_src: &Path,
    remote_dst: &str,
    mtime_ms: Option<u64>,
) -> Result<(), String> {
    if let Some((parent, _)) = remote_dst.rsplit_once('/') {
        if !parent.is_empty() {
            ensure_remote_dir_all(sftp, parent).await?;
        }
    }
    let mut src = tokio::fs::File::open(local_src)
        .await
        .map_err(|e| format!("Failed reading {}: {}", local_src.display(), e))?;
    let mut dst = sftp
        .open_with_flags(
            remote_dst,
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|e| format!("Failed opening remote {}: {}", remote_dst, e))?;
    tokio::io::copy(&mut src, &mut dst)
        .await
        .map_err(|e| format!("Failed uploading {}: {}", remote_dst, e))?;
    dst.flush()
        .await
        .map_err(|e| format!("Failed flushing {}: {}", remote_dst, e))?;
    dst.shutdown()
        .await
        .map_err(|e| format!("Failed closing {}: {}", remote_dst, e))?;
    if let Some(ms) = mtime_ms {
        let secs = (ms / 1000) as u32;
        let mut attrs = FileAttributes::empty();
        attrs.atime = Some(secs);
        attrs.mtime = Some(secs);
        let _ = sftp.set_metadata(remote_dst, attrs).await;
    }
    Ok(())
}

async fn download_single_file(
    sftp: &SftpSession,
    remote_src: &str,
    local_dst: &Path,
    mtime_ms: Option<u64>,
) -> Result<(), String> {
    if let Some(parent) = local_dst.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed creating local dir {}: {}", parent.display(), e))?;
    }
    let mut src = sftp
        .open_with_flags(remote_src, OpenFlags::READ)
        .await
        .map_err(|e| format!("Failed opening remote {}: {}", remote_src, e))?;
    let mut dst = tokio::fs::File::create(local_dst)
        .await
        .map_err(|e| format!("Failed creating local {}: {}", local_dst.display(), e))?;
    tokio::io::copy(&mut src, &mut dst)
        .await
        .map_err(|e| format!("Failed downloading {}: {}", remote_src, e))?;
    dst.flush()
        .await
        .map_err(|e| format!("Failed flushing local {}: {}", local_dst.display(), e))?;
    drop(dst);
    let _ = src.shutdown().await;
    apply_local_timestamp(local_dst, mtime_ms).await;
    Ok(())
}

async fn copy_local_single_file(
    src: &Path,
    dst: &Path,
    mtime_ms: Option<u64>,
) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed creating {}: {}", parent.display(), e))?;
    }
    tokio::fs::copy(src, dst)
        .await
        .map_err(|e| format!("Failed copying {} -> {}: {}", src.display(), dst.display(), e))?;
    apply_local_timestamp(dst, mtime_ms).await;
    Ok(())
}

#[tauri::command]
pub async fn sync_execute_checklist(
    app: AppHandle,
    sftp_manager: tauri::State<'_, SftpSessionManager>,
    request: SyncExecuteRequest,
) -> Result<usize, String> {
    let remote_fs_opt = if request.target_is_remote {
        let sid = request
            .session_id
            .as_deref()
            .ok_or_else(|| "Missing remote sessionId for sync execution".to_string())?;
        Some(sftp_manager.get_remote_fs(sid).await?)
    } else {
        None
    };

    let selected: Vec<SyncChecklistItem> =
        request.items.into_iter().filter(|item| item.checked).collect();
    let total = selected.len();
    let mut completed = 0usize;

    for item in selected {
        match item.action {
            SyncActionKind::UploadNew | SyncActionKind::UploadUpdate => {
                if let Some(ref fs) = remote_fs_opt {
                    if let Some(sftp) = fs.as_sftp() {
                        upload_single_file(
                            sftp,
                            Path::new(&item.local_path),
                            &item.remote_path,
                            item.local_mtime_ms,
                        )
                        .await?;
                    } else {
                        if let Some((parent, _)) = item.remote_path.rsplit_once('/') {
                            if !parent.is_empty() {
                                let _ = fs.ensure_dir_all(parent).await;
                            }
                        }
                        let bytes = tokio::fs::read(&item.local_path).await.map_err(|e| {
                            format!("Failed reading {}: {}", item.local_path, e)
                        })?;
                        fs.write_bytes(&item.remote_path, &bytes, item.local_mtime_ms)
                            .await?;
                    }
                } else {
                    copy_local_single_file(
                        Path::new(&item.local_path),
                        Path::new(&item.remote_path),
                        item.local_mtime_ms,
                    )
                    .await?;
                }
            }
            SyncActionKind::DownloadNew | SyncActionKind::DownloadUpdate => {
                if let Some(ref fs) = remote_fs_opt {
                    if let Some(sftp) = fs.as_sftp() {
                        download_single_file(
                            sftp,
                            &item.remote_path,
                            Path::new(&item.local_path),
                            item.remote_mtime_ms,
                        )
                        .await?;
                    } else {
                        let (bytes, mtime_opt) = fs.read_bytes(&item.remote_path, None).await?;
                        let local_dst = Path::new(&item.local_path);
                        if let Some(parent) = local_dst.parent() {
                            let _ = tokio::fs::create_dir_all(parent).await;
                        }
                        tokio::fs::write(local_dst, &bytes).await.map_err(|e| {
                            format!("Failed writing local {}: {}", item.local_path, e)
                        })?;
                        apply_local_timestamp(local_dst, item.remote_mtime_ms.or(mtime_opt)).await;
                    }
                } else {
                    copy_local_single_file(
                        Path::new(&item.remote_path),
                        Path::new(&item.local_path),
                        item.remote_mtime_ms,
                    )
                    .await?;
                }
            }
            SyncActionKind::UpdateRemoteTimestamp => {
                if let Some(ms) = item.local_mtime_ms {
                    if let Some(ref fs) = remote_fs_opt {
                        if let Some(sftp) = fs.as_sftp() {
                            let secs = (ms / 1000) as u32;
                            let mut attrs = FileAttributes::empty();
                            attrs.atime = Some(secs);
                            attrs.mtime = Some(secs);
                            sftp.set_metadata(&item.remote_path, attrs)
                                .await
                                .map_err(|e| format!("Failed updating remote mtime: {}", e))?;
                        }
                    } else {
                        apply_local_timestamp(Path::new(&item.remote_path), Some(ms)).await;
                    }
                }
            }
            SyncActionKind::UpdateLocalTimestamp => {
                apply_local_timestamp(Path::new(&item.local_path), item.remote_mtime_ms).await;
            }
            SyncActionKind::DeleteRemote => {
                if let Some(ref fs) = remote_fs_opt {
                    if let Some(sftp) = fs.as_sftp() {
                        if item.is_dir {
                            delete_remote_dir_recursive(sftp, &item.remote_path).await?;
                        } else {
                            sftp.remove_file(&item.remote_path)
                                .await
                                .map_err(|e| format!("Failed deleting remote {}: {}", item.remote_path, e))?;
                        }
                    } else {
                        let _ = fs.delete(&[item.remote_path.clone()]).await?;
                    }
                } else {
                    let p = Path::new(&item.remote_path);
                    if p.is_dir() {
                        let _ = tokio::fs::remove_dir_all(p).await;
                    } else if p.exists() {
                        let _ = tokio::fs::remove_file(p).await;
                    }
                }
            }
            SyncActionKind::DeleteLocal => {
                let p = Path::new(&item.local_path);
                if p.is_dir() {
                    let _ = tokio::fs::remove_dir_all(p).await;
                } else if p.exists() {
                    let _ = tokio::fs::remove_file(p).await;
                }
            }
        }

        completed += 1;
        let _ = app.emit(
            "sync://progress",
            SyncProgressEvent {
                completed,
                total,
                current_path: item.relative_path,
            },
        );
    }

    Ok(completed)
}

fn find_keyword_in_bytes(
    bytes: &[u8],
    keyword: &str,
    case_sensitive: bool,
) -> Option<(usize, String)> {
    let text = String::from_utf8_lossy(bytes);
    let needle = if case_sensitive {
        keyword.to_string()
    } else {
        keyword.to_lowercase()
    };
    for (idx, line) in text.lines().enumerate() {
        let hit = if case_sensitive {
            line.contains(&needle)
        } else {
            line.to_lowercase().contains(&needle)
        };
        if hit {
            let preview: String = line.trim().chars().take(120).collect();
            return Some((idx + 1, preview));
        }
    }
    None
}

#[tauri::command]
pub async fn find_files_search(
    _app: AppHandle,
    sftp_manager: tauri::State<'_, SftpSessionManager>,
    request: FileFindRequest,
) -> Result<Vec<FileFindMatch>, String> {
    let limit = request.max_results.unwrap_or(500).clamp(1, 5000);
    let keyword = request.content_keyword.trim().to_string();
    let has_keyword = !keyword.is_empty();
    let mut matches = Vec::new();

    if request.is_remote {
        let sid = request
            .session_id
            .as_deref()
            .ok_or_else(|| "Missing remote sessionId for remote search".to_string())?;
        let remote_fs = sftp_manager.get_remote_fs(sid).await?;
        let root = normalize_remote_path(&request.base_dir);
        let mut stack = vec![root];
        let mut visited = HashSet::new();

        if let Some(sftp) = remote_fs.as_sftp() {
            while let Some(dir) = stack.pop() {
                if matches.len() >= limit || !visited.insert(dir.clone()) {
                    continue;
                }
                let Ok(entries) = sftp.read_dir(&dir).await else {
                    continue;
                };
                let mut subdirs = Vec::new();
                for item in entries {
                    if matches.len() >= limit {
                        break;
                    }
                    let name = item.file_name();
                    if name == "." || name == ".." || name.is_empty() {
                        continue;
                    }
                    let full_path = join_remote_path(&dir, &name);
                    let meta = item.metadata();
                    let is_dir = meta.is_dir();

                    if is_dir && request.recursive && !meta.is_symlink() {
                        subdirs.push(full_path.clone());
                    }

                    if !matches_transfer_mask(&name, is_dir, &request.file_mask) {
                        continue;
                    }
                    if has_keyword {
                        if is_dir || meta.len() > MAX_SEARCH_CONTENT_BYTES {
                            continue;
                        }
                        let Ok(mut f) = sftp.open_with_flags(&full_path, OpenFlags::READ).await else {
                            continue;
                        };
                        let mut buf = Vec::with_capacity(meta.len() as usize);
                        if f.read_to_end(&mut buf).await.is_err() {
                            continue;
                        }
                        let _ = f.shutdown().await;
                        let Some((line_no, preview)) =
                            find_keyword_in_bytes(&buf, &keyword, request.case_sensitive)
                        else {
                            continue;
                        };
                        matches.push(FileFindMatch {
                            name,
                            directory: dir.clone(),
                            full_path,
                            is_dir: false,
                            size: meta.len(),
                            modified_ms: meta.mtime.map(|s| (s as u64) * 1000),
                            matched_line: Some(line_no),
                            matched_preview: Some(preview),
                        });
                    } else {
                        matches.push(FileFindMatch {
                            name,
                            directory: dir.clone(),
                            full_path,
                            is_dir,
                            size: if is_dir { 0 } else { meta.len() },
                            modified_ms: meta.mtime.map(|s| (s as u64) * 1000),
                            matched_line: None,
                            matched_preview: None,
                        });
                    }
                }
                subdirs.reverse();
                stack.extend(subdirs);
            }
        } else {
            while let Some(dir) = stack.pop() {
                if matches.len() >= limit || !visited.insert(dir.clone()) {
                    continue;
                }
                let Ok(listing) = remote_fs.list_dir(&dir).await else {
                    continue;
                };
                let mut subdirs = Vec::new();
                for entry in listing.entries {
                    if matches.len() >= limit {
                        break;
                    }
                    let is_dir = entry.file_type == "dir" || entry.file_type == "symlink_dir";
                    if is_dir && request.recursive {
                        subdirs.push(entry.path.clone());
                    }
                    if !matches_transfer_mask(&entry.name, is_dir, &request.file_mask) {
                        continue;
                    }
                    if has_keyword {
                        if is_dir || entry.size > MAX_SEARCH_CONTENT_BYTES {
                            continue;
                        }
                        let Ok((buf, _)) = remote_fs
                            .read_bytes(&entry.path, Some(MAX_SEARCH_CONTENT_BYTES))
                            .await
                        else {
                            continue;
                        };
                        let Some((line_no, preview)) =
                            find_keyword_in_bytes(&buf, &keyword, request.case_sensitive)
                        else {
                            continue;
                        };
                        matches.push(FileFindMatch {
                            name: entry.name,
                            directory: dir.clone(),
                            full_path: entry.path,
                            is_dir: false,
                            size: entry.size,
                            modified_ms: entry.modified_ms,
                            matched_line: Some(line_no),
                            matched_preview: Some(preview),
                        });
                    } else {
                        matches.push(FileFindMatch {
                            name: entry.name,
                            directory: dir.clone(),
                            full_path: entry.path,
                            is_dir,
                            size: entry.size,
                            modified_ms: entry.modified_ms,
                            matched_line: None,
                            matched_preview: None,
                        });
                    }
                }
                subdirs.reverse();
                stack.extend(subdirs);
            }
        }
    } else {
        let base_path = PathBuf::from(&request.base_dir);
        if !base_path.exists() {
            return Err(format!("Directory does not exist: {}", base_path.display()));
        }
        let mut stack = vec![base_path];
        while let Some(dir) = stack.pop() {
            if matches.len() >= limit {
                break;
            }
            let Ok(read_dir) = fs::read_dir(&dir) else {
                continue;
            };
            let dir_str = dir.to_string_lossy().to_string();
            let mut subdirs = Vec::new();
            for entry_res in read_dir {
                if matches.len() >= limit {
                    break;
                }
                let Ok(entry) = entry_res else {
                    continue;
                };
                let name = entry.file_name().to_string_lossy().to_string();
                let full = entry.path();
                let Ok(meta) = fs::metadata(&full) else {
                    continue;
                };
                let is_dir = meta.is_dir();
                if is_dir && request.recursive {
                    subdirs.push(full.clone());
                }
                if !matches_transfer_mask(&name, is_dir, &request.file_mask) {
                    continue;
                }
                if has_keyword {
                    if is_dir || meta.len() > MAX_SEARCH_CONTENT_BYTES {
                        continue;
                    }
                    let Ok(buf) = fs::read(&full) else {
                        continue;
                    };
                    let Some((line_no, preview)) =
                        find_keyword_in_bytes(&buf, &keyword, request.case_sensitive)
                    else {
                        continue;
                    };
                    matches.push(FileFindMatch {
                        name,
                        directory: dir_str.clone(),
                        full_path: full.to_string_lossy().to_string(),
                        is_dir: false,
                        size: meta.len(),
                        modified_ms: meta.modified().ok().and_then(system_time_to_ms),
                        matched_line: Some(line_no),
                        matched_preview: Some(preview),
                    });
                } else {
                    matches.push(FileFindMatch {
                        name,
                        directory: dir_str.clone(),
                        full_path: full.to_string_lossy().to_string(),
                        is_dir,
                        size: if is_dir { 0 } else { meta.len() },
                        modified_ms: meta.modified().ok().and_then(system_time_to_ms),
                        matched_line: None,
                        matched_preview: None,
                    });
                }
            }
            subdirs.reverse();
            stack.extend(subdirs);
        }
    }

    let _ = Duration::from_millis(0);
    Ok(matches)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_meta(rel: &str, size: u64, modified_ms: u64) -> SyncEntryMeta {
        SyncEntryMeta {
            relative_path: rel.to_string(),
            name: rel.rsplit('/').next().unwrap_or(rel).to_string(),
            full_path: format!("/tmp/{}", rel),
            is_dir: false,
            size,
            modified_ms: Some(modified_ms),
            checksum: None,
        }
    }

    #[test]
    fn sync_diff_bidirectional_mirror_and_delete_rules() {
        let local = vec![
            mk_meta("only_local.txt", 100, 10_000),
            mk_meta("newer_local.txt", 200, 30_000),
            mk_meta("newer_remote.txt", 200, 10_000),
            mk_meta("same.txt", 50, 20_000),
        ];
        let remote = vec![
            mk_meta("only_remote.txt", 150, 15_000),
            mk_meta("newer_local.txt", 200, 10_000),
            mk_meta("newer_remote.txt", 220, 30_000),
            mk_meta("same.txt", 50, 20_500),
        ];

        let both_req = SyncCompareRequest {
            session_id: Some("s1".into()),
            local_dir: "C:/proj".into(),
            remote_dir: "/var/www".into(),
            target_is_remote: true,
            direction: SyncDirection::Both,
            mode: SyncMode::SynchronizeFiles,
            delete_files: false,
            existing_files_only: false,
            selected_files_only: false,
            selected_rel_paths: vec![],
            by_time: true,
            by_size: true,
            by_checksum: false,
            case_sensitive: false,
            file_mask: "*".into(),
        };

        let summary = compute_sync_checklist(local.clone(), remote.clone(), &both_req);
        assert_eq!(summary.new_remote_count, 1);
        assert_eq!(summary.new_local_count, 1);
        assert_eq!(summary.updated_remote_count, 1);
        assert_eq!(summary.updated_local_count, 1);
        assert_eq!(summary.items.len(), 4);

        let mut mirror_remote = both_req;
        mirror_remote.direction = SyncDirection::Remote;
        mirror_remote.mode = SyncMode::MirrorFiles;
        mirror_remote.delete_files = true;
        let mirror_summary = compute_sync_checklist(local, remote, &mirror_remote);
        assert_eq!(mirror_summary.obsolete_remote_count, 1);
        assert!(mirror_summary
            .items
            .iter()
            .any(|i| i.relative_path == "only_remote.txt" && i.action == SyncActionKind::DeleteRemote));
    }
}
