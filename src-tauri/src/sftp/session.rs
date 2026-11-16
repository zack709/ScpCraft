use crate::config::keyring_store;
use crate::config::winscp_ini::SiteConfig;
use crate::local_fs::DirectoryListing;
use crate::sftp::ops;
use crate::sftp::ppk::{self, KeyDecodeOutcome};
use russh::client::{self, AuthResult, KeyboardInteractiveAuthResponse};
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::AgentIdentity;
use russh::keys::known_hosts::{check_known_hosts_path, learn_known_hosts_path};
use russh::keys::{Algorithm, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::MethodKind;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpConnectRequest {
    pub session_id: String,
    pub site: SiteConfig,
    pub password: Option<String>,
    pub passphrase: Option<String>,
    pub tunnel_password: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPromptInfo {
    pub status: String,
    pub is_tunnel: bool,
    pub host: String,
    pub port: u16,
    pub key_algorithm: String,
    pub fingerprint_sha256: String,
    pub fingerprint_sha512: String,
    pub public_key_openssh: String,
    pub known_hosts_path: String,
    pub mismatch_line: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPromptItem {
    pub id: String,
    pub prompt: String,
    pub echo: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthChallengeInfo {
    pub challenge_id: String,
    pub session_id: String,
    pub site_id: String,
    pub host: String,
    pub port: u16,
    pub user_name: String,
    pub auth_kind: String,
    pub title: String,
    pub instructions: String,
    pub key_path: Option<String>,
    pub prompts: Vec<AuthPromptItem>,
    pub log_lines: Vec<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpConnectedInfo {
    pub session_id: String,
    pub home_path: String,
    pub initial_path: String,
    pub initial_listing: DirectoryListing,
    pub auth_method_used: String,
    pub server_banner: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "outcome", content = "payload", rename_all = "snake_case")]
pub enum SftpConnectOutcome {
    Connected(SftpConnectedInfo),
    HostKeyPrompt(HostKeyPromptInfo),
    AuthPrompt(AuthChallengeInfo),
}

pub struct ScpCraftClientHandler {
    host: String,
    port: u16,
    is_tunnel: bool,
    known_hosts_path: PathBuf,
    session_trusted: HashSet<(String, u16, String)>,
    captured_host_key: Arc<Mutex<Option<HostKeyPromptInfo>>>,
}

impl client::Handler for ScpCraftClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let pubkey = server_public_key.public_key();
        let pubkey_openssh = match pubkey.to_openssh() {
            Ok(s) => s,
            Err(_) => return Ok(false),
        };

        if self
            .session_trusted
            .contains(&(self.host.clone(), self.port, pubkey_openssh.clone()))
        {
            return Ok(true);
        }

        let fp_sha256 = pubkey.fingerprint(HashAlg::Sha256).to_string();
        let fp_sha512 = pubkey.fingerprint(HashAlg::Sha512).to_string();
        let key_algorithm = pubkey.algorithm().to_string();

        match check_known_hosts_path(&self.host, self.port, &pubkey, &self.known_hosts_path) {
            Ok(true) => Ok(true),
            Ok(false) => {
                if let Ok(mut guard) = self.captured_host_key.lock() {
                    *guard = Some(HostKeyPromptInfo {
                        status: "unknown".to_string(),
                        is_tunnel: self.is_tunnel,
                        host: self.host.clone(),
                        port: self.port,
                        key_algorithm,
                        fingerprint_sha256: fp_sha256,
                        fingerprint_sha512: fp_sha512,
                        public_key_openssh: pubkey_openssh,
                        known_hosts_path: self.known_hosts_path.to_string_lossy().to_string(),
                        mismatch_line: None,
                    });
                }
                Ok(false)
            }
            Err(russh::keys::Error::KeyChanged { line }) => {
                if let Ok(mut guard) = self.captured_host_key.lock() {
                    *guard = Some(HostKeyPromptInfo {
                        status: "mismatch".to_string(),
                        is_tunnel: self.is_tunnel,
                        host: self.host.clone(),
                        port: self.port,
                        key_algorithm,
                        fingerprint_sha256: fp_sha256,
                        fingerprint_sha512: fp_sha512,
                        public_key_openssh: pubkey_openssh,
                        known_hosts_path: self.known_hosts_path.to_string_lossy().to_string(),
                        mismatch_line: Some(line),
                    });
                }
                Ok(false)
            }
            Err(err) => {
                if let Ok(mut guard) = self.captured_host_key.lock() {
                    *guard = Some(HostKeyPromptInfo {
                        status: "unknown".to_string(),
                        is_tunnel: self.is_tunnel,
                        host: self.host.clone(),
                        port: self.port,
                        key_algorithm,
                        fingerprint_sha256: fp_sha256,
                        fingerprint_sha512: fp_sha512,
                        public_key_openssh: pubkey_openssh,
                        known_hosts_path: format!(
                            "{} ({})",
                            self.known_hosts_path.display(),
                            err
                        ),
                        mismatch_line: None,
                    });
                }
                Ok(false)
            }
        }
    }
}

pub struct LiveSftpSession {
    pub sftp: Arc<SftpSession>,
    pub ssh: Arc<tokio::sync::Mutex<client::Handle<ScpCraftClientHandler>>>,
    pub _tunnel_ssh: Option<Arc<tokio::sync::Mutex<client::Handle<ScpCraftClientHandler>>>>,
    pub host: String,
    pub user_name: String,
    pub home_path: String,
    pub shell: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingAuthKind {
    Password,
    Passphrase,
    KeyboardInteractive,
}

pub struct PendingAuthState {
    pub challenge_id: String,
    pub session_id: String,
    pub site: SiteConfig,
    pub password_hint: Option<String>,
    pub kind: PendingAuthKind,
    pub handle: client::Handle<ScpCraftClientHandler>,
    pub tunnel_handle: Option<client::Handle<ScpCraftClientHandler>>,
    pub log_lines: Vec<String>,
}

pub fn default_known_hosts_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".ssh")
        .join("known_hosts")
}

fn known_host_pattern(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{}]:{}", host, port)
    }
}

