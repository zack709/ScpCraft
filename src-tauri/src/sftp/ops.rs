use crate::fs_trait::RemoteFileSystem;
use crate::local_fs::{BreadcrumbSegment, DirectoryListing, FileEntry};
use crate::sftp::manager::SftpSessionManager;
use russh_sftp::client::fs::Metadata;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::AsyncReadExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecksumEntry {
    pub algorithm: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileProperties {
    pub entry: FileEntry,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub owner_name: Option<String>,
    pub group_name: Option<String>,
    pub item_count: usize,
    pub calculated_size: u64,
    pub checksums: Vec<ChecksumEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocationProfile {
    pub id: String,
    pub name: String,
    pub local_path: String,
    pub remote_path: String,
    pub site_id: Option<String>,
}

/// Normalize a POSIX remote path, resolving `.` and `..` segments cleanly.
pub fn normalize_remote_path(raw: &str) -> String {
    let slash_fixed = raw.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for seg in slash_fixed.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    }
}

/// Join a POSIX remote base path with a relative entry or subpath.
pub fn join_remote_path(base: &str, child: &str) -> String {
    if child.starts_with('/') {
        return normalize_remote_path(child);
    }
    let clean_base = normalize_remote_path(base);
    if clean_base == "/" {
        normalize_remote_path(&format!("/{}", child))
    } else {
        normalize_remote_path(&format!("{}/{}", clean_base, child))
    }
}

/// Return the parent POSIX path if the given path is not root `"/"`.
pub fn remote_parent_path(path: &str) -> Option<String> {
    let clean = normalize_remote_path(path);
    if clean == "/" {
        return None;
    }
    match clean.rfind('/') {
        Some(0) => Some("/".to_string()),
        Some(idx) => Some(clean[..idx].to_string()),
        None => Some("/".to_string()),
    }
}

/// Split a POSIX path into clickable breadcrumb segments.
pub fn build_remote_breadcrumbs(path: &str) -> Vec<BreadcrumbSegment> {
    let clean = normalize_remote_path(path);
    let mut segments = vec![BreadcrumbSegment {
        label: "/".to_string(),
        path: "/".to_string(),
    }];
    if clean == "/" {
        return segments;
    }
    let mut accum = String::new();
    for part in clean.trim_start_matches('/').split('/') {
        if part.is_empty() {
            continue;
        }
        accum.push('/');
        accum.push_str(part);
        segments.push(BreadcrumbSegment {
            label: part.to_string(),
            path: accum.clone(),
        });
    }
    segments
}

/// Validate a single file or directory name (non-empty, not `.` or `..`, no separators).
pub fn validate_remote_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("Invalid file or directory name".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("Name cannot contain path separators".to_string());
    }
    Ok(trimmed.to_string())
}

/// Parse an octal POSIX permission string such as `"755"`, `"0755"`, or `"4755"`.
pub fn parse_octal_mode(octal: &str) -> Result<u32, String> {
    let trimmed = octal.trim();
    if trimmed.is_empty() || trimmed.len() > 4 || !trimmed.chars().all(|c| ('0'..='7').contains(&c))
    {
        return Err(format!("Invalid octal permissions: '{}'", octal));
    }
    u32::from_str_radix(trimmed, 8).map_err(|_| format!("Invalid octal permissions: '{}'", octal))
}

/// Apply WinSCP `Add X to directories` logic: grant `+x` wherever corresponding `+r` is set.
pub fn apply_add_x_to_dirs(mode: u32, is_dir: bool, add_x_to_dirs: bool) -> u32 {
    if !add_x_to_dirs || !is_dir {
        return mode & 0o7777;
    }
    let mut next = mode & 0o7777;
    if (next & 0o400) != 0 {
        next |= 0o100;
    }
    if (next & 0o040) != 0 {
        next |= 0o010;
    }
    if (next & 0o004) != 0 {
        next |= 0o001;
    }
    next
}

