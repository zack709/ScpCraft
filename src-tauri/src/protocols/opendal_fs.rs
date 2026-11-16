use crate::config::winscp_ini::{FtpsMode, SiteConfig, SiteProtocol};
use crate::fs_trait::RemoteFileSystem;
use crate::local_fs::{DirectoryListing, FileEntry};
use crate::protocols::{make_protocol_entry, parse_protocol_timestamp_ms};
use crate::sftp::ops::{
    build_remote_breadcrumbs, compute_bytes_checksums, join_remote_path, normalize_remote_path,
    remote_parent_path, validate_remote_name, RemoteFileProperties,
};
use crate::sftp::session::{
    AuthChallengeInfo, AuthPromptItem, SftpConnectRequest, SftpConnectedInfo,
};
use rustls::pki_types::ServerName;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenDalBackendKind {
    S3,
    WebDav,
}

pub struct OpenDalRemoteFs {
    pub kind: OpenDalBackendKind,
    pub host: String,
    pub port: u16,
    pub use_tls: bool,
    pub base_path: String,
    pub access_or_user: String,
    pub secret_or_pass: String,
    pub region: String,
    pub path_style: bool,
    pub timeout_secs: u64,
    pub home_path: String,
}

fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    const BLOCK_SIZE: usize = 64;
    let mut k_block = [0u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        let hashed = Sha256::digest(key);
        k_block[..32].copy_from_slice(&hashed);
    } else {
        k_block[..key.len()].copy_from_slice(key);
    }

    let mut o_pad = [0x5Cu8; BLOCK_SIZE];
    let mut i_pad = [0x36u8; BLOCK_SIZE];
    for i in 0..BLOCK_SIZE {
        o_pad[i] ^= k_block[i];
        i_pad[i] ^= k_block[i];
    }

    let mut inner = Sha256::new();
    inner.update(i_pad);
    inner.update(data);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(o_pad);
    outer.update(inner_hash);
    let mut out = [0u8; 32];
    out.copy_from_slice(&outer.finalize());
    out
}

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = chunk.get(1).copied().unwrap_or(0) as usize;
        let b2 = chunk.get(2).copied().unwrap_or(0) as usize;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) & 0x3F] as char);
        out.push(TABLE[(triple >> 12) & 0x3F] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(triple >> 6) & 0x3F] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[triple & 0x3F] as char
        } else {
            '='
        });
    }
    out
}

/// Convert UNIX epoch seconds to UTC `(YYYYMMDD, YYYYMMDDTHHMMSSZ)`.
fn format_utc_sigv4_timestamps(secs: u64) -> (String, String) {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;

    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };

    let date_stamp = format!("{:04}{:02}{:02}", year, m, d);
    let amz_date = format!("{}T{:02}{:02}{:02}Z", date_stamp, hour, min, sec);
    (date_stamp, amz_date)
}

fn uri_encode(raw: &str, encode_slash: bool) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        let safe = matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~')
            || (!encode_slash && byte == b'/');
        if safe {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
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

fn unescape_xml(raw: &str) -> String {
    raw.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

/// Extract inner XML blocks whose local tag name matches `target_tag` (case-insensitive, ignoring namespace prefix).
fn extract_xml_blocks(xml: &str, target_tag: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cursor = 0usize;
    let lower_target = target_tag.to_ascii_lowercase();

    while cursor < xml.len() {
        let Some(open_rel) = xml[cursor..].find('<') else {
            break;
        };
        let tag_start = cursor + open_rel;
        let Some(gt_rel) = xml[tag_start..].find('>') else {
            break;
        };
        let tag_end = tag_start + gt_rel;
        let header = xml[tag_start + 1..tag_end].trim();
        if header.starts_with('/') || header.starts_with('?') || header.starts_with('!') {
            cursor = tag_end + 1;
            continue;
        }
        let raw_name = header.split_whitespace().next().unwrap_or("");
        let clean_name = raw_name.trim_end_matches('/');
        let local = clean_name.rsplit(':').next().unwrap_or(clean_name);
        if local.to_ascii_lowercase() != lower_target {
            cursor = tag_end + 1;
            continue;
        }
        if raw_name.ends_with('/') {
            out.push(String::new());
            cursor = tag_end + 1;
            continue;
        }

        // Find matching closing tag `</...local>` case-insensitively
        let mut scan = tag_end + 1;
        let mut matched_close: Option<(usize, usize)> = None;
        while scan < xml.len() {
            let Some(c_rel) = xml[scan..].find("</") else {
                break;
            };
            let c_start = scan + c_rel;
            let Some(c_gt_rel) = xml[c_start..].find('>') else {
                break;
            };
            let c_end = c_start + c_gt_rel;
            let close_name = xml[c_start + 2..c_end].trim();
            let close_local = close_name.rsplit(':').next().unwrap_or(close_name);
            if close_local.to_ascii_lowercase() == lower_target {
                matched_close = Some((c_start, c_end + 1));
                break;
            }
            scan = c_end + 1;
        }

        if let Some((content_end, next_pos)) = matched_close {
            out.push(xml[tag_end + 1..content_end].to_string());
            cursor = next_pos;
        } else {
            cursor = tag_end + 1;
        }
    }

    out
}

fn extract_xml_text(xml: &str, target_tag: &str) -> Option<String> {
    extract_xml_blocks(xml, target_tag)
        .into_iter()
        .next()
        .map(|s| unescape_xml(s.trim()))
}

fn has_xml_tag(xml: &str, target_tag: &str) -> bool {
    !extract_xml_blocks(xml, target_tag).is_empty()
}

pub fn build_sigv4_authorization(
    access_key: &str,
    secret_key: &str,
    region: &str,
    service: &str,
    method: &str,
    canonical_uri: &str,
    canonical_query: &str,
    headers: &BTreeMap<String, String>,
    payload_hash: &str,
    amz_date: &str,
    date_stamp: &str,
) -> String {
    let mut canonical_headers = String::new();
    let mut signed_headers_list = Vec::new();
    for (k, v) in headers {
        let low = k.to_ascii_lowercase();
        canonical_headers.push_str(&format!("{}:{}\n", low, v.trim()));
        signed_headers_list.push(low);
    }
    let signed_headers = signed_headers_list.join(";");

    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method,
        canonical_uri,
        canonical_query,
        canonical_headers,
        signed_headers,
        payload_hash
    );

    let credential_scope = format!("{}/{}/{}/aws4_request", date_stamp, region, service);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date,
        credential_scope,
        sha256_hex(canonical_request.as_bytes())
    );

    let k_date = hmac_sha256(format!("AWS4{}", secret_key).as_bytes(), date_stamp.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let sig_bytes = hmac_sha256(&k_signing, string_to_sign.as_bytes());
    let signature: String = sig_bytes.iter().map(|b| format!("{:02x}", b)).collect();

    format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        access_key, credential_scope, signed_headers, signature
    )
}

