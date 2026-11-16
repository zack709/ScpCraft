use crate::config::winscp_ini::FtpsMode;
use crate::fs_trait::RemoteFileSystem;
use crate::local_fs::{DirectoryListing, FileEntry};
use crate::protocols::{
    make_protocol_entry, parse_month_abbr, parse_protocol_timestamp_ms, ymdhms_to_epoch_ms,
};
use crate::sftp::ops::{
    self, build_remote_breadcrumbs, compute_bytes_checksums, join_remote_path,
    normalize_remote_path, parse_octal_mode, remote_parent_path, validate_remote_name,
    RemoteFileProperties,
};
use crate::sftp::session::{
    AuthChallengeInfo, AuthPromptItem, SftpConnectRequest, SftpConnectedInfo,
};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::sync::Mutex as AsyncMutex;

struct FtpControlConn {
    reader: BufReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
}

pub struct FtpRemoteFs {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub ftps_mode: FtpsMode,
    pub passive: bool,
    pub timeout_secs: u64,
    pub home_path: String,
    control: Arc<AsyncMutex<Option<FtpControlConn>>>,
}

fn format_challenge_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("ftp_auth_{:x}", nanos)
}

async fn read_ftp_response(reader: &mut BufReader<OwnedReadHalf>) -> Result<(u16, String), String> {
    let mut first_line = String::new();
    let n = reader
        .read_line(&mut first_line)
        .await
        .map_err(|e| format!("FTP control read error: {}", e))?;
    if n == 0 {
        return Err("FTP server closed control connection unexpectedly".to_string());
    }
    let clean_first = first_line.trim_end_matches(['\r', '\n']);
    if clean_first.len() < 3 || !clean_first.as_bytes()[..3].iter().all(|b| b.is_ascii_digit()) {
        return Err(format!("Malformed FTP response: '{}'", clean_first));
    }
    let code: u16 = clean_first[..3]
        .parse()
        .map_err(|_| format!("Invalid FTP status code: '{}'", clean_first))?;
    let mut lines = vec![clean_first.to_string()];

    // RFC 959 multi-line response continues until `<code_str> <text>` arrives
    if clean_first.as_bytes().get(3) == Some(&b'-') {
        let end_prefix = format!("{:03} ", code);
        loop {
            let mut next = String::new();
            let read_n = reader
                .read_line(&mut next)
                .await
                .map_err(|e| format!("FTP multi-line read error: {}", e))?;
            if read_n == 0 {
                break;
            }
            let clean = next.trim_end_matches(['\r', '\n']);
            lines.push(clean.to_string());
            if clean.starts_with(&end_prefix) || clean == format!("{:03}", code) {
                break;
            }
        }
    }

    Ok((code, lines.join("\n")))
}

async fn send_ftp_cmd(conn: &mut FtpControlConn, cmd: &str) -> Result<(u16, String), String> {
    let wire = format!("{}\r\n", cmd);
    conn.writer
        .write_all(wire.as_bytes())
        .await
        .map_err(|e| format!("FTP control write error ({}): {}", cmd, e))?;
    conn.writer
        .flush()
        .await
        .map_err(|e| format!("FTP control flush error ({}): {}", cmd, e))?;
    read_ftp_response(&mut conn.reader).await
}

pub fn parse_pasv_addr(resp: &str, fallback_host: &str) -> Result<(String, u16), String> {
    let start = resp
        .find('(')
        .ok_or_else(|| format!("PASV response missing '(' : {}", resp))?;
    let end = resp[start + 1..]
        .find(')')
        .map(|i| start + 1 + i)
        .ok_or_else(|| format!("PASV response missing ')' : {}", resp))?;
    let nums: Vec<u16> = resp[start + 1..end]
        .split(',')
        .filter_map(|s| s.trim().parse::<u16>().ok())
        .collect();
    if nums.len() != 6 {
        return Err(format!("Invalid PASV tuple in '{}'", resp));
    }
    let ip = format!("{}.{}.{}.{}", nums[0], nums[1], nums[2], nums[3]);
    let host = if ip == "0.0.0.0" {
        fallback_host.to_string()
    } else {
        ip
    };
    let port = (nums[4] << 8) | nums[5];
    Ok((host, port))
}

pub fn parse_epsv_port(resp: &str) -> Result<u16, String> {
    let start = resp
        .find('(')
        .ok_or_else(|| format!("EPSV response missing '(' : {}", resp))?;
    let end = resp[start + 1..]
        .find(')')
        .map(|i| start + 1 + i)
        .ok_or_else(|| format!("EPSV response missing ')' : {}", resp))?;
    let inner = &resp[start + 1..end];
    let parts: Vec<&str> = inner.split('|').collect();
    for part in parts.iter().rev() {
        let trimmed = part.trim();
        if !trimmed.is_empty() {
            if let Ok(port) = trimmed.parse::<u16>() {
                return Ok(port);
            }
        }
    }
    Err(format!("Invalid EPSV port in '{}'", resp))
}