/// Format POSIX permission bits into `(rwxr-xr-x text, 4-digit octal)` representation.
pub fn format_posix_permissions(raw_perm: u32, is_dir: bool, is_symlink: bool) -> (String, String) {
    let mode = raw_perm & 0o7777;
    let prefix = if is_symlink {
        'l'
    } else if is_dir {
        'd'
    } else {
        '-'
    };

    let mut text = String::with_capacity(10);
    text.push(prefix);
    text.push(if (mode & 0o400) != 0 { 'r' } else { '-' });
    text.push(if (mode & 0o200) != 0 { 'w' } else { '-' });
    text.push(match ((mode & 0o100) != 0, (mode & 0o4000) != 0) {
        (true, true) => 's',
        (false, true) => 'S',
        (true, false) => 'x',
        (false, false) => '-',
    });

    text.push(if (mode & 0o040) != 0 { 'r' } else { '-' });
    text.push(if (mode & 0o020) != 0 { 'w' } else { '-' });
    text.push(match ((mode & 0o010) != 0, (mode & 0o2000) != 0) {
        (true, true) => 's',
        (false, true) => 'S',
        (true, false) => 'x',
        (false, false) => '-',
    });

    text.push(if (mode & 0o004) != 0 { 'r' } else { '-' });
    text.push(if (mode & 0o002) != 0 { 'w' } else { '-' });
    text.push(match ((mode & 0o001) != 0, (mode & 0o1000) != 0) {
        (true, true) => 't',
        (false, true) => 'T',
        (true, false) => 'x',
        (false, false) => '-',
    });

    (text, format!("{:04o}", mode))
}

pub fn extract_extension(name: &str, is_dir: bool) -> String {
    if is_dir {
        return String::new();
    }
    let clean = name.trim_start_matches('.');
    match clean.rfind('.') {
        Some(idx) if idx + 1 < clean.len() => clean[idx + 1..].to_string(),
        _ => String::new(),
    }
}

fn build_remote_entry(
    name: String,
    full_path: String,
    lstat_meta: &Metadata,
    target_meta: Option<&Metadata>,
    symlink_target: Option<String>,
) -> FileEntry {
    let is_symlink = lstat_meta.is_symlink();
    let effective = target_meta.unwrap_or(lstat_meta);
    let is_dir = effective.is_dir();

    let file_type = if is_symlink && is_dir {
        "symlink_dir".to_string()
    } else if is_symlink {
        "symlink".to_string()
    } else if is_dir {
        "dir".to_string()
    } else {
        "file".to_string()
    };

    let default_perm = if is_dir { 0o755 } else { 0o644 };
    let perm_bits = lstat_meta
        .permissions
        .or(effective.permissions)
        .unwrap_or(default_perm);
    let (permissions_text, octal_mode) = format_posix_permissions(perm_bits, is_dir, is_symlink);
    let readonly = (perm_bits & 0o222) == 0;

    FileEntry {
        extension: extract_extension(&name, is_dir),
        hidden: name.starts_with('.'),
        name,
        path: full_path,
        file_type,
        size: if is_dir { 0 } else { effective.len() },
        modified_ms: effective.mtime.map(|s| (s as u64) * 1000),
        created_ms: None,
        readonly,
        system: false,
        permissions_text,
        octal_mode,
        symlink_target,
    }
}

async fn resolve_remote_dir_path(sftp: &SftpSession, raw_path: &str) -> String {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == "~" {
        if let Ok(canon) = sftp.canonicalize(".").await {
            return normalize_remote_path(&canon);
        }
        return "/".to_string();
    }
    if let Some(sub) = trimmed.strip_prefix("~/") {
        if let Ok(home) = sftp.canonicalize(".").await {
            return join_remote_path(&home, sub);
        }
    }
    normalize_remote_path(trimmed)
}

