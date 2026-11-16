use serde::{Deserialize, Serialize};
use std::fmt::Write as _;

const PWALG_SIMPLE_MAGIC: u8 = 0xA3;
const PWALG_SIMPLE_FLAG: u8 = 0xFF;
const PWALG_SIMPLE_INTERNAL: u8 = 0x00;
const PWALG_SIMPLE_MIN_FRAME: usize = 48;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SiteProtocol {
    Sftp,
    Scp,
    Ftp,
    #[serde(rename = "webdav")]
    WebDav,
    S3,
}

impl SiteProtocol {
    pub fn default_port(self, ftps_mode: FtpsMode) -> u16 {
        match self {
            Self::Sftp | Self::Scp => 22,
            Self::Ftp => match ftps_mode {
                FtpsMode::Implicit => 990,
                FtpsMode::None | FtpsMode::Explicit => 21,
            },
            Self::WebDav => match ftps_mode {
                FtpsMode::None => 80,
                FtpsMode::Implicit | FtpsMode::Explicit => 443,
            },
            Self::S3 => match ftps_mode {
                FtpsMode::None => 80,
                FtpsMode::Implicit | FtpsMode::Explicit => 443,
            },
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Sftp => "SFTP",
            Self::Scp => "SCP",
            Self::Ftp => "FTP",
            Self::WebDav => "WebDAV",
            Self::S3 => "S3",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FtpsMode {
    None,
    Implicit,
    Explicit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelConfig {
    pub enabled: bool,
    pub host_name: String,
    pub port_number: u16,
    pub user_name: String,
    pub auth_type: String,
    pub private_key_path: String,
    pub local_port: u16,
}

impl Default for SshTunnelConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            host_name: String::new(),
            port_number: 22,
            user_name: String::new(),
            auth_type: "password".to_string(),
            private_key_path: String::new(),
            local_port: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteAdvancedConfig {
    pub remote_directory: String,
    pub local_directory: String,
    pub private_key_path: String,
    pub use_ssh_agent: bool,
    pub agent_forwarding: bool,
    pub ftp_passive_mode: bool,
    pub keepalive_interval_secs: u32,
    pub timeout_secs: u32,
    pub utf8_encoding: String,
    pub eol_style: String,
    #[serde(default)]
    pub shell: String,
    pub s3_url_style: String,
    pub s3_region: String,
    pub tunnel: SshTunnelConfig,
}

impl Default for SiteAdvancedConfig {
    fn default() -> Self {
        Self {
            remote_directory: String::new(),
            local_directory: String::new(),
            private_key_path: String::new(),
            use_ssh_agent: true,
            agent_forwarding: false,
            ftp_passive_mode: true,
            keepalive_interval_secs: 0,
            timeout_secs: 15,
            utf8_encoding: "auto".to_string(),
            eol_style: "lf".to_string(),
            shell: String::new(),
            s3_url_style: "virtualHost".to_string(),
            s3_region: String::new(),
            tunnel: SshTunnelConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteConfig {
    pub id: String,
    pub name: String,
    pub folder: Option<String>,
    pub protocol: SiteProtocol,
    pub ftps_mode: FtpsMode,
    pub host_name: String,
    pub port_number: u16,
    pub user_name: String,
    pub anonymous_login: bool,
    pub s3_env_credentials: bool,
    pub s3_profile: String,
    pub has_password: bool,
    pub has_passphrase: bool,
    pub color: Option<String>,
    pub note: String,
    pub advanced: SiteAdvancedConfig,
}

impl Default for SiteConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            folder: None,
            protocol: SiteProtocol::Sftp,
            ftps_mode: FtpsMode::None,
            host_name: String::new(),
            port_number: 22,
            user_name: String::new(),
            anonymous_login: false,
            s3_env_credentials: false,
            s3_profile: String::new(),
            has_password: false,
            has_passphrase: false,
            color: None,
            note: String::new(),
            advanced: SiteAdvancedConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteSecretBundle {
    pub password: Option<String>,
    pub passphrase: Option<String>,
    pub tunnel_password: Option<String>,
}

/// Encode a single byte into two uppercase hex characters using WinSCP `0xA3` simple obfuscation.
fn simple_encrypt_byte(byte: u8, out: &mut String) {
    let encoded = (!byte) ^ PWALG_SIMPLE_MAGIC;
    let _ = write!(out, "{:02X}", encoded);
}

/// Decode two hex characters back into a byte using WinSCP `0xA3` simple obfuscation.
fn simple_decrypt_next_byte(bytes: &[u8], cursor: &mut usize) -> Option<u8> {
    if *cursor + 2 > bytes.len() {
        return None;
    }
    let hex_str = std::str::from_utf8(&bytes[*cursor..*cursor + 2]).ok()?;
    let raw = u8::from_str_radix(hex_str, 16).ok()?;
    *cursor += 2;
    Some((!raw) ^ PWALG_SIMPLE_MAGIC)
}

/// Obfuscate a password into WinSCP's `WinSCP.ini` `Password=` hex representation.
pub fn encrypt_winscp_password(username: &str, hostname: &str, password: &str) -> String {
    if password.is_empty() {
        return String::new();
    }
    let combined = format!("{}{}{}", username, hostname, password);
    let payload = combined.as_bytes();
    if payload.len() > u8::MAX as usize {
        return String::new();
    }

    let shift = PWALG_SIMPLE_MIN_FRAME.saturating_sub(payload.len()).min(32);
    let mut out = String::with_capacity((4 + shift + payload.len()) * 2);

    simple_encrypt_byte(PWALG_SIMPLE_FLAG, &mut out);
    simple_encrypt_byte(PWALG_SIMPLE_INTERNAL, &mut out);
    simple_encrypt_byte(payload.len() as u8, &mut out);
    simple_encrypt_byte(shift as u8, &mut out);

    // Deterministic padding bytes (masking length in INI files similarly to WinSCP's dummy block)
    for i in 0..shift {
        let pad = (0x20u8).wrapping_add(((i * 37 + payload.len() * 13) % 90) as u8);
        simple_encrypt_byte(pad, &mut out);
    }
    for &b in payload {
        simple_encrypt_byte(b, &mut out);
    }

    out
}

/// Deobfuscate a WinSCP `Password=` hex string using `username` and `hostname`.
pub fn decrypt_winscp_password(username: &str, hostname: &str, hex_cipher: &str) -> Option<String> {
    let trimmed = hex_cipher.trim();
    if trimmed.is_empty() {
        return Some(String::new());
    }
    let bytes = trimmed.as_bytes();
    let mut cursor = 0usize;

    let flag = simple_decrypt_next_byte(bytes, &mut cursor)?;
    let length = if flag == PWALG_SIMPLE_FLAG {
        let version = simple_decrypt_next_byte(bytes, &mut cursor)?;
        if version > PWALG_SIMPLE_INTERNAL {
            // Encrypted with a non-simple scheme (e.g. master password)
            return None;
        }
        simple_decrypt_next_byte(bytes, &mut cursor)? as usize
    } else {
        flag as usize
    };

    let shift = simple_decrypt_next_byte(bytes, &mut cursor)? as usize;
    for _ in 0..shift {
        simple_decrypt_next_byte(bytes, &mut cursor)?;
    }

    let mut plain_bytes = Vec::with_capacity(length);
    for _ in 0..length {
        plain_bytes.push(simple_decrypt_next_byte(bytes, &mut cursor)?);
    }

    let combined = String::from_utf8(plain_bytes).ok()?;
    let prefix = format!("{}{}", username, hostname);
    if let Some(rest) = combined.strip_prefix(&prefix) {
        Some(rest.to_string())
    } else {
        // Fallback when WinSCP saved with empty or changed key
        Some(combined)
    }
}

/// Percent-decode WinSCP INI section/value strings without altering `+` literals.
pub fn winscp_url_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Percent-encode WinSCP INI section names (`/`, space, `%`, `\` etc.).
pub fn winscp_url_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for &b in input.as_bytes() {
        let keep = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~');
        if keep {
            out.push(b as char);
        } else {
            let _ = write!(out, "%{:02X}", b);
        }
    }
    out
}

fn make_deterministic_site_id(folder: Option<&str>, name: &str) -> String {
    let full = match folder {
        Some(f) if !f.is_empty() => format!("{}/{}", f, name),
        _ => name.to_string(),
    };
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in full.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("site-{:012x}", hash & 0xffffffffffff)
}

fn parse_delphi_or_hex_color(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    if t.starts_with('#') && t.len() == 7 {
        return Some(t.to_string());
    }
    let val: i64 = if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        i64::from_str_radix(hex, 16).ok()?
    } else if let Some(hex) = t.strip_prefix('$') {
        i64::from_str_radix(hex, 16).ok()?
    } else {
        t.parse::<i64>().ok()?
    };
    if val < 0 {
        return None;
    }
    // WinSCP / Delphi TColor stores 0x00BBGGRR
    let r = (val & 0xFF) as u8;
    let g = ((val >> 8) & 0xFF) as u8;
    let b = ((val >> 16) & 0xFF) as u8;
    Some(format!("#{:02x}{:02x}{:02x}", r, g, b))
}

fn encode_color_to_delphi(color: &str) -> Option<u32> {
    let hex = color.trim().strip_prefix('#')?;
    if hex.len() != 6 {
        return None;
    }
    let r = u32::from_str_radix(&hex[0..2], 16).ok()?;
    let g = u32::from_str_radix(&hex[2..4], 16).ok()?;
    let b = u32::from_str_radix(&hex[4..6], 16).ok()?;
    Some((b << 16) | (g << 8) | r)
}

fn parse_bool_flag(v: &str) -> bool {
    matches!(v.trim(), "1" | "true" | "True" | "TRUE")
}

/// Parse a `WinSCP.ini` string into `(SiteConfig, SiteSecretBundle)` entries.
pub fn parse_winscp_ini(content: &str) -> Vec<(SiteConfig, SiteSecretBundle)> {
    struct RawSection {
        section_path: String,
        pairs: Vec<(String, String)>,
    }

    let mut sections: Vec<RawSection> = Vec::new();
    let mut current: Option<RawSection> = None;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') && line.len() > 2 {
            if let Some(sec) = current.take() {
                sections.push(sec);
            }
            let header = &line[1..line.len() - 1];
            let suffix = header
                .strip_prefix("Sessions\\")
                .or_else(|| header.strip_prefix("Sessions/"));
            if let Some(s) = suffix {
                let decoded = winscp_url_decode(s);
                if decoded != "Default Settings" && !decoded.is_empty() {
                    current = Some(RawSection {
                        section_path: decoded,
                        pairs: Vec::new(),
                    });
                }
            }
            continue;
        }

        if let Some(sec) = current.as_mut() {
            if let Some((k, v)) = line.split_once('=') {
                sec.pairs.push((k.trim().to_string(), v.trim().to_string()));
            }
        }
    }
    if let Some(sec) = current.take() {
        sections.push(sec);
    }

    let mut result = Vec::with_capacity(sections.len());
    for sec in sections {
        let (folder, name) = match sec.section_path.rsplit_once('/') {
            Some((f, n)) if !f.is_empty() && !n.is_empty() => (Some(f.to_string()), n.to_string()),
            _ => (None, sec.section_path.clone()),
        };

        let mut site = SiteConfig {
            id: make_deterministic_site_id(folder.as_deref(), &name),
            name,
            folder,
            ..SiteConfig::default()
        };
        let mut secrets = SiteSecretBundle::default();
        let mut explicit_port: Option<u16> = None;
        let mut raw_enc_password: Option<String> = None;
        let mut raw_plain_password: Option<String> = None;
        let mut raw_enc_tunnel_password: Option<String> = None;
        let mut raw_plain_tunnel_password: Option<String> = None;

        for (k, v) in &sec.pairs {
            let unescaped = winscp_url_decode(v);
            match k.as_str() {
                "HostName" => site.host_name = unescaped,
                "UserName" => site.user_name = unescaped,
                "PortNumber" => {
                    if let Ok(port) = v.parse::<u16>() {
                        explicit_port = Some(port);
                    }
                }
                "FSProtocol" => {
                    site.protocol = match v.as_str() {
                        "0" => SiteProtocol::Scp,
                        "1" | "2" => SiteProtocol::Sftp,
                        "5" => SiteProtocol::Ftp,
                        "6" => SiteProtocol::WebDav,
                        "7" => SiteProtocol::S3,
                        _ => SiteProtocol::Sftp,
                    };
                }
                "Ftps" => {
                    site.ftps_mode = match v.as_str() {
                        "1" | "3" => FtpsMode::Implicit,
                        "2" => FtpsMode::Explicit,
                        _ => FtpsMode::None,
                    };
                }
                "Password" => raw_enc_password = Some(v.clone()),
                "PasswordPlain" => raw_plain_password = Some(unescaped),
                "Anonymous" => site.anonymous_login = parse_bool_flag(v),
                "S3CredentialsEnv" => site.s3_env_credentials = parse_bool_flag(v),
                "S3Profile" => site.s3_profile = unescaped,
                "S3DefaultRegion" => site.advanced.s3_region = unescaped,
                "S3UrlStyle" => {
                    site.advanced.s3_url_style = if v == "1" || v.eq_ignore_ascii_case("path") {
                        "path".to_string()
                    } else {
                        "virtualHost".to_string()
                    };
                }
                "PublicKeyFile" => site.advanced.private_key_path = unescaped,
                "TryAgent" => site.advanced.use_ssh_agent = parse_bool_flag(v),
                "AgentFwd" => site.advanced.agent_forwarding = parse_bool_flag(v),
                "FtpPasvMode" => site.advanced.ftp_passive_mode = parse_bool_flag(v),
                "PingIntervalSecs" | "FtpPingInterval" => {
                    if let Ok(secs) = v.parse::<u32>() {
                        site.advanced.keepalive_interval_secs = secs;
                    }
                }
                "Timeout" => {
                    if let Ok(secs) = v.parse::<u32>() {
                        site.advanced.timeout_secs = secs;
                    }
                }
                "RemoteDirectory" => site.advanced.remote_directory = unescaped,
                "LocalDirectory" => site.advanced.local_directory = unescaped,
                "Utf" => {
                    site.advanced.utf8_encoding = match v.as_str() {
                        "1" => "on".to_string(),
                        "0" => "off".to_string(),
                        _ => "auto".to_string(),
                    };
                }
                "EOLType" => {
                    site.advanced.eol_style = if v == "1" {
                        "crlf".to_string()
                    } else {
                        "lf".to_string()
                    };
                }
                "Color" => site.color = parse_delphi_or_hex_color(v),
                "Note" => site.note = unescaped.replace("\\n", "\n"),
                "Tunnel" => site.advanced.tunnel.enabled = parse_bool_flag(v),
                "TunnelHostName" => site.advanced.tunnel.host_name = unescaped,
                "TunnelPortNumber" => {
                    if let Ok(p) = v.parse::<u16>() {
                        site.advanced.tunnel.port_number = p;
                    }
                }
                "TunnelUserName" => site.advanced.tunnel.user_name = unescaped,
                "TunnelPassword" => raw_enc_tunnel_password = Some(v.clone()),
                "TunnelPasswordPlain" => raw_plain_tunnel_password = Some(unescaped),
                "TunnelPublicKeyFile" => {
                    site.advanced.tunnel.private_key_path = unescaped;
                    if !site.advanced.tunnel.private_key_path.is_empty() {
                        site.advanced.tunnel.auth_type = "publicKey".to_string();
                    }
                }
                "TunnelLocalPortNumber" => {
                    if let Ok(p) = v.parse::<u16>() {
                        site.advanced.tunnel.local_port = p;
                    }
                }
                "NameOverride" => {
                    if !unescaped.is_empty() {
                        site.name = unescaped;
                    }
                }
                _ => {}
            }
        }

        // Ignore pure folder placeholder entries in WinSCP registry/ini without host & protocol keys
        if site.host_name.is_empty() && sec.pairs.is_empty() {
            continue;
        }

        // For WebDAV without Ftps explicitly set, Ftps=1/3 means HTTPS -> normalize Implicit as TLS
        site.port_number = explicit_port.unwrap_or_else(|| site.protocol.default_port(site.ftps_mode));

        if let Some(plain) = raw_plain_password.filter(|s| !s.is_empty()) {
            site.has_password = true;
            secrets.password = Some(plain);
        } else if let Some(enc) = raw_enc_password.filter(|s| !s.is_empty()) {
            if let Some(decoded) = decrypt_winscp_password(&site.user_name, &site.host_name, &enc) {
                if !decoded.is_empty() {
                    site.has_password = true;
                    secrets.password = Some(decoded);
                }
            }
        }

        if let Some(plain) = raw_plain_tunnel_password.filter(|s| !s.is_empty()) {
            secrets.tunnel_password = Some(plain);
        } else if let Some(enc) = raw_enc_tunnel_password.filter(|s| !s.is_empty()) {
            if let Some(decoded) = decrypt_winscp_password(
                &site.advanced.tunnel.user_name,
                &site.advanced.tunnel.host_name,
                &enc,
            ) {
                if !decoded.is_empty() {
                    secrets.tunnel_password = Some(decoded);
                }
            }
        }

        result.push((site, secrets));
    }

    result
}

/// Export sites + optional keyring secrets into standard `WinSCP.ini` text.
pub fn export_winscp_ini(items: &[(SiteConfig, SiteSecretBundle)]) -> String {
    let mut out = String::from(
        "; WinSCP configuration exported by ScpCraft\n\
         [Configuration\\Interface]\n\
         ConfirmExitOnCompletion=1\n\n",
    );

    for (site, secrets) in items {
        let raw_path = match &site.folder {
            Some(f) if !f.is_empty() => format!("{}/{}", f, site.name),
            _ => site.name.clone(),
        };
        let encoded_section = winscp_url_encode(&raw_path);
        let _ = writeln!(out, "[Sessions\\{}]", encoded_section);

        if !site.host_name.is_empty() {
            let _ = writeln!(out, "HostName={}", winscp_url_encode(&site.host_name));
        }
        let default_port = site.protocol.default_port(site.ftps_mode);
        if site.port_number != default_port {
            let _ = writeln!(out, "PortNumber={}", site.port_number);
        }
        if !site.user_name.is_empty() {
            let _ = writeln!(out, "UserName={}", winscp_url_encode(&site.user_name));
        }

        let fs_protocol = match site.protocol {
            SiteProtocol::Scp => "0",
            SiteProtocol::Sftp => "2",
            SiteProtocol::Ftp => "5",
            SiteProtocol::WebDav => "6",
            SiteProtocol::S3 => "7",
        };
        let _ = writeln!(out, "FSProtocol={}", fs_protocol);

        let ftps_code = match site.ftps_mode {
            FtpsMode::None => 0,
            FtpsMode::Implicit => 1,
            FtpsMode::Explicit => 2,
        };
        if ftps_code != 0 {
            let _ = writeln!(out, "Ftps={}", ftps_code);
        }

        if let Some(pwd) = secrets.password.as_deref().filter(|s| !s.is_empty()) {
            let enc = encrypt_winscp_password(&site.user_name, &site.host_name, pwd);
            if !enc.is_empty() {
                let _ = writeln!(out, "Password={}", enc);
            }
        }

        if site.anonymous_login {
            let _ = writeln!(out, "Anonymous=1");
        }
        if site.s3_env_credentials {
            let _ = writeln!(out, "S3CredentialsEnv=1");
        }
        if !site.s3_profile.is_empty() {
            let _ = writeln!(out, "S3Profile={}", winscp_url_encode(&site.s3_profile));
        }
        if !site.advanced.s3_region.is_empty() {
            let _ = writeln!(
                out,
                "S3DefaultRegion={}",
                winscp_url_encode(&site.advanced.s3_region)
            );
        }
        if site.advanced.s3_url_style == "path" {
            let _ = writeln!(out, "S3UrlStyle=1");
        }
        if !site.advanced.remote_directory.is_empty() {
            let _ = writeln!(
                out,
                "RemoteDirectory={}",
                winscp_url_encode(&site.advanced.remote_directory)
            );
        }
        if !site.advanced.local_directory.is_empty() {
            let _ = writeln!(
                out,
                "LocalDirectory={}",
                winscp_url_encode(&site.advanced.local_directory)
            );
        }
        if !site.advanced.private_key_path.is_empty() {
            let _ = writeln!(
                out,
                "PublicKeyFile={}",
                winscp_url_encode(&site.advanced.private_key_path)
            );
        }
        if !site.advanced.use_ssh_agent {
            let _ = writeln!(out, "TryAgent=0");
        }
        if site.advanced.agent_forwarding {
            let _ = writeln!(out, "AgentFwd=1");
        }
        if !site.advanced.ftp_passive_mode {
            let _ = writeln!(out, "FtpPasvMode=0");
        }
        if site.advanced.keepalive_interval_secs > 0 {
            let _ = writeln!(
                out,
                "PingIntervalSecs={}",
                site.advanced.keepalive_interval_secs
            );
        }
        if site.advanced.timeout_secs != 15 {
            let _ = writeln!(out, "Timeout={}", site.advanced.timeout_secs);
        }
        match site.advanced.utf8_encoding.as_str() {
            "on" => {
                let _ = writeln!(out, "Utf=1");
            }
            "off" => {
                let _ = writeln!(out, "Utf=0");
            }
            _ => {}
        }
        if site.advanced.eol_style == "crlf" {
            let _ = writeln!(out, "EOLType=1");
        }
        if let Some(color_hex) = site.color.as_deref() {
            if let Some(delphi_color) = encode_color_to_delphi(color_hex) {
                let _ = writeln!(out, "Color={}", delphi_color);
            }
        }
        if !site.note.is_empty() {
            let escaped_note = site.note.replace('\n', "\\n");
            let _ = writeln!(out, "Note={}", winscp_url_encode(&escaped_note));
        }

        if site.advanced.tunnel.enabled {
            let _ = writeln!(out, "Tunnel=1");
            if !site.advanced.tunnel.host_name.is_empty() {
                let _ = writeln!(
                    out,
                    "TunnelHostName={}",
                    winscp_url_encode(&site.advanced.tunnel.host_name)
                );
            }
            if site.advanced.tunnel.port_number != 22 {
                let _ = writeln!(out, "TunnelPortNumber={}", site.advanced.tunnel.port_number);
            }
            if !site.advanced.tunnel.user_name.is_empty() {
                let _ = writeln!(
                    out,
                    "TunnelUserName={}",
                    winscp_url_encode(&site.advanced.tunnel.user_name)
                );
            }
            if let Some(tpwd) = secrets.tunnel_password.as_deref().filter(|s| !s.is_empty()) {
                let enc = encrypt_winscp_password(
                    &site.advanced.tunnel.user_name,
                    &site.advanced.tunnel.host_name,
                    tpwd,
                );
                if !enc.is_empty() {
                    let _ = writeln!(out, "TunnelPassword={}", enc);
                }
            }
            if !site.advanced.tunnel.private_key_path.is_empty() {
                let _ = writeln!(
                    out,
                    "TunnelPublicKeyFile={}",
                    winscp_url_encode(&site.advanced.tunnel.private_key_path)
                );
            }
            if site.advanced.tunnel.local_port > 0 {
                let _ = writeln!(
                    out,
                    "TunnelLocalPortNumber={}",
                    site.advanced.tunnel.local_port
                );
            }
        }

        out.push('\n');
    }

    out
}

/// Convert Windows `reg query "HKCU\Software\Martin Prikryl\WinSCP 2\Sessions" /s` output to INI text.
pub fn winscp_reg_query_to_ini(reg_output: &str) -> String {
    const PREFIX: &str = "HKEY_CURRENT_USER\\Software\\Martin Prikryl\\WinSCP 2\\Sessions\\";
    let mut ini = String::new();
    let mut in_valid_section = false;

    for raw_line in reg_output.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix(PREFIX) {
            if !rest.is_empty() {
                ini.push_str(&format!("\n[Sessions\\{}]\n", rest));
                in_valid_section = true;
            } else {
                in_valid_section = false;
            }
            continue;
        }
        if trimmed.starts_with("HKEY_") {
            in_valid_section = false;
            continue;
        }
        if !in_valid_section {
            continue;
        }

        // Standard reg.exe row: `    ValueName    REG_SZ    ValueData`
        let parts: Vec<&str> = trimmed.split("    ").collect();
        if parts.len() >= 2 {
            let key = parts[0].trim();
            let reg_type = parts[1].trim();
            let val = if parts.len() >= 3 {
                parts[2..].join("    ").trim().to_string()
            } else {
                String::new()
            };
            if key == "(Default)" {
                continue;
            }
            if reg_type == "REG_DWORD" {
                let num = if let Some(hex) = val.strip_prefix("0x").or_else(|| val.strip_prefix("0X")) {
                    u64::from_str_radix(hex, 16).unwrap_or(0)
                } else {
                    val.parse::<u64>().unwrap_or(0)
                };
                let _ = writeln!(ini, "{}={}", key, num);
            } else {
                let _ = writeln!(ini, "{}={}", key, val);
            }
        }
    }

    ini
}

/// Read WinSCP saved sessions from Windows Registry `HKCU\Software\Martin Prikryl\WinSCP 2\Sessions`.
pub fn import_winscp_registry_sessions() -> Result<Vec<(SiteConfig, SiteSecretBundle)>, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let output = std::process::Command::new("reg")
            .args([
                "query",
                r"HKCU\Software\Martin Prikryl\WinSCP 2\Sessions",
                "/s",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Failed to invoke reg.exe: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "No WinSCP sessions found in Windows Registry ({})",
                stderr.trim()
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let ini_text = winscp_reg_query_to_ini(&stdout);
        let parsed = parse_winscp_ini(&ini_text);
        Ok(parsed)
    }

    #[cfg(not(windows))]
    {
        Err("Windows Registry import is only supported on Windows hosts.".to_string())
    }
}

/// Parse a WinSCP / standard session URL (e.g. `sftp://user:pass@host:22/path`).
pub fn parse_session_url(raw_url: &str) -> Result<(SiteConfig, Option<String>), String> {
    let trimmed = raw_url.trim();
    let (scheme, rest) = trimmed
        .split_once("://")
        .ok_or_else(|| "Session URL must include scheme (e.g. sftp://user@host/)".to_string())?;

    let (protocol, ftps_mode) = match scheme.to_ascii_lowercase().as_str() {
        "sftp" => (SiteProtocol::Sftp, FtpsMode::None),
        "scp" => (SiteProtocol::Scp, FtpsMode::None),
        "ftp" => (SiteProtocol::Ftp, FtpsMode::None),
        "ftps" => (SiteProtocol::Ftp, FtpsMode::Implicit),
        "ftpes" => (SiteProtocol::Ftp, FtpsMode::Explicit),
        "http" | "dav" | "webdav" => (SiteProtocol::WebDav, FtpsMode::None),
        "https" | "davs" | "webdavs" => (SiteProtocol::WebDav, FtpsMode::Implicit),
        "s3" | "s3plain" => (
            SiteProtocol::S3,
            if scheme.eq_ignore_ascii_case("s3plain") {
                FtpsMode::None
            } else {
                FtpsMode::Implicit
            },
        ),
        other => return Err(format!("Unsupported URL scheme: {}", other)),
    };

    let (authority, path) = match rest.split_once('/') {
        Some((a, p)) => (a, format!("/{}", p)),
        None => (rest, String::new()),
    };

    let (userinfo, hostport) = match authority.rsplit_once('@') {
        Some((u, h)) => (Some(u), h),
        None => (None, authority),
    };

    let (user_name, password) = match userinfo {
        Some(u) => match u.split_once(':') {
            Some((user, pass)) => (winscp_url_decode(user), Some(winscp_url_decode(pass))),
            None => (winscp_url_decode(u), None),
        },
        None => (String::new(), None),
    };

    let (host_name, explicit_port) = if hostport.starts_with('[') {
        if let Some((ipv6, port_part)) = hostport.split_once("]:") {
            let p = port_part.parse::<u16>().ok();
            (ipv6.trim_start_matches('[').to_string(), p)
        } else {
            (hostport.trim_matches(&['[', ']'][..]).to_string(), None)
        }
    } else if let Some((h, p_str)) = hostport.rsplit_once(':') {
        match p_str.parse::<u16>() {
            Ok(p) => (h.to_string(), Some(p)),
            Err(_) => (hostport.to_string(), None),
        }
    } else {
        (hostport.to_string(), None)
    };

    if host_name.is_empty() {
        return Err("Session URL is missing a hostname".to_string());
    }

    let port_number = explicit_port.unwrap_or_else(|| protocol.default_port(ftps_mode));
    let name = if user_name.is_empty() {
        host_name.clone()
    } else {
        format!("{}@{}", user_name, host_name)
    };

    let mut site = SiteConfig {
        id: make_deterministic_site_id(None, &name),
        name,
        folder: None,
        protocol,
        ftps_mode,
        host_name,
        port_number,
        user_name,
        has_password: password.as_ref().is_some_and(|p| !p.is_empty()),
        ..SiteConfig::default()
    };
    if !path.is_empty() && path != "/" {
        site.advanced.remote_directory = winscp_url_decode(&path);
    }

    Ok((site, password))
}

/// Generate a standard WinSCP Session URL and CLI command snippet.
pub fn generate_session_url(
    site: &SiteConfig,
    password: Option<&str>,
    include_password: bool,
) -> (String, String) {
    let scheme = match (site.protocol, site.ftps_mode) {
        (SiteProtocol::Sftp, _) => "sftp",
        (SiteProtocol::Scp, _) => "scp",
        (SiteProtocol::Ftp, FtpsMode::None) => "ftp",
        (SiteProtocol::Ftp, FtpsMode::Implicit) => "ftps",
        (SiteProtocol::Ftp, FtpsMode::Explicit) => "ftpes",
        (SiteProtocol::WebDav, FtpsMode::None) => "dav",
        (SiteProtocol::WebDav, _) => "davs",
        (SiteProtocol::S3, FtpsMode::None) => "s3plain",
        (SiteProtocol::S3, _) => "s3",
    };

    let mut auth = String::new();
    if !site.user_name.is_empty() {
        auth.push_str(&winscp_url_encode(&site.user_name));
        if include_password {
            if let Some(pwd) = password.filter(|p| !p.is_empty()) {
                auth.push(':');
                auth.push_str(&winscp_url_encode(pwd));
            }
        }
        auth.push('@');
    }

    let default_port = site.protocol.default_port(site.ftps_mode);
    let port_part = if site.port_number != default_port {
        format!(":{}", site.port_number)
    } else {
        String::new()
    };

    let dir_part = if !site.advanced.remote_directory.is_empty() {
        let dir = site.advanced.remote_directory.trim_start_matches('/');
        if dir.is_empty() {
            "/".to_string()
        } else {
            format!("/{}/", dir.trim_end_matches('/'))
        }
    } else {
        "/".to_string()
    };

    let url = format!("{}://{}{}{}{}", scheme, auth, site.host_name, port_part, dir_part);
    let cli = format!("winscp.com \"{}\"", url);
    (url, cli)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_obfuscation_round_trip() {
        let user = "deploy_admin";
        let host = "prod.example.org";
        let secret = "S3cr3t!P@ss#2026";
        let enc = encrypt_winscp_password(user, host, secret);
        assert!(enc.len() >= 10);
        assert!(!enc.contains(secret));
        let dec = decrypt_winscp_password(user, host, &enc).expect("should decode");
        assert_eq!(dec, secret);
    }

    #[test]
    fn winscp_ini_round_trip_with_folder_and_tunnel() {
        let mut site = SiteConfig {
            id: "s1".to_string(),
            name: "AWS Dev".to_string(),
            folder: Some("FoodCloud".to_string()),
            protocol: SiteProtocol::Scp,
            ftps_mode: FtpsMode::None,
            host_name: "dev.efoodex.net".to_string(),
            port_number: 2222,
            user_name: "root".to_string(),
            has_password: true,
            color: Some("#22c55e".to_string()),
            note: "Staging server\nDo not restart".to_string(),
            ..SiteConfig::default()
        };
        site.advanced.remote_directory = "/var/www/app".to_string();
        site.advanced.private_key_path = "C:\\Keys\\aws-dev.ppk".to_string();
        site.advanced.tunnel = SshTunnelConfig {
            enabled: true,
            host_name: "bastion.efoodex.net".to_string(),
            port_number: 22,
            user_name: "jump".to_string(),
            auth_type: "publicKey".to_string(),
            private_key_path: "C:\\Keys\\bastion.ppk".to_string(),
            local_port: 50022,
        };

        let secrets = SiteSecretBundle {
            password: Some("SuperSecret123".to_string()),
            passphrase: None,
            tunnel_password: Some("TunnelPass456".to_string()),
        };

        let ini = export_winscp_ini(&[(site.clone(), secrets.clone())]);
        assert!(ini.contains("[Sessions\\FoodCloud%2FAWS%20Dev]"));
        assert!(!ini.contains("SuperSecret123"));
        assert!(!ini.contains("TunnelPass456"));

        let parsed = parse_winscp_ini(&ini);
        assert_eq!(parsed.len(), 1);
        let (p_site, p_sec) = &parsed[0];
        assert_eq!(p_site.folder.as_deref(), Some("FoodCloud"));
        assert_eq!(p_site.name, "AWS Dev");
        assert_eq!(p_site.protocol, SiteProtocol::Scp);
        assert_eq!(p_site.host_name, "dev.efoodex.net");
        assert_eq!(p_site.port_number, 2222);
        assert_eq!(p_site.user_name, "root");
        assert_eq!(p_site.color.as_deref(), Some("#22c55e"));
        assert_eq!(p_site.note, "Staging server\nDo not restart");
        assert_eq!(p_site.advanced.remote_directory, "/var/www/app");
        assert_eq!(p_site.advanced.private_key_path, "C:\\Keys\\aws-dev.ppk");
        assert!(p_site.advanced.tunnel.enabled);
        assert_eq!(p_site.advanced.tunnel.host_name, "bastion.efoodex.net");
        assert_eq!(p_sec.password.as_deref(), Some("SuperSecret123"));
        assert_eq!(p_sec.tunnel_password.as_deref(), Some("TunnelPass456"));
    }

    #[test]
    fn reg_query_converter_parses_dword_and_sz() {
        let reg = r#"
HKEY_CURRENT_USER\Software\Martin Prikryl\WinSCP 2\Sessions\FoodCloud%2FAWS%20Dev
    HostName    REG_SZ    dev.efoodex.net
    UserName    REG_SZ    root
    FSProtocol    REG_DWORD    0x0
    PortNumber    REG_DWORD    0x16
"#;
        let ini = winscp_reg_query_to_ini(reg);
        let parsed = parse_winscp_ini(&ini);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].0.folder.as_deref(), Some("FoodCloud"));
        assert_eq!(parsed[0].0.name, "AWS Dev");
        assert_eq!(parsed[0].0.protocol, SiteProtocol::Scp);
        assert_eq!(parsed[0].0.port_number, 22);
    }

    #[test]
    fn session_url_parse_and_generate() {
        let (site, pass) =
            parse_session_url("ftpes://alice:p%40ss@files.example.com:2121/incoming").unwrap();
        assert_eq!(site.protocol, SiteProtocol::Ftp);
        assert_eq!(site.ftps_mode, FtpsMode::Explicit);
        assert_eq!(site.user_name, "alice");
        assert_eq!(site.host_name, "files.example.com");
        assert_eq!(site.port_number, 2121);
        assert_eq!(site.advanced.remote_directory, "/incoming");
        assert_eq!(pass.as_deref(), Some("p@ss"));

        let (url_masked, _) = generate_session_url(&site, pass.as_deref(), false);
        assert_eq!(url_masked, "ftpes://alice@files.example.com:2121/incoming/");
        let (url_full, _) = generate_session_url(&site, pass.as_deref(), true);
        assert_eq!(
            url_full,
            "ftpes://alice:p%40ss@files.example.com:2121/incoming/"
        );
    }
}