fn decode_chunked_http_body(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < raw.len() {
        let Some(crlf_rel) = raw[pos..].windows(2).position(|w| w == b"\r\n") else {
            break;
        };
        let size_line = String::from_utf8_lossy(&raw[pos..pos + crlf_rel]);
        let size_hex = size_line.split(';').next().unwrap_or("").trim();
        let Ok(chunk_len) = usize::from_str_radix(size_hex, 16) else {
            break;
        };
        pos += crlf_rel + 2;
        if chunk_len == 0 {
            break;
        }
        let end = pos.saturating_add(chunk_len).min(raw.len());
        out.extend_from_slice(&raw[pos..end]);
        pos = end.saturating_add(2);
    }
    out
}

struct HttpResponseData {
    status: u16,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

fn tls_connector() -> Result<TlsConnector, String> {
    static CONNECTOR: OnceLock<TlsConnector> = OnceLock::new();
    if let Some(c) = CONNECTOR.get() {
        return Ok(c.clone());
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(config));
    let _ = CONNECTOR.set(connector.clone());
    Ok(connector)
}

async fn execute_http_on_stream<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    addr: &str,
    host: &str,
    port: u16,
    timeout_secs: u64,
    method: &str,
    request_target: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> Result<HttpResponseData, String> {
    let mut req = format!("{} {} HTTP/1.1\r\n", method, request_target);
    let mut has_host = false;
    let mut has_conn = false;
    let mut has_len = false;
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("host") {
            has_host = true;
        } else if k.eq_ignore_ascii_case("connection") {
            has_conn = true;
        } else if k.eq_ignore_ascii_case("content-length") {
            has_len = true;
        }
        req.push_str(&format!("{}: {}\r\n", k, v));
    }
    if !has_host {
        let host_hdr = if port == 80 || port == 443 {
            host.to_string()
        } else {
            format!("{}:{}", host, port)
        };
        req.push_str(&format!("Host: {}\r\n", host_hdr));
    }
    if !has_len {
        req.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    if !has_conn {
        req.push_str("Connection: close\r\n");
    }
    req.push_str("\r\n");

    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|e| format!("HTTP write failed: {}", e))?;
    if !body.is_empty() {
        stream
            .write_all(body)
            .await
            .map_err(|e| format!("HTTP body write failed: {}", e))?;
    }
    stream
        .flush()
        .await
        .map_err(|e| format!("HTTP flush failed: {}", e))?;

    let mut raw_resp = Vec::new();
    let read_res = tokio::time::timeout(
        Duration::from_secs(timeout_secs.max(120)),
        stream.read_to_end(&mut raw_resp),
    )
    .await
    .map_err(|_| format!("Timed out reading HTTP response from {}", addr))?;

    if let Err(e) = read_res {
        // Some TLS servers close TCP without sending close_notify after Connection: close
        let has_headers = raw_resp.windows(4).any(|w| w == b"\r\n\r\n");
        if !(e.kind() == std::io::ErrorKind::UnexpectedEof && has_headers) {
            return Err(format!("HTTP read failed: {}", e));
        }
    }

    if raw_resp.is_empty() {
        return Err(format!(
            "Server at {} closed connection without HTTP response.",
            addr
        ));
    }

    let Some(hdr_end_pos) = raw_resp.windows(4).position(|w| w == b"\r\n\r\n") else {
        return Err(format!(
            "Invalid HTTP response from {} (missing header terminator)",
            addr
        ));
    };

    let header_text = String::from_utf8_lossy(&raw_resp[..hdr_end_pos]);
    let mut lines = header_text.lines();
    let status_line = lines.next().unwrap_or("");
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("Malformed HTTP status line: '{}'", status_line))?;

    let mut parsed_headers = BTreeMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            parsed_headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let raw_body = &raw_resp[hdr_end_pos + 4..];
    let body_bytes = if parsed_headers
        .get("transfer-encoding")
        .map(|v| v.to_ascii_lowercase().contains("chunked"))
        .unwrap_or(false)
    {
        decode_chunked_http_body(raw_body)
    } else if let Some(len) = parsed_headers
        .get("content-length")
        .and_then(|v| v.parse::<usize>().ok())
    {
        raw_body[..len.min(raw_body.len())].to_vec()
    } else {
        raw_body.to_vec()
    };

    Ok(HttpResponseData {
        status,
        headers: parsed_headers,
        body: body_bytes,
    })
}

