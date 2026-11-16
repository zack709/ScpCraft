use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub total_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub extension: String,
    pub file_type: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
    pub created_ms: Option<u64>,
    pub readonly: bool,
    pub hidden: bool,
    pub system: bool,
    pub permissions_text: String,
    pub octal_mode: String,
    pub symlink_target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreadcrumbSegment {
    pub label: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    pub parent_path: Option<String>,
    pub breadcrumbs: Vec<BreadcrumbSegment>,
    pub entries: Vec<FileEntry>,
    pub total_files: usize,
    pub total_dirs: usize,
    pub hidden_count: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileProperties {
    pub entry: FileEntry,
    pub item_count: usize,
    pub calculated_size: u64,
    pub sha256: Option<String>,
}

/// Normalize a path string and strip Windows verbatim `\\?\` prefixes.
pub fn normalize_path(p: &Path) -> String {
    let raw = p.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        if let Some(stripped) = raw.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{}", stripped);
        }
        if let Some(stripped) = raw.strip_prefix(r"\\?\") {
            return stripped.to_string();
        }
    }
    raw
}

/// Split a path into clickable breadcrumb segments.
pub fn build_breadcrumbs(p: &Path) -> Vec<BreadcrumbSegment> {
    let normalized = normalize_path(p);
    let clean_path = PathBuf::from(&normalized);
    let mut segments = Vec::new();
    let mut accum = PathBuf::new();

    for comp in clean_path.components() {
        match comp {
            Component::Prefix(prefix) => {
                accum.push(prefix.as_os_str());
            }
            Component::RootDir => {
                accum.push(comp.as_os_str());
                let full = normalize_path(&accum);
                let label = full.trim_end_matches(['\\', '/']).to_string();
                let label = if label.is_empty() { "/".to_string() } else { label };
                segments.push(BreadcrumbSegment { label, path: full });
            }
            Component::Normal(part) => {
                accum.push(part);
                segments.push(BreadcrumbSegment {
                    label: part.to_string_lossy().to_string(),
                    path: normalize_path(&accum),
                });
            }
            _ => {}
        }
    }

    if segments.is_empty() && !normalized.is_empty() {
        segments.push(BreadcrumbSegment {
            label: normalized.clone(),
            path: normalized,
        });
    }

    segments
}

fn system_time_to_ms(t: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    t.ok()
        .and_then(|st| st.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

pub fn is_hidden_or_system(path: &Path, meta: &fs::Metadata) -> (bool, bool) {
    let dot_hidden = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.'))
        .unwrap_or(false);

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
        let attrs = meta.file_attributes();
        let hidden = (attrs & FILE_ATTRIBUTE_HIDDEN) != 0 || dot_hidden;
        let system = (attrs & FILE_ATTRIBUTE_SYSTEM) != 0;
        (hidden, system)
    }

    #[cfg(not(windows))]
    {
        let _ = meta;
        (dot_hidden, false)
    }
}

pub fn format_permissions(
    meta: &fs::Metadata,
    is_dir: bool,
    is_symlink: bool,
    hidden: bool,
    system: bool,
) -> (String, String) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = (hidden, system);
        let mode = meta.permissions().mode();
        let prefix = if is_symlink {
            'l'
        } else if is_dir {
            'd'
        } else {
            '-'
        };
        let bits = [
            (0o400, 'r'),
            (0o200, 'w'),
            (0o100, 'x'),
            (0o040, 'r'),
            (0o020, 'w'),
            (0o010, 'x'),
            (0o004, 'r'),
            (0o002, 'w'),
            (0o001, 'x'),
        ];
        let mut s = String::with_capacity(10);
        s.push(prefix);
        for (mask, ch) in bits {
            s.push(if (mode & mask) != 0 { ch } else { '-' });
        }
        let octal = format!("{:04o}", mode & 0o7777);
        (s, octal)
    }

    #[cfg(not(unix))]
    {
        let readonly = meta.permissions().readonly();
        let mut attrs = String::new();
        if is_symlink {
            attrs.push('L');
        } else if is_dir {
            attrs.push('D');
        } else {
            attrs.push('-');
        }
        attrs.push(if readonly { 'R' } else { '-' });
        attrs.push(if hidden { 'H' } else { '-' });
        attrs.push(if system { 'S' } else { '-' });

        let octal = if is_dir {
            if readonly { "0555" } else { "0755" }
        } else if readonly {
            "0444"
        } else {
            "0644"
        }
        .to_string();

        (attrs, octal)
    }
}

