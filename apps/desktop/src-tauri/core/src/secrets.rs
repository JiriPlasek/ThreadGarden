//! Where device tokens and bridge passwords live. On Android that's a file
//! encrypted with a Keystore key (the app provides it); the core only sees
//! this trait, and `store.rs` never holds a secret.

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

/// A secret store failed (a Keystore key that's gone, a file that can't be
/// written). The message never contains a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretsError(pub String);

impl fmt::Display for SecretsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SecretsError {}

pub trait Secrets: Send + Sync {
    /// The secret under `key`, or `None` when there's none.
    fn get(&self, key: &str) -> Result<Option<String>, SecretsError>;
    fn set(&self, key: &str, value: &str) -> Result<(), SecretsError>;
    /// Forgets `key`; forgetting one that isn't there is fine.
    fn delete(&self, key: &str) -> Result<(), SecretsError>;
}

/// Secrets held in memory only: for tests, and for hosts without a keystore.
#[derive(Default)]
pub struct MemorySecrets {
    values: Mutex<HashMap<String, String>>,
}

impl MemorySecrets {
    fn values(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        // A panic while holding the lock leaves the map whole: keep using it.
        self.values.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Names the keys, never the values.
impl fmt::Debug for MemorySecrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut keys: Vec<String> = self.values().keys().cloned().collect();
        keys.sort();
        f.debug_struct("MemorySecrets")
            .field("keys", &keys)
            .finish()
    }
}

impl Secrets for MemorySecrets {
    fn get(&self, key: &str) -> Result<Option<String>, SecretsError> {
        Ok(self.values().get(key).cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<(), SecretsError> {
        self.values().insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), SecretsError> {
        self.values().remove(key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_secrets_keep_set_and_forget() {
        let s = MemorySecrets::default();
        assert_eq!(s.get("machine-token:m1"), Ok(None));
        s.set("machine-token:m1", "secret-value").unwrap();
        assert_eq!(s.get("machine-token:m1"), Ok(Some("secret-value".into())));
        s.delete("machine-token:m1").unwrap();
        s.delete("machine-token:m1").unwrap();
        assert_eq!(s.get("machine-token:m1"), Ok(None));
    }

    #[test]
    fn debug_never_shows_a_value() {
        let s = MemorySecrets::default();
        s.set("machine-token:m1", "secret-value").unwrap();
        let shown = format!("{s:?}");
        assert!(shown.contains("machine-token:m1"));
        assert!(!shown.contains("secret-value"));
    }
}
