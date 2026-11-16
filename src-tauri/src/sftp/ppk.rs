use russh::keys::{self, ssh_key};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyInspection {
    pub path: String,
    pub kind: String,
    pub encrypted: bool,
    pub algorithm: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug)]
pub enum KeyDecodeOutcome {
    Ready(keys::PrivateKey),
    NeedsPassphrase,
    WrongPassphrase,
    Failed(String),
}

/// Inspect a private key file (PuTTY `.ppk` v2/v3, OpenSSH, or PEM/PKCS#8) without decoding secrets.
pub fn inspect_key_file(path: &Path) -> Result<KeyInspection, String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read key file {}: {}", path.display(), e))?;
    Ok(inspect_key_content(&path.to_string_lossy(), &content))
}

/// Inspect raw key file text to identify container format, encryption status, algorithm, and comment.
pub fn inspect_key_content(path: &str, content: &str) -> KeyInspection {
    let trimmed = content.trim_start_matches('\u{feff}').trim();

    if let Some(first_line) = trimmed.lines().next() {
        if let Some(alg) = first_line.strip_prefix("PuTTY-User-Key-File-3:") {
            return parse_ppk_metadata(path, "ppk3", alg.trim(), trimmed);
        }
        if let Some(alg) = first_line.strip_prefix("PuTTY-User-Key-File-2:") {
            return parse_ppk_metadata(path, "ppk2", alg.trim(), trimmed);
        }
    }

    if trimmed.contains("-----BEGIN OPENSSH PRIVATE KEY-----") {
        let mut encrypted = false;
        let mut algorithm = None;
        let mut comment = None;

        if let Ok(parsed) = ssh_key::PrivateKey::from_openssh(trimmed) {
            encrypted = parsed.is_encrypted();
            algorithm = Some(parsed.algorithm().to_string());
            if !parsed.comment().is_empty() {
                comment = Some(parsed.comment().to_string());
            }
        } else if matches!(
            keys::decode_secret_key(trimmed, None),
            Err(keys::Error::KeyIsEncrypted)
        ) {
            encrypted = true;
        }

        return KeyInspection {
            path: path.to_string(),
            kind: "openssh".to_string(),
            encrypted,
            algorithm,
            comment,
        };
    }

    if trimmed.contains("-----BEGIN ENCRYPTED PRIVATE KEY-----")
        || trimmed.contains("-----BEGIN PRIVATE KEY-----")
        || trimmed.contains("-----BEGIN RSA PRIVATE KEY-----")
        || trimmed.contains("-----BEGIN EC PRIVATE KEY-----")
    {
        let encrypted = trimmed.contains("-----BEGIN ENCRYPTED PRIVATE KEY-----")
            || trimmed.contains("Proc-Type: 4,ENCRYPTED");
        let algorithm = if trimmed.contains("BEGIN RSA PRIVATE KEY") {
            Some("ssh-rsa".to_string())
        } else if trimmed.contains("BEGIN EC PRIVATE KEY") {
            Some("ecdsa".to_string())
        } else {
            None
        };

        return KeyInspection {
            path: path.to_string(),
            kind: "pem".to_string(),
            encrypted,
            algorithm,
            comment: None,
        };
    }

    KeyInspection {
        path: path.to_string(),
        kind: "unknown".to_string(),
        encrypted: false,
        algorithm: None,
        comment: None,
    }
}

fn parse_ppk_metadata(path: &str, kind: &str, algorithm: &str, content: &str) -> KeyInspection {
    let mut encrypted = false;
    let mut comment = None;

    for line in content.lines().skip(1) {
        if let Some(enc) = line.strip_prefix("Encryption:") {
            let val = enc.trim();
            encrypted = !val.is_empty() && !val.eq_ignore_ascii_case("none");
        } else if let Some(c) = line.strip_prefix("Comment:") {
            let val = c.trim();
            if !val.is_empty() {
                comment = Some(val.to_string());
            }
        } else if line.starts_with("Public-Lines:") {
            break;
        }
    }

    KeyInspection {
        path: path.to_string(),
        kind: kind.to_string(),
        encrypted,
        algorithm: if algorithm.is_empty() {
            None
        } else {
            Some(algorithm.to_string())
        },
        comment,
    }
}

/// Load and decode a private key from disk (`.ppk` v2/v3, OpenSSH, or PEM/PKCS#8).
pub fn load_private_key(path: &Path, passphrase: Option<&str>) -> KeyDecodeOutcome {
    let content = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) => {
            return KeyDecodeOutcome::Failed(format!(
                "Failed to read private key {}: {}",
                path.display(),
                err
            ))
        }
    };
    decode_private_key(&content, passphrase)
}