fn build_file_entry(path: &Path) -> Result<FileEntry, String> {
    let sym_meta = fs::symlink_metadata(path)
        .map_err(|e| format!("Failed to read metadata for {}: {}", path.display(), e))?;
    let is_symlink = sym_meta.file_type().is_symlink();
    let symlink_target = if is_symlink {
        fs::read_link(path).ok().map(|t| normalize_path(&t))
    } else {
        None
    };

    // Follow symlink for target type/size if valid, otherwise fall back to symlink metadata
    let meta = if is_symlink {
        fs::metadata(path).unwrap_or_else(|_| sym_meta.clone())
    } else {
        sym_meta.clone()
    };

    let is_dir = meta.is_dir();
    let file_type = if is_symlink && is_dir {
        "symlink_dir".to_string()
    } else if is_symlink {
        "symlink".to_string()
    } else if is_dir {
        "dir".to_string()
    } else {
        "file".to_string()
    };

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| normalize_path(path));

    let extension = if is_dir {
        String::new()
    } else {
        path.extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default()
    };

    let (hidden, system) = is_hidden_or_system(path, &sym_meta);
    let (permissions_text, octal_mode) =
        format_permissions(&meta, is_dir, is_symlink, hidden, system);

    Ok(FileEntry {
        name,
        path: normalize_path(path),
        extension,
        file_type,
        size: if is_dir { 0 } else { meta.len() },
        modified_ms: system_time_to_ms(meta.modified()),
        created_ms: system_time_to_ms(meta.created()),
        readonly: meta.permissions().readonly(),
        hidden,
        system,
        permissions_text,
        octal_mode,
        symlink_target,
    })
}

fn validate_entry_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("Invalid file or folder name".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("Name cannot contain path separators".to_string());
    }
    Ok(trimmed.to_string())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<usize, String> {
    fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create directory {}: {}", dst.display(), e))?;
    let mut count = 1usize;
    let entries = fs::read_dir(src)
        .map_err(|e| format!("Failed to read directory {}: {}", src.display(), e))?;
    for item in entries {
        let entry = item.map_err(|e| format!("Failed reading entry: {}", e))?;
        let item_path = entry.path();
        let target_path = dst.join(entry.file_name());
        let ftype = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect {}: {}", item_path.display(), e))?;
        if ftype.is_dir() {
            count += copy_dir_recursive(&item_path, &target_path)?;
        } else {
            fs::copy(&item_path, &target_path).map_err(|e| {
                format!(
                    "Failed to copy {} to {}: {}",
                    item_path.display(),
                    target_path.display(),
                    e
                )
            })?;
            count += 1;
        }
    }
    Ok(count)
}

fn calculate_dir_stats(dir: &Path) -> (usize, u64) {
    let mut count = 0usize;
    let mut total_size = 0u64;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            count += 1;
            let p = entry.path();
            if let Ok(meta) = fs::symlink_metadata(&p) {
                if meta.is_dir() && !meta.file_type().is_symlink() {
                    let (sub_count, sub_size) = calculate_dir_stats(&p);
                    count += sub_count;
                    total_size += sub_size;
                } else {
                    total_size += meta.len();
                }
            }
        }
    }
    (count, total_size)
}

