use crate::fs_trait::{AnyRemoteFs, RemoteFileSystem};
use crate::sftp::manager::SftpSessionManager;
use crate::sftp::ops::{join_remote_path, normalize_remote_path, parse_octal_mode};
use crate::transfer::queue::{
    compute_chunk_throttle_delay_ms, compute_eta_seconds, now_millis, ConflictPrompt,
    TransferDirection, TransferItem, TransferOptions, TransferQueueSnapshot, TransferQueueState,
    TransferTaskStatus,
};
use crate::transfer::resume::{
    convert_crlf_to_lf_chunk, convert_lf_to_crlf_chunk, finish_crlf_to_lf, format_numbered_name,
    matches_transfer_mask, next_available_local_path, resolve_is_text_mode,
    should_skip_newer_only, strip_utf8_bom_and_eof_ctrl_z, to_filepart_path, ConflictResolution,
};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{oneshot, Mutex as AsyncMutex, Notify};

const CHUNK_SIZE: usize = 65_536;
const EMIT_INTERVAL: Duration = Duration::from_millis(140);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueTransferRequest {
    pub sources: Vec<String>,
    pub target_dir: String,
    pub options: TransferOptions,
}

#[derive(Default)]
struct TaskControl {
    paused: AtomicBool,
    cancelled: AtomicBool,
    skip_requested: AtomicBool,
}

pub struct TransferEngine {
    inner: Arc<AsyncMutex<TransferQueueState>>,
    controls: Arc<StdMutex<HashMap<String, Arc<TaskControl>>>>,
    conflict_waiters: Arc<AsyncMutex<HashMap<String, oneshot::Sender<ConflictResolution>>>>,
    scheduler_wake: Arc<Notify>,
    scheduler_started: Arc<AtomicBool>,
}

impl Default for TransferEngine {
    fn default() -> Self {
        Self {
            inner: Arc::new(AsyncMutex::new(TransferQueueState::new(3))),
            controls: Arc::new(StdMutex::new(HashMap::new())),
            conflict_waiters: Arc::new(AsyncMutex::new(HashMap::new())),
            scheduler_wake: Arc::new(Notify::new()),
            scheduler_started: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl TransferEngine {
    async fn ensure_scheduler(&self, app: AppHandle) {
        if self
            .scheduler_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            let inner = self.inner.clone();
            let controls = self.controls.clone();
            let waiters = self.conflict_waiters.clone();
            let wake = self.scheduler_wake.clone();
            tokio::spawn(async move {
                scheduler_loop(app, inner, controls, waiters, wake).await;
            });
        }
        self.scheduler_wake.notify_one();
    }
}

fn system_time_to_ms(st: Option<SystemTime>) -> Option<u64> {
    st.and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

fn is_local_hidden(path: &Path, name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if let Ok(meta) = fs::symlink_metadata(path) {
            return (meta.file_attributes() & 0x2) != 0;
        }
    }
    false
}

fn new_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}_{}_{}", prefix, nanos, seq)
}

pub async fn ensure_remote_dir_all(sftp: &SftpSession, remote_dir: &str) -> Result<(), String> {
    let clean = normalize_remote_path(remote_dir);
    if clean == "/" {
        return Ok(());
    }
    if sftp.try_exists(&clean).await.unwrap_or(false) {
        return Ok(());
    }
    let mut accum = String::new();
    for seg in clean.trim_start_matches('/').split('/') {
        if seg.is_empty() {
            continue;
        }
        accum.push('/');
        accum.push_str(seg);
        if !sftp.try_exists(&accum).await.unwrap_or(false) {
            let _ = sftp.create_dir(&accum).await;
        }
    }
    Ok(())
}

async fn next_available_remote_path(sftp: &SftpSession, target: &str) -> String {
    let clean = normalize_remote_path(target);
    if !sftp.try_exists(&clean).await.unwrap_or(false) {
        return clean;
    }
    let (parent, file_name) = match clean.rfind('/') {
        Some(0) => ("/", &clean[1..]),
        Some(idx) => (&clean[..idx], &clean[idx + 1..]),
        None => ("/", clean.as_str()),
    };
    for idx in 2..=9999u32 {
        let candidate = join_remote_path(parent, &format_numbered_name(file_name, idx));
        if !sftp.try_exists(&candidate).await.unwrap_or(false) {
            return candidate;
        }
    }
    format!("{}.new", clean)
}

async fn next_available_remote_path_fs(remote_fs: &AnyRemoteFs, target: &str) -> String {
    if let Some(sftp) = remote_fs.as_sftp() {
        return next_available_remote_path(sftp, target).await;
    }
    let clean = normalize_remote_path(target);
    let (parent, file_name) = match clean.rfind('/') {
        Some(0) => ("/", &clean[1..]),
        Some(idx) => (&clean[..idx], &clean[idx + 1..]),
        None => ("/", clean.as_str()),
    };
    let existing_names: std::collections::HashSet<String> = remote_fs
        .list_dir(parent)
        .await
        .map(|l| l.entries.into_iter().map(|e| e.name).collect())
        .unwrap_or_default();
    if !existing_names.contains(file_name) {
        return clean;
    }
    for idx in 2..=9999u32 {
        let candidate_name = format_numbered_name(file_name, idx);
        if !existing_names.contains(&candidate_name) {
            return join_remote_path(parent, &candidate_name);
        }
    }
    format!("{}.new", clean)
}

fn transform_text_payload_all(bytes: &[u8], remove_bom_eof: bool, to_lf: bool) -> Vec<u8> {
    let chunk = if remove_bom_eof {
        strip_utf8_bom_and_eof_ctrl_z(bytes, true, true)
    } else {
        bytes
    };
    if to_lf {
        let mut pending_cr = false;
        let mut out = convert_crlf_to_lf_chunk(chunk, &mut pending_cr);
        out.extend_from_slice(&finish_crlf_to_lf(&mut pending_cr));
        out
    } else {
        let mut prev_was_cr = false;
        convert_lf_to_crlf_chunk(chunk, &mut prev_was_cr)
    }
}

fn build_transfer_item(
    batch_id: &str,
    source_path: String,
    target_path: String,
    file_name: String,
    total_bytes: u64,
    source_mtime_ms: Option<u64>,
    options: &TransferOptions,
) -> TransferItem {
    TransferItem {
        id: new_id("xfer"),
        batch_id: batch_id.to_string(),
        session_id: options.session_id.clone(),
        direction: options.direction,
        is_move: options.is_move,
        source_path,
        target_path,
        file_name,
        is_dir: false,
        total_bytes,
        transferred_bytes: 0,
        resumed_from_bytes: 0,
        speed_bps: 0,
        eta_seconds: None,
        status: TransferTaskStatus::Queued,
        error: None,
        source_mtime_ms,
        started_at_ms: None,
        finished_at_ms: None,
        options: options.clone(),
    }
}