/// Record or replace a host public key in OpenSSH `known_hosts` format.
pub fn upsert_known_host_in_file(
    known_hosts_path: &Path,
    host: &str,
    port: u16,
    public_key_openssh: &str,
) -> Result<(), String> {
    let mut pubkey = PublicKey::from_openssh(public_key_openssh)
        .map_err(|e| format!("Invalid OpenSSH host key: {}", e))?;
    pubkey.set_comment("");

    if let Err(russh::keys::Error::KeyChanged { .. }) =
        check_known_hosts_path(host, port, &pubkey, known_hosts_path)
    {
        if let Ok(existing) = fs::read_to_string(known_hosts_path) {
            let target_host = known_host_pattern(host, port);
            let target_alg = pubkey.algorithm().to_string();
            let line_hit = match check_known_hosts_path(host, port, &pubkey, known_hosts_path) {
                Err(russh::keys::Error::KeyChanged { line }) => Some(line),
                _ => None,
            };

            let kept: Vec<&str> = existing
                .lines()
                .enumerate()
                .filter(|(idx, line)| {
                    if line_hit == Some(idx + 1) {
                        return false;
                    }
                    let mut parts = line.split_whitespace();
                    let hosts_field = parts.next().unwrap_or("");
                    let alg_field = parts.next().unwrap_or("");
                    let same_host = hosts_field.split(',').any(|h| h == target_host);
                    !(same_host && alg_field == target_alg)
                })
                .map(|(_, line)| line)
                .collect();

            let mut rewritten = kept.join("\n");
            if !rewritten.is_empty() {
                rewritten.push('\n');
            }
            fs::write(known_hosts_path, rewritten)
                .map_err(|e| format!("Failed to update known_hosts: {}", e))?;
        }
    }

    if matches!(
        check_known_hosts_path(host, port, &pubkey, known_hosts_path),
        Ok(true)
    ) {
        return Ok(());
    }

    learn_known_hosts_path(host, port, &pubkey, known_hosts_path)
        .map_err(|e| format!("Failed to save host key to known_hosts: {}", e))
}

fn build_client_config(site: &SiteConfig) -> Arc<client::Config> {
    let keepalive = if site.advanced.keepalive_interval_secs > 0 {
        Some(Duration::from_secs(site.advanced.keepalive_interval_secs as u64))
    } else {
        Some(Duration::from_secs(30))
    };

    Arc::new(client::Config {
        keepalive_interval: keepalive,
        keepalive_max: 3,
        inactivity_timeout: None,
        nodelay: true,
        ..Default::default()
    })
}

async fn connect_direct_handle(
    host: &str,
    port: u16,
    is_tunnel: bool,
    config: Arc<client::Config>,
    timeout_secs: u64,
    session_trusted: HashSet<(String, u16, String)>,
    known_hosts_path: PathBuf,
) -> Result<Result<client::Handle<ScpCraftClientHandler>, HostKeyPromptInfo>, String> {
    let captured = Arc::new(Mutex::new(None));
    let handler = ScpCraftClientHandler {
        host: host.to_string(),
        port,
        is_tunnel,
        known_hosts_path,
        session_trusted,
        captured_host_key: captured.clone(),
    };

    let fut = client::connect(config, (host, port), handler);
    match tokio::time::timeout(Duration::from_secs(timeout_secs.max(5)), fut).await {
        Ok(Ok(handle)) => Ok(Ok(handle)),
        Ok(Err(err)) => {
            if let Ok(mut guard) = captured.lock() {
                if let Some(prompt) = guard.take() {
                    return Ok(Err(prompt));
                }
            }
            Err(format!("SSH connection to {}:{} failed: {}", host, port, err))
        }
        Err(_) => Err(format!(
            "Connection to {}:{} timed out after {}s",
            host, port, timeout_secs
        )),
    }
}

async fn connect_stream_handle<S>(
    stream: S,
    host: &str,
    port: u16,
    config: Arc<client::Config>,
    timeout_secs: u64,
    session_trusted: HashSet<(String, u16, String)>,
    known_hosts_path: PathBuf,
) -> Result<Result<client::Handle<ScpCraftClientHandler>, HostKeyPromptInfo>, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let captured = Arc::new(Mutex::new(None));
    let handler = ScpCraftClientHandler {
        host: host.to_string(),
        port,
        is_tunnel: false,
        known_hosts_path,
        session_trusted,
        captured_host_key: captured.clone(),
    };

    let fut = client::connect_stream(config, stream, handler);
    match tokio::time::timeout(Duration::from_secs(timeout_secs.max(5)), fut).await {
        Ok(Ok(handle)) => Ok(Ok(handle)),
        Ok(Err(err)) => {
            if let Ok(mut guard) = captured.lock() {
                if let Some(prompt) = guard.take() {
                    return Ok(Err(prompt));
                }
            }
            Err(format!(
                "Tunneled SSH handshake with {}:{} failed: {}",
                host, port, err
            ))
        }
        Err(_) => Err(format!(
            "Tunneled SSH handshake with {}:{} timed out after {}s",
            host, port, timeout_secs
        )),
    }
}