async fn send_raw_http_request(
    host: &str,
    port: u16,
    use_tls: bool,
    timeout_secs: u64,
    method: &str,
    request_target: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> Result<HttpResponseData, String> {
    let addr = format!("{}:{}", host, port);
    let tcp_stream = tokio::time::timeout(
        Duration::from_secs(timeout_secs.max(30)),
        TcpStream::connect(&addr),
    )
    .await
    .map_err(|_| format!("HTTP connection timed out for {}", addr))?
    .map_err(|e| format!("Failed connecting to {}: {}", addr, e))?;

    if use_tls {
        let connector = tls_connector()?;
        let server_name = ServerName::try_from(host.to_string())
            .map_err(|_| format!("Invalid TLS server name '{}'", host))?;
        let tls_stream = tokio::time::timeout(
            Duration::from_secs(timeout_secs.max(30)),
            connector.connect(server_name, tcp_stream),
        )
        .await
        .map_err(|_| format!("TLS handshake timed out for {}", addr))?
        .map_err(|e| format!("TLS handshake failed for {}: {}", addr, e))?;

        execute_http_on_stream(
            tls_stream,
            &addr,
            host,
            port,
            timeout_secs,
            method,
            request_target,
            headers,
            body,
        )
        .await
    } else {
        execute_http_on_stream(
            tcp_stream,
            &addr,
            host,
            port,
            timeout_secs,
            method,
            request_target,
            headers,
            body,
        )
        .await
    }
}

pub fn parse_s3_list_objects_xml(dir_path: &str, xml: &str) -> Vec<FileEntry> {
    let mut entries = Vec::new();
    let mut seen_names = HashSet::new();

    // Parse folder prefixes (`<CommonPrefixes><Prefix>...</Prefix></CommonPrefixes>`)
    for block in extract_xml_blocks(xml, "CommonPrefixes") {
        let Some(prefix) = extract_xml_text(&block, "Prefix") else {
            continue;
        };
        let trimmed = prefix.trim_end_matches('/');
        let name = trimmed.rsplit('/').next().unwrap_or("").to_string();
        if name.is_empty() || !seen_names.insert(name.clone()) {
            continue;
        }
        entries.push(make_protocol_entry(
            name.clone(),
            join_remote_path(dir_path, &name),
            true,
            false,
            0,
            None,
            None,
            None,
        ));
    }

    // Parse bucket roots if ListAllMyBucketsResult was returned
    for block in extract_xml_blocks(xml, "Bucket") {
        let Some(name) = extract_xml_text(&block, "Name") else {
            continue;
        };
        if name.is_empty() || !seen_names.insert(name.clone()) {
            continue;
        }
        let mtime = extract_xml_text(&block, "CreationDate")
            .as_deref()
            .and_then(parse_protocol_timestamp_ms);
        entries.push(make_protocol_entry(
            name.clone(),
            join_remote_path("/", &name),
            true,
            false,
            0,
            mtime,
            None,
            None,
        ));
    }

    // Parse object items (`<Contents><Key>...</Key><LastModified>...</LastModified><Size>...</Size></Contents>`)
    for block in extract_xml_blocks(xml, "Contents") {
        let Some(key) = extract_xml_text(&block, "Key") else {
            continue;
        };
        if key.ends_with('/') {
            continue;
        }
        let name = key.rsplit('/').next().unwrap_or("").to_string();
        if name.is_empty() || !seen_names.insert(name.clone()) {
            continue;
        }
        let size = extract_xml_text(&block, "Size")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let mtime = extract_xml_text(&block, "LastModified")
            .as_deref()
            .and_then(parse_protocol_timestamp_ms);
        entries.push(make_protocol_entry(
            name.clone(),
            join_remote_path(dir_path, &name),
            false,
            false,
            size,
            mtime,
            None,
            None,
        ));
    }

    entries
}

pub fn parse_webdav_propfind_xml(dir_path: &str, base_url_prefix: &str, xml: &str) -> Vec<FileEntry> {
    let dir_clean = normalize_remote_path(dir_path);
    let mut expected_self_url = if base_url_prefix == "/" {
        dir_clean.clone()
    } else if dir_clean == "/" {
        base_url_prefix.to_string()
    } else {
        format!("{}{}", base_url_prefix.trim_end_matches('/'), dir_clean)
    };
    expected_self_url = normalize_remote_path(&expected_self_url);

    let mut entries = Vec::new();
    for block in extract_xml_blocks(xml, "response") {
        let Some(href_raw) = extract_xml_text(&block, "href") else {
            continue;
        };
        // Strip scheme://host:port if absolute URL is returned in <D:href>
        let href_path = if let Some(after_scheme) = href_raw.split("://").nth(1) {
            after_scheme
                .find('/')
                .map(|idx| &after_scheme[idx..])
                .unwrap_or("/")
        } else {
            href_raw.as_str()
        };
        let decoded_href = normalize_remote_path(&percent_decode(href_path));
        if decoded_href == expected_self_url || decoded_href == dir_clean {
            continue;
        }

        let rel_path = if base_url_prefix != "/" && decoded_href.starts_with(base_url_prefix) {
            let stripped = &decoded_href[base_url_prefix.len()..];
            if stripped.is_empty() {
                "/".to_string()
            } else {
                normalize_remote_path(stripped)
            }
        } else {
            decoded_href.clone()
        };

        let Some(name) = rel_path.rsplit('/').next().filter(|s| !s.is_empty()) else {
            continue;
        };

        let is_dir = has_xml_tag(&block, "collection") || href_raw.ends_with('/');
        let size = if is_dir {
            0
        } else {
            extract_xml_text(&block, "getcontentlength")
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0)
        };
        let mtime = extract_xml_text(&block, "getlastmodified")
            .as_deref()
            .and_then(parse_protocol_timestamp_ms);

        entries.push(make_protocol_entry(
            name.to_string(),
            join_remote_path(&dir_clean, name),
            is_dir,
            false,
            size,
            mtime,
            None,
            None,
        ));
    }
    entries
}