async fn expand_upload_sources(
    batch_id: &str,
    sources: &[String],
    remote_target_dir: &str,
    remote_fs: &AnyRemoteFs,
    options: &TransferOptions,
) -> Result<(Vec<TransferItem>, Vec<String>), String> {
    let base_remote = normalize_remote_path(remote_target_dir);
    let mut items = Vec::new();
    let mut dirs_to_create = Vec::new();
    let mut stack: Vec<(PathBuf, String)> = Vec::new();

    for raw in sources {
        let src = PathBuf::from(raw);
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| raw.clone());
        if options.exclude_hidden && is_local_hidden(&src, &name) {
            continue;
        }
        let target = join_remote_path(&base_remote, &name);
        stack.push((src, target));
    }

    while let Some((src_path, dst_path)) = stack.pop() {
        let meta = tokio::fs::metadata(&src_path)
            .await
            .map_err(|e| format!("Failed to read source {}: {}", src_path.display(), e))?;
        let name = src_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if meta.is_dir() {
            if !matches_transfer_mask(&name, true, &options.file_mask) {
                continue;
            }
            if !options.exclude_empty_dirs {
                dirs_to_create.push(dst_path.clone());
            }
            let mut rd = tokio::fs::read_dir(&src_path)
                .await
                .map_err(|e| format!("Failed reading directory {}: {}", src_path.display(), e))?;
            let mut children = Vec::new();
            while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
                let child_path = entry.path();
                let child_name = entry.file_name().to_string_lossy().to_string();
                if options.exclude_hidden && is_local_hidden(&child_path, &child_name) {
                    continue;
                }
                let child_target = join_remote_path(&dst_path, &child_name);
                children.push((child_path, child_target));
            }
            children.reverse();
            stack.extend(children);
        } else {
            if !matches_transfer_mask(&name, false, &options.file_mask) {
                continue;
            }
            let mtime = system_time_to_ms(meta.modified().ok());
            items.push(build_transfer_item(
                batch_id,
                src_path.to_string_lossy().to_string(),
                dst_path,
                name,
                meta.len(),
                mtime,
                options,
            ));
        }
    }

    for dir in dirs_to_create {
        let _ = remote_fs.ensure_dir_all(&dir).await;
    }

    let created_dirs_count = 0usize;
    let _ = created_dirs_count;
    Ok((items, Vec::new()))
}

async fn expand_download_sources_fs(
    batch_id: &str,
    sources: &[String],
    local_target_dir: &str,
    remote_fs: &AnyRemoteFs,
    options: &TransferOptions,
) -> Result<Vec<TransferItem>, String> {
    if let Some(sftp) = remote_fs.as_sftp() {
        return expand_download_sources(batch_id, sources, local_target_dir, sftp, options).await;
    }

    let base_local = PathBuf::from(local_target_dir);
    let mut items = Vec::new();
    let mut dirs_to_create: Vec<PathBuf> = Vec::new();
    let mut stack: Vec<(String, PathBuf)> = Vec::new();

    for raw in sources {
        let remote_src = normalize_remote_path(raw);
        let name = remote_src
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or("download")
            .to_string();
        if options.exclude_hidden && name.starts_with('.') {
            continue;
        }
        stack.push((remote_src, base_local.join(&name)));
    }

    while let Some((remote_src, local_dst)) = stack.pop() {
        let props = remote_fs.get_properties(&remote_src, false, None).await?;
        let is_dir = props.entry.file_type == "dir" || props.entry.file_type == "symlink_dir";
        let name = props.entry.name.clone();

        if is_dir {
            if !matches_transfer_mask(&name, true, &options.file_mask) {
                continue;
            }
            if !options.exclude_empty_dirs {
                dirs_to_create.push(local_dst.clone());
            }
            let listing = remote_fs.list_dir(&remote_src).await?;
            let mut children = Vec::new();
            for entry in listing.entries {
                if options.exclude_hidden && entry.name.starts_with('.') {
                    continue;
                }
                children.push((entry.path, local_dst.join(&entry.name)));
            }
            children.reverse();
            stack.extend(children);
        } else {
            if !matches_transfer_mask(&name, false, &options.file_mask) {
                continue;
            }
            items.push(build_transfer_item(
                batch_id,
                remote_src,
                local_dst.to_string_lossy().to_string(),
                name,
                props.entry.size,
                props.entry.modified_ms,
                options,
            ));
        }
    }

    for dir in dirs_to_create {
        let _ = tokio::fs::create_dir_all(&dir).await;
    }

    Ok(items)
}

async fn expand_download_sources(
    batch_id: &str,
    sources: &[String],
    local_target_dir: &str,
    sftp: &SftpSession,
    options: &TransferOptions,
) -> Result<Vec<TransferItem>, String> {
    let base_local = PathBuf::from(local_target_dir);
    let mut items = Vec::new();
    let mut dirs_to_create: Vec<PathBuf> = Vec::new();
    let mut stack: Vec<(String, PathBuf)> = Vec::new();

    for raw in sources {
        let remote_src = normalize_remote_path(raw);
        let name = remote_src
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or("download")
            .to_string();
        if options.exclude_hidden && name.starts_with('.') {
            continue;
        }
        let local_dst = base_local.join(&name);
        stack.push((remote_src, local_dst));
    }

    while let Some((remote_src, local_dst)) = stack.pop() {
        let meta = sftp
            .metadata(&remote_src)
            .await
            .map_err(|e| format!("Failed reading remote source {}: {}", remote_src, e))?;
        let name = remote_src
            .rsplit('/')
            .next()
            .unwrap_or("")
            .to_string();

        if meta.is_dir() {
            if !matches_transfer_mask(&name, true, &options.file_mask) {
                continue;
            }
            if !options.exclude_empty_dirs {
                dirs_to_create.push(local_dst.clone());
            }
            let read_dir = sftp
                .read_dir(&remote_src)
                .await
                .map_err(|e| format!("Failed listing remote directory {}: {}", remote_src, e))?;
            let mut children = Vec::new();
            for entry in read_dir {
                let child_name = entry.file_name();
                if child_name == "." || child_name == ".." || child_name.is_empty() {
                    continue;
                }
                if options.exclude_hidden && child_name.starts_with('.') {
                    continue;
                }
                children.push((
                    join_remote_path(&remote_src, &child_name),
                    local_dst.join(&child_name),
                ));
            }
            children.reverse();
            stack.extend(children);
        } else {
            if !matches_transfer_mask(&name, false, &options.file_mask) {
                continue;
            }
            let mtime = meta.mtime.map(|s| (s as u64) * 1000);
            items.push(build_transfer_item(
                batch_id,
                remote_src,
                local_dst.to_string_lossy().to_string(),
                name,
                meta.len(),
                mtime,
                options,
            ));
        }
    }

    for dir in dirs_to_create {
        let _ = tokio::fs::create_dir_all(&dir).await;
    }

    Ok(items)
}