/// Decode a private key from file contents, classifying missing/invalid passphrase errors.
pub fn decode_private_key(content: &str, passphrase: Option<&str>) -> KeyDecodeOutcome {
    let inspection = inspect_key_content("", content);
    let clean_pass = passphrase.filter(|p| !p.is_empty());

    if inspection.encrypted && clean_pass.is_none() {
        return KeyDecodeOutcome::NeedsPassphrase;
    }

    match keys::decode_secret_key(content, clean_pass) {
        Ok(key) => KeyDecodeOutcome::Ready(key),
        Err(keys::Error::KeyIsEncrypted) => {
            if clean_pass.is_some() {
                KeyDecodeOutcome::WrongPassphrase
            } else {
                KeyDecodeOutcome::NeedsPassphrase
            }
        }
        Err(err) => {
            let msg = err.to_string();
            let lower = msg.to_lowercase();
            let looks_like_passphrase_error = lower.contains("decrypt")
                || lower.contains("encrypted")
                || lower.contains("passphrase")
                || lower.contains("password")
                || lower.contains("mac")
                || lower.contains("pad")
                || lower.contains("cipher")
                || lower.contains("corrupt")
                || lower.contains("cryptographic");

            if inspection.encrypted {
                if clean_pass.is_some() {
                    KeyDecodeOutcome::WrongPassphrase
                } else {
                    KeyDecodeOutcome::NeedsPassphrase
                }
            } else if looks_like_passphrase_error {
                KeyDecodeOutcome::NeedsPassphrase
            } else {
                KeyDecodeOutcome::Failed(format!("Failed to decode private key: {}", msg))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_ED25519_OPENSSH: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACDe4a+hM4lQ6l68M5Q28E8W4eN9l3nJ7S08B4l0V+gXQgAAAIh2M0cP6V2Z
8AAAAAtzc2gtZWQyNTUxOQAAACDe4a+hM4lQ6l68M5Q28E8W4eN9l3nJ7S08B4l0V+gXQg
AAAEAhf12hM4lQ6l68M5Q28E8W4eN9l3nJ7S08B4l0V+gXQiDe4a+hM4lQ6l68M5Q28E8W
4eN9l3nJ7S08B4l0V+gXQgAAAAd0ZXN0QHVuaXQBAgME
-----END OPENSSH PRIVATE KEY-----";

    const SAMPLE_ED25519_OPENSSH_ENCRYPTED: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABD1phlku5
A2G7Q9iP+DcOc9AAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIHeLC1lWiCYrXsf/
85O/pkbUFZ6OGIt49PX3nw8iRoXEAAAAkKRF0st5ZI7xxo9g6A4m4l6NarkQre3mycqNXQ
dP3jryYgvsCIBAA5jMWSjrmnOTXhidqcOy4xYCrAttzSnZ/cUadfBenL+DQq6neffw7j8r
0tbCxVGp6yCQlKrgSZf6c0Hy7dNEIU2bJFGxLe6/kWChcUAt/5Ll5rI7DVQPJdLgehLzvv
sJWR7W+cGvJ/vLsw==
-----END OPENSSH PRIVATE KEY-----";

    #[test]
    fn inspects_ppk_v3_and_v2_headers() {
        let ppk3 = "\
PuTTY-User-Key-File-3: ssh-ed25519
Encryption: aes256-cbc
Comment: prod-bastion
Key-Derivation: Argon2id
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAIA==
";
        let info3 = inspect_key_content("C:\\keys\\prod.ppk", ppk3);
        assert_eq!(info3.kind, "ppk3");
        assert!(info3.encrypted);
        assert_eq!(info3.algorithm.as_deref(), Some("ssh-ed25519"));
        assert_eq!(info3.comment.as_deref(), Some("prod-bastion"));

        let ppk2 = "\
PuTTY-User-Key-File-2: ssh-rsa
Encryption: none
Comment: dev-rsa
Public-Lines: 1
AAAA
";
        let info2 = inspect_key_content("/keys/dev.ppk", ppk2);
        assert_eq!(info2.kind, "ppk2");
        assert!(!info2.encrypted);
        assert_eq!(info2.algorithm.as_deref(), Some("ssh-rsa"));
        assert_eq!(info2.comment.as_deref(), Some("dev-rsa"));
    }

    #[test]
    fn inspects_and_decodes_openssh_keys() {
        let enc_info = inspect_key_content("id_ed25519_enc", SAMPLE_ED25519_OPENSSH_ENCRYPTED);
        assert_eq!(enc_info.kind, "openssh");
        assert!(enc_info.encrypted);
        assert_eq!(enc_info.algorithm.as_deref(), Some("ssh-ed25519"));

        assert!(matches!(
            decode_private_key(SAMPLE_ED25519_OPENSSH_ENCRYPTED, None),
            KeyDecodeOutcome::NeedsPassphrase
        ));
        assert!(matches!(
            decode_private_key(SAMPLE_ED25519_OPENSSH_ENCRYPTED, Some("wrong-pw")),
            KeyDecodeOutcome::WrongPassphrase
        ));
        assert!(matches!(
            decode_private_key(SAMPLE_ED25519_OPENSSH_ENCRYPTED, Some("test")),
            KeyDecodeOutcome::Ready(_)
        ));

        let plain_info = inspect_key_content("plain_check", SAMPLE_ED25519_OPENSSH);
        assert_eq!(plain_info.kind, "openssh");
        assert!(!plain_info.encrypted);
    }

    #[test]
    fn detects_encrypted_pem_header() {
        let pem = "\
-----BEGIN RSA PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: AES-128-CBC,00112233445566778899AABBCCDDEEFF
AAAA
-----END RSA PRIVATE KEY-----
";
        let info = inspect_key_content("legacy.pem", pem);
        assert_eq!(info.kind, "pem");
        assert!(info.encrypted);
        assert_eq!(info.algorithm.as_deref(), Some("ssh-rsa"));
        assert!(matches!(
            decode_private_key(pem, None),
            KeyDecodeOutcome::NeedsPassphrase
        ));
    }
}