#[tauri::command]
pub fn local_list_drives() -> Result<Vec<DriveInfo>, String> {
    let mut drives = Vec::new();

    #[cfg(windows)]
    {
        for letter in b'A'..=b'Z' {
            let root = format!("{}:\\", letter as char);
            let p = Path::new(&root);
            if p.exists() {
                drives.push(DriveInfo {
                    name: format!("{}:", letter as char),
                    path: root,
                    kind: "drive".to_string(),
                    total_bytes: None,
                    available_bytes: None,
                });
            }
        }
    }

    #[cfg(not(windows))]
    {
        drives.push(DriveInfo {
            name: "/".to_string(),
            path: "/".to_string(),
            kind: "root".to_string(),
            total_bytes: None,
            available_bytes: None,
        });
        #[cfg(target_os = "macos")]
        {
            if let Ok(entries) = fs::read_dir("/Volumes") {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_dir() {
                        drives.push(DriveInfo {
                            name: entry.file_name().to_string_lossy().to_string(),
                            path: normalize_path(&p),
                            kind: "volume".to_string(),
                            total_bytes: None,
                            available_bytes: None,
                        });
                    }
                }
            }
        }
    }

    let special_dirs: [(&str, Option<PathBuf>, &str); 4] = [
        ("Home", dirs::home_dir(), "home"),
        ("Desktop", dirs::desktop_dir(), "folder"),
        ("Documents", dirs::document_dir(), "folder"),
        ("Downloads", dirs::download_dir(), "folder"),
    ];

    for (label, maybe_path, kind) in special_dirs {
        if let Some(p) = maybe_path {
            if p.exists() {
                drives.push(DriveInfo {
                    name: label.to_string(),
                    path: normalize_path(&p),
                    kind: kind.to_string(),
                    total_bytes: None,
                    available_bytes: None,
                });
            }
        }
    }

    Ok(drives)
}

#[tauri::command]
pub fn local_list_dir(path: Option<String>, show_hidden: bool) -> Result<DirectoryListing, String> {
    let target_dir = match path {
        Some(ref p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => dirs::home_dir()
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from(".")),
    };

    let resolved = fs::canonicalize(&target_dir).unwrap_or(target_dir);
    if !resolved.exists() {
        return Err(format!("Path does not exist: {}", resolved.display()));
    }
    if !resolved.is_dir() {
        return Err(format!("Path is not a directory: {}", resolved.display()));
    }

    let read_iter = fs::read_dir(&resolved)
        .map_err(|e| format!("Failed to read directory {}: {}", resolved.display(), e))?;

    let mut entries = Vec::new();
    let mut total_files = 0usize;
    let mut total_dirs = 0usize;
    let mut hidden_count = 0usize;
    let mut total_bytes = 0u64;

    for item in read_iter {
        let dir_entry = match item {
            Ok(e) => e,
            Err(_) => continue,
        };
        let item_path = dir_entry.path();
        let Ok(file_entry) = build_file_entry(&item_path) else {
            continue;
        };

        if file_entry.hidden {
            hidden_count += 1;
            if !show_hidden {
                continue;
            }
        }

        if file_entry.file_type == "dir" || file_entry.file_type == "symlink_dir" {
            total_dirs += 1;
        } else {
            total_files += 1;
            total_bytes += file_entry.size;
        }

        entries.push(file_entry);
    }

    let normalized = normalize_path(&resolved);
    let clean_path = PathBuf::from(&normalized);
    let parent_path = clean_path.parent().and_then(|p| {
        let ps = normalize_path(p);
        if ps.is_empty() || ps == normalized {
            None
        } else {
            Some(ps)
        }
    });
    let breadcrumbs = build_breadcrumbs(&clean_path);

    Ok(DirectoryListing {
        path: normalized,
        parent_path,
        breadcrumbs,
        entries,
        total_files,
        total_dirs,
        hidden_count,
        total_bytes,
    })
}