async fn expand_local_sources(
    batch_id: &str,
    sources: &[String],
    local_target_dir: &str,
    options: &TransferOptions,
) -> Result<Vec<TransferItem>, String> {
    let base_local = PathBuf::from(local_target_dir);
    let mut items = Vec::new();
    let mut dirs_to_create: Vec<PathBuf> = Vec::new();
    let mut stack: Vec<(PathBuf, PathBuf)> = Vec::new();

    for raw in sources {
        let src = PathBuf::from(raw);
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| raw.clone());
        if options.exclude_hidden && is_local_hidden(&src, &name) {
            continue;
        }
        let dst = base_local.join(&name);
        stack.push((src, dst));
    }

    while let Some((src_path, dst_path)) = stack.pop() {
        let meta = tokio::fs::metadata(&src_path)
            .await
            .map_err(|e| format!("Failed reading {}: {}", src_path.display(), e))?;
        let name = src_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if meta.is_dir() {
            if !matches_transfer_mask(&name, true, &options.file_mask) {
                continue;
            }
            if !options.exclude_empty_dirs {
                dirs_to_create.push(dst_path.clone());
            }
            let mut rd = tokio::fs::read_dir(&src_path)
                .await
                .map_err(|e| format!("Failed reading directory {}: {}", src_path.display(), e))?;
            let mut children = Vec::new();
            while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
                let child_path = entry.path();
                let child_name = entry.file_name().to_string_lossy().to_string();
                if options.exclude_hidden && is_local_hidden(&child_path, &child_name) {
                    continue;
                }
                children.push((child_path, dst_path.join(&child_name)));
            }
            children.reverse();
            stack.extend(children);
        } else {
            if !matches_transfer_mask(&name, false, &options.file_mask) {
                continue;
            }
            let mtime = system_time_to_ms(meta.modified().ok());
            items.push(build_transfer_item(
                batch_id,
                src_path.to_string_lossy().to_string(),
                dst_path.to_string_lossy().to_string(),
                name,
                meta.len(),
                mtime,
                options,
            ));
        }
    }

    for dir in dirs_to_create {
        let _ = tokio::fs::create_dir_all(&dir).await;
    }

    Ok(items)
}

async fn emit_snapshot(app: &AppHandle, inner: &Arc<AsyncMutex<TransferQueueState>>) {
    let snap = {
        let guard = inner.lock().await;
        guard.snapshot()
    };
    let _ = app.emit("transfer://queue-updated", &snap);
}

async fn scheduler_loop(
    app: AppHandle,
    inner: Arc<AsyncMutex<TransferQueueState>>,
    controls: Arc<StdMutex<HashMap<String, Arc<TaskControl>>>>,
    waiters: Arc<AsyncMutex<HashMap<String, oneshot::Sender<ConflictResolution>>>>,
    wake: Arc<Notify>,
) {
    loop {
        loop {
            let claimed = {
                let mut guard = inner.lock().await;
                guard.claim_next_queued()
            };
            let Some(item) = claimed else {
                break;
            };

            let ctrl = Arc::new(TaskControl::default());
            if let Ok(mut cguard) = controls.lock() {
                cguard.insert(item.id.clone(), ctrl.clone());
            }
            emit_snapshot(&app, &inner).await;

            let app_clone = app.clone();
            let inner_clone = inner.clone();
            let controls_clone = controls.clone();
            let waiters_clone = waiters.clone();
            let wake_clone = wake.clone();
            tokio::spawn(async move {
                run_transfer_worker(
                    app_clone.clone(),
                    item.clone(),
                    ctrl,
                    inner_clone.clone(),
                    waiters_clone,
                )
                .await;

                if let Ok(mut cguard) = controls_clone.lock() {
                    cguard.remove(&item.id);
                }
                emit_snapshot(&app_clone, &inner_clone).await;
                wake_clone.notify_one();
            });
        }

        wake.notified().await;
    }
}

enum ResolvedTransferPlan {
    Proceed {
        final_target: String,
        resume_offset: u64,
        append_existing_target: bool,
    },
    Skip,
    Cancel,
}

