use crate::config::keyring_store;
use crate::config::winscp_ini::{
    self, SiteConfig, SiteSecretBundle,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const REPO_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteRepositoryFile {
    pub version: u32,
    pub show_login_on_startup: bool,
    pub folders: Vec<String>,
    pub sites: Vec<SiteConfig>,
}

impl Default for SiteRepositoryFile {
    fn default() -> Self {
        Self {
            version: REPO_VERSION,
            show_login_on_startup: true,
            folders: Vec::new(),
            sites: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteImportResult {
    pub imported_count: usize,
    pub repository: SiteRepositoryFile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSessionUrlResult {
    pub site: SiteConfig,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedSessionUrlResult {
    pub url: String,
    pub cli_command: String,
}

fn default_repo_path() -> PathBuf {
    super::app_config_dir().join("sites.json")
}

pub fn load_repo_from_path(path: &Path) -> Result<SiteRepositoryFile, String> {
    if !path.exists() {
        return Ok(SiteRepositoryFile::default());
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("Failed to read sites.json: {}", e))?;
    let mut repo: SiteRepositoryFile =
        serde_json::from_str(&raw).map_err(|e| format!("Failed to parse sites.json: {}", e))?;
    normalize_folders(&mut repo);
    Ok(repo)
}

pub fn save_repo_to_path(path: &Path, repo: &mut SiteRepositoryFile) -> Result<(), String> {
    normalize_folders(repo);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }
    let json = serde_json::to_string_pretty(repo)
        .map_err(|e| format!("Failed to serialize sites.json: {}", e))?;
    fs::write(path, json).map_err(|e| format!("Failed to write sites.json: {}", e))?;
    Ok(())
}

fn normalize_folders(repo: &mut SiteRepositoryFile) {
    let mut set: BTreeSet<String> = BTreeSet::new();
    for f in &repo.folders {
        let trimmed = f.trim().trim_matches('/').to_string();
        if !trimmed.is_empty() {
            set.insert(trimmed);
        }
    }
    for s in &repo.sites {
        if let Some(folder) = &s.folder {
            let trimmed = folder.trim().trim_matches('/').to_string();
            if !trimmed.is_empty() {
                set.insert(trimmed);
            }
        }
    }
    repo.folders = set.into_iter().collect();
    repo.sites.sort_by(|a, b| {
        a.folder
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b.folder.as_deref().unwrap_or("").to_lowercase())
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

fn generate_unique_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("site-{:x}", nanos)
}

fn unique_site_name(existing: &[SiteConfig], folder: Option<&str>, base_name: &str) -> String {
    let exists = |candidate: &str| {
        existing
            .iter()
            .any(|s| s.folder.as_deref() == folder && s.name.eq_ignore_ascii_case(candidate))
    };
    if !exists(base_name) {
        return base_name.to_string();
    }
    for idx in 2..=999 {
        let candidate = format!("{} ({})", base_name, idx);
        if !exists(&candidate) {
            return candidate;
        }
    }
    format!("{} ({})", base_name, existing.len() + 1)
}

pub fn save_site_to_path(
    path: &Path,
    mut site: SiteConfig,
    secrets: SiteSecretBundle,
    save_as_new: bool,
) -> Result<SiteRepositoryFile, String> {
    let mut repo = load_repo_from_path(path)?;

    if site.id.trim().is_empty() || save_as_new {
        site.id = generate_unique_id();
    }

    if let Some(ref pwd) = secrets.password {
        if pwd.is_empty() {
            site.has_password = false;
        } else {
            keyring_store::set_site_secret(&site.id, "password", pwd)?;
            site.has_password = true;
        }
    }
    if let Some(ref phrase) = secrets.passphrase {
        if phrase.is_empty() {
            site.has_passphrase = false;
        } else {
            keyring_store::set_site_secret(&site.id, "passphrase", phrase)?;
            site.has_passphrase = true;
        }
    }
    if let Some(ref tpwd) = secrets.tunnel_password {
        if !tpwd.is_empty() {
            keyring_store::set_site_secret(&site.id, "tunnelPassword", tpwd)?;
        }
    }

    if save_as_new {
        site.name = unique_site_name(&repo.sites, site.folder.as_deref(), &site.name);
        repo.sites.push(site);
    } else if let Some(idx) = repo.sites.iter().position(|s| s.id == site.id) {
        repo.sites[idx] = site;
    } else {
        site.name = unique_site_name(&repo.sites, site.folder.as_deref(), &site.name);
        repo.sites.push(site);
    }

    save_repo_to_path(path, &mut repo)?;
    Ok(repo)
}

pub fn delete_site_from_path(path: &Path, site_id: &str) -> Result<SiteRepositoryFile, String> {
    let mut repo = load_repo_from_path(path)?;
    repo.sites.retain(|s| s.id != site_id);
    keyring_store::delete_site_secrets(site_id);
    save_repo_to_path(path, &mut repo)?;
    Ok(repo)
}

pub fn import_ini_into_path(path: &Path, ini_content: &str) -> Result<SiteImportResult, String> {
    let parsed = winscp_ini::parse_winscp_ini(ini_content);
    let mut repo = load_repo_from_path(path)?;
    let count = parsed.len();

    for (mut site, secrets) in parsed {
        if let Some(ref pwd) = secrets.password {
            if !pwd.is_empty() {
                keyring_store::set_site_secret(&site.id, "password", pwd)?;
                site.has_password = true;
            }
        }
        if let Some(ref tpwd) = secrets.tunnel_password {
            if !tpwd.is_empty() {
                keyring_store::set_site_secret(&site.id, "tunnelPassword", tpwd)?;
            }
        }

        if let Some(idx) = repo
            .sites
            .iter()
            .position(|s| s.id == site.id || (s.folder == site.folder && s.name == site.name))
        {
            site.id = repo.sites[idx].id.clone();
            repo.sites[idx] = site;
        } else {
            repo.sites.push(site);
        }
    }

    save_repo_to_path(path, &mut repo)?;
    Ok(SiteImportResult {
        imported_count: count,
        repository: repo,
    })
}

#[tauri::command]
pub fn site_list() -> Result<SiteRepositoryFile, String> {
    load_repo_from_path(&default_repo_path())
}

#[tauri::command]
pub fn site_save(
    site: SiteConfig,
    secrets: SiteSecretBundle,
    save_as_new: bool,
) -> Result<SiteRepositoryFile, String> {
    save_site_to_path(&default_repo_path(), site, secrets, save_as_new)
}

#[tauri::command]
pub fn site_delete(site_id: String) -> Result<SiteRepositoryFile, String> {
    delete_site_from_path(&default_repo_path(), &site_id)
}

#[tauri::command]
pub fn site_rename(site_id: String, new_name: String) -> Result<SiteRepositoryFile, String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("Site name cannot be empty".to_string());
    }
    let path = default_repo_path();
    let mut repo = load_repo_from_path(&path)?;
    if let Some(s) = repo.sites.iter_mut().find(|s| s.id == site_id) {
        s.name = trimmed.to_string();
    } else {
        return Err(format!("Site '{}' not found", site_id));
    }
    save_repo_to_path(&path, &mut repo)?;
    Ok(repo)
}

#[tauri::command]
pub fn site_clone(site_id: String) -> Result<SiteRepositoryFile, String> {
    let path = default_repo_path();
    let mut repo = load_repo_from_path(&path)?;
    let source = repo
        .sites
        .iter()
        .find(|s| s.id == site_id)
        .cloned()
        .ok_or_else(|| format!("Site '{}' not found", site_id))?;

    let mut cloned = source.clone();
    cloned.id = generate_unique_id();
    cloned.name = unique_site_name(
        &repo.sites,
        cloned.folder.as_deref(),
        &format!("{} (Copy)", source.name),
    );

    if let Some(pwd) = keyring_store::get_site_secret(&source.id, "password") {
        let _ = keyring_store::set_site_secret(&cloned.id, "password", &pwd);
        cloned.has_password = true;
    }
    if let Some(phrase) = keyring_store::get_site_secret(&source.id, "passphrase") {
        let _ = keyring_store::set_site_secret(&cloned.id, "passphrase", &phrase);
        cloned.has_passphrase = true;
    }
    if let Some(tpwd) = keyring_store::get_site_secret(&source.id, "tunnelPassword") {
        let _ = keyring_store::set_site_secret(&cloned.id, "tunnelPassword", &tpwd);
    }

    repo.sites.push(cloned);
    save_repo_to_path(&path, &mut repo)?;
    Ok(repo)
}

#[tauri::command]
pub fn site_create_folder(folder_name: String) -> Result<SiteRepositoryFile, String> {
    let trimmed = folder_name.trim().trim_matches('/').to_string();
    if trimmed.is_empty() {
        return Err("Folder name cannot be empty".to_string());
    }
    let path = default_repo_path();
    let mut repo = load_repo_from_path(&path)?;
    repo.folders.push(trimmed);
    save_repo_to_path(&path, &mut repo)?;
    Ok(repo)
}

#[tauri::command]
pub fn site_delete_folder(folder_name: String) -> Result<SiteRepositoryFile, String> {
    let trimmed = folder_name.trim().trim_matches('/');
    let path = default_repo_path();
    let mut repo = load_repo_from_path(&path)?;
    repo.folders
        .retain(|f| f != trimmed && !f.starts_with(&format!("{}/", trimmed)));
    for s in &mut repo.sites {
        if let Some(ref f) = s.folder {
            if f == trimmed || f.starts_with(&format!("{}/", trimmed)) {
                s.folder = None;
            }
        }
    }
    save_repo_to_path(&path, &mut repo)?;
    Ok(repo)
}

#[tauri::command]
pub fn site_set_show_on_startup(show: bool) -> Result<SiteRepositoryFile, String> {
    let path = default_repo_path();
    let mut repo = load_repo_from_path(&path)?;
    repo.show_login_on_startup = show;
    save_repo_to_path(&path, &mut repo)?;
    Ok(repo)
}

#[tauri::command]
pub fn site_get_secret(site_id: String) -> Result<SiteSecretBundle, String> {
    Ok(SiteSecretBundle {
        password: keyring_store::get_site_secret(&site_id, "password"),
        passphrase: keyring_store::get_site_secret(&site_id, "passphrase"),
        tunnel_password: keyring_store::get_site_secret(&site_id, "tunnelPassword"),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScpCraftYamlBundle {
    #[serde(default = "default_yaml_version")]
    pub version: u32,
    #[serde(default)]
    pub folders: Vec<String>,
    #[serde(default)]
    pub sites: Vec<SiteConfig>,
}

fn default_yaml_version() -> u32 {
    1
}

/// Exports saved sites and folders as YAML with all secret flags cleared (no passwords exported).
pub fn export_yaml_from_path(repo_path: &Path) -> Result<String, String> {
    let repo = load_repo_from_path(repo_path)?;
    let sanitized_sites = repo
        .sites
        .into_iter()
        .map(|mut site| {
            site.has_password = false;
            site.has_passphrase = false;
            site
        })
        .collect();
    let bundle = ScpCraftYamlBundle {
        version: 1,
        folders: repo.folders,
        sites: sanitized_sites,
    };
    serde_yaml::to_string(&bundle).map_err(|e| format!("Failed to serialize sites to YAML: {}", e))
}

/// Imports sites and folders from YAML without storing any passwords.
pub fn import_yaml_into_path(repo_path: &Path, yaml_content: &str) -> Result<SiteImportResult, String> {
    let bundle: ScpCraftYamlBundle = serde_yaml::from_str(yaml_content)
        .or_else(|_| {
            serde_yaml::from_str::<Vec<SiteConfig>>(yaml_content).map(|sites| ScpCraftYamlBundle {
                version: 1,
                folders: Vec::new(),
                sites,
            })
        })
        .map_err(|e| format!("Invalid YAML format: {}", e))?;

    let mut repo = load_repo_from_path(repo_path)?;
    for folder in bundle.folders {
        let trimmed = folder.trim().to_string();
        if !trimmed.is_empty() && !repo.folders.contains(&trimmed) {
            repo.folders.push(trimmed);
        }
    }

    let count = bundle.sites.len();
    for mut site in bundle.sites {
        site.has_password = false;
        site.has_passphrase = false;
        if site.id.trim().is_empty() {
            let ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            site.id = format!(
                "site_{}_{}",
                ms,
                site.name.replace(' ', "_").to_lowercase()
            );
        }
        if let Some(ref folder) = site.folder {
            if !folder.is_empty() && !repo.folders.contains(folder) {
                repo.folders.push(folder.clone());
            }
        }
        if let Some(idx) = repo
            .sites
            .iter()
            .position(|s| s.name == site.name && s.folder == site.folder)
        {
            site.id = repo.sites[idx].id.clone();
            repo.sites[idx] = site;
        } else {
            repo.sites.push(site);
        }
    }

    repo.folders.sort();
    save_repo_to_path(repo_path, &mut repo)?;
    Ok(SiteImportResult {
        imported_count: count,
        repository: repo,
    })
}

#[tauri::command]
pub fn site_import_yaml(yaml_content: String) -> Result<SiteImportResult, String> {
    import_yaml_into_path(&default_repo_path(), &yaml_content)
}

#[tauri::command]
pub fn site_export_yaml() -> Result<String, String> {
    export_yaml_from_path(&default_repo_path())
}

#[tauri::command]
pub fn site_import_winscp_ini(ini_content: String) -> Result<SiteImportResult, String> {
    import_ini_into_path(&default_repo_path(), &ini_content)
}

#[tauri::command]
pub fn site_export_winscp_ini(include_passwords: bool) -> Result<String, String> {
    let repo = load_repo_from_path(&default_repo_path())?;
    let mut pairs = Vec::with_capacity(repo.sites.len());
    for site in repo.sites {
        let secrets = if include_passwords {
            SiteSecretBundle {
                password: keyring_store::get_site_secret(&site.id, "password"),
                passphrase: keyring_store::get_site_secret(&site.id, "passphrase"),
                tunnel_password: keyring_store::get_site_secret(&site.id, "tunnelPassword"),
            }
        } else {
            SiteSecretBundle::default()
        };
        pairs.push((site, secrets));
    }
    Ok(winscp_ini::export_winscp_ini(&pairs))
}

#[tauri::command]
pub fn site_import_winscp_registry() -> Result<SiteImportResult, String> {
    let parsed = winscp_ini::import_winscp_registry_sessions()?;
    let path = default_repo_path();
    let mut repo = load_repo_from_path(&path)?;
    let count = parsed.len();

    for (mut site, secrets) in parsed {
        if let Some(ref pwd) = secrets.password {
            if !pwd.is_empty() {
                keyring_store::set_site_secret(&site.id, "password", pwd)?;
                site.has_password = true;
            }
        }
        if let Some(ref tpwd) = secrets.tunnel_password {
            if !tpwd.is_empty() {
                keyring_store::set_site_secret(&site.id, "tunnelPassword", tpwd)?;
            }
        }
        if let Some(idx) = repo
            .sites
            .iter()
            .position(|s| s.id == site.id || (s.folder == site.folder && s.name == site.name))
        {
            site.id = repo.sites[idx].id.clone();
            repo.sites[idx] = site;
        } else {
            repo.sites.push(site);
        }
    }

    save_repo_to_path(&path, &mut repo)?;
    Ok(SiteImportResult {
        imported_count: count,
        repository: repo,
    })
}

#[tauri::command]
pub fn site_parse_session_url(url: String) -> Result<ParsedSessionUrlResult, String> {
    let (site, password) = winscp_ini::parse_session_url(&url)?;
    Ok(ParsedSessionUrlResult { site, password })
}

#[tauri::command]
pub fn site_generate_session_url(
    site: SiteConfig,
    include_password: bool,
) -> Result<GeneratedSessionUrlResult, String> {
    let pwd = if include_password {
        keyring_store::get_site_secret(&site.id, "password")
    } else {
        None
    };
    let (url, cli_command) = winscp_ini::generate_session_url(&site, pwd.as_deref(), include_password);
    Ok(GeneratedSessionUrlResult { url, cli_command })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::winscp_ini::SiteProtocol;

    #[test]
    fn json_never_stores_plaintext_password() {
        let dir = std::env::temp_dir().join(format!(
            "scpcraft_site_repo_test_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let json_path = dir.join("sites.json");

        let site = SiteConfig {
            id: "test-site-keyring-1".to_string(),
            name: "Production DB".to_string(),
            folder: Some("Infra".to_string()),
            protocol: SiteProtocol::Sftp,
            host_name: "db.internal".to_string(),
            port_number: 22,
            user_name: "ops".to_string(),
            ..SiteConfig::default()
        };

        let secret_pw = "TOP_SECRET_PASSWORD_999";
        let repo = save_site_to_path(
            &json_path,
            site,
            SiteSecretBundle {
                password: Some(secret_pw.to_string()),
                passphrase: Some("KeyPhrase777".to_string()),
                tunnel_password: None,
            },
            false,
        )
        .expect("save should succeed");

        assert_eq!(repo.sites.len(), 1);
        assert!(repo.sites[0].has_password);
        assert!(repo.sites[0].has_passphrase);

        let disk_contents = fs::read_to_string(&json_path).unwrap();
        assert!(!disk_contents.contains(secret_pw));
        assert!(!disk_contents.contains("KeyPhrase777"));

        let retrieved = keyring_store::get_site_secret("test-site-keyring-1", "password");
        assert_eq!(retrieved.as_deref(), Some(secret_pw));

        delete_site_from_path(&json_path, "test-site-keyring-1").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn yaml_export_and_import_omits_passwords() {
        let dir = std::env::temp_dir().join(format!(
            "scpcraft_yaml_repo_test_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let json_path = dir.join("sites.json");

        let mut site = SiteConfig {
            id: "yaml-site-1".to_string(),
            name: "HiCloud S3".to_string(),
            folder: Some("Cloud".to_string()),
            protocol: SiteProtocol::S3,
            host_name: "s3.hicloud.net.tw".to_string(),
            port_number: 443,
            user_name: "ACCESS_KEY".to_string(),
            has_password: true,
            ..SiteConfig::default()
        };
        site.has_passphrase = true;
        let mut repo_file = SiteRepositoryFile::default();
        repo_file.sites = vec![site];
        repo_file.folders = vec!["Cloud".to_string()];
        save_repo_to_path(&json_path, &mut repo_file).unwrap();

        let yaml_text = export_yaml_from_path(&json_path).unwrap();
        assert!(yaml_text.contains("s3.hicloud.net.tw"));
        assert!(yaml_text.contains("hasPassword: false"));
        assert!(yaml_text.contains("hasPassphrase: false"));

        let imported_path = dir.join("sites_imported.json");
        let res = import_yaml_into_path(&imported_path, &yaml_text).unwrap();
        assert_eq!(res.imported_count, 1);
        assert_eq!(res.repository.sites[0].host_name, "s3.hicloud.net.tw");
        assert!(!res.repository.sites[0].has_password);

        let _ = fs::remove_dir_all(&dir);
    }
}
