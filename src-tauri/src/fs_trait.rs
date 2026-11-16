use crate::local_fs::DirectoryListing;
use crate::protocols::ftp::FtpRemoteFs;
use crate::protocols::opendal_fs::OpenDalRemoteFs;
use crate::sftp::ops::{
    self, join_remote_path, normalize_remote_path, RemoteFileProperties,
};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const DEFAULT_READ_LIMIT: u64 = 16 * 1024 * 1024;

/// Unified async file system abstraction shared across SFTP, FTP/FTPS, WebDAV, and S3 protocols.
#[allow(async_fn_in_trait)]
pub trait RemoteFileSystem: Send + Sync {
    fn protocol_name(&self) -> &'static str;

    async fn list_dir(&self, path: &str) -> Result<DirectoryListing, String>;

    async fn create_dir(
        &self,
        parent_path: &str,
        name: &str,
        octal_mode: Option<&str>,
    ) -> Result<String, String>;

    async fn create_file(&self, parent_path: &str, name: &str) -> Result<String, String>;

    async fn rename(&self, path: &str, new_name: &str) -> Result<String, String>;

    async fn delete(&self, paths: &[String]) -> Result<usize, String>;

    async fn create_symlink(
        &self,
        current_dir: &str,
        link_name: &str,
        target_path: &str,
        is_hard_link: bool,
    ) -> Result<String, String>;

    async fn get_properties(
        &self,
        path: &str,
        calculate_size: bool,
        checksum_alg: Option<&str>,
    ) -> Result<RemoteFileProperties, String>;

    async fn set_permissions(
        &self,
        paths: &[String],
        octal_mode: Option<&str>,
        owner_uid: Option<u32>,
        group_gid: Option<u32>,
        add_x_to_dirs: bool,
        recursive: bool,
    ) -> Result<usize, String>;

    async fn read_bytes(
        &self,
        path: &str,
        max_bytes: Option<u64>,
    ) -> Result<(Vec<u8>, Option<u64>), String>;

    async fn write_bytes(
        &self,
        path: &str,
        data: &[u8],
        mtime_ms: Option<u64>,
    ) -> Result<(), String>;
}

/// Wrapper implementing `RemoteFileSystem` over an active `russh_sftp` session.
#[derive(Clone)]
pub struct SftpFsAdapter {
    pub sftp: Arc<SftpSession>,
}

impl SftpFsAdapter {
    pub fn new(sftp: Arc<SftpSession>) -> Self {
        Self { sftp }
    }
}