async fn inspect_and_resolve_destination(
    app: &AppHandle,
    item: &TransferItem,
    is_text_mode: bool,
    remote_opt: Option<&AnyRemoteFs>,
    inner: &Arc<AsyncMutex<TransferQueueState>>,
    waiters: &Arc<AsyncMutex<HashMap<String, oneshot::Sender<ConflictResolution>>>>,
) -> Result<ResolvedTransferPlan, String> {
    let mut final_target = item.target_path.clone();
    let filepart_path = to_filepart_path(&final_target);

    let (target_exists, target_size, target_mtime_ms, has_filepart, filepart_size) =
        match item.direction {
            TransferDirection::Upload => {
                let remote_fs = remote_opt.ok_or_else(|| "Missing active remote session".to_string())?;
                if let Some(sftp) = remote_fs.as_sftp() {
                    let tgt_meta = sftp.metadata(&final_target).await.ok();
                    let fp_meta = if item.options.use_filepart {
                        sftp.metadata(&filepart_path).await.ok()
                    } else {
                        None
                    };
                    (
                        tgt_meta.is_some(),
                        tgt_meta.as_ref().map(|m| m.len()).unwrap_or(0),
                        tgt_meta.as_ref().and_then(|m| m.mtime.map(|s| (s as u64) * 1000)),
                        fp_meta.is_some(),
                        fp_meta.as_ref().map(|m| m.len()).unwrap_or(0),
                    )
                } else {
                    let parent = match final_target.rfind('/') {
                        Some(0) => "/",
                        Some(idx) => &final_target[..idx],
                        None => "/",
                    };
                    let existing = remote_fs
                        .list_dir(parent)
                        .await
                        .ok()
                        .and_then(|l| l.entries.into_iter().find(|e| e.path == final_target));
                    (
                        existing.is_some(),
                        existing.as_ref().map(|e| e.size).unwrap_or(0),
                        existing.as_ref().and_then(|e| e.modified_ms),
                        false,
                        0,
                    )
                }
            }
            TransferDirection::Download | TransferDirection::LocalCopy => {
                let tgt_meta = tokio::fs::metadata(&final_target).await.ok();
                let fp_meta = if item.options.use_filepart {
                    tokio::fs::metadata(&filepart_path).await.ok()
                } else {
                    None
                };
                (
                    tgt_meta.is_some(),
                    tgt_meta.as_ref().map(|m| m.len()).unwrap_or(0),
                    tgt_meta
                        .as_ref()
                        .and_then(|m| system_time_to_ms(m.modified().ok())),
                    fp_meta.is_some(),
                    fp_meta.as_ref().map(|m| m.len()).unwrap_or(0),
                )
            }
        };

    if !target_exists && !has_filepart {
        return Ok(ResolvedTransferPlan::Proceed {
            final_target,
            resume_offset: 0,
            append_existing_target: false,
        });
    }

    if item.options.newer_only
        && target_exists
        && should_skip_newer_only(item.source_mtime_ms, target_mtime_ms)
    {
        return Ok(ResolvedTransferPlan::Skip);
    }

    let policy = {
        let guard = inner.lock().await;
        guard
            .batch_policies
            .get(&item.batch_id)
            .cloned()
            .unwrap_or_else(|| item.options.overwrite_policy.clone())
    };

    let resolution = match policy.as_str() {
        "overwrite" | "overwrite_all" => ConflictResolution::Overwrite,
        "resume" | "resume_all" => ConflictResolution::Resume,
        "rename" | "rename_all" => ConflictResolution::Rename,
        "newer_only" => ConflictResolution::NewerOnly,
        "skip" | "skip_all" => ConflictResolution::Skip,
        _ => {
            let prompt = ConflictPrompt {
                item_id: item.id.clone(),
                batch_id: item.batch_id.clone(),
                direction: item.direction,
                file_name: item.file_name.clone(),
                source_path: item.source_path.clone(),
                target_path: final_target.clone(),
                source_size: item.total_bytes,
                target_size,
                source_mtime_ms: item.source_mtime_ms,
                target_mtime_ms,
                has_filepart,
                filepart_size,
            };
            let (tx, rx) = oneshot::channel();
            {
                let mut wguard = waiters.lock().await;
                wguard.insert(item.id.clone(), tx);
            }
            {
                let mut qguard = inner.lock().await;
                if let Some(it) = qguard.find_item_mut(&item.id) {
                    it.status = TransferTaskStatus::Conflict;
                    it.speed_bps = 0;
                }
                qguard.pending_conflicts.push(prompt);
            }
            emit_snapshot(app, inner).await;

            let answer = rx.await.unwrap_or(ConflictResolution::Cancel);
            {
                let mut qguard = inner.lock().await;
                qguard.pending_conflicts.retain(|c| c.item_id != item.id);
                if let Some(it) = qguard.find_item_mut(&item.id) {
                    if it.status == TransferTaskStatus::Conflict {
                        it.status = TransferTaskStatus::Running;
                    }
                }
                match answer {
                    ConflictResolution::OverwriteAll => {
                        qguard
                            .batch_policies
                            .insert(item.batch_id.clone(), "overwrite_all".to_string());
                    }
                    ConflictResolution::ResumeAll => {
                        qguard
                            .batch_policies
                            .insert(item.batch_id.clone(), "resume_all".to_string());
                    }
                    ConflictResolution::RenameAll => {
                        qguard
                            .batch_policies
                            .insert(item.batch_id.clone(), "rename_all".to_string());
                    }
                    ConflictResolution::SkipAll => {
                        qguard
                            .batch_policies
                            .insert(item.batch_id.clone(), "skip_all".to_string());
                    }
                    _ => {}
                }
            }
            emit_snapshot(app, inner).await;
            answer
        }
    };

    match resolution {
        ConflictResolution::Overwrite | ConflictResolution::OverwriteAll => {
            Ok(ResolvedTransferPlan::Proceed {
                final_target,
                resume_offset: 0,
                append_existing_target: false,
            })
        }
        ConflictResolution::Resume | ConflictResolution::ResumeAll => {
            if is_text_mode {
                Ok(ResolvedTransferPlan::Proceed {
                    final_target,
                    resume_offset: 0,
                    append_existing_target: false,
                })
            } else if has_filepart && filepart_size > 0 && filepart_size <= item.total_bytes {
                if filepart_size == item.total_bytes {
                    Ok(ResolvedTransferPlan::Proceed {
                        final_target,
                        resume_offset: filepart_size,
                        append_existing_target: false,
                    })
                } else {
                    Ok(ResolvedTransferPlan::Proceed {
                        final_target,
                        resume_offset: filepart_size,
                        append_existing_target: false,
                    })
                }
            } else if target_exists && target_size > 0 && target_size < item.total_bytes {
                Ok(ResolvedTransferPlan::Proceed {
                    final_target,
                    resume_offset: target_size,
                    append_existing_target: true,
                })
            } else if target_exists && target_size == item.total_bytes {
                Ok(ResolvedTransferPlan::Skip)
            } else {
                Ok(ResolvedTransferPlan::Proceed {
                    final_target,
                    resume_offset: 0,
                    append_existing_target: false,
                })
            }
        }
        ConflictResolution::Rename | ConflictResolution::RenameAll => {
            final_target = match item.direction {
                TransferDirection::Upload => {
                    let remote_fs = remote_opt.ok_or_else(|| "Missing active remote session".to_string())?;
                    next_available_remote_path_fs(remote_fs, &final_target).await
                }
                TransferDirection::Download | TransferDirection::LocalCopy => {
                    next_available_local_path(Path::new(&final_target))
                        .to_string_lossy()
                        .to_string()
                }
            };
            let new_name = final_target
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(&item.file_name)
                .to_string();
            {
                let mut qguard = inner.lock().await;
                if let Some(it) = qguard.find_item_mut(&item.id) {
                    it.target_path = final_target.clone();
                    it.file_name = new_name;
                }
            }
            Ok(ResolvedTransferPlan::Proceed {
                final_target,
                resume_offset: 0,
                append_existing_target: false,
            })
        }
        ConflictResolution::NewerOnly => {
            if target_exists && should_skip_newer_only(item.source_mtime_ms, target_mtime_ms) {
                Ok(ResolvedTransferPlan::Skip)
            } else {
                Ok(ResolvedTransferPlan::Proceed {
                    final_target,
                    resume_offset: 0,
                    append_existing_target: false,
                })
            }
        }
        ConflictResolution::Skip | ConflictResolution::SkipAll => Ok(ResolvedTransferPlan::Skip),
        ConflictResolution::Cancel => Ok(ResolvedTransferPlan::Cancel),
    }
}

pub async fn apply_local_timestamp(path: &Path, mtime_ms: Option<u64>) {
    if let Some(ms) = mtime_ms {
        let target_time = UNIX_EPOCH + Duration::from_millis(ms);
        if let Ok(file) = fs::OpenOptions::new().write(true).open(path) {
            let _ = file.set_modified(target_time);
        }
    }
}