#[tauri::command]
pub fn local_create_dir(parent_path: String, name: String) -> Result<String, String> {
    let valid_name = validate_entry_name(&name)?;
    let target = PathBuf::from(&parent_path).join(&valid_name);
    if target.exists() {
        return Err(format!("Target already exists: {}", target.display()));
    }
    fs::create_dir_all(&target)
        .map_err(|e| format!("Failed to create directory {}: {}", target.display(), e))?;
    Ok(normalize_path(&target))
}

#[tauri::command]
pub fn local_create_file(parent_path: String, name: String) -> Result<String, String> {
    let valid_name = validate_entry_name(&name)?;
    let target = PathBuf::from(&parent_path).join(&valid_name);
    if target.exists() {
        return Err(format!("File already exists: {}", target.display()));
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| format!("Failed to create file {}: {}", target.display(), e))?;
    Ok(normalize_path(&target))
}

#[tauri::command]
pub fn local_rename(path: String, new_name: String) -> Result<String, String> {
    let valid_name = validate_entry_name(&new_name)?;
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(format!("Source does not exist: {}", src.display()));
    }
    let parent = src
        .parent()
        .ok_or_else(|| "Cannot rename root path".to_string())?;
    let dst = parent.join(&valid_name);
    if dst.exists() {
        return Err(format!("Destination already exists: {}", dst.display()));
    }
    fs::rename(&src, &dst)
        .map_err(|e| format!("Failed to rename {} to {}: {}", src.display(), dst.display(), e))?;
    Ok(normalize_path(&dst))
}

#[tauri::command]
pub fn local_delete(paths: Vec<String>, use_trash: bool) -> Result<usize, String> {
    if paths.is_empty() {
        return Ok(0);
    }

    if use_trash {
        let path_bufs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        trash::delete_all(&path_bufs)
            .map_err(|e| format!("Failed to move items to Recycle Bin: {}", e))?;
        return Ok(path_bufs.len());
    }

    let mut deleted = 0usize;
    for raw in paths {
        let p = PathBuf::from(&raw);
        let meta = fs::symlink_metadata(&p)
            .map_err(|e| format!("Failed to inspect {}: {}", p.display(), e))?;
        if meta.is_dir() && !meta.file_type().is_symlink() {
            fs::remove_dir_all(&p)
                .map_err(|e| format!("Failed to delete folder {}: {}", p.display(), e))?;
        } else {
            fs::remove_file(&p)
                .map_err(|e| format!("Failed to delete file {}: {}", p.display(), e))?;
        }
        deleted += 1;
    }
    Ok(deleted)
}

#[tauri::command]
pub fn local_copy_or_move(
    sources: Vec<String>,
    target_dir: String,
    is_move: bool,
) -> Result<usize, String> {
    let target_root = PathBuf::from(&target_dir);
    if !target_root.is_dir() {
        return Err(format!(
            "Target directory does not exist: {}",
            target_root.display()
        ));
    }

    let mut processed = 0usize;
    for raw_src in sources {
        let src = PathBuf::from(&raw_src);
        let file_name = src
            .file_name()
            .ok_or_else(|| format!("Invalid source path: {}", src.display()))?;
        let dst = target_root.join(file_name);

        if src == dst {
            continue;
        }
        if dst.starts_with(&src) {
            return Err(format!(
                "Cannot copy or move {} into itself",
                src.display()
            ));
        }

        if is_move {
            match fs::rename(&src, &dst) {
                Ok(()) => {
                    processed += 1;
                    continue;
                }
                Err(_) => {
                    // Cross-device move fallback: copy then delete source
                }
            }
        }

        let meta = fs::symlink_metadata(&src)
            .map_err(|e| format!("Failed to inspect {}: {}", src.display(), e))?;
        if meta.is_dir() && !meta.file_type().is_symlink() {
            copy_dir_recursive(&src, &dst)?;
            if is_move {
                fs::remove_dir_all(&src).map_err(|e| {
                    format!("Copied but failed to remove source {}: {}", src.display(), e)
                })?;
            }
        } else {
            fs::copy(&src, &dst).map_err(|e| {
                format!(
                    "Failed to copy {} to {}: {}",
                    src.display(),
                    dst.display(),
                    e
                )
            })?;
            if is_move {
                fs::remove_file(&src).map_err(|e| {
                    format!("Copied but failed to remove source {}: {}", src.display(), e)
                })?;
            }
        }
        processed += 1;
    }

    Ok(processed)
}