fn parse_pwd_response(resp: &str) -> String {
    if let Some(first_q) = resp.find('"') {
        if let Some(end_q) = resp[first_q + 1..].find('"') {
            return normalize_remote_path(&resp[first_q + 1..first_q + 1 + end_q]);
        }
    }
    for tok in resp.split_whitespace().skip(1) {
        if tok.starts_with('/') {
            return normalize_remote_path(tok);
        }
    }
    "/".to_string()
}

fn parse_unix_perm_bits(mode_str: &str) -> Option<u32> {
    let chars: Vec<char> = mode_str.chars().collect();
    if chars.len() < 10 {
        return None;
    }
    let mut mode = 0u32;
    let bit_map = [
        (1, 'r', 0o400),
        (2, 'w', 0o200),
        (3, 'x', 0o100),
        (4, 'r', 0o040),
        (5, 'w', 0o020),
        (6, 'x', 0o010),
        (7, 'r', 0o004),
        (8, 'w', 0o002),
        (9, 'x', 0o001),
    ];
    for &(idx, expected, bit) in &bit_map {
        if chars[idx] == expected || ((idx % 3 == 0) && matches!(chars[idx], 's' | 't')) {
            mode |= bit;
        }
    }
    if matches!(chars[3], 's' | 'S') {
        mode |= 0o4000;
    }
    if matches!(chars[6], 's' | 'S') {
        mode |= 0o2000;
    }
    if matches!(chars[9], 't' | 'T') {
        mode |= 0o1000;
    }
    Some(mode)
}

pub fn parse_mlsd_line(dir: &str, raw_line: &str) -> Option<FileEntry> {
    let line = raw_line.trim_end_matches(['\r', '\n']);
    let (facts_str, raw_name) = line.split_once(' ')?;
    let name = raw_name.trim_start();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }

    let mut is_dir = false;
    let mut is_symlink = false;
    let mut size = 0u64;
    let mut modified_ms: Option<u64> = None;
    let mut perm_bits: Option<u32> = None;

    for fact in facts_str.split(';').filter(|s| !s.is_empty()) {
        let Some((k, v)) = fact.split_once('=') else {
            continue;
        };
        match k.to_ascii_lowercase().as_str() {
            "type" => {
                let low = v.to_ascii_lowercase();
                if low == "cdir" || low == "pdir" {
                    return None;
                }
                if low == "dir" {
                    is_dir = true;
                } else if low.starts_with("os.unix=symlink") || low == "symlink" {
                    is_symlink = true;
                }
            }
            "size" | "sizd" => {
                size = v.parse::<u64>().unwrap_or(0);
            }
            "modify" => {
                modified_ms = parse_protocol_timestamp_ms(v);
            }
            "unix.mode" => {
                if let Ok(m) = u32::from_str_radix(v.trim(), 8) {
                    perm_bits = Some(m);
                }
            }
            _ => {}
        }
    }

    Some(make_protocol_entry(
        name.to_string(),
        join_remote_path(dir, name),
        is_dir,
        is_symlink,
        size,
        modified_ms,
        perm_bits,
        None,
    ))
}

fn parse_unix_month_day_time(mon: &str, day_s: &str, year_or_time: &str) -> Option<u64> {
    let month = parse_month_abbr(mon)?;
    let day: u32 = day_s.parse().ok()?;
    if let Some((h_s, m_s)) = year_or_time.split_once(':') {
        let h: u32 = h_s.parse().ok()?;
        let m: u32 = m_s.parse().ok()?;
        // Approximate current year when UNIX `ls -l` omits year
        return ymdhms_to_epoch_ms(2026, month, day, h, m, 0);
    }
    let year: i64 = year_or_time.parse().ok()?;
    ymdhms_to_epoch_ms(year, month, day, 0, 0, 0)
}

pub fn parse_list_line(dir: &str, raw_line: &str) -> Option<FileEntry> {
    let line = raw_line.trim_end_matches(['\r', '\n']).trim_start();
    if line.is_empty() || line.starts_with("total ") {
        return None;
    }

    // UNIX format: `drwxr-xr-x 2 user group 4096 Nov 15 14:30 dirname`
    let first_ch = line.chars().next()?;
    if matches!(first_ch, 'd' | '-' | 'l' | 'b' | 'c' | 'p' | 's') && line.len() > 25 {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 9 {
            let perm_col = parts[0];
            let is_dir = perm_col.starts_with('d');
            let is_symlink = perm_col.starts_with('l');
            let size = parts[4].parse::<u64>().unwrap_or(0);
            let mtime = parse_unix_month_day_time(parts[5], parts[6], parts[7]);
            let rest = parts[8..].join(" ");
            let (name, symlink_target) = if is_symlink {
                if let Some((n, tgt)) = rest.split_once(" -> ") {
                    (n.to_string(), Some(tgt.to_string()))
                } else {
                    (rest, None)
                }
            } else {
                (rest, None)
            };
            if name == "." || name == ".." || name.is_empty() {
                return None;
            }
            return Some(make_protocol_entry(
                name.clone(),
                join_remote_path(dir, &name),
                is_dir,
                is_symlink,
                size,
                mtime,
                parse_unix_perm_bits(perm_col),
                symlink_target,
            ));
        }
    }

    // DOS / Windows IIS FTP format: `11-15-26  10:22PM       <DIR>          folder`
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() >= 4 && (parts[0].contains('-') || parts[0].contains('/')) {
        let is_dir = parts[2].eq_ignore_ascii_case("<DIR>");
        let size = if is_dir {
            0
        } else {
            parts[2].parse::<u64>().unwrap_or(0)
        };
        let name = parts[3..].join(" ");
        if name == "." || name == ".." || name.is_empty() {
            return None;
        }
        return Some(make_protocol_entry(
            name.clone(),
            join_remote_path(dir, &name),
            is_dir,
            false,
            size,
            None,
            None,
            None,
        ));
    }

    None
}