async fn connect_platform_agents() -> Vec<(&'static str, AgentClient<Box<dyn AgentStream + Send + Unpin>>)>
{
    let mut clients: Vec<(&'static str, AgentClient<Box<dyn AgentStream + Send + Unpin>>)> =
        Vec::new();

    #[cfg(windows)]
    {
        if let Ok(pageant) = AgentClient::connect_pageant().await {
            clients.push(("Pageant", pageant.dynamic()));
        }
        if let Ok(pipe) =
            tokio::net::windows::named_pipe::ClientOptions::new().open(r"\\.\pipe\openssh-ssh-agent")
        {
            clients.push(("OpenSSH Agent", AgentClient::connect(pipe).dynamic()));
        }
    }

    #[cfg(unix)]
    {
        if let Ok(unix_agent) = AgentClient::connect_env().await {
            clients.push(("SSH Agent", unix_agent.dynamic()));
        }
    }

    clients
}

async fn try_agent_auth(
    handle: &mut client::Handle<ScpCraftClientHandler>,
    user: &str,
    log_lines: &mut Vec<String>,
) -> Option<AuthResult> {
    let mut last_failure = None;
    let agents = connect_platform_agents().await;

    for (agent_name, mut agent) in agents {
        let Ok(identities) = agent.request_identities().await else {
            continue;
        };
        if identities.is_empty() {
            log_lines.push(format!("{} reported no identities.", agent_name));
            continue;
        }
        log_lines.push(format!(
            "Using {} ({} identity/identities).",
            agent_name,
            identities.len()
        ));

        for identity in identities {
            let res = match identity {
                AgentIdentity::PublicKey { key, comment } => {
                    let hash_alg = if matches!(key.algorithm(), Algorithm::Rsa { .. }) {
                        handle.best_supported_rsa_hash().await.ok().flatten().flatten()
                    } else {
                        None
                    };
                    log_lines.push(format!("Trying agent public key {}...", comment));
                    handle
                        .authenticate_publickey_with(user, key, hash_alg, &mut agent)
                        .await
                        .ok()
                }
                AgentIdentity::Certificate {
                    certificate,
                    comment,
                } => {
                    let hash_alg =
                        if matches!(certificate.public_key().algorithm(), Algorithm::Rsa { .. }) {
                            handle.best_supported_rsa_hash().await.ok().flatten().flatten()
                        } else {
                            None
                        };
                    log_lines.push(format!("Trying agent certificate {}...", comment));
                    handle
                        .authenticate_certificate_with(user, certificate, hash_alg, &mut agent)
                        .await
                        .ok()
                }
            };

            if let Some(auth_res) = res {
                if auth_res.success() {
                    return Some(auth_res);
                }
                last_failure = Some(auth_res);
            }
        }
    }

    last_failure
}

async fn authenticate_with_private_key(
    handle: &mut client::Handle<ScpCraftClientHandler>,
    user: &str,
    key: russh::keys::PrivateKey,
) -> Result<AuthResult, String> {
    let rsa_hash = if matches!(key.algorithm(), Algorithm::Rsa { .. }) {
        handle
            .best_supported_rsa_hash()
            .await
            .ok()
            .flatten()
            .flatten()
    } else {
        None
    };

    handle
        .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash))
        .await
        .map_err(|e| format!("Public key authentication error: {}", e))
}

async fn authenticate_tunnel_jump_host(
    jump: &mut client::Handle<ScpCraftClientHandler>,
    site: &SiteConfig,
    tunnel_password: Option<String>,
) -> Result<(), String> {
    let tunnel = &site.advanced.tunnel;
    let user = tunnel.user_name.trim();
    let mut dummy_log = Vec::new();

    if let Ok(res) = jump.authenticate_none(user).await {
        if res.success() {
            return Ok(());
        }
    }

    if tunnel.auth_type == "agent" || site.advanced.use_ssh_agent {
        if let Some(res) = try_agent_auth(jump, user, &mut dummy_log).await {
            if res.success() {
                return Ok(());
            }
        }
    }

    if !tunnel.private_key_path.trim().is_empty() {
        let key_path = Path::new(tunnel.private_key_path.trim());
        if let KeyDecodeOutcome::Ready(key) =
            ppk::load_private_key(key_path, tunnel_password.as_deref())
        {
            let res = authenticate_with_private_key(jump, user, key).await?;
            if res.success() {
                return Ok(());
            }
        }
    }

    if let Some(pw) = tunnel_password {
        let res = jump
            .authenticate_password(user, &pw)
            .await
            .map_err(|e| format!("Jump host password authentication failed: {}", e))?;
        if res.success() {
            return Ok(());
        }
    }

    Err(format!(
        "Jump host authentication failed for {}@{}",
        tunnel.user_name, tunnel.host_name
    ))
}

fn new_challenge_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("auth_{:x}", nanos)
}

pub enum AuthFlowResult {
    Authenticated {
        handle: client::Handle<ScpCraftClientHandler>,
        tunnel_handle: Option<client::Handle<ScpCraftClientHandler>>,
        method_used: String,
    },
    NeedsInput(PendingAuthState, AuthChallengeInfo),
}