fn split_s3_bucket_and_key(remote_path: &str) -> (Option<String>, String) {
    let clean = normalize_remote_path(remote_path);
    let trimmed = clean.trim_start_matches('/');
    if trimmed.is_empty() {
        return (None, String::new());
    }
    match trimmed.split_once('/') {
        Some((bucket, key)) => (Some(bucket.to_string()), key.to_string()),
        None => (Some(trimmed.to_string()), String::new()),
    }
}

impl OpenDalRemoteFs {
    fn host_header(&self) -> String {
        if self.port == 80 || self.port == 443 {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    fn webdav_url_path(&self, remote_path: &str) -> String {
        let clean = normalize_remote_path(remote_path);
        let joined = if self.base_path == "/" {
            clean
        } else if clean == "/" {
            self.base_path.clone()
        } else {
            format!("{}{}", self.base_path.trim_end_matches('/'), clean)
        };
        uri_encode(&joined, false)
    }

    async fn webdav_request(
        &self,
        method: &str,
        remote_path: &str,
        extra_headers: Vec<(String, String)>,
        body: &[u8],
    ) -> Result<HttpResponseData, String> {
        let mut hdrs = vec![("Host".to_string(), self.host_header())];
        if !self.access_or_user.is_empty() || !self.secret_or_pass.is_empty() {
            let token = base64_encode(
                format!("{}:{}", self.access_or_user, self.secret_or_pass).as_bytes(),
            );
            hdrs.push(("Authorization".to_string(), format!("Basic {}", token)));
        }
        hdrs.extend(extra_headers);
        let target = self.webdav_url_path(remote_path);
        send_raw_http_request(
            &self.host,
            self.port,
            self.use_tls,
            self.timeout_secs,
            method,
            &target,
            &hdrs,
            body,
        )
        .await
    }

    async fn s3_request(
        &self,
        method: &str,
        uri_path: &str,
        query_params: &BTreeMap<String, String>,
        extra_headers: Vec<(String, String)>,
        body: &[u8],
    ) -> Result<HttpResponseData, String> {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let (date_stamp, amz_date) = format_utc_sigv4_timestamps(secs);
        let payload_hash = sha256_hex(body);

        let encoded_uri = uri_encode(uri_path, false);
        let canonical_query = query_params
            .iter()
            .map(|(k, v)| format!("{}={}", uri_encode(k, true), uri_encode(v, true)))
            .collect::<Vec<_>>()
            .join("&");

        let mut signed_map = BTreeMap::new();
        signed_map.insert("host".to_string(), self.host_header());
        signed_map.insert("x-amz-content-sha256".to_string(), payload_hash.clone());
        signed_map.insert("x-amz-date".to_string(), amz_date.clone());
        for (k, v) in &extra_headers {
            signed_map.insert(k.to_ascii_lowercase(), v.clone());
        }

        let mut hdrs: Vec<(String, String)> = signed_map
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        if !self.access_or_user.is_empty() && !self.secret_or_pass.is_empty() {
            let auth = build_sigv4_authorization(
                &self.access_or_user,
                &self.secret_or_pass,
                &self.region,
                "s3",
                method,
                &encoded_uri,
                &canonical_query,
                &signed_map,
                &payload_hash,
                &amz_date,
                &date_stamp,
            );
            hdrs.push(("Authorization".to_string(), auth));
        }

        let request_target = if canonical_query.is_empty() {
            encoded_uri
        } else {
            format!("{}?{}", encoded_uri, canonical_query)
        };

        send_raw_http_request(
            &self.host,
            self.port,
            self.use_tls,
            self.timeout_secs,
            method,
            &request_target,
            &hdrs,
            body,
        )
        .await
    }
}

impl RemoteFileSystem for OpenDalRemoteFs {
    fn protocol_name(&self) -> &'static str {
        match self.kind {
            OpenDalBackendKind::S3 => "s3",
            OpenDalBackendKind::WebDav => "webdav",
        }
    }

    async fn list_dir(&self, path: &str) -> Result<DirectoryListing, String> {
        let resolved = if path.trim().is_empty() || path == "." || path == "~" {
            self.home_path.clone()
        } else {
            normalize_remote_path(path)
        };

        let mut entries = match self.kind {
            OpenDalBackendKind::WebDav => {
                let target_dir = if resolved == "/" {
                    "/".to_string()
                } else {
                    format!("{}/", resolved)
                };
                let body = br#"<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>"#;
                let resp = self
                    .webdav_request(
                        "PROPFIND",
                        &target_dir,
                        vec![
                            ("Depth".to_string(), "1".to_string()),
                            ("Content-Type".to_string(), "application/xml".to_string()),
                        ],
                        body,
                    )
                    .await?;
                if resp.status != 207 && !(200..300).contains(&resp.status) {
                    return Err(format!(
                        "WebDAV PROPFIND failed for {} (HTTP {})",
                        resolved, resp.status
                    ));
                }
                let xml = String::from_utf8_lossy(&resp.body);
                parse_webdav_propfind_xml(&resolved, &self.base_path, &xml)
            }
            OpenDalBackendKind::S3 => {
                let (bucket_opt, prefix_rel) = split_s3_bucket_and_key(&resolved);
                let resp = match bucket_opt {
                    None => {
                        self.s3_request("GET", "/", &BTreeMap::new(), Vec::new(), &[])
                            .await?
                    }
                    Some(bucket) => {
                        let mut query = BTreeMap::new();
                        query.insert("list-type".to_string(), "2".to_string());
                        query.insert("delimiter".to_string(), "/".to_string());
                        if !prefix_rel.is_empty() {
                            query.insert(
                                "prefix".to_string(),
                                format!("{}/", prefix_rel.trim_end_matches('/')),
                            );
                        }
                        self.s3_request("GET", &format!("/{}", bucket), &query, Vec::new(), &[])
                            .await?
                    }
                };
                if !(200..300).contains(&resp.status) {
                    return Err(format!(
                        "S3 List failed for {} (HTTP {}): {}",
                        resolved,
                        resp.status,
                        String::from_utf8_lossy(&resp.body)
                    ));
                }
                let xml = String::from_utf8_lossy(&resp.body);
                parse_s3_list_objects_xml(&resolved, &xml)
            }
        };

        entries.sort_by(|a, b| {
            let a_dir = a.file_type == "dir" || a.file_type == "symlink_dir";
            let b_dir = b.file_type == "dir" || b.file_type == "symlink_dir";
            b_dir
                .cmp(&a_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        let total_dirs = entries.iter().filter(|e| e.file_type == "dir").count();
        let total_files = entries.len().saturating_sub(total_dirs);
        let hidden_count = entries.iter().filter(|e| e.hidden).count();
        let total_bytes: u64 = entries.iter().map(|e| e.size).sum();

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

    async fn create_dir(
        &self,
        parent_path: &str,
        name: &str,
        _octal_mode: Option<&str>,
    ) -> Result<String, String> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Directory name cannot be empty".to_string());
        }
        let target = join_remote_path(parent_path, trimmed);
        if target == "/" {
            return Err("Cannot create root directory".to_string());
        }

        match self.kind {
            OpenDalBackendKind::WebDav => {
                let mut accum = String::new();
                for seg in target.trim_start_matches('/').split('/').filter(|s| !s.is_empty()) {
                    accum.push('/');
                    accum.push_str(seg);
                    let resp = self
                        .webdav_request("MKCOL", &format!("{}/", accum), Vec::new(), &[])
                        .await?;
                    if !(200..300).contains(&resp.status) && resp.status != 405 {
                        return Err(format!(
                            "WebDAV MKCOL failed for {} (HTTP {})",
                            accum, resp.status
                        ));
                    }
                }
            }
            OpenDalBackendKind::S3 => {
                let (bucket_opt, key) = split_s3_bucket_and_key(&target);
                let bucket = bucket_opt.ok_or_else(|| "Missing S3 bucket name".to_string())?;
                let uri = if key.is_empty() {
                    format!("/{}", bucket)
                } else {
                    format!("/{}/{}/", bucket, key.trim_end_matches('/'))
                };
                let resp = self
                    .s3_request("PUT", &uri, &BTreeMap::new(), Vec::new(), &[])
                    .await?;
                if !(200..300).contains(&resp.status) {
                    return Err(format!(
                        "S3 folder marker PUT failed for {} (HTTP {})",
                        target, resp.status
                    ));
                }
            }
        }
        Ok(target)
    }

    async fn create_file(&self, parent_path: &str, name: &str) -> Result<String, String> {
        let valid = validate_remote_name(name)?;
        let target = join_remote_path(parent_path, &valid);
        self.write_bytes(&target, &[], None).await?;
        Ok(target)
    }

    async fn rename(&self, path: &str, new_name: &str) -> Result<String, String> {
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
            let valid = validate_remote_name(trimmed)?;
            let parent = remote_parent_path(&clean_src).unwrap_or_else(|| "/".to_string());
            join_remote_path(&parent, &valid)
        };
        if dst == clean_src {
            return Ok(dst);
        }

        match self.kind {
            OpenDalBackendKind::WebDav => {
                let dst_url = format!("http://{}{}", self.host_header(), self.webdav_url_path(&dst));
                let resp = self
                    .webdav_request(
                        "MOVE",
                        &clean_src,
                        vec![
                            ("Destination".to_string(), dst_url),
                            ("Overwrite".to_string(), "T".to_string()),
                        ],
                        &[],
                    )
                    .await?;
                if !(200..300).contains(&resp.status) {
                    return Err(format!(
                        "WebDAV MOVE failed {} -> {} (HTTP {})",
                        clean_src, dst, resp.status
                    ));
                }
            }
            OpenDalBackendKind::S3 => {
                let (bytes, mtime) = self.read_bytes(&clean_src, None).await?;
                self.write_bytes(&dst, &bytes, mtime).await?;
                let _ = self.delete(&[clean_src]).await?;
            }
        }
        Ok(dst)
    }

    async fn delete(&self, paths: &[String]) -> Result<usize, String> {
        let mut deleted = 0usize;
        for raw in paths {
            let clean = normalize_remote_path(raw);
            if clean == "/" {
                return Err("Refusing to delete root '/'".to_string());
            }
            match self.kind {
                OpenDalBackendKind::WebDav => {
                    let resp = self.webdav_request("DELETE", &clean, Vec::new(), &[]).await?;
                    if !(200..300).contains(&resp.status) {
                        return Err(format!(
                            "WebDAV DELETE failed for {} (HTTP {})",
                            clean, resp.status
                        ));
                    }
                }
                OpenDalBackendKind::S3 => {
                    let (bucket_opt, key) = split_s3_bucket_and_key(&clean);
                    let bucket = bucket_opt.ok_or_else(|| "Missing S3 bucket".to_string())?;
                    if key.is_empty() {
                        let resp = self
                            .s3_request("DELETE", &format!("/{}", bucket), &BTreeMap::new(), Vec::new(), &[])
                            .await?;
                        if !(200..300).contains(&resp.status) {
                            return Err(format!(
                                "S3 bucket DELETE failed for {} (HTTP {})",
                                bucket, resp.status
                            ));
                        }
                    } else {
                        // Delete both exact key and any nested objects under prefix `key/`
                        if let Ok(listing) = self.list_dir(&clean).await {
                            for child in listing.entries {
                                let child_path = child.path;
                                let _ = Box::pin(self.delete(&[child_path])).await;
                            }
                        }
                        let _ = self
                            .s3_request(
                                "DELETE",
                                &format!("/{}/{}/", bucket, key.trim_end_matches('/')),
                                &BTreeMap::new(),
                                Vec::new(),
                                &[],
                            )
                            .await;
                        let resp = self
                            .s3_request(
                                "DELETE",
                                &format!("/{}/{}", bucket, key),
                                &BTreeMap::new(),
                                Vec::new(),
                                &[],
                            )
                            .await?;
                        if !(200..300).contains(&resp.status) && resp.status != 404 {
                            return Err(format!(
                                "S3 object DELETE failed for {} (HTTP {})",
                                clean, resp.status
                            ));
                        }
                    }
                }
            }
            deleted += 1;
        }
        Ok(deleted)
    }

    async fn create_symlink(
        &self,
        _current_dir: &str,
        _link_name: &str,
        _target_path: &str,
        _is_hard_link: bool,
    ) -> Result<String, String> {
        Err(format!(
            "Symbolic links are not supported over {} protocol.",
            self.protocol_name().to_uppercase()
        ))
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
        let entry = parent_listing
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

        let is_dir = entry.file_type == "dir";
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
        _paths: &[String],
        _octal_mode: Option<&str>,
        _owner_uid: Option<u32>,
        _group_gid: Option<u32>,
        _add_x_to_dirs: bool,
        _recursive: bool,
    ) -> Result<usize, String> {
        Err(format!(
            "POSIX chmod permissions are not supported on {} endpoints.",
            self.protocol_name().to_uppercase()
        ))
    }

    async fn read_bytes(
        &self,
        path: &str,
        max_bytes: Option<u64>,
    ) -> Result<(Vec<u8>, Option<u64>), String> {
        let clean = normalize_remote_path(path);
        let resp = match self.kind {
            OpenDalBackendKind::WebDav => {
                self.webdav_request("GET", &clean, Vec::new(), &[]).await?
            }
            OpenDalBackendKind::S3 => {
                let (bucket_opt, key) = split_s3_bucket_and_key(&clean);
                let bucket = bucket_opt.ok_or_else(|| "Missing S3 bucket".to_string())?;
                self.s3_request(
                    "GET",
                    &format!("/{}/{}", bucket, key),
                    &BTreeMap::new(),
                    Vec::new(),
                    &[],
                )
                .await?
            }
        };
        if !(200..300).contains(&resp.status) {
            return Err(format!(
                "Failed reading {} (HTTP {})",
                clean, resp.status
            ));
        }
        if let Some(limit) = max_bytes {
            if resp.body.len() as u64 > limit {
                return Err(format!(
                    "Remote object {} ({} bytes) exceeds {} byte limit",
                    clean,
                    resp.body.len(),
                    limit
                ));
            }
        }
        let mtime = resp
            .headers
            .get("last-modified")
            .and_then(|s| parse_protocol_timestamp_ms(s));
        Ok((resp.body, mtime))
    }

    async fn write_bytes(
        &self,
        path: &str,
        data: &[u8],
        _mtime_ms: Option<u64>,
    ) -> Result<(), String> {
        let clean = normalize_remote_path(path);
        let resp = match self.kind {
            OpenDalBackendKind::WebDav => {
                self.webdav_request(
                    "PUT",
                    &clean,
                    vec![(
                        "Content-Type".to_string(),
                        "application/octet-stream".to_string(),
                    )],
                    data,
                )
                .await?
            }
            OpenDalBackendKind::S3 => {
                let (bucket_opt, key) = split_s3_bucket_and_key(&clean);
                let bucket = bucket_opt.ok_or_else(|| "Missing S3 bucket".to_string())?;
                if key.is_empty() {
                    return Err("Cannot write file payload to bucket root".to_string());
                }
                self.s3_request(
                    "PUT",
                    &format!("/{}/{}", bucket, key),
                    &BTreeMap::new(),
                    vec![(
                        "Content-Type".to_string(),
                        "application/octet-stream".to_string(),
                    )],
                    data,
                )
                .await?
            }
        };
        if !(200..300).contains(&resp.status) {
            return Err(format!(
                "Failed writing {} (HTTP {})",
                clean, resp.status
            ));
        }
        Ok(())
    }
}

fn parse_endpoint_host_and_base(raw_host: &str) -> (String, String) {
    let trimmed = raw_host
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    match trimmed.split_once('/') {
        Some((h, base)) => (
            h.trim_end_matches(':').to_string(),
            normalize_remote_path(&format!("/{}", base)),
        ),
        None => (trimmed.to_string(), "/".to_string()),
    }
}

fn format_challenge_id(kind: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}_auth_{:x}", kind, nanos)
}

pub async fn connect_opendal_session(
    request: &SftpConnectRequest,
) -> Result<Result<(OpenDalRemoteFs, SftpConnectedInfo), AuthChallengeInfo>, String> {
    let site: &SiteConfig = &request.site;
    let (host, base_path) = parse_endpoint_host_and_base(&site.host_name);
    if host.is_empty() {
        return Err("Endpoint Host name cannot be empty.".to_string());
    }

    let kind = match site.protocol {
        SiteProtocol::S3 => OpenDalBackendKind::S3,
        SiteProtocol::WebDav => OpenDalBackendKind::WebDav,
        other => {
            return Err(format!("Unsupported protocol {:?} for OpenDal backend", other));
        }
    };

    let raw_trimmed = site.host_name.trim();
    let explicit_http = raw_trimmed.starts_with("http://");
    let explicit_https = raw_trimmed.starts_with("https://");

    let port = if site.port_number == 0 {
        site.protocol.default_port(site.ftps_mode)
    } else {
        site.port_number
    };

    let use_tls =
        explicit_https || (!explicit_http && (site.ftps_mode != FtpsMode::None || port == 443));

    let (access_or_user, secret_or_pass) = match kind {
        OpenDalBackendKind::S3 => {
            let env_id = if site.s3_env_credentials {
                std::env::var("AWS_ACCESS_KEY_ID").ok()
            } else {
                None
            };
            let env_secret = if site.s3_env_credentials {
                std::env::var("AWS_SECRET_ACCESS_KEY").ok()
            } else {
                None
            };
            let key_id = env_id
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| site.user_name.trim().to_string());
            let secret = env_secret
                .filter(|s| !s.is_empty())
                .or_else(|| request.password.clone());
            match secret {
                Some(sec) => (key_id, sec),
                None if site.anonymous_login => (String::new(), String::new()),
                None => {
                    return Ok(Err(AuthChallengeInfo {
                        challenge_id: format_challenge_id("s3"),
                        session_id: request.session_id.clone(),
                        site_id: site.id.clone(),
                        host,
                        port,
                        user_name: key_id.clone(),
                        auth_kind: "password".to_string(),
                        title: format!("S3 Secret Key - {}", key_id),
                        instructions: format!(
                            "Enter S3 Secret Access Key for Access Key '{}':",
                            key_id
                        ),
                        key_path: None,
                        prompts: vec![AuthPromptItem {
                            id: "password".to_string(),
                            prompt: "Secret Key:".to_string(),
                            echo: false,
                        }],
                        log_lines: vec![format!("Connecting to S3 endpoint {}:{}", site.host_name, port)],
                        error_message: None,
                    }));
                }
            }
        }
        OpenDalBackendKind::WebDav => {
            if site.anonymous_login {
                (String::new(), String::new())
            } else if let Some(ref pwd) = request.password {
                (site.user_name.trim().to_string(), pwd.clone())
            } else {
                return Ok(Err(AuthChallengeInfo {
                    challenge_id: format_challenge_id("webdav"),
                    session_id: request.session_id.clone(),
                    site_id: site.id.clone(),
                    host: host.clone(),
                    port,
                    user_name: site.user_name.clone(),
                    auth_kind: "password".to_string(),
                    title: format!("WebDAV Password - {}@{}", site.user_name, host),
                    instructions: format!("Enter password for {}@{}:", site.user_name, host),
                    key_path: None,
                    prompts: vec![AuthPromptItem {
                        id: "password".to_string(),
                        prompt: "Password:".to_string(),
                        echo: false,
                    }],
                    log_lines: vec![format!("Connecting to WebDAV {}:{}", host, port)],
                    error_message: None,
                }));
            }
        }
    };

