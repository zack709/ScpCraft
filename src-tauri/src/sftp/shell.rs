use crate::sftp::manager::SftpSessionManager;
use russh::{ChannelMsg, ChannelWriteHalf};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOpenRequest {
    pub session_id: String,
    pub cwd: Option<String>,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutputEvent {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyClosedEvent {
    pub session_id: String,
    pub exit_code: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteExecRequest {
    pub session_id: String,
    pub command: String,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteExecResult {
    pub command: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomCommandPreset {
    pub id: String,
    pub description: String,
    pub command: String,
    pub is_local: bool,
    pub apply_to_directories: bool,
    pub execute_recursively: bool,
    pub show_results_in_terminal: bool,
    pub copy_results_to_clipboard: bool,
    pub use_remote_files: bool,
    pub shortcut: String,
}

struct ActivePtyHandle {
    writer: ChannelWriteHalf<russh::client::Msg>,
}

#[derive(Default)]
pub struct ShellSessionManager {
    ptys: Arc<Mutex<HashMap<String, ActivePtyHandle>>>,
}

fn shell_quote_posix(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    let safe = value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-@:=+".contains(c));
    if safe {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }
}

/// Expand WinSCP custom command patterns: `!?prompt?default!`, `!/`, `!&`, `!`.
pub fn expand_custom_command_pattern(
    pattern: &str,
    current_path: &str,
    selected_files: &[String],
    prompt_values: &HashMap<String, String>,
) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::with_capacity(pattern.len() + 32);
    let mut i = 0usize;

    while i < chars.len() {
        if chars[i] != '!' {
            out.push(chars[i]);
            i += 1;
            continue;
        }

        // Escaped !! -> !
        if i + 1 < chars.len() && chars[i + 1] == '!' {
            out.push('!');
            i += 2;
            continue;
        }

        // Interactive prompt: !?Prompt label?default value!
        if i + 1 < chars.len() && chars[i + 1] == '?' {
            if let Some(end_rel) = chars[i + 2..].iter().position(|&c| c == '!') {
                let inner: String = chars[i + 2..i + 2 + end_rel].iter().collect();
                let (prompt_label, default_val) = match inner.split_once('?') {
                    Some((p, d)) => (p.trim(), d.trim()),
                    None => (inner.trim(), ""),
                };
                let replacement = prompt_values
                    .get(prompt_label)
                    .map(String::as_str)
                    .unwrap_or(default_val);
                out.push_str(replacement);
                i = i + 2 + end_rel + 1;
                continue;
            }
        }

        // !/ -> current directory path
        if i + 1 < chars.len() && chars[i + 1] == '/' {
            out.push_str(&shell_quote_posix(current_path));
            i += 2;
            continue;
        }

        // !& -> space-separated list of selected files
        if i + 1 < chars.len() && chars[i + 1] == '&' {
            let joined: Vec<String> = selected_files.iter().map(|s| shell_quote_posix(s)).collect();
            out.push_str(&joined.join(" "));
            i += 2;
            continue;
        }

        // ! -> first selected file
        if let Some(first) = selected_files.first() {
            out.push_str(&shell_quote_posix(first));
        }
        i += 1;
    }

    out
}

fn custom_commands_store_path() -> PathBuf {
    crate::config::app_config_dir().join("custom_commands.json")
}

pub fn default_custom_command_presets() -> Vec<CustomCommandPreset> {
    vec![
        CustomCommandPreset {
            id: "cc-tar-gz".to_string(),
            description: "Archive selected files (.tar.gz)".to_string(),
            command: "tar -czvf \"!?Archive file name?archive.tar.gz!\" !&".to_string(),
            is_local: false,
            apply_to_directories: true,
            execute_recursively: false,
            show_results_in_terminal: true,
            copy_results_to_clipboard: false,
            use_remote_files: true,
            shortcut: "".to_string(),
        },
        CustomCommandPreset {
            id: "cc-untar-gz".to_string(),
            description: "Extract selected archive (.tar.gz)".to_string(),
            command: "tar -xzvf !".to_string(),
            is_local: false,
            apply_to_directories: false,
            execute_recursively: false,
            show_results_in_terminal: true,
            copy_results_to_clipboard: false,
            use_remote_files: true,
            shortcut: "".to_string(),
        },
        CustomCommandPreset {
            id: "cc-sha256".to_string(),
            description: "Calculate SHA-256 checksum".to_string(),
            command: "sha256sum !&".to_string(),
            is_local: false,
            apply_to_directories: false,
            execute_recursively: false,
            show_results_in_terminal: true,
            copy_results_to_clipboard: true,
            use_remote_files: true,
            shortcut: "".to_string(),
        },
        CustomCommandPreset {
            id: "cc-du".to_string(),
            description: "Disk usage summary (du -sh)".to_string(),
            command: "du -sh !&".to_string(),
            is_local: false,
            apply_to_directories: true,
            execute_recursively: false,
            show_results_in_terminal: true,
            copy_results_to_clipboard: false,
            use_remote_files: true,
            shortcut: "".to_string(),
        },
        CustomCommandPreset {
            id: "cc-tail".to_string(),
            description: "Tail last lines of file".to_string(),
            command: "tail -n !?Lines to show?50! !".to_string(),
            is_local: false,
            apply_to_directories: false,
            execute_recursively: false,
            show_results_in_terminal: true,
            copy_results_to_clipboard: false,
            use_remote_files: true,
            shortcut: "".to_string(),
        },
    ]
}

#[tauri::command]
pub async fn sftp_pty_open(
    app: AppHandle,
    shell_state: tauri::State<'_, ShellSessionManager>,
    sftp_manager: tauri::State<'_, SftpSessionManager>,
    request: PtyOpenRequest,
) -> Result<(), String> {
    let live = sftp_manager.get_session(&request.session_id).await?;
    let channel = {
        let ssh = live.ssh.lock().await;
        ssh.channel_open_session()
            .await
            .map_err(|e| format!("Failed opening SSH terminal channel: {}", e))?
    };

    channel
        .request_pty(
            true,
            "xterm-256color",
            request.cols.max(20),
            request.rows.max(5),
            0,
            0,
            &[],
        )
        .await
        .map_err(|e| format!("Failed allocating SSH PTY: {}", e))?;

    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("Failed starting remote shell: {}", e))?;

    let (mut read_half, write_half) = channel.split();

    if !live.shell.is_empty() {
        let shell_cmd = format!("{}\r", live.shell);
        let _ = write_half.data(shell_cmd.as_bytes()).await;
    }

    if let Some(dir) = request.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let cmd = format!("cd {}\r", shell_quote_posix(dir));
        let _ = write_half.data(cmd.as_bytes()).await;
    }

    let old_writer = {
        let mut guard = shell_state.ptys.lock().await;
        guard.insert(
            request.session_id.clone(),
            ActivePtyHandle { writer: write_half },
        )
    };
    if let Some(prev) = old_writer {
        let _ = prev.writer.close().await;
    }

    let sid = request.session_id;
    let ptys_arc = shell_state.ptys.clone();
    tokio::spawn(async move {
        let mut exit_code: Option<u32> = None;
        while let Some(msg) = read_half.wait().await {
            match msg {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    let text = String::from_utf8_lossy(&data).into_owned();
                    let _ = app.emit(
                        "terminal://output",
                        PtyOutputEvent {
                            session_id: sid.clone(),
                            data: text,
                        },
                    );
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    exit_code = Some(exit_status);
                }
                ChannelMsg::Eof | ChannelMsg::Close => {
                    break;
                }
                _ => {}
            }
        }
        {
            let mut guard = ptys_arc.lock().await;
            guard.remove(&sid);
        }
        let _ = app.emit(
            "terminal://closed",
            PtyClosedEvent {
                session_id: sid,
                exit_code,
            },
        );
    });

    Ok(())
}

#[tauri::command]
pub async fn sftp_pty_write(
    shell_state: tauri::State<'_, ShellSessionManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let guard = shell_state.ptys.lock().await;
    let pty = guard
        .get(&session_id)
        .ok_or_else(|| "Remote PTY terminal is not active for this session".to_string())?;
    pty.writer
        .data(data.as_bytes())
        .await
        .map_err(|e| format!("Failed sending input to SSH PTY: {}", e))
}

#[tauri::command]
pub async fn sftp_pty_resize(
    shell_state: tauri::State<'_, ShellSessionManager>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let guard = shell_state.ptys.lock().await;
    if let Some(pty) = guard.get(&session_id) {
        pty.writer
            .window_change(cols.max(20), rows.max(5), 0, 0)
            .await
            .map_err(|e| format!("Failed resizing SSH PTY: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_pty_close(
    shell_state: tauri::State<'_, ShellSessionManager>,
    session_id: String,
) -> Result<(), String> {
    let removed = {
        let mut guard = shell_state.ptys.lock().await;
        guard.remove(&session_id)
    };
    if let Some(pty) = removed {
        let _ = pty.writer.close().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_exec_command(
    sftp_manager: tauri::State<'_, SftpSessionManager>,
    request: RemoteExecRequest,
) -> Result<RemoteExecResult, String> {
    let cmd_trimmed = request.command.trim();
    if cmd_trimmed.is_empty() {
        return Err("Command cannot be empty".to_string());
    }

    let started = Instant::now();
    let live = sftp_manager.get_session(&request.session_id).await?;
    let channel = {
        let ssh = live.ssh.lock().await;
        ssh.channel_open_session()
            .await
            .map_err(|e| format!("Failed opening SSH exec channel: {}", e))?
    };

    let full_command = if let Some(cwd) = request.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        format!("cd {} && ({})", shell_quote_posix(cwd), cmd_trimmed)
    } else {
        cmd_trimmed.to_string()
    };

    channel
        .exec(true, full_command.into_bytes())
        .await
        .map_err(|e| format!("Failed executing remote command: {}", e))?;

    let (mut read_half, _write_half) = channel.split();
    let mut stdout_buf = Vec::new();
    let mut stderr_buf = Vec::new();
    let mut exit_code: i32 = 0;

    while let Some(msg) = read_half.wait().await {
        match msg {
            ChannelMsg::Data { data } => stdout_buf.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, .. } => stderr_buf.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => exit_code = exit_status as i32,
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }

    Ok(RemoteExecResult {
        command: request.command,
        stdout: String::from_utf8_lossy(&stdout_buf).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_buf).into_owned(),
        exit_code,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub async fn local_exec_command(
    command: String,
    cwd: Option<String>,
) -> Result<RemoteExecResult, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("Command cannot be empty".to_string());
    }
    let started = Instant::now();

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", trimmed]);
        c
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", trimmed]);
        c
    };

    if let Some(dir) = cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        cmd.current_dir(dir);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed running local command: {}", e))?;

    Ok(RemoteExecResult {
        command,
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub fn custom_commands_list() -> Result<Vec<CustomCommandPreset>, String> {
    let path = custom_commands_store_path();
    if path.exists() {
        let raw = fs::read_to_string(&path)
            .map_err(|e| format!("Failed reading {}: {}", path.display(), e))?;
        let parsed: Vec<CustomCommandPreset> = serde_json::from_str(&raw)
            .map_err(|e| format!("Failed parsing {}: {}", path.display(), e))?;
        if !parsed.is_empty() {
            return Ok(parsed);
        }
    }
    Ok(default_custom_command_presets())
}

#[tauri::command]
pub fn custom_commands_save(
    commands: Vec<CustomCommandPreset>,
) -> Result<Vec<CustomCommandPreset>, String> {
    let path = custom_commands_store_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed creating {}: {}", parent.display(), e))?;
    }
    let json = serde_json::to_string_pretty(&commands)
        .map_err(|e| format!("Failed serializing custom commands: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed saving {}: {}", path.display(), e))?;
    Ok(commands)
}

#[tauri::command]
pub fn custom_command_expand(
    pattern: String,
    current_path: String,
    selected_files: Vec<String>,
    prompt_values: HashMap<String, String>,
) -> Result<String, String> {
    Ok(expand_custom_command_pattern(
        &pattern,
        &current_path,
        &selected_files,
        &prompt_values,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_winscp_custom_command_patterns_with_quoting() {
        let mut prompts = HashMap::new();
        prompts.insert("Lines".to_string(), "120".to_string());

        let expanded = expand_custom_command_pattern(
            "tail -n !?Lines?50! ! && ls !/ && stat !&",
            "/var/log/app name",
            &["error log.txt".to_string(), "access.log".to_string()],
            &prompts,
        );
        assert_eq!(
            expanded,
            "tail -n 120 'error log.txt' && ls '/var/log/app name' && stat 'error log.txt' access.log"
        );

        let defaulted = expand_custom_command_pattern(
            "tar -czvf !?Archive file?bundle.tar.gz! !!",
            "/tmp",
            &[],
            &HashMap::new(),
        );
        assert_eq!(defaulted, "tar -czvf bundle.tar.gz !");
    }

    #[test]
    fn default_custom_commands_presets_are_valid() {
        let presets = default_custom_command_presets();
        assert!(presets.len() >= 4);
        assert!(presets.iter().any(|p| p.command.contains("sha256sum")));
        assert!(presets.iter().all(|p| !p.id.is_empty() && !p.description.is_empty()));
    }
}
