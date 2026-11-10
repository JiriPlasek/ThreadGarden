//! The machines this phone pairs with: `machines.*`, the same shapes and
//! errors as the service's `server/handlers/machines.ts`. Each machine's
//! token is a secret (`Secrets`, under [`token_key`]); the store keeps where
//! it is and its pin. The relays (Task 7) close when a machine moves or goes.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde_json::{Value, json};

use crate::alerts::Alerts;
use crate::methods::{LocalEvents, MethodError, Router, blocking, string_param};
use crate::pairing;
use crate::power::Power;
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

fn not_found() -> MethodError {
    MethodError::new("NOT_FOUND", "No such machine")
}

fn duplicate(name: &str) -> MethodError {
    MethodError::new("PAIRING_DUPLICATE", format!("Already paired as {name}"))
}

#[derive(Clone)]
pub struct Machines {
    store: Arc<Store>,
    secrets: Arc<dyn Secrets>,
    events: LocalEvents,
    relays: Arc<Relays>,
    /// The machines' alert links: started on pairing, moved and stopped with them.
    alerts: Arc<Alerts>,
    /// The machines' plugs: forgotten with them.
    power: Power,
    /// All of pairing, closing included (`Timing::pairing`).
    pairing_timeout: Duration,
    /// The machines whose token `Secrets` holds, kept here so listing never
    /// calls the keystore (on Android, a Keystore call) on the runtime.
    unlocked: Arc<Mutex<HashSet<String>>>,
    /// Held while a machine's token and record change together (pairing,
    /// removing), so two of them can't mix one machine's device id with
    /// another pairing's token. Only on blocking threads.
    saving: Arc<Mutex<()>>,
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Machines {
    /// Reads which stored machines have a token, once, here (the core starts
    /// off the runtime's threads, or before any screen waits on it).
    pub fn new(
        store: Arc<Store>,
        secrets: Arc<dyn Secrets>,
        events: LocalEvents,
        relays: Arc<Relays>,
        alerts: Arc<Alerts>,
        power: Power,
        pairing_timeout: Duration,
    ) -> Self {
        let unlocked = store
            .machines()
            .into_iter()
            .filter(|m| matches!(secrets.get(&token_key(&m.id)), Ok(Some(_))))
            .map(|m| m.id)
            .collect();
        Machines {
            store,
            secrets,
            events,
            relays,
            alerts,
            power,
            pairing_timeout,
            unlocked: Arc::new(Mutex::new(unlocked)),
            saving: Arc::new(Mutex::new(())),
        }
    }

    /// A machine as the protocol lists it (`PairedMachineSchema`). `unlocked`:
    /// the core holds its token (it reads tokens itself; nothing hands them over).
    fn listed(&self, m: &StoredMachine) -> Value {
        let unlocked = locked(&self.unlocked).contains(&m.id);
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
            .ok_or_else(not_found)
    }

    /// Refuses this phone itself and a machine already paired, before the code is sent.
    fn refuse(&self, machine: &Value) -> Result<(), MethodError> {
        let id = machine["id"].as_str().unwrap_or_default();
        if id == self.store.machine_id() {
            return Err(MethodError::new("PAIRING_SELF", "This is this machine"));
        }
        match self.store.machines().into_iter().find(|m| m.id == id) {
            Some(existing) => Err(duplicate(&existing.name)),
            None => Ok(()),
        }
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
        let paired = pairing::pair(
            &address,
            port,
            &code,
            &device_name,
            self.pairing_timeout,
            move |m| me.refuse(m),
        )
        .await?;
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
        let (me, token) = (self.clone(), paired.token.clone());
        let kept = blocking(move || {
            let _one_at_a_time = locked(&me.saving);
            // Checked again, now that no other pairing or removal can run:
            // another pairing with the same machine may have finished
            // meanwhile, and its token must not be overwritten.
            if let Some(existing) = me.store.machines().into_iter().find(|m| m.id == stored.id) {
                return Err(duplicate(&existing.name));
            }
            // The token as a secret first, then the machine: a machine is never stored without it.
            let key = token_key(&stored.id);
            me.secrets.set(&key, &token).map_err(internal)?;
            match me.store.add_machine(stored.clone()) {
                Ok(true) => {
                    locked(&me.unlocked).insert(stored.id.clone());
                    Ok(())
                }
                // Not possible while `saving` is held (only pairing adds); refused all the same.
                Ok(false) => Err(duplicate(&stored.name)),
                Err(_) => {
                    let _ = me.secrets.delete(&key);
                    Err(MethodError::internal())
                }
            }
        })
        .await;
        if let Err(e) = kept {
            // Unusable here: the machine is asked to forget the device it just made.
            self.give_back(&address, port, &paired);
            return Err(e);
        }
        self.alerts.start(&id);
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
        let id = string_param(p, "machineId")?;
        let (name, address, port) = (trimmed(p, "name", 40)?, address(p)?, port(p)?);
        let mut moved = false;
        // Checked and changed in one store change: a machine removed meanwhile stays removed.
        let m = self
            .store
            .update_machine(id, |m| {
                let was = (m.address.clone(), m.port);
                if let Some(name) = name {
                    m.name = name;
                }
                if let Some(address) = address {
                    m.address = address;
                }
                if let Some(port) = port {
                    m.port = port;
                }
                // Its pin stays.
                moved = (m.address.clone(), m.port) != was;
            })
            .map_err(internal)?
            .ok_or_else(not_found)?;
        // Relays to the old address end; the screens reconnect to the new one (same pin).
        if moved {
            self.relays.drop_machine(&m.id, relay::UNREACHABLE);
            self.alerts.restart(&m.id);
        }
        self.changed();
        Ok(self.listed(&m))
    }

    /// Forgets the machine, its token first, then asks it to revoke this
    /// phone if `revoke` and it can be reached (a failure is ignored). If the
    /// store can't be written, the token is put back and nothing is revoked:
    /// the machine stays paired as it was, so removing it again still works.
    async fn remove(&self, p: Value) -> Result<Value, MethodError> {
        let machine_id = string_param(&p, "machineId")?.to_string();
        let Some(revoke) = p.get("revoke").and_then(Value::as_bool) else {
            return Err(MethodError::invalid("revoke: expected true or false"));
        };
        let me = self.clone();
        let forgotten = blocking(move || {
            let _one_at_a_time = locked(&me.saving);
            let Some(machine) = me.store.machines().into_iter().find(|m| m.id == machine_id) else {
                return Ok(None);
            };
            let key = token_key(&machine_id);
            let token = me.secrets.get(&key).ok().flatten();
            me.secrets.delete(&key).map_err(internal)?;
            locked(&me.unlocked).remove(&machine_id);
            if me.store.remove_machine(&machine_id).is_err() {
                if let Some(token) = &token
                    && me.secrets.set(&key, token).is_ok()
                {
                    locked(&me.unlocked).insert(machine_id.clone());
                }
                return Err(MethodError::internal());
            }
            // Its plug goes with it, the password too.
            me.power.forget(&machine_id);
            Ok(Some((machine, token)))
        })
        .await?;
        let Some((machine, token)) = forgotten else {
            return Ok(json!({ "revoked": false }));
        };
        // Forgotten, token included, before its relays close: one opened now finds nothing (4404).
        self.relays.drop_machine(&machine.id, relay::LOCKED);
        self.alerts.stop(&machine.id);
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
        let alerts = crate::alerts::for_tests(dir.path());
        let store_for_power = store.clone();
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
                alerts,
                Power::new(store_for_power, secrets.clone(), Duration::ZERO),
                Duration::from_secs(10),
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
        m.store.add_machine(desk()).unwrap();
        assert_eq!(m.list()[0]["unlocked"], false);
        // Read from `Secrets` when the core starts; kept in memory after that.
        secrets.set(&token_key("m1"), "t").unwrap();
        let m = Machines::new(
            m.store.clone(),
            secrets.clone(),
            LocalEvents::default(),
            m.relays.clone(),
            m.alerts.clone(),
            m.power.clone(),
            Duration::from_secs(10),
        );
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
