use crate::config::keyring_store;
use crate::config::winscp_ini::SiteProtocol;
use crate::fs_trait::{AnyRemoteFs, SftpFsAdapter};
use crate::protocols::{ftp, opendal_fs};
use crate::sftp::ppk::{self, KeyInspection};
use crate::sftp::session::{
    self, AuthFlowResult, LiveSftpSession, PendingAuthState, SftpConnectOutcome,
    SftpConnectRequest,
};
use russh::Disconnect;
use russh_sftp::client::SftpSession;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex as AsyncMutex;

#[derive(Clone)]
pub struct SftpSessionManager {
    sessions: Arc<AsyncMutex<HashMap<String, Arc<LiveSftpSession>>>>,
    remote_fs_map: Arc<AsyncMutex<HashMap<String, AnyRemoteFs>>>,
    pending_auths: Arc<AsyncMutex<HashMap<String, PendingAuthState>>>,
    pending_protocol_auths: Arc<AsyncMutex<HashMap<String, SftpConnectRequest>>>,
    session_trusted_hosts: Arc<StdMutex<HashSet<(String, u16, String)>>>,
}

impl Default for SftpSessionManager {
    fn default() -> Self {
        Self {
            sessions: Arc::new(AsyncMutex::new(HashMap::new())),
            remote_fs_map: Arc::new(AsyncMutex::new(HashMap::new())),
            pending_auths: Arc::new(AsyncMutex::new(HashMap::new())),
            pending_protocol_auths: Arc::new(AsyncMutex::new(HashMap::new())),
            session_trusted_hosts: Arc::new(StdMutex::new(HashSet::new())),
        }
    }
}

impl SftpSessionManager {
    pub async fn get_sftp(&self, session_id: &str) -> Result<Arc<SftpSession>, String> {
        let guard = self.sessions.lock().await;
        let session = guard
            .get(session_id)
            .ok_or_else(|| format!("No active SFTP session for tab '{}'", session_id))?;
        Ok(session.sftp.clone())
    }

    pub async fn get_remote_fs(&self, session_id: &str) -> Result<AnyRemoteFs, String> {
        {
            let guard = self.remote_fs_map.lock().await;
            if let Some(fs) = guard.get(session_id) {
                return Ok(fs.clone());
            }
        }
        let sftp = self.get_sftp(session_id).await?;
        let adapter = AnyRemoteFs::Sftp(SftpFsAdapter::new(sftp));
        self.remote_fs_map
            .lock()
            .await
            .insert(session_id.to_string(), adapter.clone());
        Ok(adapter)
    }

    pub async fn get_session(&self, session_id: &str) -> Result<Arc<LiveSftpSession>, String> {
        let guard = self.sessions.lock().await;
        let session = guard
            .get(session_id)
            .ok_or_else(|| format!("No active SFTP session for tab '{}'", session_id))?;
        Ok(session.clone())
    }