pub async fn list_dir_with_sftp(
    sftp: &Arc<SftpSession>,
    path: &str,
) -> Result<DirectoryListing, String> {
    let target = resolve_remote_dir_path(sftp, path).await;
    let resolved = match sftp.canonicalize(&target).await {
        Ok(canon) => normalize_remote_path(&canon),
        Err(_) => target,
    };

    let read_dir = sftp
        .read_dir(&resolved)
        .await
        .map_err(|e| format!("Failed to read remote directory {}: {}", resolved, e))?;

    let mut entries = Vec::new();
    let mut total_files = 0usize;
    let mut total_dirs = 0usize;
    let mut hidden_count = 0usize;
    let mut total_bytes = 0u64;

    for dir_entry in read_dir {
        let name = dir_entry.file_name();
        if name == "." || name == ".." || name.is_empty() {
            continue;
        }
        let full_path = join_remote_path(&resolved, &name);
        let lstat_meta = dir_entry.metadata();

        let (target_meta, symlink_target) = if lstat_meta.is_symlink() {
            let link_target = sftp.read_link(&full_path).await.ok();
            let stat_meta = sftp.metadata(&full_path).await.ok();
            (stat_meta, link_target)
        } else {
            (None, None)
        };

        let entry = build_remote_entry(
            name,
            full_path,
            &lstat_meta,
            target_meta.as_ref(),
            symlink_target,
        );

        if entry.hidden {
            hidden_count += 1;
        }
        if entry.file_type == "dir" || entry.file_type == "symlink_dir" {
            total_dirs += 1;
        } else {
            total_files += 1;
            total_bytes = total_bytes.saturating_add(entry.size);
        }

        entries.push(entry);
    }

    entries.sort_by(|a, b| {
        let a_dir = a.file_type == "dir" || a.file_type == "symlink_dir";
        let b_dir = b.file_type == "dir" || b.file_type == "symlink_dir";
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(DirectoryListing {
        parent_path: remote_parent_path(&resolved),
        breadcrumbs: build_remote_breadcrumbs(&resolved),
        path: resolved,
        entries,
        total_files,
        total_dirs,
        hidden_count,
        total_bytes,
    })
}

pub async fn delete_remote_dir_recursive(sftp: &SftpSession, root: &str) -> Result<(), String> {
    let mut stack: Vec<(String, bool)> = vec![(root.to_string(), false)];
    let mut visited: HashSet<String> = HashSet::new();

    while let Some((dir_path, expanded)) = stack.pop() {
        if expanded {
            sftp.remove_dir(&dir_path)
                .await
                .map_err(|e| format!("Failed to remove remote directory {}: {}", dir_path, e))?;
            continue;
        }

        if !visited.insert(dir_path.clone()) {
            continue;
        }

        stack.push((dir_path.clone(), true));

        let read_dir = sftp
            .read_dir(&dir_path)
            .await
            .map_err(|e| format!("Failed to read remote directory {}: {}", dir_path, e))?;
        for entry in read_dir {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child_path = join_remote_path(&dir_path, &name);
            let meta = entry.metadata();
            if meta.is_dir() && !meta.is_symlink() {
                stack.push((child_path, false));
            } else {
                sftp.remove_file(&child_path)
                    .await
                    .map_err(|e| format!("Failed to remove remote item {}: {}", child_path, e))?;
            }
        }
    }

    Ok(())
}

async fn calculate_remote_dir_stats(sftp: &SftpSession, root: &str) -> (usize, u64) {
    let mut count = 0usize;
    let mut total_size = 0u64;
    let mut stack = vec![root.to_string()];

    while let Some(dir_path) = stack.pop() {
        if let Ok(read_dir) = sftp.read_dir(&dir_path).await {
            for entry in read_dir {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                count += 1;
                let meta = entry.metadata();
                if meta.is_dir() && !meta.is_symlink() {
                    stack.push(join_remote_path(&dir_path, &name));
                } else {
                    total_size = total_size.saturating_add(meta.len());
                }
            }
        }
    }

    (count, total_size)
}

pub fn crc32_ieee_update(mut crc: u32, data: &[u8]) -> u32 {
    crc = !crc;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB88320 & mask);
        }
    }
    !crc
}

