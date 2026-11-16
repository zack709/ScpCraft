use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_ASCII_MASK: &str = "*.txt;*.html;*.htm;*.cgi;*.pl;*.php;*.py;*.sh;*.xml;*.css;*.js;*.ts;*.tsx;*.json;*.md;*.ini;*.conf;*.yml;*.yaml;*.rs;*.c;*.cpp;*.h;*.sql;*.csv";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TransferMode {
    #[default]
    Binary,
    Text,
    Automatic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictResolution {
    Overwrite,
    OverwriteAll,
    Resume,
    ResumeAll,
    Rename,
    RenameAll,
    NewerOnly,
    Skip,
    SkipAll,
    Cancel,
}

/// Append `.filepart` temporary suffix unless already present.
pub fn to_filepart_path(target_path: &str) -> String {
    if target_path.ends_with(".filepart") {
        target_path.to_string()
    } else {
        format!("{}.filepart", target_path)
    }
}

/// Strip `.filepart` suffix when inspecting an incomplete temporary file.
pub fn strip_filepart_suffix(path: &str) -> Option<&str> {
    path.strip_suffix(".filepart")
}

/// Decide whether a file should use Text EOL translation based on mode and mask.
pub fn resolve_is_text_mode(mode: TransferMode, file_name: &str, ascii_mask: &str) -> bool {
    match mode {
        TransferMode::Binary => false,
        TransferMode::Text => true,
        TransferMode::Automatic => {
            let effective_mask = if ascii_mask.trim().is_empty() {
                DEFAULT_ASCII_MASK
            } else {
                ascii_mask
            };
            matches_transfer_mask(file_name, false, effective_mask)
        }
    }
}

/// Streaming CRLF -> LF conversion for Text mode uploads, handling split `\r` across chunk boundaries.
pub fn convert_crlf_to_lf_chunk(input: &[u8], pending_cr: &mut bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() + usize::from(*pending_cr));
    for &b in input {
        if *pending_cr {
            if b == b'\n' {
                out.push(b'\n');
                *pending_cr = false;
                continue;
            }
            out.push(b'\r');
            *pending_cr = false;
        }
        if b == b'\r' {
            *pending_cr = true;
        } else {
            out.push(b);
        }
    }
    out
}

/// Flush any trailing unmatched `\r` at EOF after streaming CRLF -> LF conversion.
pub fn finish_crlf_to_lf(pending_cr: &mut bool) -> Vec<u8> {
    if *pending_cr {
        *pending_cr = false;
        vec![b'\r']
    } else {
        Vec::new()
    }
}

/// Streaming LF -> CRLF conversion for Text mode downloads without doubling existing `\r\n`.
pub fn convert_lf_to_crlf_chunk(input: &[u8], prev_was_cr: &mut bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() + input.len() / 16);
    for &b in input {
        if b == b'\n' && !*prev_was_cr {
            out.push(b'\r');
        }
        out.push(b);
        *prev_was_cr = b == b'\r';
    }
    out
}

/// Strip UTF-8 BOM at the beginning of a text buffer and DOS Ctrl-Z (`0x1A`) at EOF when requested.
pub fn strip_utf8_bom_and_eof_ctrl_z(data: &[u8], is_first_chunk: bool, is_last_chunk: bool) -> &[u8] {
    let mut slice = data;
    if is_first_chunk && slice.starts_with(&[0xEF, 0xBB, 0xBF]) {
        slice = &slice[3..];
    }
    if is_last_chunk && slice.ends_with(&[0x1A]) {
        slice = &slice[..slice.len() - 1];
    }
    slice
}

fn glob_match_ci(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let mut star_pi: Option<usize> = None;
    let mut star_ti: usize = 0;

    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star_pi = Some(pi);
            star_ti = ti;
            pi += 1;
        } else if let Some(sp) = star_pi {
            pi = sp + 1;
            star_ti += 1;
            ti = star_ti;
        } else {
            return false;
        }
    }

    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn match_pattern_list(name: &str, is_dir: bool, list_str: &str) -> bool {
    for raw in list_str.split([';', ',']) {
        let token = raw.trim();
        if token.is_empty() {
            continue;
        }
        if let Some(dir_pat) = token.strip_suffix('/').or_else(|| token.strip_suffix('\\')) {
            if is_dir && glob_match_ci(dir_pat, name) {
                return true;
            }
        } else if glob_match_ci(token, name) {
            return true;
        }
    }
    false
}

/// Evaluate WinSCP-style file mask (`include1;include2|exclude1/;exclude2`).
pub fn matches_transfer_mask(name: &str, is_dir: bool, mask_spec: &str) -> bool {
    let trimmed = mask_spec.trim();
    if trimmed.is_empty() || trimmed == "*" || trimmed == "*.*" {
        return true;
    }

    let (include_part, exclude_part) = match trimmed.split_once('|') {
        Some((inc, exc)) => (inc.trim(), exc.trim()),
        None => (trimmed, ""),
    };

    let included = if include_part.is_empty() || include_part == "*" || include_part == "*.*" {
        true
    } else {
        match_pattern_list(name, is_dir, include_part)
    };

    if !included {
        return false;
    }

    if !exclude_part.is_empty() && match_pattern_list(name, is_dir, exclude_part) {
        return false;
    }

    true
}

