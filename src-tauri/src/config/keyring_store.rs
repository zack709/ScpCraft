use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const KEYRING_SERVICE: &str = "ScpCraft";

static MEMORY_FALLBACK: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn memory_store() -> &'static Mutex<HashMap<String, String>> {
    MEMORY_FALLBACK.get_or_init(|| Mutex::new(HashMap::new()))
}

fn account_key(site_id: &str, kind: &str) -> String {
    format!("site:{}:{}", site_id, kind)
}

/// Store a site credential in the OS Keyring (plus in-memory fallback for headless CI/tests).
pub fn set_site_secret(site_id: &str, kind: &str, secret: &str) -> Result<(), String> {
    let account = account_key(site_id, kind);
    {
        let mut guard = memory_store()
            .lock()
            .map_err(|_| "Secret store mutex poisoned".to_string())?;
        if secret.is_empty() {
            guard.remove(&account);
        } else {
            guard.insert(account.clone(), secret.to_string());
        }
    }

    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &account) {
        if secret.is_empty() {
            let _ = entry.delete_credential();
        } else {
            // Best effort OS keyring write; falls back gracefully in headless/sandboxed runners
            let _ = entry.set_password(secret);
        }
    }
    Ok(())
}

/// Retrieve a credential from memory cache or the OS Keyring.
pub fn get_site_secret(site_id: &str, kind: &str) -> Option<String> {
    let account = account_key(site_id, kind);
    if let Ok(guard) = memory_store().lock() {
        if let Some(val) = guard.get(&account) {
            return Some(val.clone());
        }
    }

    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &account) {
        if let Ok(pwd) = entry.get_password() {
            if let Ok(mut guard) = memory_store().lock() {
                guard.insert(account, pwd.clone());
            }
            return Some(pwd);
        }
    }
    None
}

/// Delete all secrets belonging to a given site ID.
pub fn delete_site_secrets(site_id: &str) {
    for kind in ["password", "passphrase", "tunnelPassword"] {
        let account = account_key(site_id, kind);
        if let Ok(mut guard) = memory_store().lock() {
            guard.remove(&account);
        }
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &account) {
            let _ = entry.delete_credential();
        }
    }
}