async fn apply_remote_post_metadata(
    sftp: &SftpSession,
    remote_path: &str,
    options: &TransferOptions,
    source_mtime_ms: Option<u64>,
) {
    let mut attrs = FileAttributes::empty();
    let mut changed = false;

    if options.preserve_timestamp {
        if let Some(ms) = source_mtime_ms {
            let secs = (ms / 1000) as u32;
            attrs.atime = Some(secs);
            attrs.mtime = Some(secs);
            changed = true;
        }
    }
    if options.preserve_rights {
        if let Some(ref octal) = options.octal_rights {
            if let Ok(mode) = parse_octal_mode(octal) {
                attrs.permissions = Some(mode);
                changed = true;
            }
        }
    }
    if changed {
        let _ = sftp.set_metadata(remote_path, attrs).await;
    }
}

#[derive(Debug)]
enum StreamOutcome {
    Completed,
    Cancelled,
    Skipped,
}

#[allow(clippy::too_many_arguments)]
async fn stream_copy<R, W>(
    app: &AppHandle,
    item: &TransferItem,
    ctrl: &Arc<TaskControl>,
    inner: &Arc<AsyncMutex<TransferQueueState>>,
    mut reader: R,
    mut writer: W,
    resume_offset: u64,
    is_text_mode: bool,
    eol_mode: Option<bool>, // Some(true) = CRLF->LF upload, Some(false) = LF->CRLF download, None = binary
) -> Result<StreamOutcome, String>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut bytes_done = resume_offset;
    let mut window_bytes: u64 = 0;
    let mut window_start = Instant::now();
    let mut last_emit = Instant::now();
    let mut pending_cr = false;
    let mut prev_was_cr = false;
    let mut is_first_chunk = resume_offset == 0;

    {
        let mut qguard = inner.lock().await;
        if let Some(it) = qguard.find_item_mut(&item.id) {
            it.transferred_bytes = resume_offset;
            it.resumed_from_bytes = resume_offset;
        }
    }

    loop {
        if ctrl.cancelled.load(Ordering::Relaxed) {
            return Ok(StreamOutcome::Cancelled);
        }
        if ctrl.skip_requested.load(Ordering::Relaxed) {
            return Ok(StreamOutcome::Skipped);
        }
        while ctrl.paused.load(Ordering::Relaxed) {
            if ctrl.cancelled.load(Ordering::Relaxed) {
                return Ok(StreamOutcome::Cancelled);
            }
            if ctrl.skip_requested.load(Ordering::Relaxed) {
                return Ok(StreamOutcome::Skipped);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        let n = reader
            .read(&mut buf)
            .await
            .map_err(|e| format!("Read failed during transfer: {}", e))?;

        if n == 0 {
            if is_text_mode && eol_mode == Some(true) {
                let tail = finish_crlf_to_lf(&mut pending_cr);
                if !tail.is_empty() {
                    writer
                        .write_all(&tail)
                        .await
                        .map_err(|e| format!("Write tail failed: {}", e))?;
                }
            }
            writer
                .flush()
                .await
                .map_err(|e| format!("Flush failed: {}", e))?;
            writer
                .shutdown()
                .await
                .map_err(|e| format!("Close/shutdown failed: {}", e))?;
            break;
        }

        let raw_chunk = &buf[..n];
        let trimmed_slice = if is_text_mode && item.options.remove_bom_eof {
            let s = strip_utf8_bom_and_eof_ctrl_z(raw_chunk, is_first_chunk, n < CHUNK_SIZE);
            is_first_chunk = false;
            s
        } else {
            is_first_chunk = false;
            raw_chunk
        };

        let converted;
        let out_slice: &[u8] = match eol_mode {
            Some(true) if is_text_mode => {
                converted = convert_crlf_to_lf_chunk(trimmed_slice, &mut pending_cr);
                &converted
            }
            Some(false) if is_text_mode => {
                converted = convert_lf_to_crlf_chunk(trimmed_slice, &mut prev_was_cr);
                &converted
            }
            _ => trimmed_slice,
        };

        if !out_slice.is_empty() {
            writer
                .write_all(out_slice)
                .await
                .map_err(|e| format!("Write failed during transfer: {}", e))?;
        }

        bytes_done = bytes_done.saturating_add(n as u64);
        window_bytes = window_bytes.saturating_add(n as u64);

        let (limit_kbps, active_workers) = {
            let guard = inner.lock().await;
            let limit = if item.options.speed_limit_kbps > 0 {
                item.options.speed_limit_kbps
            } else {
                guard.global_speed_limit_kbps
            };
            (limit, guard.running_count().max(1))
        };
        let delay_ms = compute_chunk_throttle_delay_ms(n, limit_kbps, active_workers);
        if delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }

        if last_emit.elapsed() >= EMIT_INTERVAL {
            let elapsed_secs = window_start.elapsed().as_secs_f64().max(0.05);
            let speed_bps = (window_bytes as f64 / elapsed_secs) as u64;
            let remaining = item.total_bytes.saturating_sub(bytes_done);
            let eta = compute_eta_seconds(remaining, speed_bps);
            {
                let mut qguard = inner.lock().await;
                if let Some(it) = qguard.find_item_mut(&item.id) {
                    it.transferred_bytes = bytes_done;
                    it.speed_bps = speed_bps;
                    it.eta_seconds = eta;
                }
            }
            emit_snapshot(app, inner).await;
            last_emit = Instant::now();
            if window_start.elapsed() >= Duration::from_secs(2) {
                window_bytes = 0;
                window_start = Instant::now();
            }
        }
    }

    {
        let mut qguard = inner.lock().await;
        if let Some(it) = qguard.find_item_mut(&item.id) {
            it.transferred_bytes = item.total_bytes.max(bytes_done);
            it.speed_bps = 0;
            it.eta_seconds = Some(0);
        }
    }

    Ok(StreamOutcome::Completed)
}