#[tauri::command]
pub async fn pick_private_key_file() -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_title("Select Private Key File")
        .add_filter("SSH Private Keys", &["ppk", "pem", "key", "pub"])
        .add_filter("All Files", &["*"]);
    if let Some(ssh_dir) = dirs::home_dir().map(|h| h.join(".ssh")).filter(|p| p.is_dir()) {
        dialog = dialog.set_directory(ssh_dir);
    }
    let picked = dialog.pick_file().await;
    Ok(picked.map(|f| f.path().to_string_lossy().to_string()))
}

#[tauri::command]
pub fn local_get_properties(
    path: String,
    calculate_dir_size: bool,
) -> Result<FileProperties, String> {
    let target = PathBuf::from(&path);
    let entry = build_file_entry(&target)?;
    let (item_count, calculated_size) =
        if calculate_dir_size && (entry.file_type == "dir" || entry.file_type == "symlink_dir") {
            calculate_dir_stats(&target)
        } else {
            (1, entry.size)
        };

    Ok(FileProperties {
        entry,
        item_count,
        calculated_size,
        sha256: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_temp_test_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "scpcraft_test_{}_{}",
            tag,
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_drives_and_breadcrumbs() {
        let drives = local_list_drives().unwrap();
        assert!(!drives.is_empty());

        let listing = local_list_dir(Some(drives[0].path.clone()), true).unwrap();
        assert!(!listing.breadcrumbs.is_empty());
    }

    #[test]
    fn test_local_crud_copy_move_properties_and_delete() {
        let root = make_temp_test_dir("crud");
        let root_str = normalize_path(&root);

        // Create directory & file
        let sub = local_create_dir(root_str.clone(), "alpha".to_string()).unwrap();
        let file = local_create_file(sub.clone(), "hello.txt".to_string()).unwrap();
        fs::write(&file, b"scpcraft test payload").unwrap();

        // Rename file
        let renamed = local_rename(file, "world.txt".to_string()).unwrap();
        assert!(renamed.ends_with("world.txt"));

        // List directory
        let listing = local_list_dir(Some(sub.clone()), false).unwrap();
        assert_eq!(listing.total_files, 1);
        assert_eq!(listing.entries[0].name, "world.txt");
        assert_eq!(listing.entries[0].size, 21);

        // Copy & Move
        let dest = local_create_dir(root_str.clone(), "beta".to_string()).unwrap();
        let copied = local_copy_or_move(vec![renamed.clone()], dest.clone(), false).unwrap();
        assert_eq!(copied, 1);
        assert!(Path::new(&dest).join("world.txt").exists());

        let dest_gamma = local_create_dir(root_str.clone(), "gamma".to_string()).unwrap();
        let moved = local_copy_or_move(vec![renamed.clone()], dest_gamma.clone(), true).unwrap();
        assert_eq!(moved, 1);
        assert!(!Path::new(&renamed).exists());
        assert!(Path::new(&dest_gamma).join("world.txt").exists());

        // Properties with recursive size
        let props = local_get_properties(root_str.clone(), true).unwrap();
        assert!(props.item_count >= 5);
        assert_eq!(props.calculated_size, 42);

        // Clean up permanently
        let deleted = local_delete(vec![root_str], false).unwrap();
        assert_eq!(deleted, 1);
        assert!(!root.exists());
    }
}
