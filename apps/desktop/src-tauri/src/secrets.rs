//! Threadgarden's optional Anthropic API key in the OS credential store (spec §5.5):
//! Windows Credential Manager, macOS Keychain, Secret Service on Linux.
//! The key never touches Threadgarden's database, `service.json` or logs.
//!
//! The entry's service name is `threadgarden`. Before v1.3 it was `pahub`
//! (spec v1.3 §9): a key found only there is moved under the new name when
//! read, and saving or removing the key removes any old entry too.

const SERVICE: &str = "threadgarden";
const LEGACY_SERVICE: &str = "pahub";
const USER: &str = "anthropic-api-key";

/// The credential store, by service name and user (account). The API key
/// lives under `USER`, a machine's device token under `machine:<id>`.
trait Store {
    /// A missing credential is `None`, not an error.
    fn get(&self, service: &str, user: &str) -> Result<Option<String>, String>;
    fn set(&self, service: &str, user: &str, key: &str) -> Result<(), String>;
    /// Removing a credential that is not stored is fine.
    fn delete(&self, service: &str, user: &str) -> Result<(), String>;
}

/// The OS credential store, through the `keyring` crate.
struct Keyring;

fn entry(service: &str, user: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, user).map_err(|e| format!("credential-store-unavailable: {e}"))
}

/// A missing credential is `None`, not an error.
fn absent_ok<T>(result: keyring::Result<T>) -> Result<Option<T>, String> {
    match result {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("credential-store-error: {e}")),
    }
}

impl Store for Keyring {
    fn get(&self, service: &str, user: &str) -> Result<Option<String>, String> {
        absent_ok(entry(service, user)?.get_password())
    }

    fn set(&self, service: &str, user: &str, key: &str) -> Result<(), String> {
        entry(service, user)?
            .set_password(key)
            .map_err(|e| format!("credential-store-error: {e}"))
    }

    fn delete(&self, service: &str, user: &str) -> Result<(), String> {
        absent_ok(entry(service, user)?.delete_credential()).map(|_| ())
    }
}

/// The key under the new name, else pahub's, which is then moved under the
/// new name. A failed move is no error: the key was read, and the next read
/// tries the move again.
fn get_from(store: &impl Store) -> Result<Option<String>, String> {
    if let Some(key) = store.get(SERVICE, USER)? {
        return Ok(Some(key));
    }
    let Some(key) = store.get(LEGACY_SERVICE, USER)? else {
        return Ok(None);
    };
    if store.set(SERVICE, USER, &key).is_ok() {
        let _ = store.delete(LEGACY_SERVICE, USER);
    }
    Ok(Some(key))
}

fn set_in(store: &impl Store, key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("api-key-empty".into());
    }
    store.set(SERVICE, USER, key)?;
    store.delete(LEGACY_SERVICE, USER)
}

/// Removes the key under both names; both are tried even when one fails.
fn clear_in(store: &impl Store) -> Result<(), String> {
    let current = store.delete(SERVICE, USER);
    let legacy = store.delete(LEGACY_SERVICE, USER);
    current.and(legacy)
}

pub fn get() -> Result<Option<String>, String> {
    get_from(&Keyring)
}

pub fn set(key: &str) -> Result<(), String> {
    set_in(&Keyring, key)
}

/// Removing a key that is not stored is fine.
pub fn clear() -> Result<(), String> {
    clear_in(&Keyring)
}

/// The keychain account of a machine's device token. Ids are UUIDs
/// (`^[0-9a-f-]{36}$`); anything else is refused so an id can never shape
/// another account name.
fn machine_user(machine_id: &str) -> Result<String, String> {
    let valid = machine_id.len() == 36
        && machine_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-');
    if valid {
        Ok(format!("machine:{machine_id}"))
    } else {
        Err("machine-id-invalid".into())
    }
}

fn machine_token_get_from(store: &impl Store, machine_id: &str) -> Result<Option<String>, String> {
    store.get(SERVICE, &machine_user(machine_id)?)
}

fn machine_token_set_in(store: &impl Store, machine_id: &str, token: &str) -> Result<(), String> {
    store.set(SERVICE, &machine_user(machine_id)?, token)
}

fn machine_token_clear_in(store: &impl Store, machine_id: &str) -> Result<(), String> {
    store.delete(SERVICE, &machine_user(machine_id)?)
}

/// The device token this desktop received when it paired with a machine.
pub fn machine_token_get(machine_id: &str) -> Result<Option<String>, String> {
    machine_token_get_from(&Keyring, machine_id)
}

pub fn machine_token_set(machine_id: &str, token: &str) -> Result<(), String> {
    machine_token_set_in(&Keyring, machine_id, token)
}