async fn run_transfer_worker(
    app: AppHandle,
    mut item: TransferItem,
    ctrl: Arc<TaskControl>,
    inner: Arc<AsyncMutex<TransferQueueState>>,
    waiters: Arc<AsyncMutex<HashMap<String, oneshot::Sender<ConflictResolution>>>>,
) {
    let is_text_mode = resolve_is_text_mode(
        item.options.transfer_mode,
        &item.file_name,
        &item.options.ascii_file_mask,
    );

    let remote_opt = if matches!(
        item.direction,
        TransferDirection::Upload | TransferDirection::Download
    ) {
        let Some(ref sid) = item.session_id else {
            let mut qguard = inner.lock().await;
            if let Some(it) = qguard.find_item_mut(&item.id) {
                it.status = TransferTaskStatus::Failed;
                it.error = Some("Missing session ID for remote transfer".to_string());
                it.finished_at_ms = Some(now_millis());
            }
            return;
        };
        let mgr = app.state::<SftpSessionManager>();
        match mgr.get_remote_fs(sid).await {
            Ok(fs) => Some(fs),
            Err(err) => {
                let mut qguard = inner.lock().await;
                if let Some(it) = qguard.find_item_mut(&item.id) {
                    it.status = TransferTaskStatus::Failed;
                    it.error = Some(err);
                    it.finished_at_ms = Some(now_millis());
                }
                return;
            }
        }
    } else {
        None
    };

    let plan = match inspect_and_resolve_destination(
        &app,
        &item,
        is_text_mode,
        remote_opt.as_ref(),
        &inner,
        &waiters,
    )
    .await
    {
        Ok(p) => p,
        Err(err) => {
            let mut qguard = inner.lock().await;
            if let Some(it) = qguard.find_item_mut(&item.id) {
                it.status = TransferTaskStatus::Failed;
                it.error = Some(err);
                it.finished_at_ms = Some(now_millis());
            }
            return;
        }
    };

    let (final_target, resume_offset, append_existing_target) = match plan {
        ResolvedTransferPlan::Proceed {
            final_target,
            resume_offset,
            append_existing_target,
        } => (final_target, resume_offset, append_existing_target),
        ResolvedTransferPlan::Skip => {
            let mut qguard = inner.lock().await;
            if let Some(it) = qguard.find_item_mut(&item.id) {
                it.status = TransferTaskStatus::Skipped;
                it.speed_bps = 0;
                it.finished_at_ms = Some(now_millis());
            }
            return;
        }
        ResolvedTransferPlan::Cancel => {
            let mut qguard = inner.lock().await;
            let batch_id = item.batch_id.clone();
            for it in &mut qguard.items {
                if it.batch_id == batch_id && !it.status.is_terminal() {
                    it.status = TransferTaskStatus::Cancelled;
                    it.speed_bps = 0;
                    it.finished_at_ms = Some(now_millis());
                }
            }
            return;
        }
    };
    item.target_path = final_target.clone();

    let use_filepart_write = item.options.use_filepart && !append_existing_target;
    let write_path = if use_filepart_write {
        to_filepart_path(&final_target)
    } else {
        final_target.clone()
    };

    let result: Result<StreamOutcome, String> = match item.direction {
        TransferDirection::Upload => {
            let remote_fs = remote_opt.as_ref().unwrap();
            if let Some(sftp) = remote_fs.as_sftp() {
                if let Some((parent, _)) = final_target.rsplit_once('/') {
                    if !parent.is_empty() {
                        let _ = ensure_remote_dir_all(sftp, parent).await;
                    }
                }
                async {
                    let mut src = tokio::fs::File::open(&item.source_path)
                        .await
                        .map_err(|e| format!("Failed opening source {}: {}", item.source_path, e))?;
                    if resume_offset > 0 {
                        src.seek(SeekFrom::Start(resume_offset))
                            .await
                            .map_err(|e| format!("Failed seeking local source: {}", e))?;
                    }

                    let flags = if resume_offset > 0 {
                        OpenFlags::CREATE | OpenFlags::WRITE
                    } else {
                        OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE
                    };
                    let mut dst = sftp
                        .open_with_flags(&write_path, flags)
                        .await
                        .map_err(|e| format!("Failed opening remote target {}: {}", write_path, e))?;
                    if resume_offset > 0 {
                        dst.seek(SeekFrom::Start(resume_offset))
                            .await
                            .map_err(|e| format!("Failed seeking remote .filepart: {}", e))?;
                    }

                    let outcome = stream_copy(
                        &app,
                        &item,
                        &ctrl,
                        &inner,
                        src,
                        dst,
                        resume_offset,
                        is_text_mode,
                        if is_text_mode { Some(true) } else { None },
                    )
                    .await?;

                    if matches!(outcome, StreamOutcome::Completed) {
                        if write_path != final_target {
                            if sftp.try_exists(&final_target).await.unwrap_or(false) {
                                let _ = sftp.remove_file(&final_target).await;
                            }
                            sftp.rename(&write_path, &final_target)
                                .await
                                .map_err(|e| format!("Failed renaming .filepart to target: {}", e))?;
                        }
                        apply_remote_post_metadata(
                            sftp,
                            &final_target,
                            &item.options,
                            item.source_mtime_ms,
                        )
                        .await;
                        if item.is_move {
                            let _ = tokio::fs::remove_file(&item.source_path).await;
                        }
                    }
                    Ok(outcome)
                }
                .await
            } else {
                async {
                    if let Some((parent, _)) = final_target.rsplit_once('/') {
                        if !parent.is_empty() {
                            let _ = remote_fs.ensure_dir_all(parent).await;
                        }
                    }
                    let raw = tokio::fs::read(&item.source_path)
                        .await
                        .map_err(|e| format!("Failed opening source {}: {}", item.source_path, e))?;
                    let payload = if is_text_mode {
                        transform_text_payload_all(&raw, item.options.remove_bom_eof, true)
                    } else {
                        raw
                    };
                    remote_fs
                        .write_bytes(&final_target, &payload, item.source_mtime_ms)
                        .await?;
                    {
                        let mut qguard = inner.lock().await;
                        if let Some(it) = qguard.find_item_mut(&item.id) {
                            it.transferred_bytes = item.total_bytes.max(payload.len() as u64);
                            it.eta_seconds = Some(0);
                        }
                    }
                    if item.is_move {
                        let _ = tokio::fs::remove_file(&item.source_path).await;
                    }
                    Ok(StreamOutcome::Completed)
                }
                .await
            }
        }
        TransferDirection::Download => {
            let remote_fs = remote_opt.as_ref().unwrap();
            if let Some(parent) = Path::new(&final_target).parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            if let Some(sftp) = remote_fs.as_sftp() {
                async {
                    let mut src = sftp
                        .open_with_flags(&item.source_path, OpenFlags::READ)
                        .await
                        .map_err(|e| format!("Failed opening remote file {}: {}", item.source_path, e))?;
                    if resume_offset > 0 {
                        src.seek(SeekFrom::Start(resume_offset))
                            .await
                            .map_err(|e| format!("Failed seeking remote source: {}", e))?;
                    }

                    let mut opts = tokio::fs::OpenOptions::new();
                    opts.create(true).write(true);
                    if resume_offset == 0 {
                        opts.truncate(true);
                    }
                    let mut dst = opts
                        .open(&write_path)
                        .await
                        .map_err(|e| format!("Failed opening local file {}: {}", write_path, e))?;
                    if resume_offset > 0 {
                        dst.seek(SeekFrom::Start(resume_offset))
                            .await
                            .map_err(|e| format!("Failed seeking local .filepart: {}", e))?;
                    }

                    let outcome = stream_copy(
                        &app,
                        &item,
                        &ctrl,
                        &inner,
                        src,
                        dst,
                        resume_offset,
                        is_text_mode,
                        if is_text_mode { Some(false) } else { None },
                    )
                    .await?;

                    if matches!(outcome, StreamOutcome::Completed) {
                        if write_path != final_target {
                            let dst_path = Path::new(&final_target);
                            if dst_path.exists() {
                                let _ = tokio::fs::remove_file(dst_path).await;
                            }
                            tokio::fs::rename(&write_path, &final_target)
                                .await
                                .map_err(|e| format!("Failed finalizing download {}: {}", final_target, e))?;
                        }
                        if item.options.preserve_timestamp {
                            apply_local_timestamp(Path::new(&final_target), item.source_mtime_ms).await;
                        }
                        if item.is_move {
                            let _ = sftp.remove_file(&item.source_path).await;
                        }
                    }
                    Ok(outcome)
                }
                .await
            } else {
                async {
                    let (raw, mtime_opt) = remote_fs.read_bytes(&item.source_path, None).await?;
                    let payload = if is_text_mode {
                        transform_text_payload_all(&raw, item.options.remove_bom_eof, false)
                    } else {
                        raw
                    };
                    tokio::fs::write(&final_target, &payload)
                        .await
                        .map_err(|e| format!("Failed writing local file {}: {}", final_target, e))?;
                    {
                        let mut qguard = inner.lock().await;
                        if let Some(it) = qguard.find_item_mut(&item.id) {
                            it.transferred_bytes = item.total_bytes.max(payload.len() as u64);
                            it.eta_seconds = Some(0);
                        }
                    }
                    if item.options.preserve_timestamp {
                        apply_local_timestamp(
                            Path::new(&final_target),
                            item.source_mtime_ms.or(mtime_opt),
                        )
                        .await;
                    }
                    if item.is_move {
                        let _ = remote_fs.delete(&[item.source_path.clone()]).await;
                    }
                    Ok(StreamOutcome::Completed)
                }
                .await
            }
        }
        TransferDirection::LocalCopy => {
            if let Some(parent) = Path::new(&final_target).parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            async {
                let mut src = tokio::fs::File::open(&item.source_path)
                    .await
                    .map_err(|e| format!("Failed opening local source {}: {}", item.source_path, e))?;
                if resume_offset > 0 {
                    src.seek(SeekFrom::Start(resume_offset))
                        .await
                        .map_err(|e| format!("Failed seeking source: {}", e))?;
                }

                let mut opts = tokio::fs::OpenOptions::new();
                opts.create(true).write(true);
                if resume_offset == 0 {
                    opts.truncate(true);
                }
                let mut dst = opts
                    .open(&write_path)
                    .await
                    .map_err(|e| format!("Failed opening target {}: {}", write_path, e))?;
                if resume_offset > 0 {
                    dst.seek(SeekFrom::Start(resume_offset))
                        .await
                        .map_err(|e| format!("Failed seeking target: {}", e))?;
                }

                let outcome = stream_copy(
                    &app,
                    &item,
                    &ctrl,
                    &inner,
                    src,
                    dst,
                    resume_offset,
                    false,
                    None,
                )
                .await?;

                if matches!(outcome, StreamOutcome::Completed) {
                    if write_path != final_target {
                        let dst_path = Path::new(&final_target);
                        if dst_path.exists() {
                            let _ = tokio::fs::remove_file(dst_path).await;
                        }
                        tokio::fs::rename(&write_path, &final_target)
                            .await
                            .map_err(|e| format!("Failed finalizing local copy {}: {}", final_target, e))?;
                    }
                    if item.options.preserve_timestamp {
                        apply_local_timestamp(Path::new(&final_target), item.source_mtime_ms).await;
                    }
                    if item.is_move {
                        let _ = tokio::fs::remove_file(&item.source_path).await;
                    }
                }
                Ok(outcome)
            }
            .await
        }
    };

    let mut qguard = inner.lock().await;
    if let Some(it) = qguard.find_item_mut(&item.id) {
        it.speed_bps = 0;
        it.finished_at_ms = Some(now_millis());
        match result {
            Ok(StreamOutcome::Completed) => {
                it.status = TransferTaskStatus::Completed;
                it.eta_seconds = Some(0);
            }
            Ok(StreamOutcome::Skipped) => {
                it.status = TransferTaskStatus::Skipped;
            }
            Ok(StreamOutcome::Cancelled) => {
                it.status = TransferTaskStatus::Cancelled;
            }
            Err(err) => {
                it.status = TransferTaskStatus::Failed;
                it.error = Some(err);
            }
        }
    }
}