async fn establish_ftp_control(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    ftps_mode: FtpsMode,
    timeout_secs: u64,
) -> Result<(FtpControlConn, String, String), String> {
    if ftps_mode == FtpsMode::Implicit {
        return Err(
            "Implicit FTPS (port 990 TLS wrapper) requires external TLS; select FTP (plain) or SFTP."
                .to_string(),
        );
    }

    let addr = format!("{}:{}", host, port);
    let stream = tokio::time::timeout(
        Duration::from_secs(timeout_secs.max(5)),
        TcpStream::connect(&addr),
    )
    .await
    .map_err(|_| format!("Timed out connecting to FTP server {}", addr))?
    .map_err(|e| format!("Failed connecting to FTP server {}: {}", addr, e))?;

    let (read_half, write_half) = stream.into_split();
    let mut conn = FtpControlConn {
        reader: BufReader::new(read_half),
        writer: write_half,
    };

    let (greet_code, banner) = read_ftp_response(&mut conn.reader).await?;
    if !(200..300).contains(&greet_code) {
        return Err(format!("FTP server rejected connection: {}", banner));
    }

    if ftps_mode == FtpsMode::Explicit {
        let (tls_code, tls_msg) = send_ftp_cmd(&mut conn, "AUTH TLS").await?;
        if tls_code == 234 {
            return Err(format!(
                "Server accepted Explicit FTPS ({}), which requires a TLS socket layer not bundled in this build.",
                tls_msg
            ));
        }
    }

    let effective_user = if user.trim().is_empty() {
        "anonymous"
    } else {
        user.trim()
    };
    let (u_code, u_msg) = send_ftp_cmd(&mut conn, &format!("USER {}", effective_user)).await?;
    if u_code == 331 || u_code == 332 {
        let (p_code, p_msg) = send_ftp_cmd(&mut conn, &format!("PASS {}", password)).await?;
        if !(200..300).contains(&p_code) {
            return Err(format!("FTP authentication failed: {}", p_msg));
        }
    } else if !(200..300).contains(&u_code) {
        return Err(format!("FTP USER rejected: {}", u_msg));
    }

    let _ = send_ftp_cmd(&mut conn, "OPTS UTF8 ON").await;
    let _ = send_ftp_cmd(&mut conn, "TYPE I").await;

    let (pwd_code, pwd_resp) = send_ftp_cmd(&mut conn, "PWD").await?;
    let home = if (200..300).contains(&pwd_code) {
        parse_pwd_response(&pwd_resp)
    } else {
        "/".to_string()
    };

    Ok((conn, home, banner))
}

macro_rules! ftp_retry {
    ($self:ident, |$conn:ident| $body:block) => {{
        let mut guard = $self.control.lock().await;
        if guard.is_none() {
            let (conn, _, _) = establish_ftp_control(
                &$self.host,
                $self.port,
                &$self.user,
                &$self.password,
                $self.ftps_mode,
                $self.timeout_secs,
            )
            .await?;
            *guard = Some(conn);
        }
        let first_res = {
            let $conn = guard.as_mut().unwrap();
            $body
        };
        if first_res.is_ok() {
            first_res
        } else if let Ok((conn, _, _)) = establish_ftp_control(
            &$self.host,
            $self.port,
            &$self.user,
            &$self.password,
            $self.ftps_mode,
            $self.timeout_secs,
        )
        .await
        {
            *guard = Some(conn);
            let $conn = guard.as_mut().unwrap();
            $body
        } else {
            first_res
        }
    }};
}

impl FtpRemoteFs {
    async fn open_passive_data_stream(
        &self,
        conn: &mut FtpControlConn,
    ) -> Result<TcpStream, String> {
        let (target_host, target_port) = match send_ftp_cmd(conn, "EPSV").await {
            Ok((229, msg)) => (self.host.clone(), parse_epsv_port(&msg)?),
            _ => {
                let (code, msg) = send_ftp_cmd(conn, "PASV").await?;
                if code != 227 {
                    return Err(format!("FTP PASV failed ({}): {}", code, msg));
                }
                parse_pasv_addr(&msg, &self.host)?
            }
        };

        let addr = format!("{}:{}", target_host, target_port);
        tokio::time::timeout(
            Duration::from_secs(self.timeout_secs.max(5)),
            TcpStream::connect(&addr),
        )
        .await
        .map_err(|_| format!("Timed out opening FTP data socket {}", addr))?
        .map_err(|e| format!("Failed opening FTP data socket {}: {}", addr, e))
    }