pub async fn start_connection_and_auth(
    request: &SftpConnectRequest,
    session_trusted: &HashSet<(String, u16, String)>,
    known_hosts_path: &Path,
) -> Result<Result<AuthFlowResult, HostKeyPromptInfo>, String> {
    let site = &request.site;
    let host = site.host_name.trim();
    if host.is_empty() {
        return Err("Host name cannot be empty.".to_string());
    }
    let user = site.user_name.trim();
    if user.is_empty() {
        return Err("User name cannot be empty.".to_string());
    }

    let timeout_secs = site.advanced.timeout_secs.max(5) as u64;
    let config = build_client_config(site);

    let (mut handle, tunnel_handle) = if site.advanced.tunnel.enabled {
        let tunnel = &site.advanced.tunnel;
        let t_host = tunnel.host_name.trim();
        if t_host.is_empty() {
            return Err("SSH tunnel host name is empty.".to_string());
        }
        let mut jump = match connect_direct_handle(
            t_host,
            tunnel.port_number,
            true,
            config.clone(),
            timeout_secs,
            session_trusted.clone(),
            known_hosts_path.to_path_buf(),
        )
        .await?
        {
            Ok(h) => h,
            Err(host_key_prompt) => return Ok(Err(host_key_prompt)),
        };

        let saved_tunnel_pw = request
            .tunnel_password
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| keyring_store::get_site_secret(&site.id, "tunnelPassword"));
        authenticate_tunnel_jump_host(&mut jump, site, saved_tunnel_pw).await?;

        let channel = jump
            .channel_open_direct_tcpip(host, site.port_number as u32, "127.0.0.1", 0)
            .await
            .map_err(|e| format!("Failed opening SSH tunnel to {}:{}: {}", host, site.port_number, e))?;

        let target = match connect_stream_handle(
            channel.into_stream(),
            host,
            site.port_number,
            config,
            timeout_secs,
            session_trusted.clone(),
            known_hosts_path.to_path_buf(),
        )
        .await?
        {
            Ok(h) => h,
            Err(host_key_prompt) => return Ok(Err(host_key_prompt)),
        };

        (target, Some(jump))
    } else {
        let h = match connect_direct_handle(
            host,
            site.port_number,
            false,
            config,
            timeout_secs,
            session_trusted.clone(),
            known_hosts_path.to_path_buf(),
        )
        .await?
        {
            Ok(h) => h,
            Err(host_key_prompt) => return Ok(Err(host_key_prompt)),
        };
        (h, None)
    };

    let mut log_lines = vec![
        format!("Connected to {}:{}", host, site.port_number),
        format!("Using username \"{}\".", user),
    ];

    let stored_password = request
        .password
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| keyring_store::get_site_secret(&site.id, "password"));
    let stored_passphrase = request
        .passphrase
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| keyring_store::get_site_secret(&site.id, "passphrase"));

    let mut allowed_methods = None;
    if let Ok(res) = handle.authenticate_none(user).await {
        if res.success() {
            return Ok(Ok(AuthFlowResult::Authenticated {
                handle,
                tunnel_handle,
                method_used: "none".to_string(),
            }));
        }
        if let AuthResult::Failure {
            remaining_methods, ..
        } = res
        {
            allowed_methods = Some(remaining_methods);
        }
    }

    let allows = |m: &Option<russh::MethodSet>, kind: MethodKind| -> bool {
        match m {
            Some(set) if !set.is_empty() => set.contains(&kind),
            _ => true,
        }
    };

    if site.advanced.use_ssh_agent && allows(&allowed_methods, MethodKind::PublicKey) {
        if let Some(res) = try_agent_auth(&mut handle, user, &mut log_lines).await {
            if res.success() {
                return Ok(Ok(AuthFlowResult::Authenticated {
                    handle,
                    tunnel_handle,
                    method_used: "agent".to_string(),
                }));
            }
            if let AuthResult::Failure {
                remaining_methods, ..
            } = res
            {
                allowed_methods = Some(remaining_methods);
            }
        }
    }

    let key_path_trimmed = site.advanced.private_key_path.trim().to_string();
    if !key_path_trimmed.is_empty() && allows(&allowed_methods, MethodKind::PublicKey) {
        log_lines.push(format!("Authenticating with key \"{}\".", key_path_trimmed));
        match ppk::load_private_key(Path::new(&key_path_trimmed), stored_passphrase.as_deref()) {
            KeyDecodeOutcome::Ready(key) => {
                let res = authenticate_with_private_key(&mut handle, user, key).await?;
                if res.success() {
                    return Ok(Ok(AuthFlowResult::Authenticated {
                        handle,
                        tunnel_handle,
                        method_used: "publickey".to_string(),
                    }));
                }
                log_lines.push("Server refused our key.".to_string());
                if let AuthResult::Failure {
                    remaining_methods, ..
                } = res
                {
                    allowed_methods = Some(remaining_methods);
                }
            }
            KeyDecodeOutcome::NeedsPassphrase => {
                log_lines.push("Passphrase required for private key.".to_string());
                let challenge_id = new_challenge_id();
                let challenge = AuthChallengeInfo {
                    challenge_id: challenge_id.clone(),
                    session_id: request.session_id.clone(),
                    site_id: site.id.clone(),
                    host: host.to_string(),
                    port: site.port_number,
                    user_name: user.to_string(),
                    auth_kind: "passphrase".to_string(),
                    title: format!("Passphrase - {}@{}", user, host),
                    instructions: format!(
                        "Passphrase for key \"{}\":",
                        Path::new(&key_path_trimmed)
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or(&key_path_trimmed)
                    ),
                    key_path: Some(key_path_trimmed),
                    prompts: vec![AuthPromptItem {
                        id: "passphrase".to_string(),
                        prompt: "Passphrase:".to_string(),
                        echo: false,
                    }],
                    log_lines: log_lines.clone(),
                    error_message: None,
                };
                let pending = PendingAuthState {
                    challenge_id,
                    session_id: request.session_id.clone(),
                    site: site.clone(),
                    password_hint: stored_password,
                    kind: PendingAuthKind::Passphrase,
                    handle,
                    tunnel_handle,
                    log_lines,
                };
                return Ok(Ok(AuthFlowResult::NeedsInput(pending, challenge)));
            }
            KeyDecodeOutcome::WrongPassphrase => {
                log_lines.push("Wrong passphrase for private key.".to_string());
                let challenge_id = new_challenge_id();
                let challenge = AuthChallengeInfo {
                    challenge_id: challenge_id.clone(),
                    session_id: request.session_id.clone(),
                    site_id: site.id.clone(),
                    host: host.to_string(),
                    port: site.port_number,
                    user_name: user.to_string(),
                    auth_kind: "passphrase".to_string(),
                    title: format!("Passphrase - {}@{}", user, host),
                    instructions: "Enter key passphrase:".to_string(),
                    key_path: Some(key_path_trimmed),
                    prompts: vec![AuthPromptItem {
                        id: "passphrase".to_string(),
                        prompt: "Passphrase:".to_string(),
                        echo: false,
                    }],
                    log_lines: log_lines.clone(),
                    error_message: Some("Wrong passphrase. Please try again.".to_string()),
                };
                let pending = PendingAuthState {
                    challenge_id,
                    session_id: request.session_id.clone(),
                    site: site.clone(),
                    password_hint: stored_password,
                    kind: PendingAuthKind::Passphrase,
                    handle,
                    tunnel_handle,
                    log_lines,
                };
                return Ok(Ok(AuthFlowResult::NeedsInput(pending, challenge)));
            }
            KeyDecodeOutcome::Failed(err) => {
                log_lines.push(err);
            }
        }
    }

    if let Some(ref pw) = stored_password {
        if allows(&allowed_methods, MethodKind::Password) {
            log_lines.push("Attempting password authentication...".to_string());
            let res = handle
                .authenticate_password(user, pw.as_str())
                .await
                .map_err(|e| format!("Password authentication error: {}", e))?;
            if res.success() {
                return Ok(Ok(AuthFlowResult::Authenticated {
                    handle,
                    tunnel_handle,
                    method_used: "password".to_string(),
                }));
            }
            log_lines.push("Access denied.".to_string());
            if let AuthResult::Failure {
                remaining_methods, ..
            } = res
            {
                allowed_methods = Some(remaining_methods);
            }
        }
    }

    if allows(&allowed_methods, MethodKind::KeyboardInteractive) {
        log_lines.push("Using keyboard-interactive authentication.".to_string());
        match handle
            .authenticate_keyboard_interactive_start(user, None)
            .await
        {
            Ok(KeyboardInteractiveAuthResponse::Success) => {
                return Ok(Ok(AuthFlowResult::Authenticated {
                    handle,
                    tunnel_handle,
                    method_used: "keyboard-interactive".to_string(),
                }));
            }
            Ok(KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            }) if !prompts.is_empty() => {
                let challenge_id = new_challenge_id();
                let title = if name.trim().is_empty() {
                    format!("Authentication - {}@{}", user, host)
                } else {
                    name
                };
                let prompt_items: Vec<AuthPromptItem> = prompts
                    .into_iter()
                    .enumerate()
                    .map(|(i, p)| AuthPromptItem {
                        id: format!("kbi_{}", i),
                        prompt: p.prompt,
                        echo: p.echo,
                    })
                    .collect();

                let challenge = AuthChallengeInfo {
                    challenge_id: challenge_id.clone(),
                    session_id: request.session_id.clone(),
                    site_id: site.id.clone(),
                    host: host.to_string(),
                    port: site.port_number,
                    user_name: user.to_string(),
                    auth_kind: "keyboard_interactive".to_string(),
                    title,
                    instructions,
                    key_path: None,
                    prompts: prompt_items,
                    log_lines: log_lines.clone(),
                    error_message: None,
                };
                let pending = PendingAuthState {
                    challenge_id,
                    session_id: request.session_id.clone(),
                    site: site.clone(),
                    password_hint: stored_password,
                    kind: PendingAuthKind::KeyboardInteractive,
                    handle,
                    tunnel_handle,
                    log_lines,
                };
                return Ok(Ok(AuthFlowResult::NeedsInput(pending, challenge)));
            }
            Ok(KeyboardInteractiveAuthResponse::InfoRequest { .. }) => {
                // Server sent an empty info-request prompt block; respond with empty responses
                if let Ok(KeyboardInteractiveAuthResponse::Success) = handle
                    .authenticate_keyboard_interactive_respond(Vec::new())
                    .await
                {
                    return Ok(Ok(AuthFlowResult::Authenticated {
                        handle,
                        tunnel_handle,
                        method_used: "keyboard-interactive".to_string(),
                    }));
                }
            }
            Ok(KeyboardInteractiveAuthResponse::Failure {
                remaining_methods, ..
            }) => {
                allowed_methods = Some(remaining_methods);
            }
            Err(err) => {
                log_lines.push(format!("Keyboard-interactive failed: {}", err));
            }
        }
    }

    if allows(&allowed_methods, MethodKind::Password) {
        let challenge_id = new_challenge_id();
        let error_message = if stored_password.is_some() {
            Some("Access denied. Please enter your password.".to_string())
        } else {
            None
        };
        let challenge = AuthChallengeInfo {
            challenge_id: challenge_id.clone(),
            session_id: request.session_id.clone(),
            site_id: site.id.clone(),
            host: host.to_string(),
            port: site.port_number,
            user_name: user.to_string(),
            auth_kind: "password".to_string(),
            title: format!("Password - {}@{}", user, host),
            instructions: format!("{}@{}'s password:", user, host),
            key_path: None,
            prompts: vec![AuthPromptItem {
                id: "password".to_string(),
                prompt: "Password:".to_string(),
                echo: false,
            }],
            log_lines: log_lines.clone(),
            error_message,
        };
        let pending = PendingAuthState {
            challenge_id,
            session_id: request.session_id.clone(),
            site: site.clone(),
            password_hint: stored_password,
            kind: PendingAuthKind::Password,
            handle,
            tunnel_handle,
            log_lines,
        };
        return Ok(Ok(AuthFlowResult::NeedsInput(pending, challenge)));
    }

    Err(format!(
        "No supported authentication methods succeeded for {}@{}.",
        user, host
    ))
}