impl RemoteFileSystem for SftpFsAdapter {
    fn protocol_name(&self) -> &'static str {
        "sftp"
    }

    async fn list_dir(&self, path: &str) -> Result<DirectoryListing, String> {
        ops::list_dir_with_sftp(&self.sftp, path).await
    }

    async fn create_dir(
        &self,
        parent_path: &str,
        name: &str,
        octal_mode: Option<&str>,
    ) -> Result<String, String> {
        ops::sftp_create_dir_with_session(&self.sftp, parent_path, name, octal_mode).await
    }

    async fn create_file(&self, parent_path: &str, name: &str) -> Result<String, String> {
        ops::sftp_create_file_with_session(&self.sftp, parent_path, name).await
    }

    async fn rename(&self, path: &str, new_name: &str) -> Result<String, String> {
        ops::sftp_rename_with_session(&self.sftp, path, new_name).await
    }

    async fn delete(&self, paths: &[String]) -> Result<usize, String> {
        ops::sftp_delete_with_session(&self.sftp, paths).await
    }

    async fn create_symlink(
        &self,
        current_dir: &str,
        link_name: &str,
        target_path: &str,
        is_hard_link: bool,
    ) -> Result<String, String> {
        ops::sftp_create_symlink_with_session(
            &self.sftp,
            current_dir,
            link_name,
            target_path,
            is_hard_link,
        )
        .await
    }

    async fn get_properties(
        &self,
        path: &str,
        calculate_size: bool,
        checksum_alg: Option<&str>,
    ) -> Result<RemoteFileProperties, String> {
        ops::sftp_get_properties_with_session(&self.sftp, path, calculate_size, checksum_alg).await
    }

    async fn set_permissions(
        &self,
        paths: &[String],
        octal_mode: Option<&str>,
        owner_uid: Option<u32>,
        group_gid: Option<u32>,
        add_x_to_dirs: bool,
        recursive: bool,
    ) -> Result<usize, String> {
        ops::sftp_set_permissions_with_session(
            &self.sftp,
            paths,
            octal_mode,
            owner_uid,
            group_gid,
            add_x_to_dirs,
            recursive,
        )
        .await
    }

    async fn read_bytes(
        &self,
        path: &str,
        max_bytes: Option<u64>,
    ) -> Result<(Vec<u8>, Option<u64>), String> {
        let meta = self
            .sftp
            .metadata(path)
            .await
            .map_err(|e| format!("Failed inspecting remote file {}: {}", path, e))?;
        let limit = max_bytes.unwrap_or(DEFAULT_READ_LIMIT);
        if meta.len() > limit {
            return Err(format!(
                "Remote file {} ({} bytes) exceeds {} byte limit",
                path,
                meta.len(),
                limit
            ));
        }
        let mut file = self
            .sftp
            .open_with_flags(path, OpenFlags::READ)
            .await
            .map_err(|e| format!("Failed opening remote file {}: {}", path, e))?;
        let mut buf = Vec::with_capacity(meta.len().min(limit) as usize);
        file.read_to_end(&mut buf)
            .await
            .map_err(|e| format!("Failed reading remote file {}: {}", path, e))?;
        let _ = file.shutdown().await;
        Ok((buf, meta.mtime.map(|s| (s as u64) * 1000)))
    }

    async fn write_bytes(
        &self,
        path: &str,
        data: &[u8],
        mtime_ms: Option<u64>,
    ) -> Result<(), String> {
        if let Some((parent, _)) = path.rsplit_once('/') {
            if !parent.is_empty() {
                let _ = crate::transfer::engine::ensure_remote_dir_all(&self.sftp, parent).await;
            }
        }
        let mut dst = self
            .sftp
            .open_with_flags(path, OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE)
            .await
            .map_err(|e| format!("Failed opening remote file {} for write: {}", path, e))?;
        dst.write_all(data)
            .await
            .map_err(|e| format!("Failed writing remote file {}: {}", path, e))?;
        dst.flush()
            .await
            .map_err(|e| format!("Failed flushing remote file {}: {}", path, e))?;
        dst.shutdown()
            .await
            .map_err(|e| format!("Failed closing remote file {}: {}", path, e))?;
        if let Some(ms) = mtime_ms {
            let secs = (ms / 1000) as u32;
            let mut attrs = FileAttributes::empty();
            attrs.atime = Some(secs);
            attrs.mtime = Some(secs);
            let _ = self.sftp.set_metadata(path, attrs).await;
        }
        Ok(())
    }
}

/// Polymorphic backend handle stored in `SftpSessionManager` for every active remote tab.
#[derive(Clone)]
pub enum AnyRemoteFs {
    Sftp(SftpFsAdapter),
    Ftp(Arc<FtpRemoteFs>),
    OpenDal(Arc<OpenDalRemoteFs>),
}

impl AnyRemoteFs {
    pub fn as_sftp(&self) -> Option<&Arc<SftpSession>> {
        match self {
            AnyRemoteFs::Sftp(adapter) => Some(&adapter.sftp),
            _ => None,
        }
    }

    pub async fn ensure_dir_all(&self, remote_dir: &str) -> Result<(), String> {
        if let Some(sftp) = self.as_sftp() {
            return crate::transfer::engine::ensure_remote_dir_all(sftp, remote_dir).await;
        }
        let clean = normalize_remote_path(remote_dir);
        if clean == "/" {
            return Ok(());
        }
        let mut parent = "/".to_string();
        for seg in clean.trim_start_matches('/').split('/').filter(|s| !s.is_empty()) {
            let _ = self.create_dir(&parent, seg, None).await;
            parent = join_remote_path(&parent, seg);
        }
        Ok(())
    }
}