    fn snapshot_trusted_hosts(&self) -> HashSet<(String, u16, String)> {
        self.session_trusted_hosts
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    pub fn add_session_trusted_host(&self, host: String, port: u16, public_key_openssh: String) {
        if let Ok(mut guard) = self.session_trusted_hosts.lock() {
            guard.insert((host, port, public_key_openssh));
        }
    }

    async fn register_non_ssh_fs(&self, session_id: String, fs: AnyRemoteFs) {
        let prev_ssh = {
            let mut sguard = self.sessions.lock().await;
            sguard.remove(&session_id)
        };
        if let Some(prev) = prev_ssh {
            let ssh = prev.ssh.lock().await;
            let _ = ssh
                .disconnect(Disconnect::ByApplication, "Replaced session", "")
                .await;
        }
        self.remote_fs_map.lock().await.insert(session_id, fs);
    }

    async fn connect_non_ssh(&self, mut request: SftpConnectRequest) -> Result<SftpConnectOutcome, String> {
        if request.password.is_none() && !request.site.id.trim().is_empty() && request.site.has_password {
            request.password = keyring_store::get_site_secret(&request.site.id, "password");
        }
        match request.site.protocol {
            SiteProtocol::Ftp => match ftp::connect_ftp_session(&request).await? {
                Ok((fs, info)) => {
                    self.register_non_ssh_fs(request.session_id, AnyRemoteFs::Ftp(Arc::new(fs)))
                        .await;
                    Ok(SftpConnectOutcome::Connected(info))
                }
                Err(challenge) => {
                    self.pending_protocol_auths
                        .lock()
                        .await
                        .insert(challenge.challenge_id.clone(), request);
                    Ok(SftpConnectOutcome::AuthPrompt(challenge))
                }
            },
            SiteProtocol::WebDav | SiteProtocol::S3 => {
                match opendal_fs::connect_opendal_session(&request).await? {
                    Ok((fs, info)) => {
                        self.register_non_ssh_fs(
                            request.session_id,
                            AnyRemoteFs::OpenDal(Arc::new(fs)),
                        )
                        .await;
                        Ok(SftpConnectOutcome::Connected(info))
                    }
                    Err(challenge) => {
                        self.pending_protocol_auths
                            .lock()
                            .await
                            .insert(challenge.challenge_id.clone(), request);
                        Ok(SftpConnectOutcome::AuthPrompt(challenge))
                    }
                }
            }
            _ => Err("Expected non-SSH protocol".to_string()),
        }
    }

    async fn finalize_connected(
        &self,
        handle: russh::client::Handle<session::ScpCraftClientHandler>,
        tunnel_handle: Option<russh::client::Handle<session::ScpCraftClientHandler>>,
        session_id: String,
        site: &crate::config::winscp_ini::SiteConfig,
        method_used: String,
    ) -> Result<SftpConnectOutcome, String> {
        let (live, info) = session::open_sftp_subsystem(
            handle,
            tunnel_handle,
            session_id.clone(),
            site,
            method_used,
        )
        .await?;

        let sftp_arc = live.sftp.clone();
        // Close any previous live handle on the same session tab cleanly
        let old = {
            let mut guard = self.sessions.lock().await;
            guard.insert(session_id.clone(), Arc::new(live))
        };
        self.remote_fs_map
            .lock()
            .await
            .insert(session_id, AnyRemoteFs::Sftp(SftpFsAdapter::new(sftp_arc)));
        if let Some(prev) = old {
            let ssh = prev.ssh.lock().await;
            let _ = ssh
                .disconnect(Disconnect::ByApplication, "Replaced session", "")
                .await;
        }

        Ok(SftpConnectOutcome::Connected(info))
    }
}

#[tauri::command]
pub async fn sftp_connect(
    state: tauri::State<'_, SftpSessionManager>,
    request: SftpConnectRequest,
) -> Result<SftpConnectOutcome, String> {
    if matches!(
        request.site.protocol,
        SiteProtocol::Ftp | SiteProtocol::WebDav | SiteProtocol::S3
    ) {
        return state.connect_non_ssh(request).await;
    }

    let trusted = state.snapshot_trusted_hosts();
    let known_hosts_path = session::default_known_hosts_path();

    let flow = match session::start_connection_and_auth(&request, &trusted, &known_hosts_path)
        .await?
    {
        Ok(flow) => flow,
        Err(host_key_prompt) => return Ok(SftpConnectOutcome::HostKeyPrompt(host_key_prompt)),
    };

    match flow {
        AuthFlowResult::Authenticated {
            handle,
            tunnel_handle,
            method_used,
        } => {
            state
                .finalize_connected(
                    handle,
                    tunnel_handle,
                    request.session_id,
                    &request.site,
                    method_used,
                )
                .await
        }
        AuthFlowResult::NeedsInput(pending, challenge) => {
            let mut guard = state.pending_auths.lock().await;
            guard.insert(challenge.challenge_id.clone(), pending);
            Ok(SftpConnectOutcome::AuthPrompt(challenge))
        }
    }
}

#[tauri::command]
pub async fn sftp_connect_respond(
    state: tauri::State<'_, SftpSessionManager>,
    challenge_id: String,
    responses: Vec<String>,
    save_secret: bool,
) -> Result<SftpConnectOutcome, String> {
    if let Some(mut proto_req) = state.pending_protocol_auths.lock().await.remove(&challenge_id) {
        let supplied = responses.into_iter().next().unwrap_or_default();
        proto_req.password = Some(supplied.clone());
        let outcome = state.connect_non_ssh(proto_req.clone()).await?;
        if save_secret && !proto_req.site.id.trim().is_empty() && !supplied.is_empty() {
            let _ = keyring_store::set_site_secret(&proto_req.site.id, "password", &supplied);
        }
        return Ok(outcome);
    }

    let pending = {
        let mut guard = state.pending_auths.lock().await;
        guard
            .remove(&challenge_id)
            .ok_or_else(|| "Authentication challenge expired or cancelled".to_string())?
    };

    let session_id = pending.session_id.clone();
    let site = pending.site.clone();

    match session::continue_pending_auth(pending, responses, save_secret).await? {
        AuthFlowResult::Authenticated {
            handle,
            tunnel_handle,
            method_used,
        } => {
            state
                .finalize_connected(handle, tunnel_handle, session_id, &site, method_used)
                .await
        }
        AuthFlowResult::NeedsInput(next_pending, challenge) => {
            let mut guard = state.pending_auths.lock().await;
            guard.insert(challenge.challenge_id.clone(), next_pending);
            Ok(SftpConnectOutcome::AuthPrompt(challenge))
        }
    }
}

#[tauri::command]
pub async fn sftp_connect_cancel(
    state: tauri::State<'_, SftpSessionManager>,
    challenge_id: String,
) -> Result<(), String> {
    state.pending_protocol_auths.lock().await.remove(&challenge_id);
    let pending = {
        let mut guard = state.pending_auths.lock().await;
        guard.remove(&challenge_id)
    };
    if let Some(p) = pending {
        let _ = p
            .handle
            .disconnect(Disconnect::ByApplication, "User cancelled auth", "")
            .await;
    }
    Ok(())
}

#[tauri::command]
pub fn sftp_trust_host_key(
    state: tauri::State<'_, SftpSessionManager>,
    host: String,
    port: u16,
    public_key_openssh: String,
    save_permanently: bool,
) -> Result<(), String> {
    state.add_session_trusted_host(host.clone(), port, public_key_openssh.clone());
    if save_permanently {
        let kh_path = session::default_known_hosts_path();
        session::upsert_known_host_in_file(&kh_path, &host, port, &public_key_openssh)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_disconnect(
    state: tauri::State<'_, SftpSessionManager>,
    session_id: String,
) -> Result<(), String> {
    state.remote_fs_map.lock().await.remove(&session_id);
    let removed = {
        let mut guard = state.sessions.lock().await;
        guard.remove(&session_id)
    };
    if let Some(session) = removed {
        let ssh = session.ssh.lock().await;
        let _ = ssh
            .disconnect(Disconnect::ByApplication, "User disconnected", "")
            .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_session_status(
    state: tauri::State<'_, SftpSessionManager>,
    session_id: String,
) -> Result<bool, String> {
    {
        let guard = state.sessions.lock().await;
        if let Some(session) = guard.get(&session_id) {
            let ssh = session.ssh.lock().await;
            return Ok(!ssh.is_closed());
        }
    }
    Ok(state.remote_fs_map.lock().await.contains_key(&session_id))
}

#[tauri::command]
pub fn sftp_inspect_key_file(path: String) -> Result<KeyInspection, String> {
    ppk::inspect_key_file(Path::new(path.trim()))
}