pub async fn continue_pending_auth(
    mut pending: PendingAuthState,
    responses: Vec<String>,
    save_secret: bool,
) -> Result<AuthFlowResult, String> {
    let user = pending.site.user_name.trim().to_string();
    let host = pending.site.host_name.trim().to_string();
    let port = pending.site.port_number;
    let first_resp = responses.first().cloned().unwrap_or_default();

    match pending.kind {
        PendingAuthKind::Passphrase => {
            let key_path_trimmed = pending.site.advanced.private_key_path.trim().to_string();
            match ppk::load_private_key(Path::new(&key_path_trimmed), Some(first_resp.as_str())) {
                KeyDecodeOutcome::Ready(key) => {
                    if save_secret && !pending.site.id.is_empty() && !first_resp.is_empty() {
                        let _ = keyring_store::set_site_secret(
                            &pending.site.id,
                            "passphrase",
                            &first_resp,
                        );
                    }
                    let res =
                        authenticate_with_private_key(&mut pending.handle, &user, key).await?;
                    if res.success() {
                        return Ok(AuthFlowResult::Authenticated {
                            handle: pending.handle,
                            tunnel_handle: pending.tunnel_handle,
                            method_used: "publickey".to_string(),
                        });
                    }
                    pending
                        .log_lines
                        .push("Server refused our key. Switching to password...".to_string());
                    pending.kind = PendingAuthKind::Password;
                    let next_id = new_challenge_id();
                    pending.challenge_id = next_id.clone();
                    let challenge = AuthChallengeInfo {
                        challenge_id: next_id,
                        session_id: pending.session_id.clone(),
                        site_id: pending.site.id.clone(),
                        host: host.clone(),
                        port,
                        user_name: user.clone(),
                        auth_kind: "password".to_string(),
                        title: format!("Password - {}@{}", user, host),
                        instructions: "Server refused public key. Enter password:".to_string(),
                        key_path: None,
                        prompts: vec![AuthPromptItem {
                            id: "password".to_string(),
                            prompt: "Password:".to_string(),
                            echo: false,
                        }],
                        log_lines: pending.log_lines.clone(),
                        error_message: Some("Server refused our key.".to_string()),
                    };
                    Ok(AuthFlowResult::NeedsInput(pending, challenge))
                }
                KeyDecodeOutcome::WrongPassphrase | KeyDecodeOutcome::NeedsPassphrase => {
                    pending.log_lines.push("Wrong passphrase.".to_string());
                    let next_id = new_challenge_id();
                    pending.challenge_id = next_id.clone();
                    let challenge = AuthChallengeInfo {
                        challenge_id: next_id,
                        session_id: pending.session_id.clone(),
                        site_id: pending.site.id.clone(),
                        host,
                        port,
                        user_name: user,
                        auth_kind: "passphrase".to_string(),
                        title: "Key Passphrase".to_string(),
                        instructions: "Enter key passphrase:".to_string(),
                        key_path: Some(key_path_trimmed),
                        prompts: vec![AuthPromptItem {
                            id: "passphrase".to_string(),
                            prompt: "Passphrase:".to_string(),
                            echo: false,
                        }],
                        log_lines: pending.log_lines.clone(),
                        error_message: Some("Wrong passphrase. Please try again.".to_string()),
                    };
                    Ok(AuthFlowResult::NeedsInput(pending, challenge))
                }
                KeyDecodeOutcome::Failed(err) => Err(err),
            }
        }
        PendingAuthKind::Password => {
            let res = pending
                .handle
                .authenticate_password(&user, &first_resp)
                .await
                .map_err(|e| format!("Password authentication error: {}", e))?;
            if res.success() {
                if save_secret && !pending.site.id.is_empty() && !first_resp.is_empty() {
                    let _ = keyring_store::set_site_secret(
                        &pending.site.id,
                        "password",
                        &first_resp,
                    );
                }
                return Ok(AuthFlowResult::Authenticated {
                    handle: pending.handle,
                    tunnel_handle: pending.tunnel_handle,
                    method_used: "password".to_string(),
                });
            }

            pending.log_lines.push("Access denied.".to_string());
            let next_id = new_challenge_id();
            pending.challenge_id = next_id.clone();
            let challenge = AuthChallengeInfo {
                challenge_id: next_id,
                session_id: pending.session_id.clone(),
                site_id: pending.site.id.clone(),
                host: host.clone(),
                port,
                user_name: user.clone(),
                auth_kind: "password".to_string(),
                title: format!("Password - {}@{}", user, host),
                instructions: format!("{}@{}'s password:", user, host),
                key_path: None,
                prompts: vec![AuthPromptItem {
                    id: "password".to_string(),
                    prompt: "Password:".to_string(),
                    echo: false,
                }],
                log_lines: pending.log_lines.clone(),
                error_message: Some("Access denied. Please check your password.".to_string()),
            };
            Ok(AuthFlowResult::NeedsInput(pending, challenge))
        }
        PendingAuthKind::KeyboardInteractive => {
            let res = pending
                .handle
                .authenticate_keyboard_interactive_respond(responses)
                .await
                .map_err(|e| format!("Keyboard-interactive authentication failed: {}", e))?;

            match res {
                KeyboardInteractiveAuthResponse::Success => Ok(AuthFlowResult::Authenticated {
                    handle: pending.handle,
                    tunnel_handle: pending.tunnel_handle,
                    method_used: "keyboard-interactive".to_string(),
                }),
                KeyboardInteractiveAuthResponse::InfoRequest {
                    name,
                    instructions,
                    prompts,
                } => {
                    let next_id = new_challenge_id();
                    pending.challenge_id = next_id.clone();
                    let prompt_items: Vec<AuthPromptItem> = prompts
                        .into_iter()
                        .enumerate()
                        .map(|(i, p)| AuthPromptItem {
                            id: format!("kbi_{}", i),
                            prompt: p.prompt,
                            echo: p.echo,
                        })
                        .collect();
                    let challenge = AuthChallengeInfo {
                        challenge_id: next_id,
                        session_id: pending.session_id.clone(),
                        site_id: pending.site.id.clone(),
                        host: host.clone(),
                        port,
                        user_name: user,
                        auth_kind: "keyboard_interactive".to_string(),
                        title: if name.trim().is_empty() {
                            format!("Authentication - {}", host)
                        } else {
                            name
                        },
                        instructions,
                        key_path: None,
                        prompts: prompt_items,
                        log_lines: pending.log_lines.clone(),
                        error_message: None,
                    };
                    Ok(AuthFlowResult::NeedsInput(pending, challenge))
                }
                KeyboardInteractiveAuthResponse::Failure {
                    remaining_methods, ..
                } => {
                    if remaining_methods.contains(&MethodKind::Password) {
                        pending.log_lines.push("Access denied. Enter password:".to_string());
                        pending.kind = PendingAuthKind::Password;
                        let next_id = new_challenge_id();
                        pending.challenge_id = next_id.clone();
                        let challenge = AuthChallengeInfo {
                            challenge_id: next_id,
                            session_id: pending.session_id.clone(),
                            site_id: pending.site.id.clone(),
                            host: host.clone(),
                            port,
                            user_name: user.clone(),
                            auth_kind: "password".to_string(),
                            title: format!("Password - {}@{}", user, host),
                            instructions: format!("{}@{}'s password:", user, host),
                            key_path: None,
                            prompts: vec![AuthPromptItem {
                                id: "password".to_string(),
                                prompt: "Password:".to_string(),
                                echo: false,
                            }],
                            log_lines: pending.log_lines.clone(),
                            error_message: Some("Authentication failed. Try password.".to_string()),
                        };
                        return Ok(AuthFlowResult::NeedsInput(pending, challenge));
                    }
                    Err("Keyboard-interactive authentication rejected by server.".to_string())
                }
            }
        }
    }
}