    let region = if !site.advanced.s3_region.trim().is_empty() {
        site.advanced.s3_region.trim().to_string()
    } else if site.s3_env_credentials {
        std::env::var("AWS_REGION")
            .or_else(|_| std::env::var("AWS_DEFAULT_REGION"))
            .unwrap_or_else(|_| "us-east-1".to_string())
    } else {
        "us-east-1".to_string()
    };

    let preferred_remote = site.advanced.remote_directory.trim();
    let home_path = if preferred_remote.is_empty() {
        "/".to_string()
    } else {
        normalize_remote_path(preferred_remote)
    };

    let fs = OpenDalRemoteFs {
        kind,
        host: host.clone(),
        port,
        use_tls,
        base_path,
        access_or_user,
        secret_or_pass,
        region,
        path_style: site.advanced.s3_url_style.eq_ignore_ascii_case("path"),
        timeout_secs: site.advanced.timeout_secs as u64,
        home_path: home_path.clone(),
    };

    let initial_listing = match fs.list_dir(&home_path).await {
        Ok(l) => l,
        Err(e) if home_path != "/" => fs.list_dir("/").await.map_err(|_| e)?,
        Err(e) => return Err(e),
    };
    let initial_path = initial_listing.path.clone();

    let banner = match kind {
        OpenDalBackendKind::S3 => format!("S3/SigV4 ({}:{})", host, port),
        OpenDalBackendKind::WebDav => format!("WebDAV HTTP ({}:{})", host, port),
    };