pub fn compute_bytes_checksums(data: &[u8], alg: &str) -> Vec<ChecksumEntry> {
    let want_all = alg.eq_ignore_ascii_case("all");
    let want_sha256 =
        want_all || alg.eq_ignore_ascii_case("sha-256") || alg.eq_ignore_ascii_case("sha256");
    let want_sha512 =
        want_all || alg.eq_ignore_ascii_case("sha-512") || alg.eq_ignore_ascii_case("sha512");
    let want_crc32 = want_all || alg.eq_ignore_ascii_case("crc32");

    let mut results = Vec::new();
    if want_sha256 {
        let hex: String = Sha256::digest(data)
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        results.push(ChecksumEntry {
            algorithm: "SHA-256".to_string(),
            value: hex,
        });
    }
    if want_sha512 {
        let hex: String = Sha512::digest(data)
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        results.push(ChecksumEntry {
            algorithm: "SHA-512".to_string(),
            value: hex,
        });
    }
    if want_crc32 {
        results.push(ChecksumEntry {
            algorithm: "CRC32".to_string(),
            value: format!("{:08x}", crc32_ieee_update(0, data)),
        });
    }
    results
}

pub async fn compute_remote_checksums(
    sftp: &SftpSession,
    path: &str,
    alg: &str,
) -> Result<Vec<ChecksumEntry>, String> {
    let want_all = alg.eq_ignore_ascii_case("all");
    let want_sha256 = want_all || alg.eq_ignore_ascii_case("sha-256") || alg.eq_ignore_ascii_case("sha256");
    let want_sha512 = want_all || alg.eq_ignore_ascii_case("sha-512") || alg.eq_ignore_ascii_case("sha512");
    let want_crc32 = want_all || alg.eq_ignore_ascii_case("crc32");

    let mut file = sftp
        .open(path)
        .await
        .map_err(|e| format!("Failed opening remote file {} for checksum: {}", path, e))?;

    let mut sha256_hasher = Sha256::new();
    let mut sha512_hasher = Sha512::new();
    let mut crc32_acc = 0u32;
    let mut buf = vec![0u8; 65536];

    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| format!("Failed reading remote file {} for checksum: {}", path, e))?;
        if n == 0 {
            break;
        }
        let chunk = &buf[..n];
        if want_sha256 {
            sha256_hasher.update(chunk);
        }
        if want_sha512 {
            sha512_hasher.update(chunk);
        }
        if want_crc32 {
            crc32_acc = crc32_ieee_update(crc32_acc, chunk);
        }
    }

    let mut results = Vec::new();
    if want_sha256 {
        let hex: String = sha256_hasher
            .finalize()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        results.push(ChecksumEntry {
            algorithm: "SHA-256".to_string(),
            value: hex,
        });
    }
    if want_sha512 {
        let hex: String = sha512_hasher
            .finalize()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        results.push(ChecksumEntry {
            algorithm: "SHA-512".to_string(),
            value: hex,
        });
    }
    if want_crc32 {
        results.push(ChecksumEntry {
            algorithm: "CRC32".to_string(),
            value: format!("{:08x}", crc32_acc),
        });
    }

    Ok(results)
}

#[tauri::command]
pub async fn sftp_list_dir(
    state: tauri::State<'_, SftpSessionManager>,
    session_id: String,
    path: String,
) -> Result<DirectoryListing, String> {
    let fs = state.get_remote_fs(&session_id).await?;
    fs.list_dir(&path).await
}

