//! The machines this phone pairs with: `machines.*`, the same shapes and
//! errors as the service's `server/handlers/machines.ts`. Each machine's
//! token is a secret (`Secrets`, under [`token_key`]); the store keeps where
//! it is and its pin. The relays (Task 7) close when a machine moves or goes.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde_json::{Value, json};

use crate::methods::{LocalEvents, MethodError, Router, blocking, string_param};
use crate::pairing;
use crate::relay::{self, Relays};
use crate::secrets::Secrets;
use crate::store::{Store, StoredMachine};

/// A machine's listener port unless told otherwise (`REMOTE_PORT`).
pub const REMOTE_PORT: u16 = 47380;

/// The `Secrets` key of a machine's device token.
pub fn token_key(machine_id: &str) -> String {
    format!("machine-token:{machine_id}")
}

// ── params, as `machines.*` in `packages/protocol/src/methods.ts` ─────────

/// Length as JavaScript counts it (UTF-16 units), for zod's `min`/`max`.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// A trimmed string of 1 to `max` characters (`z.string().trim().min(1).max(max)`).
fn trimmed(p: &Value, name: &str, max: usize) -> Result<Option<String>, MethodError> {
    match p.get(name) {
        None => Ok(None),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() || js_len(t) > max {
                Err(MethodError::invalid(format!(
                    "{name}: 1 to {max} characters"
                )))
            } else {
                Ok(Some(t.to_string()))
            }
        }
        Some(_) => Err(MethodError::invalid(format!("{name}: expected a string"))),
    }
}

/// `MachineAddressSchema`: an IP address or a host name.
fn address(p: &Value) -> Result<Option<String>, MethodError> {
    let Some(a) = trimmed(p, "address", 253)? else {
        return Ok(None);
    };
    if a.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
    {
        Ok(Some(a))
    } else {
        Err(MethodError::invalid(
            "address: An IP address or a host name",
        ))
    }
}

/// `MachinePortSchema`: a whole number from 1 to 65535.
fn port(p: &Value) -> Result<Option<u16>, MethodError> {
    let Some(v) = p.get("port") else {
        return Ok(None);
    };
    let whole = v.as_u64().or_else(|| {
        v.as_f64()
            .filter(|f| f.fract() == 0.0 && *f >= 0.0)
            .map(|f| f as u64)
    });
    match whole {
        Some(n @ 1..=65535) => Ok(Some(n as u16)),
        _ => Err(MethodError::invalid("port: a whole number from 1 to 65535")),
    }
}