const SFTP_SERVER_DISCOVERY_SH: &str = "for p in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/sftp-server /usr/sbin/sftp-server; do [ -x \"$p\" ] && exec \"$p\"; done; exec sftp-server";

const SFTP_SU_BOOTSTRAP_LINE: &str = "SFTP_BIN=sftp-server; for p in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/sftp-server /usr/sbin/sftp-server; do [ -x \"$p\" ] && SFTP_BIN=\"$p\" && break; done; echo __SCP_READY__; exec \"$SFTP_BIN\"\n";

async fn try_sudo_su_sftp(
    handle: &client::Handle<ScpCraftClientHandler>,
    sudo_su_cmd: &str,
) -> Result<russh::Channel<client::Msg>, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Failed opening SSH channel for {}: {}", sudo_su_cmd, e))?;
    channel
        .exec(true, sudo_su_cmd.as_bytes().to_vec())
        .await
        .map_err(|e| format!("Failed executing {}: {}", sudo_su_cmd, e))?;
    channel
        .data(SFTP_SU_BOOTSTRAP_LINE.as_bytes())
        .await
        .map_err(|e| format!("Failed sending SFTP bootstrap to {}: {}", sudo_su_cmd, e))?;

    let mut stdout_buf = Vec::new();
    let mut stderr_buf = Vec::new();
    let marker = b"__SCP_READY__\n";

    let wait_res = tokio::time::timeout(std::time::Duration::from_secs(8), async {
        while let Some(msg) = channel.wait().await {
            match msg {
                russh::ChannelMsg::Data { data } => {
                    stdout_buf.extend_from_slice(&data);
                    if stdout_buf
                        .windows(marker.len())
                        .any(|w| w == marker)
                    {
                        return Ok(());
                    }
                }
                russh::ChannelMsg::ExtendedData { data, .. } => {
                    stderr_buf.extend_from_slice(&data);
                }
                russh::ChannelMsg::Eof | russh::ChannelMsg::Close => {
                    return Err(String::from_utf8_lossy(&stderr_buf).trim().to_string());
                }
                _ => {}
            }
        }
        Err(String::from_utf8_lossy(&stderr_buf).trim().to_string())
    })
    .await;

    match wait_res {
        Ok(Ok(())) => Ok(channel),
        Ok(Err(err)) => Err(if err.is_empty() {
            format!("{} closed before sftp-server started", sudo_su_cmd)
        } else {
            err
        }),
        Err(_) => Err(format!("Timed out waiting for {} to start sftp-server", sudo_su_cmd)),
    }
}