pub async fn sftp_create_dir_with_session(
    sftp: &SftpSession,
    parent_path: &str,
    name: &str,
    octal_mode: Option<&str>,
) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Directory name cannot be empty".to_string());
    }

    let parsed_mode = match octal_mode.map(str::trim).filter(|s| !s.is_empty()) {
        Some(mode_str) => Some(parse_octal_mode(mode_str)?),
        None => None,
    };

    let target = join_remote_path(parent_path, trimmed);
    if target == "/" {
        return Err("Cannot create root directory".to_string());
    }

    // Create intermediate parents if user entered a multi-segment path (matching WinSCP behavior)
    let segments: Vec<&str> = target
        .trim_start_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    let mut accum = String::new();
    let last_idx = segments.len().saturating_sub(1);

    for (idx, seg) in segments.iter().enumerate() {
        accum.push('/');
        accum.push_str(seg);
        if sftp.symlink_metadata(&accum).await.is_ok() {
            if idx == last_idx {
                return Err(format!("Remote directory already exists: {}", accum));
            }
            continue;
        }
        sftp.create_dir(&accum)
            .await
            .map_err(|e| format!("Failed creating remote directory {}: {}", accum, e))?;
        if let Some(mode) = parsed_mode {
            let mut attrs = FileAttributes::empty();
            attrs.permissions = Some(mode);
            let _ = sftp.set_metadata(&accum, attrs).await;
        }
    }

    Ok(target)
}

#[tauri::command]
pub async fn sftp_create_dir(
    state: tauri::State<'_, SftpSessionManager>,
    session_id: String,
    parent_path: String,
    name: String,
    octal_mode: Option<String>,
) -> Result<String, String> {
    let fs = state.get_remote_fs(&session_id).await?;
    fs.create_dir(&parent_path, &name, octal_mode.as_deref())
        .await
}

pub async fn sftp_create_file_with_session(
    sftp: &SftpSession,
    parent_path: &str,
    name: &str,
) -> Result<String, String> {
    let valid_name = validate_remote_name(name)?;
    let target = join_remote_path(parent_path, &valid_name);

    if sftp.symlink_metadata(&target).await.is_ok() {
        return Err(format!("Remote file already exists: {}", target));
    }

    let _file = sftp
        .open_with_flags(
            &target,
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE | OpenFlags::READ,
        )
        .await
        .map_err(|e| format!("Failed creating remote file {}: {}", target, e))?;

    Ok(target)
}

#[tauri::command]
pub async fn sftp_create_file(
    state: tauri::State<'_, SftpSessionManager>,
    session_id: String,
    parent_path: String,
    name: String,
) -> Result<String, String> {
    let fs = state.get_remote_fs(&session_id).await?;
    fs.create_file(&parent_path, &name).await
}

pub async fn sftp_rename_with_session(
    sftp: &SftpSession,
    path: &str,
    new_name: &str,
) -> Result<String, String> {
    let clean_src = normalize_remote_path(path);
    if clean_src == "/" {
        return Err("Cannot rename root directory".to_string());
    }
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("New name cannot be empty".to_string());
    }

    let dst = if trimmed.contains('/') {
        if trimmed.starts_with('/') {
            normalize_remote_path(trimmed)
        } else {
            let parent = remote_parent_path(&clean_src).unwrap_or_else(|| "/".to_string());
            join_remote_path(&parent, trimmed)
        }
    } else {
        let valid_name = validate_remote_name(trimmed)?;
        let parent = remote_parent_path(&clean_src).unwrap_or_else(|| "/".to_string());
        join_remote_path(&parent, &valid_name)
    };

    if dst == clean_src {
        return Ok(dst);
    }

    sftp.rename(&clean_src, &dst)
        .await
        .map_err(|e| format!("Failed renaming {} to {}: {}", clean_src, dst, e))?;

    Ok(dst)
}

#[tauri::command]
pub async fn sftp_rename(
    state: tauri::State<'_, SftpSessionManager>,
    session_id: String,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let fs = state.get_remote_fs(&session_id).await?;
    fs.rename(&path, &new_name).await
}

pub async fn sftp_delete_with_session(
    sftp: &SftpSession,
    paths: &[String],
) -> Result<usize, String> {
    let mut deleted = 0usize;

    for raw in paths {
        let clean = normalize_remote_path(raw);
        if clean == "/" {
            return Err("Refusing to delete root directory '/'".to_string());
        }
        let meta = sftp
            .symlink_metadata(&clean)
            .await
            .map_err(|e| format!("Failed inspecting remote path {}: {}", clean, e))?;

        if meta.is_dir() && !meta.is_symlink() {
            delete_remote_dir_recursive(sftp, &clean).await?;
        } else {
            sftp.remove_file(&clean)
                .await
                .map_err(|e| format!("Failed deleting remote item {}: {}", clean, e))?;
        }
        deleted += 1;
    }

    Ok(deleted)
}

