use crate::config::keyring_store;
use crate::config::winscp_ini::{self, SiteConfig, SiteProtocol};
use crate::sftp::session::default_known_hosts_path;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::menu::{
    AboutMetadata, Menu, MenuBuilder, MenuEvent, MenuItemBuilder, PredefinedMenuItem,
    SubmenuBuilder,
};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppPreferences {
    pub language: String,
    pub theme: String,
    pub interface_mode: String,
    pub show_hidden_files: bool,
    pub confirm_overwriting: bool,
    pub confirm_deleting: bool,
    pub confirm_closing_session: bool,
    pub max_concurrent_transfers: usize,
    pub default_speed_limit_kbps: u64,
    pub use_filepart_resume: bool,
    pub external_editor_command: String,
    pub double_click_action: String,
    pub remember_session_tabs: bool,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            language: "zh-TW".to_string(),
            theme: "dark".to_string(),
            interface_mode: "commander".to_string(),
            show_hidden_files: false,
            confirm_overwriting: true,
            confirm_deleting: true,
            confirm_closing_session: true,
            max_concurrent_transfers: 3,
            default_speed_limit_kbps: 0,
            use_filepart_resume: true,
            external_editor_command: "code --wait".to_string(),
            double_click_action: "edit".to_string(),
            remember_session_tabs: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDataItem {
    pub id: String,
    pub label: String,
    pub description: String,
    pub location: String,
    pub exists: bool,
    pub size_bytes: u64,
    pub item_count: usize,
    pub checked_by_default: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateUrlRequest {
    pub site: SiteConfig,
    pub include_username: bool,
    pub include_password: bool,
    pub include_host_key: bool,
    pub include_remote_dir: bool,
    pub winscp_specific: bool,
    pub save_extension: bool,
    pub raw_settings: bool,
    pub host_key_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateUrlBundle {
    pub url: String,
    pub winscp_script: String,
    pub batch_script: String,
    pub cli_command: String,
    pub powershell_script: String,
    pub csharp_code: String,
    pub powershell_sdk_code: String,
    pub rust_code: String,
}

fn scpcraft_config_dir() -> PathBuf {
    crate::config::app_config_dir()
}

pub fn default_preferences_path() -> PathBuf {
    scpcraft_config_dir().join("preferences.json")
}

pub fn load_preferences_from_path(path: &Path) -> Result<AppPreferences, String> {
    if !path.exists() {
        return Ok(AppPreferences::default());
    }
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("Failed reading preferences {}: {}", path.display(), e))?;
    serde_json::from_str(&raw)
        .map_err(|e| format!("Failed parsing preferences {}: {}", path.display(), e))
}

pub fn save_preferences_to_path(
    path: &Path,
    mut prefs: AppPreferences,
) -> Result<AppPreferences, String> {
    prefs.max_concurrent_transfers = prefs.max_concurrent_transfers.clamp(1, 8);
    if prefs.language != "en" && prefs.language != "zh-TW" {
        prefs.language = "zh-TW".to_string();
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed creating config dir {}: {}", parent.display(), e))?;
    }
    let json = serde_json::to_string_pretty(&prefs)
        .map_err(|e| format!("Failed serializing preferences: {}", e))?;
    fs::write(path, json)
        .map_err(|e| format!("Failed writing preferences {}: {}", path.display(), e))?;
    Ok(prefs)
}

#[tauri::command]
pub fn app_preferences_get() -> Result<AppPreferences, String> {
    load_preferences_from_path(&default_preferences_path())
}

#[tauri::command]
pub fn app_preferences_save(preferences: AppPreferences) -> Result<AppPreferences, String> {
    save_preferences_to_path(&default_preferences_path(), preferences)
}

fn dir_or_file_stats(path: &Path) -> (bool, u64, usize) {
    if !path.exists() {
        return (false, 0, 0);
    }
    let Ok(meta) = fs::metadata(path) else {
        return (false, 0, 0);
    };
    if meta.is_file() {
        return (true, meta.len(), 1);
    }
    let mut size = 0u64;
    let mut count = 0usize;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let p = entry.path();
            if let Ok(m) = fs::metadata(&p) {
                if m.is_dir() {
                    stack.push(p);
                } else {
                    size = size.saturating_add(m.len());
                    count += 1;
                }
            }
        }
    }
    (true, size, count)
}