#[tauri::command]
pub async fn transfer_enqueue(
    app: AppHandle,
    engine: State<'_, TransferEngine>,
    sftp_mgr: State<'_, SftpSessionManager>,
    request: EnqueueTransferRequest,
) -> Result<String, String> {
    if request.sources.is_empty() {
        return Err("No source files selected".to_string());
    }
    let batch_id = new_id("batch");

    let items = match request.options.direction {
        TransferDirection::Upload => {
            let sid = request
                .options
                .session_id
                .as_deref()
                .ok_or_else(|| "Active remote session required for upload".to_string())?;
            let remote_fs = sftp_mgr.get_remote_fs(sid).await?;
            let (items, _) = expand_upload_sources(
                &batch_id,
                &request.sources,
                &request.target_dir,
                &remote_fs,
                &request.options,
            )
            .await?;
            items
        }
        TransferDirection::Download => {
            let sid = request
                .options
                .session_id
                .as_deref()
                .ok_or_else(|| "Active remote session required for download".to_string())?;
            let remote_fs = sftp_mgr.get_remote_fs(sid).await?;
            expand_download_sources_fs(
                &batch_id,
                &request.sources,
                &request.target_dir,
                &remote_fs,
                &request.options,
            )
            .await?
        }
        TransferDirection::LocalCopy => {
            expand_local_sources(
                &batch_id,
                &request.sources,
                &request.target_dir,
                &request.options,
            )
            .await?
        }
    };

    if items.is_empty() {
        return Err("No matching files found for the selected mask/filter".to_string());
    }

    {
        let mut guard = engine.inner.lock().await;
        guard.enqueue(items);
    }
    emit_snapshot(&app, &engine.inner).await;
    engine.ensure_scheduler(app).await;
    Ok(batch_id)
}

#[tauri::command]
pub async fn transfer_get_snapshot(
    engine: State<'_, TransferEngine>,
) -> Result<TransferQueueSnapshot, String> {
    let guard = engine.inner.lock().await;
    Ok(guard.snapshot())
}

