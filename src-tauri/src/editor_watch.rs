use crate::fs_trait::RemoteFileSystem;
use crate::sftp::manager::SftpSessionManager;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::sync::{watch, Mutex};

const MAX_EDITOR_FILE_SIZE: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorOpenRequest {
    pub pane: String,
    pub session_id: Option<String>,
    pub path: String,
    pub is_remote: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorDocument {
    pub doc_id: String,
    pub pane: String,
    pub session_id: Option<String>,
    pub path: String,
    pub file_name: String,
    pub is_remote: bool,
    pub local_temp_path: String,
    pub content: String,
    pub encoding: String,
    pub line_ending: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
    pub watching_external: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSaveRequest {
    pub doc_id: String,
    pub content: String,
    pub encoding: String,
    pub line_ending: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSaveResult {
    pub doc_id: String,
    pub path: String,
    pub is_remote: bool,
    pub bytes_written: u64,
    pub saved_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorExternalSyncEvent {
    pub doc_id: String,
    pub path: String,
    pub is_remote: bool,
    pub bytes_written: u64,
    pub saved_at_ms: u64,
    pub content: String,
    pub status: String,
    pub detail: String,
}

struct WatchedDocEntry {
    doc: EditorDocument,
    last_sha256: String,
    last_mtime_ms: Option<u64>,
    watch_cancel_tx: Option<watch::Sender<bool>>,
}

#[derive(Default)]
pub struct EditorWatchManager {
    docs: Arc<Mutex<HashMap<String, WatchedDocEntry>>>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

pub fn decode_text_bytes(raw: &[u8]) -> (String, String, String) {
    let (encoding, text_raw) = if let Some(rest) = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        ("UTF-8-BOM".to_string(), String::from_utf8_lossy(rest).into_owned())
    } else {
        match std::str::from_utf8(raw) {
            Ok(s) => ("UTF-8".to_string(), s.to_string()),
            Err(_) => (
                "Latin-1".to_string(),
                raw.iter().map(|&b| b as char).collect::<String>(),
            ),
        }
    };

    let crlf_count = text_raw.matches("\r\n").count();
    let total_lf = text_raw.bytes().filter(|&b| b == b'\n').count();
    let line_ending = if crlf_count > 0 && crlf_count * 2 >= total_lf.max(1) {
        "CRLF".to_string()
    } else {
        "LF".to_string()
    };

    let normalized = text_raw.replace("\r\n", "\n").replace('\r', "\n");
    (normalized, encoding, line_ending)
}

pub fn encode_text_bytes(content: &str, encoding: &str, line_ending: &str) -> Vec<u8> {
    let lf_text = content.replace("\r\n", "\n").replace('\r', "\n");
    let eol_text = if line_ending.eq_ignore_ascii_case("CRLF") {
        lf_text.replace('\n', "\r\n")
    } else {
        lf_text
    };

    if encoding.eq_ignore_ascii_case("UTF-8-BOM") {
        let mut out = Vec::with_capacity(3 + eol_text.len());
        out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        out.extend_from_slice(eol_text.as_bytes());
        out
    } else if encoding.eq_ignore_ascii_case("Latin-1") {
        eol_text
            .chars()
            .map(|ch| if (ch as u32) <= 0xFF { ch as u8 } else { b'?' })
            .collect()
    } else {
        eol_text.into_bytes()
    }
}

fn make_doc_id(is_remote: bool, session_id: Option<&str>, path: &str) -> String {
    let key = format!(
        "{}:{}:{}",
        if is_remote { "sftp" } else { "local" },
        session_id.unwrap_or("local"),
        path
    );
    let digest = sha256_hex(key.as_bytes());
    format!("doc_{}", &digest[..16])
}

fn sanitize_segment(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "default".to_string()
    } else {
        cleaned
    }
}

fn file_name_from_path(path: &str, is_remote: bool) -> String {
    if is_remote {
        path.rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or("untitled.txt")
            .to_string()
    } else {
        Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "untitled.txt".to_string())
    }
}

fn local_mtime_ms(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

async fn read_source_bytes(
    sftp_manager: &SftpSessionManager,
    session_id: Option<&str>,
    path: &str,
    is_remote: bool,
) -> Result<(Vec<u8>, Option<u64>), String> {
    if is_remote {
        let sid = session_id.ok_or_else(|| "Missing remote sessionId for remote file".to_string())?;
        let remote_fs = sftp_manager.get_remote_fs(sid).await?;
        remote_fs.read_bytes(path, Some(MAX_EDITOR_FILE_SIZE)).await
    } else {
        let local_path = Path::new(path);
        let meta = tokio::fs::metadata(local_path)
            .await
            .map_err(|e| format!("Failed inspecting local file {}: {}", path, e))?;
        if meta.len() > MAX_EDITOR_FILE_SIZE {
            return Err(format!(
                "Local file {} ({} bytes) exceeds 10 MB built-in editor limit",
                path,
                meta.len()
            ));
        }
        let buf = tokio::fs::read(local_path)
            .await
            .map_err(|e| format!("Failed reading local file {}: {}", path, e))?;
        Ok((buf, local_mtime_ms(local_path)))
    }
}

async fn upload_bytes_to_remote(
    sftp_manager: &SftpSessionManager,
    session_id: &str,
    remote_path: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let remote_fs = sftp_manager.get_remote_fs(session_id).await?;
    remote_fs.write_bytes(remote_path, bytes, None).await
}

fn prepare_local_stage_path(is_remote: bool, session_id: Option<&str>, doc_id: &str, path: &str) -> Result<String, String> {
    if !is_remote {
        return Ok(path.to_string());
    }
    let dir = std::env::temp_dir()
        .join("scpcraft-edit")
        .join(sanitize_segment(session_id.unwrap_or("remote")));
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed creating temp editor folder {}: {}", dir.display(), e))?;
    let name = sanitize_segment(&file_name_from_path(path, true));
    let short_hash = doc_id.strip_prefix("doc_").unwrap_or(doc_id);
    Ok(dir
        .join(format!("{}_{}", short_hash, name))
        .to_string_lossy()
        .to_string())
}

fn parse_command_tokens(raw: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for ch in raw.chars() {
        match quote {
            Some(q) if ch == q => {
                quote = None;
            }
            Some(_) => cur.push(ch),
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
            }
            None if ch.is_whitespace() => {
                if !cur.is_empty() {
                    tokens.push(std::mem::take(&mut cur));
                }
            }
            None => cur.push(ch),
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    tokens
}

fn launch_external_process(local_path: &str, editor_command: Option<&str>) -> Result<String, String> {
    if let Some(cmd_str) = editor_command.map(str::trim).filter(|s| !s.is_empty()) {
        let tokens = parse_command_tokens(cmd_str);
        if let Some((prog, args)) = tokens.split_first() {
            #[cfg(target_os = "macos")]
            if Path::new(prog)
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("app"))
            {
                let mut cmd = std::process::Command::new("open");
                cmd.arg("-a").arg(prog);
                if !args.is_empty() {
                    cmd.args(args);
                }
                cmd.arg(local_path);
                cmd.spawn()
                    .map_err(|e| format!("Failed launching editor '{}': {}", prog, e))?;
                return Ok(prog.to_string());
            }

            std::process::Command::new(prog)
                .args(args)
                .arg(local_path)
                .spawn()
                .map_err(|e| format!("Failed launching editor '{}': {}", prog, e))?;
            return Ok(prog.to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        if std::process::Command::new("cmd")
            .args(["/C", "start", "", local_path])
            .spawn()
            .is_ok()
        {
            return Ok("System Default Editor".to_string());
        }
        std::process::Command::new("notepad.exe")
            .arg(local_path)
            .spawn()
            .map_err(|e| format!("Failed launching Notepad: {}", e))?;
        Ok("notepad.exe".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        if std::process::Command::new("open")
            .args(["-t", local_path])
            .spawn()
            .is_ok()
        {
            return Ok("TextEdit / Default Editor".to_string());
        }
        std::process::Command::new("open")
            .arg(local_path)
            .spawn()
            .map_err(|e| format!("Failed launching external editor: {}", e))?;
        Ok("open".to_string())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(local_path)
            .spawn()
            .map_err(|e| format!("Failed launching xdg-open: {}", e))?;
        Ok("xdg-open".to_string())
    }
}

#[tauri::command]
pub async fn editor_open_file(
    editor_state: tauri::State<'_, EditorWatchManager>,
    sftp_manager: tauri::State<'_, SftpSessionManager>,
    request: EditorOpenRequest,
) -> Result<EditorDocument, String> {
    let doc_id = make_doc_id(request.is_remote, request.session_id.as_deref(), &request.path);
    let (raw_bytes, remote_mtime) = read_source_bytes(
        &sftp_manager,
        request.session_id.as_deref(),
        &request.path,
        request.is_remote,
    )
    .await?;

    let local_temp_path = prepare_local_stage_path(
        request.is_remote,
        request.session_id.as_deref(),
        &doc_id,
        &request.path,
    )?;

    if request.is_remote {
        tokio::fs::write(&local_temp_path, &raw_bytes)
            .await
            .map_err(|e| format!("Failed writing temp edit file {}: {}", local_temp_path, e))?;
    }

    let (content, encoding, line_ending) = decode_text_bytes(&raw_bytes);
    let disk_hash = sha256_hex(&raw_bytes);
    let disk_mtime = local_mtime_ms(Path::new(&local_temp_path)).or(remote_mtime);

    let mut guard = editor_state.docs.lock().await;
    if let Some(prev) = guard.get_mut(&doc_id) {
        if let Some(tx) = prev.watch_cancel_tx.take() {
            let _ = tx.send(true);
        }
    }

    let doc = EditorDocument {
        doc_id: doc_id.clone(),
        pane: request.pane,
        session_id: request.session_id,
        path: request.path.clone(),
        file_name: file_name_from_path(&request.path, request.is_remote),
        is_remote: request.is_remote,
        local_temp_path,
        content,
        encoding,
        line_ending,
        size: raw_bytes.len() as u64,
        modified_ms: disk_mtime,
        watching_external: false,
    };

    guard.insert(
        doc_id,
        WatchedDocEntry {
            doc: doc.clone(),
            last_sha256: disk_hash,
            last_mtime_ms: disk_mtime,
            watch_cancel_tx: None,
        },
    );

    Ok(doc)
}

#[tauri::command]
pub async fn editor_save_file(
    editor_state: tauri::State<'_, EditorWatchManager>,
    sftp_manager: tauri::State<'_, SftpSessionManager>,
    request: EditorSaveRequest,
) -> Result<EditorSaveResult, String> {
    let (is_remote, session_id, path, local_temp_path) = {
        let guard = editor_state.docs.lock().await;
        let entry = guard
            .get(&request.doc_id)
            .ok_or_else(|| format!("Editor document '{}' is not open", request.doc_id))?;
        (
            entry.doc.is_remote,
            entry.doc.session_id.clone(),
            entry.doc.path.clone(),
            entry.doc.local_temp_path.clone(),
        )
    };

    let bytes = encode_text_bytes(&request.content, &request.encoding, &request.line_ending);
    let new_hash = sha256_hex(&bytes);

    tokio::fs::write(&local_temp_path, &bytes)
        .await
        .map_err(|e| format!("Failed saving local file {}: {}", local_temp_path, e))?;

    if is_remote {
        let sid = session_id.ok_or_else(|| "Missing SFTP sessionId for remote save".to_string())?;
        upload_bytes_to_remote(&sftp_manager, &sid, &path, &bytes).await?;
    }

    let saved_at_ms = now_millis();
    let new_mtime = local_mtime_ms(Path::new(&local_temp_path)).or(Some(saved_at_ms));
    let bytes_written = bytes.len() as u64;

    let mut guard = editor_state.docs.lock().await;
    if let Some(entry) = guard.get_mut(&request.doc_id) {
        entry.last_sha256 = new_hash;
        entry.last_mtime_ms = new_mtime;
        entry.doc.content = request.content;
        entry.doc.encoding = request.encoding;
        entry.doc.line_ending = request.line_ending;
        entry.doc.size = bytes_written;
        entry.doc.modified_ms = new_mtime;
    }

    Ok(EditorSaveResult {
        doc_id: request.doc_id,
        path,
        is_remote,
        bytes_written,
        saved_at_ms,
    })
}

#[tauri::command]
pub async fn editor_reload_file(
    editor_state: tauri::State<'_, EditorWatchManager>,
    sftp_manager: tauri::State<'_, SftpSessionManager>,
    doc_id: String,
) -> Result<EditorDocument, String> {
    let (is_remote, session_id, path, local_temp_path) = {
        let guard = editor_state.docs.lock().await;
        let entry = guard
            .get(&doc_id)
            .ok_or_else(|| format!("Editor document '{}' is not open", doc_id))?;
        (
            entry.doc.is_remote,
            entry.doc.session_id.clone(),
            entry.doc.path.clone(),
            entry.doc.local_temp_path.clone(),
        )
    };

    let (raw_bytes, remote_mtime) =
        read_source_bytes(&sftp_manager, session_id.as_deref(), &path, is_remote).await?;

    if is_remote {
        tokio::fs::write(&local_temp_path, &raw_bytes)
            .await
            .map_err(|e| format!("Failed refreshing temp file {}: {}", local_temp_path, e))?;
    }

    let (content, encoding, line_ending) = decode_text_bytes(&raw_bytes);
    let new_hash = sha256_hex(&raw_bytes);
    let new_mtime = local_mtime_ms(Path::new(&local_temp_path)).or(remote_mtime);

    let mut guard = editor_state.docs.lock().await;
    let entry = guard
        .get_mut(&doc_id)
        .ok_or_else(|| format!("Editor document '{}' was closed", doc_id))?;
    entry.last_sha256 = new_hash;
    entry.last_mtime_ms = new_mtime;
    entry.doc.content = content;
    entry.doc.encoding = encoding;
    entry.doc.line_ending = line_ending;
    entry.doc.size = raw_bytes.len() as u64;
    entry.doc.modified_ms = new_mtime;
    Ok(entry.doc.clone())
}

#[tauri::command]
pub async fn editor_open_external(
    app: AppHandle,
    editor_state: tauri::State<'_, EditorWatchManager>,
    sftp_manager: tauri::State<'_, SftpSessionManager>,
    doc_id: String,
    editor_command: Option<String>,
) -> Result<String, String> {
    let local_temp_path = {
        let guard = editor_state.docs.lock().await;
        let entry = guard
            .get(&doc_id)
            .ok_or_else(|| format!("Editor document '{}' is not open", doc_id))?;
        entry.doc.local_temp_path.clone()
    };

    let launcher = launch_external_process(&local_temp_path, editor_command.as_deref())?;

    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    {
        let mut guard = editor_state.docs.lock().await;
        if let Some(entry) = guard.get_mut(&doc_id) {
            if let Some(prev_tx) = entry.watch_cancel_tx.take() {
                let _ = prev_tx.send(true);
            }
            entry.watch_cancel_tx = Some(cancel_tx);
            entry.doc.watching_external = true;
        }
    }

    let docs = editor_state.docs.clone();
    let sftp_arc = sftp_manager.inner().clone();
    let doc_id_clone = doc_id.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() {
                        break;
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(250)) => {}
            }

            if *cancel_rx.borrow() {
                break;
            }

            let meta_snap = {
                let guard = docs.lock().await;
                guard.get(&doc_id_clone).map(|e| {
                    (
                        e.doc.local_temp_path.clone(),
                        e.last_sha256.clone(),
                        e.last_mtime_ms,
                    )
                })
            };

            let Some((watch_path, prev_hash, prev_mtime)) = meta_snap else {
                break;
            };

            let cur_mtime = local_mtime_ms(Path::new(&watch_path));
            if cur_mtime.is_some() && cur_mtime == prev_mtime {
                continue;
            }

            // Settle window so external editors finishing atomic write/truncation complete cleanly
            tokio::time::sleep(Duration::from_millis(150)).await;
            let Ok(bytes) = tokio::fs::read(&watch_path).await else {
                continue;
            };
            let next_hash = sha256_hex(&bytes);
            if next_hash == prev_hash {
                let mut guard = docs.lock().await;
                if let Some(entry) = guard.get_mut(&doc_id_clone) {
                    entry.last_mtime_ms = local_mtime_ms(Path::new(&watch_path));
                }
                continue;
            }

            let doc_meta = {
                let guard = docs.lock().await;
                guard.get(&doc_id_clone).map(|e| {
                    (
                        e.doc.is_remote,
                        e.doc.session_id.clone(),
                        e.doc.path.clone(),
                    )
                })
            };
            let Some((is_remote, session_id, remote_path)) = doc_meta else {
                break;
            };

            let mut upload_error: Option<String> = None;
            if is_remote {
                if let Some(sid) = session_id.as_deref() {
                    if let Err(err) =
                        upload_bytes_to_remote(&sftp_arc, sid, &remote_path, &bytes).await
                    {
                        upload_error = Some(err);
                    }
                }
            }

            let (content, encoding, line_ending) = decode_text_bytes(&bytes);
            let saved_at_ms = now_millis();
            let settled_mtime = local_mtime_ms(Path::new(&watch_path)).or(Some(saved_at_ms));
            let bytes_written = bytes.len() as u64;

            {
                let mut guard = docs.lock().await;
                if let Some(entry) = guard.get_mut(&doc_id_clone) {
                    entry.last_sha256 = next_hash;
                    entry.last_mtime_ms = settled_mtime;
                    entry.doc.content = content.clone();
                    entry.doc.encoding = encoding;
                    entry.doc.line_ending = line_ending;
                    entry.doc.size = bytes_written;
                    entry.doc.modified_ms = settled_mtime;
                }
            }

            let event = match upload_error {
                Some(err) => EditorExternalSyncEvent {
                    doc_id: doc_id_clone.clone(),
                    path: remote_path,
                    is_remote,
                    bytes_written,
                    saved_at_ms,
                    content,
                    status: "error".to_string(),
                    detail: err,
                },
                None => EditorExternalSyncEvent {
                    doc_id: doc_id_clone.clone(),
                    path: remote_path.clone(),
                    is_remote,
                    bytes_written,
                    saved_at_ms,
                    content,
                    status: "done".to_string(),
                    detail: if is_remote {
                        format!(
                            "External save synced {} bytes to remote {}",
                            bytes_written, remote_path
                        )
                    } else {
                        format!("External editor updated {} ({} bytes)", remote_path, bytes_written)
                    },
                },
            };

            let _ = app.emit("editor://external-synced", event);
        }
    });

    Ok(format!("Opened in {} ({})", launcher, local_temp_path))
}

#[tauri::command]
pub async fn editor_close_file(
    editor_state: tauri::State<'_, EditorWatchManager>,
    doc_id: String,
) -> Result<(), String> {
    let removed = {
        let mut guard = editor_state.docs.lock().await;
        guard.remove(&doc_id)
    };
    if let Some(mut entry) = removed {
        if let Some(tx) = entry.watch_cancel_tx.take() {
            let _ = tx.send(true);
        }
        if entry.doc.is_remote {
            let _ = tokio::fs::remove_file(&entry.doc.local_temp_path).await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_encoding_and_line_ending_round_trip() {
        let bom_crlf = b"\xEF\xBB\xBFhello\r\nworld\r\n";
        let (text, enc, eol) = decode_text_bytes(bom_crlf);
        assert_eq!(text, "hello\nworld\n");
        assert_eq!(enc, "UTF-8-BOM");
        assert_eq!(eol, "CRLF");

        let re_encoded = encode_text_bytes(&text, &enc, &eol);
        assert_eq!(re_encoded, bom_crlf);

        let lf_bytes = encode_text_bytes("a\nb\n", "UTF-8", "LF");
        assert_eq!(lf_bytes, b"a\nb\n");

        let latin1_raw = [b'c', b'a', b'f', 0xE9, b'\n'];
        let (l_text, l_enc, l_eol) = decode_text_bytes(&latin1_raw);
        assert_eq!(l_enc, "Latin-1");
        assert_eq!(l_eol, "LF");
        assert_eq!(encode_text_bytes(&l_text, "Latin-1", "LF"), latin1_raw);
    }

    #[test]
    fn external_file_change_hash_detection() {
        let tmp_dir = std::env::temp_dir().join(format!("scpcraft_ed_test_{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp_dir);
        let file = tmp_dir.join("sample.conf");

        fs::write(&file, b"port=22\n").unwrap();
        let initial_bytes = fs::read(&file).unwrap();
        let h1 = sha256_hex(&initial_bytes);

        fs::write(&file, b"port=22\n").unwrap();
        let same_bytes = fs::read(&file).unwrap();
        assert_eq!(sha256_hex(&same_bytes), h1);

        fs::write(&file, b"port=2222\n").unwrap();
        let edited_bytes = fs::read(&file).unwrap();
        let h2 = sha256_hex(&edited_bytes);
        assert_ne!(h1, h2);

        let _ = fs::remove_dir_all(&tmp_dir);
    }
}