/// Removing a token that is not stored is fine.
pub fn machine_token_clear(machine_id: &str) -> Result<(), String> {
    machine_token_clear_in(&Keyring, machine_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// An in-memory store; `failing` names the services whose writes and deletes fail.
    #[derive(Default)]
    struct FakeStore {
        entries: RefCell<HashMap<(String, String), String>>,
        failing: Vec<&'static str>,
    }

    impl FakeStore {
        fn with(entries: &[(&str, &str)]) -> Self {
            let store = FakeStore::default();
            for (service, key) in entries {
                store
                    .entries
                    .borrow_mut()
                    .insert((service.to_string(), USER.to_string()), key.to_string());
            }
            store
        }

        /// The API key entry of `service`.
        fn stored(&self, service: &str) -> Option<String> {
            self.stored_as(service, USER)
        }

        fn stored_as(&self, service: &str, user: &str) -> Option<String> {
            self.entries
                .borrow()
                .get(&(service.to_string(), user.to_string()))
                .cloned()
        }

        fn check(&self, service: &str) -> Result<(), String> {
            if self.failing.contains(&service) {
                Err("credential-store-error: locked".into())
            } else {
                Ok(())
            }
        }
    }

    impl Store for FakeStore {
        fn get(&self, service: &str, user: &str) -> Result<Option<String>, String> {
            Ok(self.stored_as(service, user))
        }

        fn set(&self, service: &str, user: &str, key: &str) -> Result<(), String> {
            self.check(service)?;
            self.entries
                .borrow_mut()
                .insert((service.to_string(), user.to_string()), key.to_string());
            Ok(())
        }

        fn delete(&self, service: &str, user: &str) -> Result<(), String> {
            self.check(service)?;
            self.entries
                .borrow_mut()
                .remove(&(service.to_string(), user.to_string()));
            Ok(())
        }
    }

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

    #[test]
    fn reads_the_new_entry_first() {
        let store = FakeStore::with(&[(SERVICE, "new"), (LEGACY_SERVICE, "old")]);
        assert_eq!(get_from(&store), Ok(Some("new".to_string())));
        assert_eq!(store.stored(LEGACY_SERVICE), Some("old".to_string()));
    }

    #[test]
    fn no_key_under_either_name_is_none() {
        assert_eq!(get_from(&FakeStore::default()), Ok(None));
    }

    #[test]
    fn moves_a_pahub_key_under_the_new_name() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, "old")]);
        assert_eq!(get_from(&store), Ok(Some("old".to_string())));
        assert_eq!(store.stored(SERVICE), Some("old".to_string()));
        assert_eq!(store.stored(LEGACY_SERVICE), None);
    }

    #[test]
    fn a_failed_move_still_returns_the_key_and_keeps_the_old_entry() {
        let store = FakeStore {
            failing: vec![SERVICE],
            ..FakeStore::with(&[(LEGACY_SERVICE, "old")])
        };
        assert_eq!(get_from(&store), Ok(Some("old".to_string())));
        assert_eq!(store.stored(LEGACY_SERVICE), Some("old".to_string()));
    }

    #[test]
    fn saving_writes_the_new_entry_and_removes_the_old_one() {
        let store = FakeStore::with(&[(LEGACY_SERVICE, "old")]);
        assert_eq!(set_in(&store, " sk-new "), Ok(()));
        assert_eq!(store.stored(SERVICE), Some("sk-new".to_string()));
        assert_eq!(store.stored(LEGACY_SERVICE), None);
        assert_eq!(set_in(&store, " "), Err("api-key-empty".to_string()));
    }

    #[test]
    fn removing_clears_both_names() {
        let store = FakeStore::with(&[(SERVICE, "new"), (LEGACY_SERVICE, "old")]);
        assert_eq!(clear_in(&store), Ok(()));
        assert_eq!(store.stored(SERVICE), None);
        assert_eq!(store.stored(LEGACY_SERVICE), None);
        assert_eq!(clear_in(&store), Ok(()));
    }

    const ID: &str = "0b9f3c1e-5a7d-4e2b-9c8a-1d2e3f4a5b6c";

    #[test]
    fn a_machine_token_round_trips_under_its_own_account() {
        let store = FakeStore::default();
        assert_eq!(machine_token_get_from(&store, ID), Ok(None));
        assert_eq!(machine_token_set_in(&store, ID, "tok"), Ok(()));
        assert_eq!(
            machine_token_get_from(&store, ID),
            Ok(Some("tok".to_string()))
        );
        assert_eq!(
            store.stored_as(SERVICE, &format!("machine:{ID}")),
            Some("tok".to_string())
        );
        assert_eq!(machine_token_clear_in(&store, ID), Ok(()));
        assert_eq!(machine_token_get_from(&store, ID), Ok(None));
        assert_eq!(machine_token_clear_in(&store, ID), Ok(()));
    }

    #[test]
    fn an_invalid_machine_id_is_refused() {
        let store = FakeStore::default();
        for bad in [
            "",
            "../x",
            "ABCDEFAB-5a7d-4e2b-9c8a-1d2e3f4a5b6c",
            "short",
            "0b9f3c1e-5a7d-4e2b-9c8a-1d2e3f4a5b6c0",
        ] {
            let err = "machine-id-invalid".to_string();
            assert_eq!(machine_token_get_from(&store, bad), Err(err.clone()));
            assert_eq!(machine_token_set_in(&store, bad, "t"), Err(err.clone()));
            assert_eq!(machine_token_clear_in(&store, bad), Err(err));
        }
        assert!(store.entries.borrow().is_empty());
    }

    #[test]
    fn machine_tokens_leave_the_api_key_alone() {
        let store = FakeStore::with(&[(SERVICE, "sk-key")]);
        machine_token_set_in(&store, ID, "tok").unwrap();
        assert_eq!(get_from(&store), Ok(Some("sk-key".to_string())));
        machine_token_clear_in(&store, ID).unwrap();
        assert_eq!(get_from(&store), Ok(Some("sk-key".to_string())));
        clear_in(&store).unwrap();
        machine_token_set_in(&store, ID, "tok").unwrap();
        clear_in(&store).unwrap();
        assert_eq!(
            machine_token_get_from(&store, ID),
            Ok(Some("tok".to_string()))
        );
    }

    #[test]
    fn removing_reports_an_old_entry_it_could_not_remove() {
        let store = FakeStore {
            failing: vec![LEGACY_SERVICE],
            ..FakeStore::with(&[(SERVICE, "new"), (LEGACY_SERVICE, "old")])
        };
        assert!(clear_in(&store).is_err());
        assert_eq!(store.stored(SERVICE), None);
    }
}
