//! The machines this phone pairs with: `machines.*`, the same shapes as the
//! service's. This starts with what needs no network: the list, unlock and
//! remove. Pairing (`machines.pair`, proof before code) and `machines.update`
//! come with Task 6, the relays with Task 7.

use std::sync::Arc;

use serde_json::{Value, json};

use crate::methods::{MethodError, Router, string_param};
use crate::secrets::Secrets;
use crate::store::{Store, StoredMachine};

/// The `Secrets` key of a machine's device token.
pub fn token_key(machine_id: &str) -> String {
    format!("machine-token:{machine_id}")
}

#[derive(Clone)]
pub struct Machines {
    store: Arc<Store>,
    secrets: Arc<dyn Secrets>,
}

impl Machines {
    pub fn new(store: Arc<Store>, secrets: Arc<dyn Secrets>) -> Self {
        Machines { store, secrets }
    }

    /// A machine as the protocol lists it (`PairedMachineSchema`). `unlocked`:
    /// the core holds its token (it reads tokens itself; nothing hands them over).
    fn listed(&self, m: &StoredMachine) -> Value {
        let unlocked = matches!(self.secrets.get(&token_key(&m.id)), Ok(Some(_)));
        json!({
            "id": m.id,
            "name": m.name,
            "address": m.address,
            "port": m.port,
            "fingerprint": m.fingerprint,
            "addedAt": m.added_at,
            "unlocked": unlocked,
        })
    }

    pub fn list(&self) -> Value {
        Value::Array(
            self.store
                .machines()
                .iter()
                .map(|m| self.listed(m))
                .collect(),
        )
    }

    fn known(&self, machine_id: &str) -> Result<StoredMachine, MethodError> {
        self.store
            .machines()
            .into_iter()
            .find(|m| m.id == machine_id)
            .ok_or_else(|| MethodError::new("NOT_FOUND", "No such machine"))
    }

    /// Forgets the machine, its token first; Task 6 then asks it to revoke this phone.
    fn remove(&self, machine_id: &str) -> Result<Value, MethodError> {
        if self.known(machine_id).is_err() {
            return Ok(json!({ "revoked": false }));
        }
        self.secrets
            .delete(&token_key(machine_id))
            .map_err(|_| MethodError::internal())?;
        self.store
            .remove_machine(machine_id)
            .map_err(|_| MethodError::internal())?;
        Ok(json!({ "revoked": false }))
    }

    pub fn register(&self, router: &mut Router) {
        let m = self.clone();
        router.answer("machines.list", move |_| Ok(m.list()));
        router.in_order("machines.list");
        // The core reads tokens itself, so a handed-over one changes nothing: accepted for a known machine.
        let m = self.clone();
        router.answer("machines.unlock", move |p| {
            m.known(string_param(&p, "machineId")?)?;
            Ok(json!({}))
        });
        // `machines.update` comes with pairing: a move closes the machine's relays.
        let m = self.clone();
        router.answer_blocking("machines.remove", move |p| {
            m.remove(string_param(&p, "machineId")?)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemorySecrets;

    fn machines() -> (tempfile::TempDir, Machines, Arc<MemorySecrets>) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(dir.path()).unwrap());
        let secrets = Arc::new(MemorySecrets::default());
        (dir, Machines::new(store, secrets.clone()), secrets)
    }

    fn desk() -> StoredMachine {
        StoredMachine {
            id: "m1".into(),
            name: "Desk".into(),
            address: "192.0.2.10".into(),
            port: 47380,
            fingerprint: "AB:CD".into(),
            added_at: 7,
        }
    }

    #[test]
    fn a_machine_is_listed_unlocked_once_its_token_is_kept() {
        let (_dir, m, secrets) = machines();
        assert_eq!(m.list(), json!([]));
        m.store.put_machine(desk()).unwrap();
        assert_eq!(m.list()[0]["unlocked"], false);
        secrets.set(&token_key("m1"), "t").unwrap();
        assert_eq!(
            m.list(),
            json!([{ "id": "m1", "name": "Desk", "address": "192.0.2.10", "port": 47380,
                     "fingerprint": "AB:CD", "addedAt": 7, "unlocked": true }])
        );
    }

    #[test]
    fn removing_forgets_the_machine_and_its_token() {
        let (_dir, m, secrets) = machines();
        m.store.put_machine(desk()).unwrap();
        secrets.set(&token_key("m1"), "t").unwrap();
        assert_eq!(m.remove("m1"), Ok(json!({ "revoked": false })));
        assert_eq!(secrets.get(&token_key("m1")), Ok(None));
        assert_eq!(m.list(), json!([]));
        assert_eq!(m.remove("m1"), Ok(json!({ "revoked": false })));
    }

    #[test]
    fn an_unknown_machine_is_not_found() {
        let (_dir, m, _) = machines();
        assert_eq!(m.known("nope").unwrap_err().code, "NOT_FOUND");
    }
}