pub fn inspect_cleanup_targets_with_roots(
    config_dir: &Path,
    known_hosts_path: &Path,
    editor_temp_dir: &Path,
) -> Vec<CleanupDataItem> {
    let defs: Vec<(&str, &str, &str, PathBuf, bool)> = vec![
        (
            "editor_temp",
            "Temporary Edited Files",
            "Cached files staged when opening remote files in the built-in/external editor",
            editor_temp_dir.to_path_buf(),
            true,
        ),
        (
            "saved_sites",
            "Saved Site Profiles",
            "Stored connections and folders in sites.json (keyring passwords retained unless site removed)",
            config_dir.join("sites.json"),
            false,
        ),
        (
            "bookmarks",
            "Location Bookmarks",
            "Local/Remote quick navigation folder pairs in bookmarks.json",
            config_dir.join("bookmarks.json"),
            false,
        ),
        (
            "custom_commands",
            "Custom Commands Presets",
            "User-customized shell command templates in custom_commands.json",
            config_dir.join("custom_commands.json"),
            false,
        ),
        (
            "preferences",
            "Application Preferences",
            "Language, theme, transfer limits, and editor preferences in preferences.json",
            config_dir.join("preferences.json"),
            false,
        ),
        (
            "known_hosts",
            "SSH Host Keys (known_hosts)",
            "Trusted SSH host fingerprints stored in shared OpenSSH known_hosts",
            known_hosts_path.to_path_buf(),
            false,
        ),
    ];

    defs.into_iter()
        .map(|(id, label, desc, path, default_chk)| {
            let (exists, size_bytes, item_count) = dir_or_file_stats(&path);
            CleanupDataItem {
                id: id.to_string(),
                label: label.to_string(),
                description: desc.to_string(),
                location: path.to_string_lossy().to_string(),
                exists,
                size_bytes,
                item_count,
                checked_by_default: default_chk && exists,
            }
        })
        .collect()
}

pub fn execute_cleanup_ids_with_roots(
    config_dir: &Path,
    known_hosts_path: &Path,
    editor_temp_dir: &Path,
    selected_ids: &[String],
) -> Result<usize, String> {
    let mut cleaned = 0usize;
    for id in selected_ids {
        let target: Option<PathBuf> = match id.as_str() {
            "editor_temp" => Some(editor_temp_dir.to_path_buf()),
            "saved_sites" => Some(config_dir.join("sites.json")),
            "bookmarks" => Some(config_dir.join("bookmarks.json")),
            "custom_commands" => Some(config_dir.join("custom_commands.json")),
            "preferences" => Some(config_dir.join("preferences.json")),
            "known_hosts" => Some(known_hosts_path.to_path_buf()),
            _ => None,
        };
        if let Some(path) = target {
            if path.exists() {
                if path.is_dir() {
                    fs::remove_dir_all(&path).map_err(|e| {
                        format!("Failed removing cleanup directory {}: {}", path.display(), e)
                    })?;
                } else {
                    fs::remove_file(&path).map_err(|e| {
                        format!("Failed removing cleanup file {}: {}", path.display(), e)
                    })?;
                }
                cleaned += 1;
            }
        }
    }
    Ok(cleaned)
}

#[tauri::command]
pub fn app_cleanup_inspect() -> Vec<CleanupDataItem> {
    let cfg = scpcraft_config_dir();
    let kh = default_known_hosts_path();
    let tmp = std::env::temp_dir().join("scpcraft-edit");
    inspect_cleanup_targets_with_roots(&cfg, &kh, &tmp)
}