    async fn list_raw_dir(
        &self,
        conn: &mut FtpControlConn,
        path: &str,
    ) -> Result<DirectoryListing, String> {
        let target = if path.trim().is_empty() || path == "." || path == "~" {
            self.home_path.clone()
        } else {
            normalize_remote_path(path)
        };

        let (cwd_code, cwd_msg) = send_ftp_cmd(conn, &format!("CWD {}", target)).await?;
        if !(200..300).contains(&cwd_code) {
            return Err(format!("Failed changing FTP directory to {}: {}", target, cwd_msg));
        }

        let resolved = match send_ftp_cmd(conn, "PWD").await {
            Ok((c, msg)) if (200..300).contains(&c) => parse_pwd_response(&msg),
            _ => target,
        };

        let mut data_stream = self.open_passive_data_stream(conn).await?;
        let (used_mlsd, start_code, start_msg) = match send_ftp_cmd(conn, "MLSD").await {
            Ok((c, msg)) if c == 150 || c == 125 => (true, c, msg),
            _ => {
                drop(data_stream);
                data_stream = self.open_passive_data_stream(conn).await?;
                let (c, msg) = send_ftp_cmd(conn, "LIST").await?;
                (false, c, msg)
            }
        };
        if start_code != 150 && start_code != 125 && !(200..300).contains(&start_code) {
            return Err(format!("FTP directory listing failed: {}", start_msg));
        }

        let mut raw_bytes = Vec::new();
        data_stream
            .read_to_end(&mut raw_bytes)
            .await
            .map_err(|e| format!("Failed reading FTP listing stream: {}", e))?;
        drop(data_stream);

        let (fin_code, fin_msg) = read_ftp_response(&mut conn.reader).await?;
        if !(200..300).contains(&fin_code) {
            return Err(format!("FTP listing completion error: {}", fin_msg));
        }

        let text = String::from_utf8_lossy(&raw_bytes);
        let mut entries = Vec::new();
        let mut total_files = 0usize;
        let mut total_dirs = 0usize;
        let mut hidden_count = 0usize;
        let mut total_bytes = 0u64;

        for line in text.lines() {
            let parsed = if used_mlsd {
                parse_mlsd_line(&resolved, line)
            } else {
                parse_list_line(&resolved, line)
            };
            if let Some(entry) = parsed {
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
}

impl RemoteFileSystem for FtpRemoteFs {
    fn protocol_name(&self) -> &'static str {
        "ftp"
    }

    async fn list_dir(&self, path: &str) -> Result<DirectoryListing, String> {
        ftp_retry!(self, |conn| { self.list_raw_dir(conn, path).await })
    }

    async fn create_dir(
        &self,
        parent_path: &str,
        name: &str,
        octal_mode: Option<&str>,
    ) -> Result<String, String> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Directory name cannot be empty".to_string());
        }
        let target = join_remote_path(parent_path, trimmed);
        if target == "/" {
            return Err("Cannot create root directory".to_string());
        }
        let parsed_mode = match octal_mode.map(str::trim).filter(|s| !s.is_empty()) {
            Some(m) => Some(parse_octal_mode(m)?),
            None => None,
        };

        ftp_retry!(self, |conn| {
            let mut accum = String::new();
            for seg in target.trim_start_matches('/').split('/').filter(|s| !s.is_empty()) {
                accum.push('/');
                accum.push_str(seg);
                let (code, _) = send_ftp_cmd(conn, &format!("CWD {}", accum)).await?;
                if !(200..300).contains(&code) {
                    let (mk_c, mk_msg) = send_ftp_cmd(conn, &format!("MKD {}", accum)).await?;
                    if !(200..300).contains(&mk_c) {
                        return Err(format!("FTP MKD failed for {}: {}", accum, mk_msg));
                    }
                }
            }
            if let Some(mode) = parsed_mode {
                let _ = send_ftp_cmd(conn, &format!("SITE CHMOD {:o} {}", mode, target)).await;
            }
            Ok(target.clone())
        })
    }

    async fn create_file(&self, parent_path: &str, name: &str) -> Result<String, String> {
        let valid = validate_remote_name(name)?;
        let target = join_remote_path(parent_path, &valid);
        self.write_bytes(&target, &[], None).await?;
        Ok(target)
    }

    async fn rename(&self, path: &str, new_name: &str) -> Result<String, String> {
        let src = normalize_remote_path(path);
        if src == "/" {
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
                let parent = remote_parent_path(&src).unwrap_or_else(|| "/".to_string());
                join_remote_path(&parent, trimmed)
            }
        } else {
            let valid = validate_remote_name(trimmed)?;
            let parent = remote_parent_path(&src).unwrap_or_else(|| "/".to_string());
            join_remote_path(&parent, &valid)
        };
        if dst == src {
            return Ok(dst);
        }