#[tauri::command]
pub async fn sftp_delete(
    state: tauri::State<'_, SftpSessionManager>,
    session_id: String,
    paths: Vec<String>,
) -> Result<usize, String> {
    let fs = state.get_remote_fs(&session_id).await?;
    fs.delete(&paths).await
}

pub async fn sftp_create_symlink_with_session(
    sftp: &SftpSession,
    current_dir: &str,
    link_name: &str,
    target_path: &str,
    is_hard_link: bool,
) -> Result<String, String> {
    let trimmed_link = link_name.trim();
    let trimmed_target = target_path.trim();
    if trimmed_link.is_empty() || trimmed_target.is_empty() {
        return Err("Both link name and target path are required".to_string());
    }

    let link_full = join_remote_path(current_dir, trimmed_link);
    if is_hard_link {
        let target_full = join_remote_path(current_dir, trimmed_target);
        let ok = sftp
            .hardlink(&target_full, &link_full)
            .await
            .map_err(|e| format!("Failed creating hard link {}: {}", link_full, e))?;
        if !ok {
            return Err("Remote SFTP server does not support hardlink@openssh.com extension".to_string());
        }
    } else {
        // OpenSSH sftp-server expects SSH_FXP_SYMLINK args in (target, link_path) order, matching russh-sftp's client example.
        sftp.symlink(trimmed_target, &link_full)
            .await
            .map_err(|e| format!("Failed creating symbolic link {}: {}", link_full, e))?;
    }

    Ok(link_full)
}

#[tauri::command]
pub async fn sftp_create_symlink(
    state: tauri::State<'_, SftpSessionManager>,
    session_id: String,
    current_dir: String,
    link_name: String,
    target_path: String,
    is_hard_link: bool,
) -> Result<String, String> {
    let fs = state.get_remote_fs(&session_id).await?;
    fs.create_symlink(&current_dir, &link_name, &target_path, is_hard_link)
        .await
}