fn required<T>(v: Option<T>, name: &str) -> Result<T, MethodError> {
    v.ok_or_else(|| MethodError::invalid(format!("{name}: required")))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn internal<E>(_: E) -> MethodError {
    MethodError::internal()
}

#[derive(Clone)]
pub struct Machines {
    store: Arc<Store>,
    secrets: Arc<dyn Secrets>,
    events: LocalEvents,
    relays: Arc<Relays>,
}

impl Machines {
    pub fn new(
        store: Arc<Store>,
        secrets: Arc<dyn Secrets>,
        events: LocalEvents,
        relays: Arc<Relays>,
    ) -> Self {
        Machines {
            store,
            secrets,
            events,
            relays,
        }
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

    /// Tells the screens: `machines.changed` with the whole list.
    fn changed(&self) {
        self.events.emit("machines.changed", self.list());
    }

    fn known(&self, machine_id: &str) -> Result<StoredMachine, MethodError> {
        self.store
            .machines()
            .into_iter()
            .find(|m| m.id == machine_id)
            .ok_or_else(|| MethodError::new("NOT_FOUND", "No such machine"))
    }

    /// Refuses this phone itself and a machine already paired, before the code is sent.
    fn refuse(&self, machine: &Value) -> Result<(), MethodError> {
        let id = machine["id"].as_str().unwrap_or_default();
        if id == self.store.machine_id() {
            return Err(MethodError::new("PAIRING_SELF", "This is this machine"));
        }
        if let Some(existing) = self.store.machines().into_iter().find(|m| m.id == id) {
            return Err(MethodError::new(
                "PAIRING_DUPLICATE",
                format!("Already paired as {}", existing.name),
            ));
        }
        Ok(())
    }

    async fn pair(&self, p: Value) -> Result<Value, MethodError> {
        let address = required(address(&p)?, "address")?;
        let port = port(&p)?.unwrap_or(REMOTE_PORT);
        let code = string_param(&p, "code")?.to_string();
        if js_len(&code) > 64 {
            return Err(MethodError::invalid("code: at most 64 characters"));
        }
        let device_name = required(trimmed(&p, "deviceName", 60)?, "deviceName")?;

        let me = self.clone();
        let paired =
            pairing::pair(&address, port, &code, &device_name, move |m| me.refuse(m)).await?;
        // Checked again: another pairing with the same machine may have finished meanwhile.
        if let Err(e) = self.refuse(&paired.machine) {
            self.give_back(&address, port, &paired);
            return Err(e);
        }
        let id = paired.machine["id"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let stored = StoredMachine {
            id: id.clone(),
            name: paired.machine["name"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            address: address.clone(),
            port,
            fingerprint: paired.peer.fingerprint.clone(),
            cert_der: base64::engine::general_purpose::STANDARD.encode(&paired.peer.cert_der),
            device_id: paired.device_id.clone(),
            added_at: now_ms(),
        };
        // The token as a secret first, then the machine: a machine is never stored without it.
        let (me, token) = (self.clone(), paired.token.clone());
        let kept = blocking(move || {
            me.secrets
                .set(&token_key(&stored.id), &token)
                .map_err(internal)?;
            if me.store.put_machine(stored.clone()).is_err() {
                let _ = me.secrets.delete(&token_key(&stored.id));
                return Err(MethodError::internal());
            }
            Ok(())
        })
        .await;
        if let Err(e) = kept {
            // Unusable without its token here: the machine is asked to forget this phone too.
            self.give_back(&address, port, &paired);
            return Err(e);
        }
        self.changed();
        let machine = self.listed(&self.known(&id)?);
        Ok(json!({ "machine": machine, "token": paired.token }))
    }

    /// Pairing went through on the machine but can't be kept here: it revokes the new device.
    fn give_back(&self, address: &str, port: u16, paired: &pairing::Paired) {
        let (address, pin) = (address.to_string(), paired.peer.fingerprint.clone());
        let (token, device_id) = (paired.token.clone(), paired.device_id.clone());
        tokio::spawn(async move {
            pairing::unpair(&address, port, &pin, &token, &device_id).await;
        });
    }

    fn update(&self, p: &Value) -> Result<Value, MethodError> {
        let mut m = self.known(string_param(p, "machineId")?)?;
        let (name, address, port) = (trimmed(p, "name", 40)?, address(p)?, port(p)?);
        let was = (m.address.clone(), m.port);
        m.name = name.unwrap_or(m.name);
        m.address = address.unwrap_or(m.address);
        m.port = port.unwrap_or(m.port);
        // Its pin stays.
        self.store.put_machine(m.clone()).map_err(internal)?;
        // Relays to the old address end; the screens reconnect to the new one (same pin).
        if (m.address.clone(), m.port) != was {
            self.relays.drop_machine(&m.id, relay::UNREACHABLE);
        }
        self.changed();
        Ok(self.listed(&m))
    }

    /// Forgets the machine, its token first, then asks it to revoke this
    /// phone if `revoke` and it can be reached (a failure is ignored).
    async fn remove(&self, p: Value) -> Result<Value, MethodError> {
        let machine_id = string_param(&p, "machineId")?.to_string();
        let Some(revoke) = p.get("revoke").and_then(Value::as_bool) else {
            return Err(MethodError::invalid("revoke: expected true or false"));
        };
        let Ok(machine) = self.known(&machine_id) else {
            return Ok(json!({ "revoked": false }));
        };
        let me = self.clone();
        let token = blocking(move || {
            let token = me.secrets.get(&token_key(&machine_id)).ok().flatten();
            me.secrets
                .delete(&token_key(&machine_id))
                .map_err(internal)?;
            me.store.remove_machine(&machine_id).map_err(internal)?;
            Ok(token)
        })
        .await?;
        // Forgotten, token included, before its relays close: one opened now finds nothing (4404).
        self.relays.drop_machine(&machine.id, relay::LOCKED);
        self.changed();
        let revoked = match (revoke, token) {
            (true, Some(token)) => {
                pairing::unpair(
                    &machine.address,
                    machine.port,
                    &machine.fingerprint,
                    &token,
                    &machine.device_id,
                )
                .await
            }
            _ => false,
        };
        Ok(json!({ "revoked": revoked }))
    }

    pub fn register(&self, router: &mut Router) {
        let m = self.clone();
        router.answer("machines.list", move |_| Ok(m.list()));
        router.in_order("machines.list");
        let m = self.clone();
        router.register("machines.pair", move |p| {
            let m = m.clone();
            async move { m.pair(p).await }
        });
        // The core reads tokens itself, so a handed-over one changes nothing: accepted for a known machine.
        let m = self.clone();
        router.answer("machines.unlock", move |p| {
            let token = string_param(&p, "token")?;
            if token.len() != 64
                || !token
                    .bytes()
                    .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            {
                return Err(MethodError::invalid("token: a device token"));
            }
            m.known(string_param(&p, "machineId")?)?;
            Ok(json!({}))
        });
        let m = self.clone();
        router.answer_blocking("machines.update", move |p| m.update(&p));
        let m = self.clone();
        router.register("machines.remove", move |p| {
            let m = m.clone();
            async move { m.remove(p).await }
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
        (
            dir,
            Machines::new(
                store.clone(),
                secrets.clone(),
                LocalEvents::default(),
                Arc::new(Relays::new(
                    store,
                    secrets.clone(),
                    crate::Timing::default(),
                    tokio::sync::broadcast::channel(1).0,
                )),
            ),
            secrets,
        )
    }

    fn desk() -> StoredMachine {
        StoredMachine {
            id: "m1".into(),
            name: "Desk".into(),
            address: "192.0.2.10".into(),
            port: 47380,
            fingerprint: "AB:CD".into(),
            cert_der: String::new(),
            device_id: "d1".into(),
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
    fn an_unknown_machine_is_not_found() {
        let (_dir, m, _) = machines();
        assert_eq!(m.known("nope").unwrap_err().code, "NOT_FOUND");
    }

    #[test]
    fn params_are_read_as_the_protocol_has_them() {
        assert_eq!(
            address(&json!({ "address": " desk.local " })),
            Ok(Some("desk.local".into()))
        );
        assert_eq!(
            address(&json!({ "address": "fe80::1" })),
            Ok(Some("fe80::1".into()))
        );
        assert!(address(&json!({ "address": "a b" })).is_err());
        assert!(address(&json!({ "address": "" })).is_err());
        assert_eq!(port(&json!({ "port": 47380.0 })), Ok(Some(47380)));
        assert!(port(&json!({ "port": 65536 })).is_err());
        assert!(port(&json!({ "port": 1.5 })).is_err());
        assert_eq!(
            trimmed(&json!({ "name": "  Study " }), "name", 40),
            Ok(Some("Study".into()))
        );
        assert!(trimmed(&json!({ "name": "   " }), "name", 40).is_err());
    }
}