    let info = SftpConnectedInfo {
        session_id: request.session_id.clone(),
        home_path,
        initial_path,
        initial_listing,
        auth_method_used: if kind == OpenDalBackendKind::S3 {
            "aws-sigv4".to_string()
        } else if site.anonymous_login {
            "anonymous".to_string()
        } else {
            "http-basic".to_string()
        },
        server_banner: banner,
    };

    Ok(Ok((fs, info)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::net::TcpListener;
    use tokio::sync::Mutex;

    #[test]
    fn aws_sigv4_signing_and_s3_list_objects_xml_parsing() {
        let mut headers = BTreeMap::new();
        headers.insert("host".to_string(), "s3.amazonaws.com".to_string());
        headers.insert("x-amz-date".to_string(), "20251115T120000Z".to_string());

        let auth = build_sigv4_authorization(
            "AKIAIOSFODNN7EXAMPLE",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "us-east-1",
            "s3",
            "GET",
            "/my-bucket",
            "delimiter=%2F&list-type=2",
            &headers,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "20251115T120000Z",
            "20251115",
        );
        assert!(auth.starts_with("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20251115/us-east-1/s3/aws4_request"));
        assert!(auth.contains("SignedHeaders=host;x-amz-date"));
        assert!(auth.contains("Signature="));

        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>my-bucket</Name>
  <CommonPrefixes><Prefix>assets/</Prefix></CommonPrefixes>
  <Contents>
    <Key>logo.png</Key>
    <LastModified>2025-11-15T12:00:00.000Z</LastModified>
    <Size>4096</Size>
  </Contents>
</ListBucketResult>"#;

        let entries = parse_s3_list_objects_xml("/my-bucket", xml);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "assets");
        assert_eq!(entries[0].file_type, "dir");
        assert_eq!(entries[1].name, "logo.png");
        assert_eq!(entries[1].size, 4096);
        assert!(entries[1].modified_ms.is_some());
    }

    #[tokio::test]
    async fn webdav_propfind_xml_parsing_and_loopback_crud() {
        let propfind_sample = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/docs/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/hello%20world.txt</D:href>
    <D:propstat><D:prop><D:getcontentlength>128</D:getcontentlength><D:getlastmodified>Sat, 15 Nov 2025 12:30:00 GMT</D:getlastmodified></D:prop></D:propstat>
  </D:response>
</D:multistatus>"#;

        let parsed = parse_webdav_propfind_xml("/", "/dav", propfind_sample);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "docs");
        assert_eq!(parsed[0].file_type, "dir");
        assert_eq!(parsed[1].name, "hello world.txt");
        assert_eq!(parsed[1].size, 128);
        assert!(parsed[1].modified_ms.is_some());

        // Loopback HTTP WebDAV server test covering connect + PROPFIND + PUT + GET + DELETE
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let store: Arc<Mutex<std::collections::HashMap<String, Vec<u8>>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        store
            .lock()
            .await
            .insert("/readme.txt".to_string(), b"webdav initial".to_vec());

        let store_clone = store.clone();
        let server_task = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let st = store_clone.clone();
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut tmp = [0u8; 4096];
                    loop {
                        let Ok(n) = sock.read(&mut tmp).await else {
                            return;
                        };
                        if n == 0 {
                            break;
                        }
                        raw.extend_from_slice(&tmp[..n]);
                        if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                            let hdr = String::from_utf8_lossy(&raw[..pos]).to_string();
                            let content_len = hdr
                                .lines()
                                .find_map(|l| {
                                    let (k, v) = l.split_once(':')?;
                                    if k.trim().eq_ignore_ascii_case("content-length") {
                                        v.trim().parse::<usize>().ok()
                                    } else {
                                        None
                                    }
                                })
                                .unwrap_or(0);
                            if raw.len() >= pos + 4 + content_len {
                                let req_line = hdr.lines().next().unwrap_or("");
                                let mut parts = req_line.split_whitespace();
                                let method = parts.next().unwrap_or("");
                                let req_path = parts.next().unwrap_or("/");
                                let body_slice = &raw[pos + 4..pos + 4 + content_len];

                                match method {
                                    "PROPFIND" => {
                                        let map = st.lock().await;
                                        let mut xml = String::from(
                                            "<?xml version=\"1.0\"?><D:multistatus xmlns:D=\"DAV:\"><D:response><D:href>/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>",
                                        );
                                        for (p, data) in map.iter() {
                                            xml.push_str(&format!(
                                                "<D:response><D:href>{}</D:href><D:propstat><D:prop><D:getcontentlength>{}</D:getcontentlength></D:prop></D:propstat></D:response>",
                                                p,
                                                data.len()
                                            ));
                                        }
                                        xml.push_str("</D:multistatus>");
                                        let resp = format!(
                                            "HTTP/1.1 207 Multi-Status\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                            xml.len(),
                                            xml
                                        );
                                        let _ = sock.write_all(resp.as_bytes()).await;
                                    }
                                    "PUT" => {
                                        st.lock()
                                            .await
                                            .insert(req_path.to_string(), body_slice.to_vec());
                                        let _ = sock
                                            .write_all(b"HTTP/1.1 201 Created\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                                            .await;
                                    }
                                    "GET" => {
                                        let map = st.lock().await;
                                        if let Some(payload) = map.get(req_path) {
                                            let hdr_out = format!(
                                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                                payload.len()
                                            );
                                            let _ = sock.write_all(hdr_out.as_bytes()).await;
                                            let _ = sock.write_all(payload).await;
                                        } else {
                                            let _ = sock
                                                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                                                .await;
                                        }
                                    }
                                    "DELETE" => {
                                        st.lock().await.remove(req_path);
                                        let _ = sock
                                            .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                                            .await;
                                    }
                                    _ => {
                                        let _ = sock
                                            .write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                                            .await;
                                    }
                                }
                                let _ = sock.shutdown().await;
                                return;
                            }
                        }
                    }
                });
            }
        });

        let mut site = SiteConfig::default();
        site.protocol = SiteProtocol::WebDav;
        site.host_name = "127.0.0.1".to_string();
        site.port_number = port;
        site.anonymous_login = true;

        let outcome = connect_opendal_session(&SftpConnectRequest {
            session_id: "tab-dav".to_string(),
            site,
            password: None,
            passphrase: None,
            tunnel_password: None,
        })
        .await
        .unwrap();

        let (fs, info) = match outcome {
            Ok(pair) => pair,
            Err(_) => panic!("Expected anonymous WebDAV connection"),
        };
        assert_eq!(info.initial_listing.entries.len(), 1);
        assert_eq!(info.initial_listing.entries[0].name, "readme.txt");

        fs.write_bytes("/notes.txt", b"hello dav", None).await.unwrap();
        let (bytes, _) = fs.read_bytes("/notes.txt", None).await.unwrap();
        assert_eq!(bytes, b"hello dav");
        assert_eq!(fs.delete(&["/notes.txt".to_string()]).await.unwrap(), 1);

        server_task.abort();
    }
}