pub async fn sftp_get_properties_with_session(
    sftp: &SftpSession,
    path: &str,
    calculate_size: bool,
    checksum_alg: Option<&str>,
) -> Result<RemoteFileProperties, String> {
    let clean = normalize_remote_path(path);

    let lstat_meta = sftp
        .symlink_metadata(&clean)
        .await
        .map_err(|e| format!("Failed reading metadata for {}: {}", clean, e))?;

    let (target_meta, symlink_target) = if lstat_meta.is_symlink() {
        let link_target = sftp.read_link(&clean).await.ok();
        let stat_meta = sftp.metadata(&clean).await.ok();
        (stat_meta, link_target)
    } else {
        (None, None)
    };

    let name = clean
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("/")
        .to_string();

    let entry = build_remote_entry(
        name,
        clean.clone(),
        &lstat_meta,
        target_meta.as_ref(),
        symlink_target,
    );

    let effective = target_meta.as_ref().unwrap_or(&lstat_meta);
    let is_dir = effective.is_dir();

    let (item_count, calculated_size) = if is_dir && calculate_size {
        calculate_remote_dir_stats(sftp, &clean).await
    } else if is_dir {
        (0, 0)
    } else {
        (1, effective.len())
    };

    let checksums = if !is_dir {
        if let Some(alg) = checksum_alg {
            compute_remote_checksums(sftp, &clean, alg).await?
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    Ok(RemoteFileProperties {
        entry,
        uid: effective.uid,
        gid: effective.gid,
        owner_name: effective.user.clone(),
        group_name: effective.group.clone(),
        item_count,
        calculated_size,
        checksums,
    })
}

#[tauri::command]
pub async fn sftp_get_properties(
    state: tauri::State<'_, SftpSessionManager>,
    session_id: String,
    path: String,
    calculate_size: bool,
    checksum_alg: Option<String>,
) -> Result<RemoteFileProperties, String> {
    let fs = state.get_remote_fs(&session_id).await?;
    fs.get_properties(&path, calculate_size, checksum_alg.as_deref())
        .await
}

pub async fn sftp_set_permissions_with_session(
    sftp: &SftpSession,
    paths: &[String],
    octal_mode: Option<&str>,
    owner_uid: Option<u32>,
    group_gid: Option<u32>,
    add_x_to_dirs: bool,
    recursive: bool,
) -> Result<usize, String> {
    let parsed_mode = match octal_mode.map(str::trim).filter(|s| !s.is_empty()) {
        Some(m) => Some(parse_octal_mode(m)?),
        None => None,
    };

    let mut updated = 0usize;
    let mut stack: Vec<String> = paths.iter().map(|p| normalize_remote_path(p)).collect();
    let mut visited: HashSet<String> = HashSet::new();

    while let Some(target) = stack.pop() {
        if !visited.insert(target.clone()) {
            continue;
        }
        let meta = sftp
            .symlink_metadata(&target)
            .await
            .map_err(|e| format!("Failed inspecting remote path {}: {}", target, e))?;

        let is_dir = meta.is_dir() && !meta.is_symlink();
        if !meta.is_symlink() {
            let mut attrs = FileAttributes::empty();
            if let Some(base_mode) = parsed_mode {
                attrs.permissions = Some(apply_add_x_to_dirs(base_mode, is_dir, add_x_to_dirs));
            }
            if owner_uid.is_some() || group_gid.is_some() {
                attrs.uid = owner_uid.or(meta.uid);
                attrs.gid = group_gid.or(meta.gid);
            }
            sftp.set_metadata(&target, attrs)
                .await
                .map_err(|e| format!("Failed updating permissions on {}: {}", target, e))?;
            updated += 1;
        }

        if recursive && is_dir {
            let read_dir = sftp
                .read_dir(&target)
                .await
                .map_err(|e| format!("Failed traversing {}: {}", target, e))?;
            for child in read_dir {
                let name = child.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                stack.push(join_remote_path(&target, &name));
            }
        }
    }

    Ok(updated)
}

#[tauri::command]
pub async fn sftp_set_permissions(
    state: tauri::State<'_, SftpSessionManager>,
    session_id: String,
    paths: Vec<String>,
    octal_mode: Option<String>,
    owner_uid: Option<u32>,
    group_gid: Option<u32>,
    add_x_to_dirs: bool,
    recursive: bool,
) -> Result<usize, String> {
    let fs = state.get_remote_fs(&session_id).await?;
    fs.set_permissions(
        &paths,
        octal_mode.as_deref(),
        owner_uid,
        group_gid,
        add_x_to_dirs,
        recursive,
    )
    .await
}

fn default_bookmarks_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ScpCraft")
        .join("bookmarks.json")
}

pub fn load_bookmarks_from_path(
    path: &PathBuf,
    site_id: Option<&str>,
) -> Result<Vec<LocationProfile>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw =
        fs::read_to_string(path).map_err(|e| format!("Failed to read bookmarks.json: {}", e))?;
    let all: Vec<LocationProfile> =
        serde_json::from_str(&raw).map_err(|e| format!("Failed to parse bookmarks.json: {}", e))?;
    match site_id {
        Some(sid) => Ok(all
            .into_iter()
            .filter(|b| b.site_id.is_none() || b.site_id.as_deref() == Some(sid))
            .collect()),
        None => Ok(all),
    }
}

pub fn save_bookmarks_to_path(
    path: &PathBuf,
    bookmarks: Vec<LocationProfile>,
) -> Result<Vec<LocationProfile>, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed creating bookmarks config directory: {}", e))?;
    }
    let json = serde_json::to_string_pretty(&bookmarks)
        .map_err(|e| format!("Failed serializing bookmarks: {}", e))?;
    fs::write(path, json).map_err(|e| format!("Failed writing bookmarks.json: {}", e))?;
    Ok(bookmarks)
}