        ftp_retry!(self, |conn| {
            let (c1, m1) = send_ftp_cmd(conn, &format!("RNFR {}", src)).await?;
            if c1 != 350 && !(200..400).contains(&c1) {
                return Err(format!("FTP RNFR failed: {}", m1));
            }
            let (c2, m2) = send_ftp_cmd(conn, &format!("RNTO {}", dst)).await?;
            if !(200..300).contains(&c2) {
                return Err(format!("FTP RNTO failed: {}", m2));
            }
            Ok(dst.clone())
        })
    }

    async fn delete(&self, paths: &[String]) -> Result<usize, String> {
        let owned_paths: Vec<String> = paths.iter().map(|p| normalize_remote_path(p)).collect();
        ftp_retry!(self, |conn| {
            let mut deleted = 0usize;
            for raw in &owned_paths {
                if raw == "/" {
                    return Err("Refusing to delete FTP root directory '/'".to_string());
                }
                // Check if directory via CWD
                let (cwd_c, _) = send_ftp_cmd(conn, &format!("CWD {}", raw)).await?;
                if (200..300).contains(&cwd_c) {
                    let mut stack: Vec<(String, bool)> = vec![(raw.clone(), false)];
                    let mut visited = HashSet::new();
                    while let Some((dir_path, expanded)) = stack.pop() {
                        if expanded {
                            let _ = send_ftp_cmd(conn, "CWD /").await;
                            let (c, m) = send_ftp_cmd(conn, &format!("RMD {}", dir_path)).await?;
                            if !(200..300).contains(&c) {
                                return Err(format!("FTP RMD failed for {}: {}", dir_path, m));
                            }
                            continue;
                        }
                        if !visited.insert(dir_path.clone()) {
                            continue;
                        }
                        stack.push((dir_path.clone(), true));
                        let listing = self.list_raw_dir(conn, &dir_path).await?;
                        for entry in listing.entries {
                            if entry.file_type == "dir" {
                                stack.push((entry.path, false));
                            } else {
                                let (dc, dm) =
                                    send_ftp_cmd(conn, &format!("DELE {}", entry.path)).await?;
                                if !(200..300).contains(&dc) {
                                    return Err(format!(
                                        "FTP DELE failed for {}: {}",
                                        entry.path, dm
                                    ));
                                }
                            }
                        }
                    }
                } else {
                    let (c, m) = send_ftp_cmd(conn, &format!("DELE {}", raw)).await?;
                    if !(200..300).contains(&c) {
                        return Err(format!("FTP DELE failed for {}: {}", raw, m));
                    }
                }
                deleted += 1;
            }
            Ok(deleted)
        })
    }

    async fn create_symlink(
        &self,
        _current_dir: &str,
        _link_name: &str,
        _target_path: &str,
        _is_hard_link: bool,
    ) -> Result<String, String> {
        Err("Creating symbolic or hard links is not supported over standard FTP.".to_string())
    }

    async fn get_properties(
        &self,
        path: &str,
        calculate_size: bool,
        checksum_alg: Option<&str>,
    ) -> Result<RemoteFileProperties, String> {
        let clean = normalize_remote_path(path);
        let parent = remote_parent_path(&clean).unwrap_or_else(|| "/".to_string());
        let parent_listing = self.list_dir(&parent).await?;
        let mut entry = parent_listing
            .entries
            .into_iter()
            .find(|e| e.path == clean)
            .unwrap_or_else(|| {
                let name = clean
                    .rsplit('/')
                    .next()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("/")
                    .to_string();
                make_protocol_entry(name, clean.clone(), clean == "/", false, 0, None, None, None)
            });

        let is_dir = entry.file_type == "dir" || entry.file_type == "symlink_dir";
        if !is_dir {
            let size_res: Result<Option<u64>, String> = ftp_retry!(self, |conn| {
                let mut found = None;
                if let Ok((213, s_msg)) = send_ftp_cmd(conn, &format!("SIZE {}", clean)).await {
                    found = s_msg
                        .split_whitespace()
                        .last()
                        .and_then(|s| s.parse::<u64>().ok());
                }
                Ok(found)
            });
            if let Ok(Some(sz)) = size_res {
                entry.size = sz;
            }
        }

        let (item_count, calculated_size) = if is_dir && calculate_size {
            let listing = self.list_dir(&clean).await?;
            (listing.entries.len(), listing.total_bytes)
        } else if is_dir {
            (0, 0)
        } else {
            (1, entry.size)
        };

        let checksums = if !is_dir {
            if let Some(alg) = checksum_alg {
                let (bytes, _) = self.read_bytes(&clean, Some(16 * 1024 * 1024)).await?;
                compute_bytes_checksums(&bytes, alg)
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };

        Ok(RemoteFileProperties {
            entry,
            uid: None,
            gid: None,
            owner_name: None,
            group_name: None,
            item_count,
            calculated_size,
            checksums,
        })
    }

    async fn set_permissions(
        &self,
        paths: &[String],
        octal_mode: Option<&str>,
        _owner_uid: Option<u32>,
        _group_gid: Option<u32>,
        add_x_to_dirs: bool,
        recursive: bool,
    ) -> Result<usize, String> {
        let Some(raw_mode) = octal_mode.map(str::trim).filter(|s| !s.is_empty()) else {
            return Ok(0);
        };
        let base_mode = parse_octal_mode(raw_mode)?;
        let targets: Vec<String> = paths.iter().map(|p| normalize_remote_path(p)).collect();

        ftp_retry!(self, |conn| {
            let mut updated = 0usize;
            let mut stack = targets.clone();
            let mut visited = HashSet::new();
            while let Some(target) = stack.pop() {
                if !visited.insert(target.clone()) {
                    continue;
                }
                let is_dir = matches!(
                    send_ftp_cmd(conn, &format!("CWD {}", target)).await,
                    Ok((c, _)) if (200..300).contains(&c)
                );
                let applied = ops::apply_add_x_to_dirs(base_mode, is_dir, add_x_to_dirs);
                let (code, msg) =
                    send_ftp_cmd(conn, &format!("SITE CHMOD {:o} {}", applied, target)).await?;
                if (200..300).contains(&code) {
                    updated += 1;
                } else if updated == 0 {
                    return Err(format!("FTP SITE CHMOD failed: {}", msg));
                }
                if recursive && is_dir {
                    if let Ok(listing) = self.list_raw_dir(conn, &target).await {
                        for child in listing.entries {
                            stack.push(child.path);
                        }
                    }
                }
            }
            Ok(updated)
        })
    }

    async fn read_bytes(
        &self,
        path: &str,
        max_bytes: Option<u64>,
    ) -> Result<(Vec<u8>, Option<u64>), String> {
        let clean = normalize_remote_path(path);
        ftp_retry!(self, |conn| {
            let _ = send_ftp_cmd(conn, "TYPE I").await;
            let mtime_ms = match send_ftp_cmd(conn, &format!("MDTM {}", clean)).await {
                Ok((213, msg)) => msg
                    .split_whitespace()
                    .last()
                    .and_then(parse_protocol_timestamp_ms),
                _ => None,
            };
            let mut data_stream = self.open_passive_data_stream(conn).await?;
            let (c1, m1) = send_ftp_cmd(conn, &format!("RETR {}", clean)).await?;
            if c1 != 150 && c1 != 125 && !(200..300).contains(&c1) {
                return Err(format!("FTP RETR failed for {}: {}", clean, m1));
            }
            let mut buf = Vec::new();
            if let Some(limit) = max_bytes {
                let mut limited = data_stream.take(limit + 1);
                limited
                    .read_to_end(&mut buf)
                    .await
                    .map_err(|e| format!("FTP RETR stream failed: {}", e))?;
                if buf.len() as u64 > limit {
                    return Err(format!(
                        "Remote file {} exceeds {} byte limit",
                        clean, limit
                    ));
                }
            } else {
                data_stream
                    .read_to_end(&mut buf)
                    .await
                    .map_err(|e| format!("FTP RETR stream failed: {}", e))?;
            }
            let (c2, m2) = read_ftp_response(&mut conn.reader).await?;
            if !(200..300).contains(&c2) {
                return Err(format!("FTP RETR completion error: {}", m2));
            }
            Ok((buf, mtime_ms))
        })
    }

    async fn write_bytes(
        &self,
        path: &str,
        data: &[u8],
        _mtime_ms: Option<u64>,
    ) -> Result<(), String> {
        let clean = normalize_remote_path(path);
        ftp_retry!(self, |conn| {
            let _ = send_ftp_cmd(conn, "TYPE I").await;
            let mut data_stream = self.open_passive_data_stream(conn).await?;
            let (c1, m1) = send_ftp_cmd(conn, &format!("STOR {}", clean)).await?;
            if c1 != 150 && c1 != 125 && !(200..300).contains(&c1) {
                return Err(format!("FTP STOR failed for {}: {}", clean, m1));
            }
            data_stream
                .write_all(data)
                .await
                .map_err(|e| format!("FTP STOR write failed: {}", e))?;
            data_stream
                .shutdown()
                .await
                .map_err(|e| format!("FTP STOR shutdown failed: {}", e))?;
            drop(data_stream);
            let (c2, m2) = read_ftp_response(&mut conn.reader).await?;
            if !(200..300).contains(&c2) {
                return Err(format!("FTP STOR completion error: {}", m2));
            }
            Ok(())
        })
    }
}