async fn probe_sudo_command(
    handle: &client::Handle<ScpCraftClientHandler>,
    cmd: &str,
) -> Result<(Option<u32>, String), String> {
    let mut probe = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Failed opening SSH probe channel: {}", e))?;
    probe
        .exec(true, cmd.as_bytes().to_vec())
        .await
        .map_err(|e| format!("Failed probing sudo privileges: {}", e))?;

    let mut exit_code: Option<u32> = None;
    let mut stderr_buf = Vec::new();
    while let Some(msg) = probe.wait().await {
        match msg {
            russh::ChannelMsg::ExitStatus { exit_status } => {
                exit_code = Some(exit_status);
            }
            russh::ChannelMsg::ExtendedData { data, .. } => {
                stderr_buf.extend_from_slice(&data);
            }
            russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
            _ => {}
        }
    }
    let stderr_str = String::from_utf8_lossy(&stderr_buf).trim().to_string();
    Ok((exit_code, stderr_str))
}

async fn open_elevated_sftp_channel(
    handle: &client::Handle<ScpCraftClientHandler>,
    site: &SiteConfig,
) -> Result<russh::Channel<client::Msg>, String> {
    let (probe_exit, probe_err) = probe_sudo_command(handle, "sudo -n true").await?;

    if probe_exit == Some(0) {
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Failed opening elevated SFTP channel: {}", e))?;
        let cmd = format!("sudo -n sh -c '{}'", SFTP_SERVER_DISCOVERY_SH);
        channel
            .exec(true, cmd.into_bytes())
            .await
            .map_err(|e| format!("Failed starting elevated sftp-server: {}", e))?;
        return Ok(channel);
    }

    // Some sudoers configs only allow `sudo su` / `sudo su -` (without -c) without password.
    let shell_trimmed = site.advanced.shell.trim();
    let mut su_candidates: Vec<String> = Vec::new();
    if shell_trimmed.eq_ignore_ascii_case("sudo su -") {
        su_candidates.push("sudo -n su -".to_string());
        su_candidates.push("sudo -n su".to_string());
    } else if shell_trimmed.eq_ignore_ascii_case("sudo su") {
        su_candidates.push("sudo -n su".to_string());
        su_candidates.push("sudo -n su -".to_string());
    } else {
        su_candidates.push("sudo -n su".to_string());
        su_candidates.push("sudo -n su -".to_string());
    }

    let mut last_su_err = String::new();
    for cand in &su_candidates {
        match try_sudo_su_sftp(handle, cand).await {
            Ok(ch) => return Ok(ch),
            Err(e) => last_su_err = e,
        }
    }

    let saved_pwd = if !site.id.trim().is_empty() {
        keyring_store::get_site_secret(&site.id, "password").filter(|p| !p.is_empty())
    } else {
        None
    };

    if let Some(pwd) = saved_pwd {
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Failed opening elevated SFTP channel: {}", e))?;
        let cmd = format!("sudo -S -p '' sh -c '{}'", SFTP_SERVER_DISCOVERY_SH);
        channel
            .exec(true, cmd.into_bytes())
            .await
            .map_err(|e| format!("Failed starting elevated sftp-server with password: {}", e))?;
        channel
            .data(format!("{}\n", pwd).as_bytes())
            .await
            .map_err(|e| format!("Failed sending sudo password: {}", e))?;
        return Ok(channel);
    }

    let detail = if !last_su_err.is_empty() {
        last_su_err
    } else if !probe_err.is_empty() {
        probe_err
    } else {
        "exit status non-zero".to_string()
    };
    Err(format!(
        "Elevated shell (sudo) failed ({}). Ensure NOPASSWD is enabled in /etc/sudoers or save the user password.",
        detail
    ))
}