impl RemoteFileSystem for AnyRemoteFs {
    fn protocol_name(&self) -> &'static str {
        match self {
            AnyRemoteFs::Sftp(a) => a.protocol_name(),
            AnyRemoteFs::Ftp(f) => f.protocol_name(),
            AnyRemoteFs::OpenDal(o) => o.protocol_name(),
        }
    }

    async fn list_dir(&self, path: &str) -> Result<DirectoryListing, String> {
        match self {
            AnyRemoteFs::Sftp(a) => a.list_dir(path).await,
            AnyRemoteFs::Ftp(f) => f.list_dir(path).await,
            AnyRemoteFs::OpenDal(o) => o.list_dir(path).await,
        }
    }

    async fn create_dir(
        &self,
        parent_path: &str,
        name: &str,
        octal_mode: Option<&str>,
    ) -> Result<String, String> {
        match self {
            AnyRemoteFs::Sftp(a) => a.create_dir(parent_path, name, octal_mode).await,
            AnyRemoteFs::Ftp(f) => f.create_dir(parent_path, name, octal_mode).await,
            AnyRemoteFs::OpenDal(o) => o.create_dir(parent_path, name, octal_mode).await,
        }
    }

    async fn create_file(&self, parent_path: &str, name: &str) -> Result<String, String> {
        match self {
            AnyRemoteFs::Sftp(a) => a.create_file(parent_path, name).await,
            AnyRemoteFs::Ftp(f) => f.create_file(parent_path, name).await,
            AnyRemoteFs::OpenDal(o) => o.create_file(parent_path, name).await,
        }
    }

    async fn rename(&self, path: &str, new_name: &str) -> Result<String, String> {
        match self {
            AnyRemoteFs::Sftp(a) => a.rename(path, new_name).await,
            AnyRemoteFs::Ftp(f) => f.rename(path, new_name).await,
            AnyRemoteFs::OpenDal(o) => o.rename(path, new_name).await,
        }
    }

    async fn delete(&self, paths: &[String]) -> Result<usize, String> {
        match self {
            AnyRemoteFs::Sftp(a) => a.delete(paths).await,
            AnyRemoteFs::Ftp(f) => f.delete(paths).await,
            AnyRemoteFs::OpenDal(o) => o.delete(paths).await,
        }
    }

    async fn create_symlink(
        &self,
        current_dir: &str,
        link_name: &str,
        target_path: &str,
        is_hard_link: bool,
    ) -> Result<String, String> {
        match self {
            AnyRemoteFs::Sftp(a) => {
                a.create_symlink(current_dir, link_name, target_path, is_hard_link)
                    .await
            }
            AnyRemoteFs::Ftp(f) => {
                f.create_symlink(current_dir, link_name, target_path, is_hard_link)
                    .await
            }
            AnyRemoteFs::OpenDal(o) => {
                o.create_symlink(current_dir, link_name, target_path, is_hard_link)
                    .await
            }
        }
    }

    async fn get_properties(
        &self,
        path: &str,
        calculate_size: bool,
        checksum_alg: Option<&str>,
    ) -> Result<RemoteFileProperties, String> {
        match self {
            AnyRemoteFs::Sftp(a) => a.get_properties(path, calculate_size, checksum_alg).await,
            AnyRemoteFs::Ftp(f) => f.get_properties(path, calculate_size, checksum_alg).await,
            AnyRemoteFs::OpenDal(o) => o.get_properties(path, calculate_size, checksum_alg).await,
        }
    }

    async fn set_permissions(
        &self,
        paths: &[String],
        octal_mode: Option<&str>,
        owner_uid: Option<u32>,
        group_gid: Option<u32>,
        add_x_to_dirs: bool,
        recursive: bool,
    ) -> Result<usize, String> {
        match self {
            AnyRemoteFs::Sftp(a) => {
                a.set_permissions(
                    paths,
                    octal_mode,
                    owner_uid,
                    group_gid,
                    add_x_to_dirs,
                    recursive,
                )
                .await
            }
            AnyRemoteFs::Ftp(f) => {
                f.set_permissions(
                    paths,
                    octal_mode,
                    owner_uid,
                    group_gid,
                    add_x_to_dirs,
                    recursive,
                )
                .await
            }
            AnyRemoteFs::OpenDal(o) => {
                o.set_permissions(
                    paths,
                    octal_mode,
                    owner_uid,
                    group_gid,
                    add_x_to_dirs,
                    recursive,
                )
                .await
            }
        }
    }

    async fn read_bytes(
        &self,
        path: &str,
        max_bytes: Option<u64>,
    ) -> Result<(Vec<u8>, Option<u64>), String> {
        match self {
            AnyRemoteFs::Sftp(a) => a.read_bytes(path, max_bytes).await,
            AnyRemoteFs::Ftp(f) => f.read_bytes(path, max_bytes).await,
            AnyRemoteFs::OpenDal(o) => o.read_bytes(path, max_bytes).await,
        }
    }

    async fn write_bytes(
        &self,
        path: &str,
        data: &[u8],
        mtime_ms: Option<u64>,
    ) -> Result<(), String> {
        match self {
            AnyRemoteFs::Sftp(a) => a.write_bytes(path, data, mtime_ms).await,
            AnyRemoteFs::Ftp(f) => f.write_bytes(path, data, mtime_ms).await,
            AnyRemoteFs::OpenDal(o) => o.write_bytes(path, data, mtime_ms).await,
        }
    }
}
