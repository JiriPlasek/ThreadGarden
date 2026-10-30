//! pahub's optional Anthropic API key in the OS credential store (spec §5.5):
//! Windows Credential Manager, macOS Keychain, Secret Service on Linux.
//! The key never touches pahub's database, `service.json` or logs.

const SERVICE: &str = "pahub";
const USER: &str = "anthropic-api-key";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, USER).map_err(|e| format!("credential-store-unavailable: {e}"))
}

/// A missing credential is `None`, not an error.
fn absent_ok<T>(result: keyring::Result<T>) -> Result<Option<T>, String> {
    match result {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("credential-store-error: {e}")),
    }
}

pub fn get() -> Result<Option<String>, String> {
    absent_ok(entry()?.get_password())
}

pub fn set(key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("api-key-empty".into());
    }
    entry()?
        .set_password(key)
        .map_err(|e| format!("credential-store-error: {e}"))
}

/// Removing a key that is not stored is fine.
pub fn clear() -> Result<(), String> {
    absent_ok(entry()?.delete_credential()).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The real store is not exercised here: CI runners have no unlocked keychain/Secret Service.
    #[test]
    fn missing_credential_is_none() {
        assert_eq!(absent_ok::<String>(Err(keyring::Error::NoEntry)), Ok(None));
        assert_eq!(absent_ok(Ok("k".to_string())), Ok(Some("k".to_string())));
        let err = absent_ok::<String>(Err(keyring::Error::NoStorageAccess(
            "locked".to_string().into(),
        )));
        assert!(err.unwrap_err().starts_with("credential-store-error"));
    }

    #[test]
    fn refuses_an_empty_key() {
        assert_eq!(set("  "), Err("api-key-empty".to_string()));
    }
}