pub async fn connect_ftp_session(
    request: &SftpConnectRequest,
) -> Result<Result<(FtpRemoteFs, SftpConnectedInfo), AuthChallengeInfo>, String> {
    let site = &request.site;
    let host = site.host_name.trim();
    if host.is_empty() {
        return Err("FTP Host name cannot be empty.".to_string());
    }
    let port = if site.port_number == 0 {
        site.protocol.default_port(site.ftps_mode)
    } else {
        site.port_number
    };
    let user = if site.anonymous_login {
        "anonymous".to_string()
    } else {
        site.user_name.clone()
    };
    let effective_password = if site.anonymous_login {
        "anonymous@scpcraft.local".to_string()
    } else if let Some(ref p) = request.password {
        p.clone()
    } else {
        return Ok(Err(AuthChallengeInfo {
            challenge_id: format_challenge_id(),
            session_id: request.session_id.clone(),
            site_id: site.id.clone(),
            host: host.to_string(),
            port,
            user_name: user.clone(),
            auth_kind: "password".to_string(),
            title: format!("FTP Password - {}@{}", user, host),
            instructions: format!("Enter FTP password for {}@{}:", user, host),
            key_path: None,
            prompts: vec![AuthPromptItem {
                id: "password".to_string(),
                prompt: "Password:".to_string(),
                echo: false,
            }],
            log_lines: vec![format!("Connecting to FTP {}:{}", host, port)],
            error_message: None,
        }));
    };

    let (conn, home_path, banner) = establish_ftp_control(
        host,
        port,
        &user,
        &effective_password,
        site.ftps_mode,
        site.advanced.timeout_secs as u64,
    )
    .await?;

    let fs = FtpRemoteFs {
        host: host.to_string(),
        port,
        user: user.clone(),
        password: effective_password,
        ftps_mode: site.ftps_mode,
        passive: site.advanced.ftp_passive_mode,
        timeout_secs: site.advanced.timeout_secs as u64,
        home_path: home_path.clone(),
        control: Arc::new(AsyncMutex::new(Some(conn))),
    };

    let preferred_remote = site.advanced.remote_directory.trim();
    let target_start = if preferred_remote.is_empty() {
        home_path.clone()
    } else {
        preferred_remote.to_string()
    };
    let initial_listing = match fs.list_dir(&target_start).await {
        Ok(l) => l,
        Err(_) => fs.list_dir(&home_path).await?,
    };
    let initial_path = initial_listing.path.clone();

    let info = SftpConnectedInfo {
        session_id: request.session_id.clone(),
        home_path,
        initial_path,
        initial_listing,
        auth_method_used: if site.anonymous_login {
            "anonymous".to_string()
        } else {
            "password".to_string()
        },
        server_banner: banner,
    };

    Ok(Ok((fs, info)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::winscp_ini::SiteProtocol;
    use std::collections::HashMap;
    use tokio::net::TcpListener;

    #[test]
    fn parses_pasv_and_epsv_responses_and_mlsd_unix_dos_listings() {
        let (h, p) = parse_pasv_addr("227 Entering Passive Mode (127,0,0,1,195,80).", "example.com").unwrap();
        assert_eq!(h, "127.0.0.1");
        assert_eq!(p, 195 * 256 + 80);

        let (h_nat, p_nat) = parse_pasv_addr("227 Entering Passive Mode (0,0,0,0,16,2).", "ftp.host").unwrap();
        assert_eq!(h_nat, "ftp.host");
        assert_eq!(p_nat, 16 * 256 + 2);

        assert_eq!(parse_epsv_port("229 Entering Extended Passive Mode (|||54321|)").unwrap(), 54321);

        let mlsd_dir = parse_mlsd_line("/var", "type=dir;modify=20251115120000;UNIX.mode=0755; www").unwrap();
        assert_eq!(mlsd_dir.name, "www");
        assert_eq!(mlsd_dir.file_type, "dir");
        assert_eq!(mlsd_dir.octal_mode, "0755");
        assert!(mlsd_dir.modified_ms.is_some());

        let mlsd_file = parse_mlsd_line("/var/www", "type=file;size=2048;modify=20251115123045; index.html").unwrap();
        assert_eq!(mlsd_file.size, 2048);
        assert_eq!(mlsd_file.extension, "html");

        let unix_link = parse_list_line("/etc", "lrwxrwxrwx 1 root root 14 Nov 15 10:00 conf -> /opt/conf").unwrap();
        assert_eq!(unix_link.file_type, "symlink");
        assert_eq!(unix_link.symlink_target.as_deref(), Some("/opt/conf"));

        let dos_dir = parse_list_line("/", "11-15-26  10:22PM       <DIR>          uploads").unwrap();
        assert_eq!(dos_dir.file_type, "dir");
        assert_eq!(dos_dir.name, "uploads");
    }

    #[tokio::test]
    async fn ftp_loopback_server_connect_list_upload_download_rename_delete() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let server_handle = tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let (rh, mut wh) = sock.into_split();
            let mut reader = BufReader::new(rh);
            let mut files: HashMap<String, Vec<u8>> = HashMap::new();
            files.insert("/hello.txt".to_string(), b"initial ftp payload".to_vec());
            let mut pending_data_listener: Option<TcpListener> = None;
            let mut rnfr_src: Option<String> = None;

            wh.write_all(b"220 ScpCraft Mock FTP Ready\r\n").await.unwrap();

            let mut line = String::new();
            while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                let cmd_line = line.trim().to_string();
                line.clear();
                let (verb, arg) = match cmd_line.split_once(' ') {
                    Some((v, a)) => (v.to_ascii_uppercase(), a.trim().to_string()),
                    None => (cmd_line.to_ascii_uppercase(), String::new()),
                };

                match verb.as_str() {
                    "USER" => {
                        wh.write_all(b"331 Password required\r\n").await.unwrap();
                    }
                    "PASS" => {
                        wh.write_all(b"230 Login OK\r\n").await.unwrap();
                    }
                    "OPTS" | "TYPE" => {
                        wh.write_all(b"200 OK\r\n").await.unwrap();
                    }
                    "PWD" => {
                        wh.write_all(b"257 \"/\" is current directory\r\n").await.unwrap();
                    }
                    "CWD" => {
                        if arg == "/" {
                            wh.write_all(b"250 CWD successful\r\n").await.unwrap();
                        } else {
                            wh.write_all(b"550 Not a directory\r\n").await.unwrap();
                        }
                    }
                    "EPSV" => {
                        let dl = TcpListener::bind("127.0.0.1:0").await.unwrap();
                        let dp = dl.local_addr().unwrap().port();
                        pending_data_listener = Some(dl);
                        wh.write_all(
                            format!("229 Entering Extended Passive Mode (|||{}|)\r\n", dp).as_bytes(),
                        )
                        .await
                        .unwrap();
                    }
                    "MLSD" => {
                        let dl = pending_data_listener.take().unwrap();
                        wh.write_all(b"150 Opening MLSD stream\r\n").await.unwrap();
                        let (mut ds, _) = dl.accept().await.unwrap();
                        let mut listing = String::new();
                        for (path, data) in &files {
                            let name = path.trim_start_matches('/');
                            listing.push_str(&format!(
                                "type=file;size={};modify=20251115120000; {}\r\n",
                                data.len(),
                                name
                            ));
                        }
                        ds.write_all(listing.as_bytes()).await.unwrap();
                        ds.shutdown().await.unwrap();
                        wh.write_all(b"226 Transfer complete\r\n").await.unwrap();
                    }
                    "RETR" => {
                        let dl = pending_data_listener.take().unwrap();
                        let key = if arg.starts_with('/') { arg.clone() } else { format!("/{}", arg) };
                        let payload = files.get(&key).cloned().unwrap_or_default();
                        wh.write_all(b"150 Opening data connection\r\n").await.unwrap();
                        let (mut ds, _) = dl.accept().await.unwrap();
                        ds.write_all(&payload).await.unwrap();
                        ds.shutdown().await.unwrap();
                        wh.write_all(b"226 Transfer complete\r\n").await.unwrap();
                    }
                    "STOR" => {
                        let dl = pending_data_listener.take().unwrap();
                        let key = if arg.starts_with('/') { arg.clone() } else { format!("/{}", arg) };
                        wh.write_all(b"150 Ok to send data\r\n").await.unwrap();
                        let (mut ds, _) = dl.accept().await.unwrap();
                        let mut buf = Vec::new();
                        ds.read_to_end(&mut buf).await.unwrap();
                        files.insert(key, buf);
                        wh.write_all(b"226 Transfer complete\r\n").await.unwrap();
                    }
                    "RNFR" => {
                        rnfr_src = Some(arg);
                        wh.write_all(b"350 Ready for RNTO\r\n").await.unwrap();
                    }
                    "RNTO" => {
                        let src = rnfr_src.take().unwrap();
                        let val = files.remove(&src).unwrap_or_default();
                        files.insert(arg, val);
                        wh.write_all(b"250 Rename OK\r\n").await.unwrap();
                    }
                    "DELE" => {
                        files.remove(&arg);
                        wh.write_all(b"250 Deleted\r\n").await.unwrap();
                    }
                    _ => {
                        wh.write_all(b"502 Command not implemented\r\n").await.unwrap();
                    }
                }
            }
        });

        let mut site = crate::config::winscp_ini::SiteConfig::default();
        site.protocol = SiteProtocol::Ftp;
        site.host_name = "127.0.0.1".to_string();
        site.port_number = port;
        site.user_name = "tester".to_string();

        let outcome = connect_ftp_session(&SftpConnectRequest {
            session_id: "tab-ftp-test".to_string(),
            site,
            password: Some("secret".to_string()),
            passphrase: None,
            tunnel_password: None,
        })
        .await
        .unwrap();

        let (fs, info) = match outcome {
            Ok(pair) => pair,
            Err(_) => panic!("Expected FTP connection without auth prompt"),
        };

        assert_eq!(info.initial_listing.entries.len(), 1);
        assert_eq!(info.initial_listing.entries[0].name, "hello.txt");

        let (read_data, _) = fs.read_bytes("/hello.txt", None).await.unwrap();
        assert_eq!(read_data, b"initial ftp payload");

        fs.write_bytes("/uploaded.txt", b"new ftp bytes", None).await.unwrap();
        let (dl_new, _) = fs.read_bytes("/uploaded.txt", None).await.unwrap();
        assert_eq!(dl_new, b"new ftp bytes");

        let renamed = fs.rename("/uploaded.txt", "renamed.txt").await.unwrap();
        assert_eq!(renamed, "/renamed.txt");

        let deleted = fs.delete(&["/renamed.txt".to_string()]).await.unwrap();
        assert_eq!(deleted, 1);

        drop(fs);
        server_handle.abort();
    }
}