#[tauri::command]
pub fn sftp_list_bookmarks(site_id: Option<String>) -> Result<Vec<LocationProfile>, String> {
    load_bookmarks_from_path(&default_bookmarks_path(), site_id.as_deref())
}

#[tauri::command]
pub fn sftp_save_bookmarks(
    bookmarks: Vec<LocationProfile>,
) -> Result<Vec<LocationProfile>, String> {
    save_bookmarks_to_path(&default_bookmarks_path(), bookmarks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn posix_path_normalization_and_breadcrumbs() {
        assert_eq!(normalize_remote_path("/"), "/");
        assert_eq!(normalize_remote_path("//var//log/../www/"), "/var/www");
        assert_eq!(normalize_remote_path("a\\b\\c"), "/a/b/c");
        assert_eq!(join_remote_path("/var/www", "html/index.html"), "/var/www/html/index.html");
        assert_eq!(join_remote_path("/var/www", "/etc/nginx"), "/etc/nginx");
        assert_eq!(remote_parent_path("/"), None);
        assert_eq!(remote_parent_path("/etc"), Some("/".to_string()));
        assert_eq!(remote_parent_path("/var/www"), Some("/var".to_string()));

        let crumbs = build_remote_breadcrumbs("/var/www");
        assert_eq!(crumbs.len(), 3);
        assert_eq!(crumbs[0].path, "/");
        assert_eq!(crumbs[1].label, "var");
        assert_eq!(crumbs[2].path, "/var/www");
    }

    #[test]
    fn posix_mode_formatting_and_add_x_to_dirs() {
        assert_eq!(parse_octal_mode("755").unwrap(), 0o755);
        assert_eq!(parse_octal_mode("4755").unwrap(), 0o4755);
        assert!(parse_octal_mode("0899").is_err());

        assert_eq!(
            format_posix_permissions(0o755, true, false),
            ("drwxr-xr-x".to_string(), "0755".to_string())
        );
        assert_eq!(
            format_posix_permissions(0o4755, false, false),
            ("-rwsr-xr-x".to_string(), "4755".to_string())
        );
        assert_eq!(
            format_posix_permissions(0o1777, true, false),
            ("drwxrwxrwt".to_string(), "1777".to_string())
        );

        assert_eq!(apply_add_x_to_dirs(0o644, true, true), 0o755);
        assert_eq!(apply_add_x_to_dirs(0o640, true, true), 0o750);
        assert_eq!(apply_add_x_to_dirs(0o644, false, true), 0o644);
    }

    #[test]
    fn bookmarks_roundtrip_and_site_filtering() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("scpcraft_bm_{}", nanos));
        let path = dir.join("bookmarks.json");

        let saved = vec![
            LocationProfile {
                id: "bm_1".to_string(),
                name: "Shared Web Root".to_string(),
                local_path: "E:\\Projects".to_string(),
                remote_path: "/var/www".to_string(),
                site_id: None,
            },
            LocationProfile {
                id: "bm_2".to_string(),
                name: "Prod Logs".to_string(),
                local_path: "".to_string(),
                remote_path: "/var/log/app".to_string(),
                site_id: Some("site-prod".to_string()),
            },
            LocationProfile {
                id: "bm_3".to_string(),
                name: "Staging".to_string(),
                local_path: "".to_string(),
                remote_path: "/srv/stage".to_string(),
                site_id: Some("site-stage".to_string()),
            },
        ];

        save_bookmarks_to_path(&path, saved).unwrap();
        let prod_only = load_bookmarks_from_path(&path, Some("site-prod")).unwrap();
        assert_eq!(prod_only.len(), 2);
        assert_eq!(prod_only[0].id, "bm_1");
        assert_eq!(prod_only[1].id, "bm_2");

        let _ = fs::remove_dir_all(&dir);
    }
}