#[tauri::command]
pub async fn transfer_control_item(
    app: AppHandle,
    engine: State<'_, TransferEngine>,
    item_id: String,
    action: String,
) -> Result<(), String> {
    let has_active_ctrl = {
        let cguard = engine.controls.lock().map_err(|_| "Control lock poisoned")?;
        cguard.get(&item_id).cloned()
    };

    match action.as_str() {
        "pause" => {
            if let Some(ctrl) = has_active_ctrl {
                ctrl.paused.store(true, Ordering::Relaxed);
                let mut guard = engine.inner.lock().await;
                if let Some(it) = guard.find_item_mut(&item_id) {
                    if it.status == TransferTaskStatus::Running {
                        it.status = TransferTaskStatus::Paused;
                        it.speed_bps = 0;
                    }
                }
            } else {
                let mut guard = engine.inner.lock().await;
                guard.set_item_paused(&item_id, true);
            }
        }
        "resume" => {
            if let Some(ctrl) = has_active_ctrl {
                let mut guard = engine.inner.lock().await;
                if let Some(it) = guard.find_item_mut(&item_id) {
                    if it.status == TransferTaskStatus::Paused {
                        it.status = TransferTaskStatus::Running;
                    }
                }
                ctrl.paused.store(false, Ordering::Relaxed);
            } else {
                let mut guard = engine.inner.lock().await;
                guard.set_item_paused(&item_id, false);
            }
        }
        "skip" => {
            if let Some(tx) = engine.conflict_waiters.lock().await.remove(&item_id) {
                let _ = tx.send(ConflictResolution::Skip);
            } else if let Some(ctrl) = has_active_ctrl {
                ctrl.skip_requested.store(true, Ordering::Relaxed);
                ctrl.paused.store(false, Ordering::Relaxed);
            } else {
                let mut guard = engine.inner.lock().await;
                if let Some(it) = guard.find_item_mut(&item_id) {
                    if !it.status.is_terminal() {
                        it.status = TransferTaskStatus::Skipped;
                        it.finished_at_ms = Some(now_millis());
                    }
                }
            }
        }
        "cancel" => {
            if let Some(tx) = engine.conflict_waiters.lock().await.remove(&item_id) {
                let _ = tx.send(ConflictResolution::Cancel);
            } else if let Some(ctrl) = has_active_ctrl {
                ctrl.cancelled.store(true, Ordering::Relaxed);
                ctrl.paused.store(false, Ordering::Relaxed);
            } else {
                let mut guard = engine.inner.lock().await;
                guard.set_item_cancelled(&item_id);
            }
        }
        "retry" => {
            let mut guard = engine.inner.lock().await;
            guard.retry_item(&item_id);
        }
        "remove" => {
            let mut guard = engine.inner.lock().await;
            guard.remove_item(&item_id);
        }
        other => return Err(format!("Unknown transfer action: {}", other)),
    }

    emit_snapshot(&app, &engine.inner).await;
    engine.ensure_scheduler(app).await;
    Ok(())
}

#[tauri::command]
pub async fn transfer_control_all(
    app: AppHandle,
    engine: State<'_, TransferEngine>,
    action: String,
    batch_id: Option<String>,
) -> Result<(), String> {
    let target_ids: Vec<String> = {
        let guard = engine.inner.lock().await;
        guard
            .items
            .iter()
            .filter(|it| batch_id.as_ref().is_none_or(|b| &it.batch_id == b))
            .map(|it| it.id.clone())
            .collect()
    };

    match action.as_str() {
        "pause_all" => {
            for id in target_ids {
                let ctrl_opt = engine
                    .controls
                    .lock()
                    .ok()
                    .and_then(|g| g.get(&id).cloned());
                if let Some(ctrl) = ctrl_opt {
                    ctrl.paused.store(true, Ordering::Relaxed);
                    let mut guard = engine.inner.lock().await;
                    if let Some(it) = guard.find_item_mut(&id) {
                        if it.status == TransferTaskStatus::Running {
                            it.status = TransferTaskStatus::Paused;
                            it.speed_bps = 0;
                        }
                    }
                } else {
                    let mut guard = engine.inner.lock().await;
                    guard.set_item_paused(&id, true);
                }
            }
        }
        "resume_all" => {
            for id in target_ids {
                let ctrl_opt = engine
                    .controls
                    .lock()
                    .ok()
                    .and_then(|g| g.get(&id).cloned());
                if let Some(ctrl) = ctrl_opt {
                    let mut guard = engine.inner.lock().await;
                    if let Some(it) = guard.find_item_mut(&id) {
                        if it.status == TransferTaskStatus::Paused {
                            it.status = TransferTaskStatus::Running;
                        }
                    }
                    ctrl.paused.store(false, Ordering::Relaxed);
                } else {
                    let mut guard = engine.inner.lock().await;
                    guard.set_item_paused(&id, false);
                }
            }
        }
        "cancel_all" => {
            for id in target_ids {
                if let Some(tx) = engine.conflict_waiters.lock().await.remove(&id) {
                    let _ = tx.send(ConflictResolution::Cancel);
                }
                let ctrl_opt = engine
                    .controls
                    .lock()
                    .ok()
                    .and_then(|g| g.get(&id).cloned());
                if let Some(ctrl) = ctrl_opt {
                    ctrl.cancelled.store(true, Ordering::Relaxed);
                    ctrl.paused.store(false, Ordering::Relaxed);
                } else {
                    let mut guard = engine.inner.lock().await;
                    guard.set_item_cancelled(&id);
                }
            }
        }
        "clear_finished" => {
            let mut guard = engine.inner.lock().await;
            guard.clear_finished();
        }
        other => return Err(format!("Unknown batch action: {}", other)),
    }

    emit_snapshot(&app, &engine.inner).await;
    engine.ensure_scheduler(app).await;
    Ok(())
}

#[tauri::command]
pub async fn transfer_resolve_conflict(
    app: AppHandle,
    engine: State<'_, TransferEngine>,
    item_id: String,
    resolution: ConflictResolution,
) -> Result<(), String> {
    let tx = {
        let mut wguard = engine.conflict_waiters.lock().await;
        wguard.remove(&item_id)
    };
    if let Some(sender) = tx {
        let _ = sender.send(resolution);
    }
    emit_snapshot(&app, &engine.inner).await;
    Ok(())
}

#[tauri::command]
pub async fn transfer_update_settings(
    app: AppHandle,
    engine: State<'_, TransferEngine>,
    max_concurrent: Option<usize>,
    global_speed_limit_kbps: Option<u64>,
) -> Result<TransferQueueSnapshot, String> {
    let snap = {
        let mut guard = engine.inner.lock().await;
        if let Some(mc) = max_concurrent {
            guard.max_concurrent = mc.clamp(1, 8);
        }
        if let Some(limit) = global_speed_limit_kbps {
            guard.global_speed_limit_kbps = limit;
        }
        guard.snapshot()
    };
    emit_snapshot(&app, &engine.inner).await;
    engine.ensure_scheduler(app).await;
    Ok(snap)
}