pub async fn open_sftp_subsystem(
    handle: client::Handle<ScpCraftClientHandler>,
    tunnel_handle: Option<client::Handle<ScpCraftClientHandler>>,
    session_id: String,
    site: &SiteConfig,
    method_used: String,
) -> Result<(LiveSftpSession, SftpConnectedInfo), String> {
    let shell_trimmed = site.advanced.shell.trim();
    let wants_sudo = shell_trimmed
        .split_whitespace()
        .next()
        .map(|cmd| cmd.eq_ignore_ascii_case("sudo"))
        .unwrap_or(false);

    let channel = if wants_sudo {
        open_elevated_sftp_channel(&handle, site).await?
    } else {
        let ch = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Failed opening SSH session channel: {}", e))?;
        ch.request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("Failed requesting SFTP subsystem: {}", e))?;
        ch
    };

    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("Failed initializing SFTP protocol: {}", e))?;
    let sftp = Arc::new(sftp);

    let home_path = sftp
        .canonicalize(".")
        .await
        .unwrap_or_else(|_| "/".to_string());

    let preferred_remote = site.advanced.remote_directory.trim();
    let target_start = if preferred_remote.is_empty() {
        home_path.clone()
    } else {
        preferred_remote.to_string()
    };

    let initial_listing = match ops::list_dir_with_sftp(&sftp, &target_start).await {
        Ok(listing) => listing,
        Err(_) => ops::list_dir_with_sftp(&sftp, &home_path).await?,
    };
    let initial_path = initial_listing.path.clone();

    let live = LiveSftpSession {
        sftp,
        ssh: Arc::new(tokio::sync::Mutex::new(handle)),
        _tunnel_ssh: tunnel_handle.map(|h| Arc::new(tokio::sync::Mutex::new(h))),
        host: site.host_name.clone(),
        user_name: site.user_name.clone(),
        home_path: home_path.clone(),
        shell: site.advanced.shell.trim().to_string(),
    };

    let info = SftpConnectedInfo {
        session_id,
        home_path,
        initial_path,
        initial_listing,
        auth_method_used: method_used,
        server_banner: if wants_sudo {
            format!("SSH-2.0 (SFTP+sudo via {})", site.host_name)
        } else {
            format!("SSH-2.0 (SFTP via {})", site.host_name)
        },
    };

    Ok((live, info))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const TEST_KEY_1: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK2pr+Bfus1hvPof4Wb/plZCzSbqadHH0u+/f4ODtKnE test1";
    const TEST_KEY_2: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ test2";

    #[test]
    fn known_hosts_upsert_learns_and_replaces_changed_key() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("scpcraft_kh_{}", nanos));
        fs::create_dir_all(&dir).unwrap();
        let kh = dir.join("known_hosts");

        let mut pk1 = PublicKey::from_openssh(TEST_KEY_1).unwrap();
        pk1.set_comment("");
        let mut pk2 = PublicKey::from_openssh(TEST_KEY_2).unwrap();
        pk2.set_comment("");

        assert_eq!(check_known_hosts_path("example.internal", 2222, &pk1, &kh).unwrap(), false);

        upsert_known_host_in_file(&kh, "example.internal", 2222, TEST_KEY_1).unwrap();
        assert_eq!(check_known_hosts_path("example.internal", 2222, &pk1, &kh).unwrap(), true);
        assert!(matches!(
            check_known_hosts_path("example.internal", 2222, &pk2, &kh),
            Err(russh::keys::Error::KeyChanged { .. })
        ));

        upsert_known_host_in_file(&kh, "example.internal", 2222, TEST_KEY_2).unwrap();
        assert_eq!(check_known_hosts_path("example.internal", 2222, &pk2, &kh).unwrap(), true);

        let _ = fs::remove_dir_all(&dir);
    }
}