#[tauri::command]
pub fn app_cleanup_execute(selected_ids: Vec<String>) -> Result<usize, String> {
    let cfg = scpcraft_config_dir();
    let kh = default_known_hosts_path();
    let tmp = std::env::temp_dir().join("scpcraft-edit");
    execute_cleanup_ids_with_roots(&cfg, &kh, &tmp, &selected_ids)
}

pub fn generate_url_bundle_impl(
    req: &GenerateUrlRequest,
    resolved_password: Option<&str>,
) -> GenerateUrlBundle {
    let mut effective_site = req.site.clone();
    if !req.include_username {
        effective_site.user_name.clear();
    }
    if !req.include_remote_dir {
        effective_site.advanced.remote_directory.clear();
    }

    let (base_url, _) = winscp_ini::generate_session_url(
        &effective_site,
        resolved_password,
        req.include_password && req.include_username,
    );

    let mut ext_parts = Vec::new();
    if req.winscp_specific {
        if !effective_site.advanced.ftp_passive_mode && effective_site.protocol == SiteProtocol::Ftp {
            ext_parts.push("x-passive=0".to_string());
        }
        if req.include_host_key {
            let fp = req
                .host_key_fingerprint
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("ssh-ed25519 255 SHA256:...");
            ext_parts.push(format!("x-hostkey={}", fp));
        }
    }
    if req.save_extension {
        ext_parts.push("save".to_string());
    }
    if req.raw_settings {
        if effective_site.advanced.timeout_secs != 15 {
            ext_parts.push(format!("Timeout={}", effective_site.advanced.timeout_secs));
        }
        if effective_site.protocol == SiteProtocol::S3 && !effective_site.advanced.s3_region.is_empty() {
            ext_parts.push(format!("S3Region={}", effective_site.advanced.s3_region));
        }
    }

    let url = if ext_parts.is_empty() {
        base_url.clone()
    } else {
        format!("{};{}", base_url, ext_parts.join(";"))
    };

    let hostkey_switch = if req.include_host_key {
        let fp = req
            .host_key_fingerprint
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or("ssh-ed25519 255 SHA256:...");
        format!(" -hostkey=\"{}\"", fp)
    } else {
        String::new()
    };

    let mut raw_switches = String::new();
    if req.raw_settings && !effective_site.advanced.ftp_passive_mode {
        raw_switches.push_str(" -passive=off");
    }

    let open_line = format!("open \"{}\"{}{}", url, hostkey_switch, raw_switches);
    let remote_dir = if req.include_remote_dir && !req.site.advanced.remote_directory.is_empty() {
        req.site.advanced.remote_directory.clone()
    } else {
        "/".to_string()
    };

    let winscp_script = format!(
        "{}\n# Execute file transfers\ncd {}\n# put localfile.txt\n# get remotefile.txt\nexit\n",
        open_line, remote_dir
    );

    let batch_script = format!(
        "@echo off\nwinscp.com /ini=nul /command ^\n  \"{}\" ^\n  \"cd {}\" ^\n  \"exit\"\n",
        open_line.replace('"', "\"\""),
        remote_dir
    );

    let cli_command = format!("winscp.com /command \"{}\" \"exit\"", open_line.replace('"', "\\\""));

    let powershell_script = format!(
        "& \"winscp.com\" /ini=nul /command `\n  '{}' `\n  'cd {}' `\n  'exit'\n",
        open_line.replace('\'', "''"),
        remote_dir
    );

    let proto_enum = match req.site.protocol {
        SiteProtocol::Sftp => "Protocol.Sftp",
        SiteProtocol::Scp => "Protocol.Scp",
        SiteProtocol::Ftp => "Protocol.Ftp",
        SiteProtocol::WebDav => "Protocol.Webdav",
        SiteProtocol::S3 => "Protocol.S3",
    };

    let user_val = if req.include_username {
        &req.site.user_name
    } else {
        ""
    };
    let pwd_val = if req.include_password && req.include_username {
        resolved_password.unwrap_or("PASSWORD")
    } else {
        "PASSWORD"
    };

    let csharp_code = format!(
        "using WinSCP;\n\nvar sessionOptions = new SessionOptions\n{{\n    Protocol = {},\n    HostName = \"{}\",\n    PortNumber = {},\n    UserName = \"{}\",\n    Password = \"{}\",\n}};\n\nusing (var session = new Session())\n{{\n    session.Open(sessionOptions);\n    // session.GetFiles(\"{}/*\", @\"C:\\Downloads\\\").Check();\n}}\n",
        proto_enum, req.site.host_name, req.site.port_number, user_val, pwd_val, remote_dir
    );

    let powershell_sdk_code = format!(
        "Add-Type -Path \"WinSCPnet.dll\"\n$sessionOptions = New-Object WinSCP.SessionOptions -Property @{{\n    Protocol = [WinSCP.{}]\n    HostName = \"{}\"\n    PortNumber = {}\n    UserName = \"{}\"\n    Password = \"{}\"\n}}\n$session = New-Object WinSCP.Session\ntry {{\n    $session.Open($sessionOptions)\n}} finally {{\n    $session.Dispose()\n}}\n",
        proto_enum, req.site.host_name, req.site.port_number, user_val, pwd_val
    );

    let rust_code = format!(
        "// Connect with ScpCraft site URL or SFTP/FTP/S3/WebDAV profile\nlet session_url = \"{}\";\n// Host: {}:{} | Initial dir: {}\n",
        url, req.site.host_name, req.site.port_number, remote_dir
    );

    GenerateUrlBundle {
        url,
        winscp_script,
        batch_script,
        cli_command,
        powershell_script,
        csharp_code,
        powershell_sdk_code,
        rust_code,
    }
}

