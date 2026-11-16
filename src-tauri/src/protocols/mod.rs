pub mod ftp;
pub mod opendal_fs;

use crate::local_fs::FileEntry;
use crate::sftp::ops::{extract_extension, format_posix_permissions};

/// Convert civil `(year, month 1..=12, day 1..=31, h, m, s)` UTC to UNIX epoch milliseconds.
pub fn ymdhms_to_epoch_ms(
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    min: u32,
    sec: u32,
) -> Option<u64> {
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || min > 59
        || sec > 60
    {
        return None;
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = month as i64;
    let d = day as i64;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let secs = days * 86400 + (hour as i64) * 3600 + (min as i64) * 60 + (sec as i64);
    if secs < 0 {
        None
    } else {
        Some((secs as u64) * 1000)
    }
}

pub fn parse_month_abbr(raw: &str) -> Option<u32> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "jan" => Some(1),
        "feb" => Some(2),
        "mar" => Some(3),
        "apr" => Some(4),
        "may" => Some(5),
        "jun" => Some(6),
        "jul" => Some(7),
        "aug" => Some(8),
        "sep" => Some(9),
        "oct" => Some(10),
        "nov" => Some(11),
        "dec" => Some(12),
        _ => None,
    }
}

/// Parse compact FTP `YYYYMMDDHHMMSS`, ISO-8601 `YYYY-MM-DDTHH:MM:SS...`, or RFC-1123 date strings.
pub fn parse_protocol_timestamp_ms(raw: &str) -> Option<u64> {
    let trimmed = raw.trim();
    if trimmed.len() >= 14 && trimmed[..14].chars().all(|c| c.is_ascii_digit()) {
        let y = trimmed[0..4].parse().ok()?;
        let mo = trimmed[4..6].parse().ok()?;
        let d = trimmed[6..8].parse().ok()?;
        let h = trimmed[8..10].parse().ok()?;
        let mi = trimmed[10..12].parse().ok()?;
        let s = trimmed[12..14].parse().ok()?;
        return ymdhms_to_epoch_ms(y, mo, d, h, mi, s);
    }

    if let Some((date_part, time_rest)) = trimmed.split_once('T') {
        if date_part.len() == 10 && !date_part.contains([' ', ',']) {
            let mut dp = date_part.split('-');
            let y: i64 = dp.next()?.parse().ok()?;
            let mo: u32 = dp.next()?.parse().ok()?;
            let d: u32 = dp.next()?.parse().ok()?;
            let t_clean = time_rest
                .split(['Z', '+', '.'])
                .next()
                .unwrap_or(time_rest);
            let mut tp = t_clean.split(':');
            let h: u32 = tp.next()?.parse().ok()?;
            let mi: u32 = tp.next()?.parse().ok()?;
            let s: u32 = tp.next().unwrap_or("0").parse().ok()?;
            return ymdhms_to_epoch_ms(y, mo, d, h, mi, s);
        }
    }

    // RFC 1123: `Sun, 15 Nov 2025 14:30:00 GMT`
    let after_comma = trimmed.split(',').nth(1).unwrap_or(trimmed).trim();
    let parts: Vec<&str> = after_comma.split_whitespace().collect();
    if parts.len() >= 4 {
        let d: u32 = parts[0].parse().ok()?;
        let mo = parse_month_abbr(parts[1])?;
        let y: i64 = parts[2].parse().ok()?;
        let mut tp = parts[3].split(':');
        let h: u32 = tp.next()?.parse().ok()?;
        let mi: u32 = tp.next()?.parse().ok()?;
        let s: u32 = tp.next().unwrap_or("0").parse().ok()?;
        return ymdhms_to_epoch_ms(y, mo, d, h, mi, s);
    }

    None
}

pub fn make_protocol_entry(
    name: String,
    full_path: String,
    is_dir: bool,
    is_symlink: bool,
    size: u64,
    modified_ms: Option<u64>,
    perm_bits: Option<u32>,
    symlink_target: Option<String>,
) -> FileEntry {
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
    let effective_perm = perm_bits.unwrap_or(default_perm);
    let (permissions_text, octal_mode) =
        format_posix_permissions(effective_perm, is_dir, is_symlink);
    let readonly = (effective_perm & 0o222) == 0;

    FileEntry {
        extension: extract_extension(&name, is_dir),
        hidden: name.starts_with('.'),
        name,
        path: full_path,
        file_type,
        size: if is_dir { 0 } else { size },
        modified_ms,
        created_ms: None,
        readonly,
        system: false,
        permissions_text,
        octal_mode,
        symlink_target,
    }
}
