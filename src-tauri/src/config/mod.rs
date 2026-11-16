use std::path::{Path, PathBuf};

pub mod keyring_store;
pub mod site_repo;
pub mod winscp_ini;

/// Returns true when built with the `portable` feature or when a `config`
/// directory already exists alongside the executable.
pub fn is_portable_mode() -> bool {
    if cfg!(feature = "portable") {
        return true;
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join("config").is_dir()))
        .unwrap_or(false)
}

fn resolve_config_dir_with(
    is_portable: bool,
    exe_dir: Option<&Path>,
    os_config_dir: Option<PathBuf>,
) -> PathBuf {
    if is_portable {
        if let Some(dir) = exe_dir {
            return dir.join("config");
        }
    }
    os_config_dir
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ScpCraft")
}

/// Resolves the ScpCraft configuration directory.
/// In portable mode, uses `<exe_dir>/config` (creating it if needed).
/// Otherwise uses the OS standard config directory (`<config_dir>/ScpCraft`).
pub fn app_config_dir() -> PathBuf {
    let portable = is_portable_mode();
    let exe_dir = if portable {
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
    } else {
        None
    };
    let dir = resolve_config_dir_with(portable, exe_dir.as_deref(), dirs::config_dir());
    if portable {
        let _ = std::fs::create_dir_all(&dir);
    }
    dir
}

#[cfg(test)]
mod tests {
    use super::resolve_config_dir_with;
    use std::path::{Path, PathBuf};

    #[test]
    fn portable_mode_uses_config_next_to_executable() {
        let exe_dir = Path::new("C:\\Portable\\ScpCraft");
        let os_cfg = Some(PathBuf::from("C:\\Users\\Alice\\AppData\\Roaming"));
        assert_eq!(
            resolve_config_dir_with(true, Some(exe_dir), os_cfg),
            exe_dir.join("config")
        );
    }

    #[test]
    fn standard_mode_uses_os_config_dir() {
        let exe_dir = Path::new("C:\\Program Files\\ScpCraft");
        let os_cfg = Some(PathBuf::from("C:\\Users\\Alice\\AppData\\Roaming"));
        assert_eq!(
            resolve_config_dir_with(false, Some(exe_dir), os_cfg),
            PathBuf::from("C:\\Users\\Alice\\AppData\\Roaming").join("ScpCraft")
        );
    }
}