#[tauri::command]
pub fn site_generate_url_bundle(request: GenerateUrlRequest) -> GenerateUrlBundle {
    let pwd = if request.include_password && !request.site.id.trim().is_empty() {
        keyring_store::get_site_secret(&request.site.id, "password")
    } else {
        None
    };
    generate_url_bundle_impl(&request, pwd.as_deref())
}

pub fn build_app_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder = MenuBuilder::new(app);

    #[cfg(target_os = "macos")]
    {
        let about_meta = AboutMetadata {
            name: Some("ScpCraft".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            authors: Some(vec!["zack709".into()]),
            copyright: Some("Copyright © 2026 zack709 & ScpCraft Contributors".into()),
            comments: Some("Cross-platform dual-pane SFTP, SCP, FTP, WebDAV & S3 file transfer client.".into()),
            license: Some("Apache-2.0".into()),
            ..Default::default()
        };
        let app_sub = SubmenuBuilder::new(app, "ScpCraft")
            .item(&PredefinedMenuItem::about(app, Some("About ScpCraft"), Some(about_meta))?)
            .separator()
            .item(
                &MenuItemBuilder::with_id("preferences", "Preferences...")
                    .accelerator("Cmd+,")
                    .build(app)?,
            )
            .separator()
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::quit(app, None)?)
            .build()?;
        builder = builder.item(&app_sub);
    }

    let session_sub = SubmenuBuilder::new(app, "Session")
        .item(
            &MenuItemBuilder::with_id("new_session", "New Session / Site Manager...")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("generate_url", "Generate Session URL/Code...")
                .accelerator("CmdOrCtrl+Shift+U")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("disconnect", "Disconnect Active Session").build(app)?)
        .build()?;

    let edit_sub = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    let view_sub = SubmenuBuilder::new(app, "View")
        .item(&MenuItemBuilder::with_id("mode_commander", "Commander (Dual Pane)").build(app)?)
        .item(&MenuItemBuilder::with_id("mode_explorer", "Explorer (Single Pane)").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("toggle_terminal", "Toggle Interactive Terminal")
                .accelerator("CmdOrCtrl+T")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("toggle_theme", "Toggle Dark / Light Theme").build(app)?)
        .item(
            &MenuItemBuilder::with_id("toggle_locale", "Switch Language (繁體中文 / English)")
                .build(app)?,
        )
        .build()?;

    let commands_sub = SubmenuBuilder::new(app, "Commands")
        .item(
            &MenuItemBuilder::with_id("synchronize", "Synchronize Directories...")
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("keep_up_to_date", "Keep Remote Directory up to Date...")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("find_files", "Find Files...")
                .accelerator("Alt+F7")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("custom_commands", "Custom Commands...").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("preferences", "Preferences...")
                .accelerator("CmdOrCtrl+,")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("cleanup", "Clean Up Application Data...").build(app)?)
        .build()?;

    builder
        .item(&session_sub)
        .item(&edit_sub)
        .item(&view_sub)
        .item(&commands_sub)
        .build()
}