/// Skip transfer under "New and updated files only" when target is strictly same age or newer.
pub fn should_skip_newer_only(source_mtime_ms: Option<u64>, target_mtime_ms: Option<u64>) -> bool {
    match (source_mtime_ms, target_mtime_ms) {
        (Some(src), Some(dst)) => dst >= src,
        _ => false,
    }
}

/// Split filename into `(stem, extension_with_dot)` preserving dotfiles cleanly.
pub fn split_stem_and_ext(file_name: &str) -> (&str, &str) {
    if let Some(idx) = file_name.rfind('.') {
        if idx > 0 && idx + 1 < file_name.len() {
            return (&file_name[..idx], &file_name[idx..]);
        }
    }
    (file_name, "")
}

/// Format an auto-renamed candidate filename such as `report (2).pdf`.
pub fn format_numbered_name(file_name: &str, index: u32) -> String {
    let (stem, ext) = split_stem_and_ext(file_name);
    format!("{} ({}){}", stem, index, ext)
}

/// Find the first non-existent auto-renamed path beside `target` on local filesystem.
pub fn next_available_local_path(target: &Path) -> PathBuf {
    if !target.exists() {
        return target.to_path_buf();
    }
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());

    for idx in 2..=9999u32 {
        let candidate = parent.join(format_numbered_name(&file_name, idx));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{}.new", file_name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn filepart_naming_and_auto_rename() {
        assert_eq!(to_filepart_path("/var/www/app.zip"), "/var/www/app.zip.filepart");
        assert_eq!(
            to_filepart_path("/var/www/app.zip.filepart"),
            "/var/www/app.zip.filepart"
        );
        assert_eq!(
            strip_filepart_suffix("/var/www/app.zip.filepart"),
            Some("/var/www/app.zip")
        );
        assert_eq!(strip_filepart_suffix("/var/www/app.zip"), None);

        assert_eq!(format_numbered_name("report.pdf", 2), "report (2).pdf");
        assert_eq!(format_numbered_name(".env", 3), ".env (3)");
        assert_eq!(format_numbered_name("Makefile", 2), "Makefile (2)");

        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("scpcraft_rename_{}", nanos));
        fs::create_dir_all(&dir).unwrap();
        let base = dir.join("archive.tar.gz");
        let second = dir.join("archive.tar (2).gz");
        fs::write(&base, b"1").unwrap();
        fs::write(&second, b"2").unwrap();

        let next = next_available_local_path(&base);
        assert_eq!(next, dir.join("archive.tar (3).gz"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn text_eol_crlf_lf_streaming_conversion() {
        let mut pending_cr = false;
        let mut out = Vec::new();
        out.extend_from_slice(&convert_crlf_to_lf_chunk(b"hello\r\nworld\r", &mut pending_cr));
        out.extend_from_slice(&convert_crlf_to_lf_chunk(b"\nend\r\r\n", &mut pending_cr));
        out.extend_from_slice(&finish_crlf_to_lf(&mut pending_cr));
        assert_eq!(out, b"hello\nworld\nend\r\n");

        let mut prev_cr = false;
        let mut dl = Vec::new();
        dl.extend_from_slice(&convert_lf_to_crlf_chunk(b"a\nb\r", &mut prev_cr));
        dl.extend_from_slice(&convert_lf_to_crlf_chunk(b"\nc\n", &mut prev_cr));
        assert_eq!(dl, b"a\r\nb\r\nc\r\n");
    }

    #[test]
    fn winscp_include_exclude_mask_and_newer_only() {
        assert!(matches_transfer_mask("index.html", false, "*.html;*.css|*.min.css"));
        assert!(!matches_transfer_mask(
            "style.min.css",
            false,
            "*.html;*.css|*.min.css"
        ));
        assert!(!matches_transfer_mask(
            "node_modules",
            true,
            "*|node_modules/;target/"
        ));
        assert!(matches_transfer_mask("node_modules", false, "*|node_modules/"));
        assert!(matches_transfer_mask("doc.txt", false, "|*.tmp"));
        assert!(!matches_transfer_mask("scratch.tmp", false, "|*.tmp"));

        assert!(resolve_is_text_mode(
            TransferMode::Automatic,
            "script.ts",
            DEFAULT_ASCII_MASK
        ));
        assert!(!resolve_is_text_mode(
            TransferMode::Automatic,
            "photo.png",
            DEFAULT_ASCII_MASK
        ));

        assert!(should_skip_newer_only(Some(1000), Some(1500)));
        assert!(should_skip_newer_only(Some(1500), Some(1500)));
        assert!(!should_skip_newer_only(Some(2000), Some(1500)));
        assert!(!should_skip_newer_only(Some(2000), None));
    }
}