pub fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref().to_string();
    let _ = app.emit("menu://action", id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn preferences_round_trip_and_cleanup_inspection() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("scpcraft_menu_test_{}", nanos));
        let cfg = root.join("config");
        let kh = root.join("known_hosts");
        let tmp = root.join("temp_edit");
        fs::create_dir_all(&cfg).unwrap();
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("draft.txt"), b"hello cached").unwrap();
        fs::write(&kh, b"example.com ssh-ed25519 AAAA\n").unwrap();

        let prefs_path = cfg.join("preferences.json");
        let mut prefs = AppPreferences::default();
        prefs.language = "en".to_string();
        prefs.max_concurrent_transfers = 6;
        prefs.external_editor_command = "nvim".to_string();
        save_preferences_to_path(&prefs_path, prefs.clone()).unwrap();
        let loaded = load_preferences_from_path(&prefs_path).unwrap();
        assert_eq!(loaded, prefs);

        let inspected = inspect_cleanup_targets_with_roots(&cfg, &kh, &tmp);
        let temp_item = inspected.iter().find(|i| i.id == "editor_temp").unwrap();
        assert!(temp_item.exists);
        assert_eq!(temp_item.size_bytes, 12);
        assert!(temp_item.checked_by_default);

        let cleaned = execute_cleanup_ids_with_roots(
            &cfg,
            &kh,
            &tmp,
            &["editor_temp".to_string()],
        )
        .unwrap();
        assert_eq!(cleaned, 1);
        assert!(!tmp.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn generate_url_script_and_code_formats() {
        let mut site = SiteConfig::default();
        site.protocol = SiteProtocol::Sftp;
        site.host_name = "prod.example.com".to_string();
        site.port_number = 2222;
        site.user_name = "deploy".to_string();
        site.advanced.remote_directory = "/var/www/app".to_string();

        let bundle = generate_url_bundle_impl(
            &GenerateUrlRequest {
                site,
                include_username: true,
                include_password: true,
                include_host_key: true,
                include_remote_dir: true,
                winscp_specific: true,
                save_extension: true,
                raw_settings: false,
                host_key_fingerprint: Some("ssh-ed25519 255 SHA256:TESTFP".to_string()),
            },
            Some("s3cret!"),
        );

        assert!(bundle.url.starts_with("sftp://deploy:s3cret%21@prod.example.com:2222/var/www/app/"));
        assert!(bundle.url.contains("x-hostkey=ssh-ed25519 255 SHA256:TESTFP;save"));
        assert!(bundle.winscp_script.contains("open \""));
        assert!(bundle.batch_script.contains("winscp.com /ini=nul /command"));
        assert!(bundle.csharp_code.contains("Protocol = Protocol.Sftp"));
        assert!(bundle.powershell_sdk_code.contains("WinSCP.SessionOptions"));
    }
}
