//! Turn on a machine through its plug, from the phone: the plug details the
//! owner typed here (`power.configure`), the password in `Secrets` only, and
//! the rules of the desktop's `power/hub.ts`:
//!
//! - a fresh reading first, every time;
//! - a plug that's on and drawing power (at least `offWatts`) is left alone:
//!   the machine runs;
//! - on but below `offWatts` (standby), with a reading at most 5 s old, it's
//!   cycled: off, the minimum off time, on (a PC set to power on after a cut
//!   boots from that); an older reading never drives a cut;
//! - off: on, once the minimum off time since the last cut is over (the
//!   phone's own cuts, and the desktop rule's `Mem11` when the bridge has it);
//! - one operation at a time per machine: a second Turn on gets the first's
//!   answer, and one waiting out the off time gets that wait.
//!
//! The waits are the switch's own (`Backlog …;Delay …;on`), so a phone that
//! goes away meanwhile can't leave a machine without power. No rule is ever
//! installed, no `power.adopt` sent, and nothing is polled: a reading happens
//! when a screen asks (kept 3 s).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use serde_json::{Value, json};

use crate::methods::{MethodError, Router, blocking, string_param};
use crate::secrets::Secrets;
use crate::store::Store;
use crate::tasmota::{self, AUTH, NOT_CONFIGURED, NOT_TASMOTA, UNREACHABLE, field};

/// How long a reading answers again before the plug is asked anew.
const READING_TTL_MS: u64 = 3000;
/// A standby reading older than this (seconds) never drives a cycle.
const FRESH_READING_S: u64 = 5;
/// Tasmota's longest `Delay`, in tenths of a second.
const MAX_DELAY: u64 = 3600;

/// The `Secrets` key of a machine's plug password.
pub fn password_key(machine_id: &str) -> String {
    format!("plug-password:{machine_id}")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn not_configured() -> MethodError {
    MethodError::new(
        NOT_CONFIGURED,
        "No power switch is set up for this machine.",
    )
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A whole number as an integer (so `5.0` lists as `5`, as JavaScript would).
fn number(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        json!(v as i64)
    } else {
        json!(v)
    }
}

/// The Zigbee names Tasmota takes in a command (`isZigbeeName`).
fn is_zigbee_name(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A plug's settings, as `PowerConfigSchema` reads them (defaults filled in).
#[derive(Clone, Debug, PartialEq)]
pub struct PlugConfig {
    pub zigbee: bool,
    pub address: String,
    pub device: Option<String>,
    pub off_watts: f64,
    pub min_off_seconds: u64,
    pub measured: (Option<f64>, Option<f64>),
}

impl PlugConfig {
    /// `PowerConfigSchema`: the details as typed, checked, with the protocol's defaults.
    pub fn read(v: &Value) -> Result<PlugConfig, MethodError> {
        let bad = |why: &str| MethodError::invalid(format!("config: {why}"));
        let zigbee = match v["kind"].as_str() {
            Some("tasmota-zigbee") => true,
            Some("tasmota-plug") => false,
            _ => return Err(bad("kind is tasmota-zigbee or tasmota-plug")),
        };
        let address = v["address"]
            .as_str()
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if !tasmota::is_address(&address) {
            return Err(bad(
                "an address (an IP address or a host name, maybe with a port)",
            ));
        }
        let device = match &v["device"] {
            Value::Null => None,
            Value::String(d) => Some(d.trim().to_string()),
            _ => return Err(bad("device is a name or null")),
        };
        if zigbee && !device.as_deref().is_some_and(is_zigbee_name) {
            return Err(MethodError::new(
                NOT_CONFIGURED,
                "The Zigbee plug's name can only use letters, digits, '.', '_' and '-'",
            ));
        }
        let off_watts = match &v["offWatts"] {
            Value::Null => 5.0,
            w => w
                .as_f64()
                .filter(|w| (0.5..=100.0).contains(w))
                .ok_or_else(|| bad("offWatts from 0.5 to 100"))?,
        };
        let min_off_seconds = match &v["minOffSeconds"] {
            Value::Null => 90,
            m => m
                .as_f64()
                .filter(|m| m.fract() == 0.0 && (10.0..=600.0).contains(m))
                .map(|m| m as u64)
                .ok_or_else(|| bad("minOffSeconds a whole number from 10 to 600"))?,
        };
        let reading = |k: &str| -> Result<Option<f64>, MethodError> {
            match &v["measured"][k] {
                Value::Null => Ok(None),
                w => w
                    .as_f64()
                    .map(Some)
                    .ok_or_else(|| bad("measured watts are numbers or null")),
            }
        };
        let measured = (reading("running")?, reading("standby")?);
        Ok(PlugConfig {
            zigbee,
            address,
            device: if zigbee { device } else { None },
            off_watts,
            min_off_seconds,
            measured,
        })
    }

    /// As the protocol lists it.
    pub fn to_json(&self) -> Value {
        json!({
            "kind": if self.zigbee { "tasmota-zigbee" } else { "tasmota-plug" },
            "address": self.address,
            "device": self.device,
            "offWatts": number(self.off_watts),
            "minOffSeconds": self.min_off_seconds,
            "measured": {
                "running": self.measured.0.map(number),
                "standby": self.measured.1.map(number),
            },
        })
    }

    fn device(&self) -> &str {
        self.device.as_deref().unwrap_or_default()
    }

    /// `commandsFor` of `power/rules.ts`.
    fn on(&self) -> String {
        if self.zigbee {
            format!(
                r#"ZbSend {{"Device":"{}","Send":{{"Power":1}}}}"#,
                self.device()
            )
        } else {
            "Power 1".into()
        }
    }

    fn off(&self) -> String {
        if self.zigbee {
            format!(
                r#"ZbSend {{"Device":"{}","Send":{{"Power":0}}}}"#,
                self.device()
            )
        } else {
            "Power 0".into()
        }
    }
}

/// `Delay` commands that wait `ms` on the switch (each at most `MAX_DELAY`).
fn delays(ms: u64) -> Vec<String> {
    let mut tenths = ms.div_ceil(100);
    let mut out = Vec::new();
    while tenths > 0 {
        let d = tenths.min(MAX_DELAY);
        out.push(format!("Delay {d}"));
        tenths -= d;
    }
    out
}

type Answer = Result<Value, MethodError>;

#[derive(Clone)]
pub struct Power {
    store: Arc<Store>,
    secrets: Arc<dyn Secrets>,
    read_wait: Duration,
    /// Turn ons under way, by machine: a second caller gets the first's answer.
    inflight: Arc<Mutex<HashMap<String, Shared<BoxFuture<'static, Answer>>>>>,
    /// A Turn on waiting out the off time on the switch: its answer until then.
    pending: Arc<Mutex<HashMap<String, (Value, u64)>>>,
    /// The last reading of each plug, and when.
    cache: Arc<Mutex<HashMap<String, (Value, u64)>>>,
}

impl Power {
    pub fn new(store: Arc<Store>, secrets: Arc<dyn Secrets>, read_wait: Duration) -> Self {
        Power {
            store,
            secrets,
            read_wait,
            inflight: Arc::default(),
            pending: Arc::default(),
            cache: Arc::default(),
        }
    }

    fn config(&self, machine_id: &str) -> Option<PlugConfig> {
        self.store
            .plug(machine_id)
            .and_then(|p| PlugConfig::read(&p).ok())
    }

    /// The config and the password, or POWER_NOT_CONFIGURED.
    async fn ready(&self, machine_id: &str) -> Result<(PlugConfig, String), MethodError> {
        let config = self.config(machine_id).ok_or_else(not_configured)?;
        let (secrets, key) = (self.secrets.clone(), password_key(machine_id));
        let password = blocking(move || Ok(secrets.get(&key).ok().flatten()))
            .await?
            .ok_or_else(not_configured)?;
        Ok((config, password))
    }

    fn forget_state(&self, machine_id: &str) {
        locked(&self.pending).remove(machine_id);
        locked(&self.cache).remove(machine_id);
    }

    /// Forgets a machine's plug (it was removed): details and password.
    pub fn forget(&self, machine_id: &str) {
        self.forget_state(machine_id);
        let _ = self.store.set_plug(machine_id, None);
        let _ = self.secrets.delete(&password_key(machine_id));
    }

    /// `power.configure {machineId, config | null, password?}`: the plug details typed on the phone.
    async fn configure(&self, p: Value) -> Answer {
        let machine_id = string_param(&p, "machineId")?.to_string();
        if self
            .store
            .machines()
            .into_iter()
            .all(|m| m.id != machine_id)
        {
            return Err(MethodError::new("NOT_FOUND", "No such machine"));
        }
        if p["config"].is_null() {
            let me = self.clone();
            blocking(move || {
                me.forget(&machine_id);
                Ok(Value::Null)
            })
            .await?;
            return Ok(Value::Null);
        }
        let config = PlugConfig::read(&p["config"])?;
        let typed = match &p["password"] {
            Value::Null => None,
            Value::String(s) => Some(s.clone()),
            _ => return Err(MethodError::invalid("password: expected a string")),
        };
        let (secrets, key) = (self.secrets.clone(), password_key(&machine_id));
        let password = match typed {
            Some(p) => p,
            None => blocking(move || Ok(secrets.get(&key).ok().flatten()))
                .await?
                .ok_or_else(|| {
                    MethodError::new(
                        NOT_CONFIGURED,
                        "The switch password is needed to set this up.",
                    )
                })?,
        };
        // The password checked now, so a typo says so here. An unreachable
        // switch is kept all the same (the phone may be away from home).
        match tasmota::command(&config.address, &password, "Status 2").await {
            Ok(_) => {}
            Err(e) if e.code == AUTH || e.code == NOT_TASMOTA => return Err(e),
            Err(_) => {}
        }
        let (me, id, stored) = (self.clone(), machine_id.clone(), config.to_json());
        blocking(move || {
            me.secrets
                .set(&password_key(&id), &password)
                .map_err(|_| MethodError::internal())?;
            me.store
                .set_plug(&id, Some(stored))
                .map_err(|_| MethodError::internal())?;
            Ok(())
        })
        .await?;
        self.forget_state(&machine_id);
        Ok(config.to_json())
    }

    fn list(&self) -> Value {
        let mut all: Vec<(String, PlugConfig)> = self
            .store
            .plugs()
            .into_iter()
            .filter_map(|(id, v)| PlugConfig::read(&v).ok().map(|c| (id, c)))
            .collect();
        all.sort_by(|a, b| a.0.cmp(&b.0));
        Value::Array(
            all.into_iter()
                .map(|(id, c)| json!({ "machineId": id, "config": c.to_json() }))
                .collect(),
        )
    }

    /// Asks the plug to report, then reads it: `{on, watts, at, age}`.
    async fn read_plug(&self, config: &PlugConfig, password: &str) -> Answer {
        let read = if config.zigbee {
            format!(
                r#"ZbSend {{"Device":"{}","Read":{{"ActivePower":true}}}}"#,
                config.device()
            )
        } else {
            "Status 8".into()
        };
        tasmota::command(&config.address, password, &read).await?;
        if !self.read_wait.is_zero() {
            tokio::time::sleep(self.read_wait).await;
        }
        let (mut on, mut watts, mut age) = (Value::Null, Value::Null, json!(0));
        if config.zigbee {
            // A bridge answers from what it last heard: how old that is matters.
            age = Value::Null;
            let st = tasmota::command(
                &config.address,
                password,
                &format!("ZbStatus3 {}", config.device()),
            )
            .await?;
            if let Some(d) = field(&st, "ZbStatus3").and_then(|v| v.get(0)) {
                if let Some(p) = d["Power"].as_u64() {
                    on = json!(p == 1);
                }
                if let Some(w) = d["ActivePower"].as_f64() {
                    watts = json!(w);
                }
                if let Some(s) = d["LastSeen"].as_u64() {
                    age = json!(s);
                }
            }
        } else {
            let sns = tasmota::command(&config.address, password, "Status 8").await?;
            if let Some(w) = field(&sns, "StatusSNS").and_then(|s| s["ENERGY"]["Power"].as_f64()) {
                watts = json!(w);
            }
            let power = tasmota::command(&config.address, password, "Power").await?;
            if let Some(p) = field(&power, "POWER").and_then(Value::as_str) {
                on = json!(p.eq_ignore_ascii_case("ON"));
            }
        }
        Ok(json!({ "on": on, "watts": watts, "at": now_ms(), "age": age }))
    }

    async fn reading(&self, machine_id: &str) -> Answer {
        if let Some((r, at)) = locked(&self.cache).get(machine_id).cloned()
            && now_ms().saturating_sub(at) < READING_TTL_MS
        {
            return Ok(r);
        }
        let (config, password) = self.ready(machine_id).await?;
        let reading = self.read_plug(&config, &password).await?;
        locked(&self.cache).insert(machine_id.to_string(), (reading.clone(), now_ms()));
        Ok(reading)
    }

    /// One Turn on per machine at a time.
    async fn turn_on(&self, machine_id: String) -> Answer {
        if let Some((answer, until)) = locked(&self.pending).get(&machine_id).cloned()
            && now_ms() < until
        {
            return Ok(answer);
        }
        let run = {
            let mut inflight = locked(&self.inflight);
            match inflight.get(&machine_id) {
                Some(run) => run.clone(),
                None => {
                    let me = self.clone();
                    let id = machine_id.clone();
                    let run = async move {
                        let answer = me.do_turn_on(&id).await;
                        locked(&me.inflight).remove(&id);
                        answer
                    }
                    .boxed()
                    .shared();
                    inflight.insert(machine_id.clone(), run.clone());
                    run
                }
            }
        };
        run.await
    }

    async fn do_turn_on(&self, machine_id: &str) -> Answer {
        let (config, password) = self.ready(machine_id).await?;
        let min_off_ms = config.min_off_seconds * 1000;
        locked(&self.cache).remove(machine_id);
        let reading = self.read_plug(&config, &password).await?;
        let Some(on) = reading["on"].as_bool() else {
            return Err(MethodError::new(
                UNREACHABLE,
                "The switch didn't report whether the plug is on.",
            ));
        };
        let (address, pw) = (config.address.clone(), password.clone());
        let send = move |cmnds: Vec<String>| {
            let backlog = format!("Backlog {}", cmnds.join(";"));
            let (address, pw) = (address.clone(), pw.clone());
            async move { tasmota::command(&address, &pw, &backlog).await.map(|_| ()) }
        };
        if on {
            let standby = reading["watts"]
                .as_f64()
                .is_some_and(|w| w < config.off_watts);
            if !standby {
                // Drawing power (or no meter to say otherwise): the machine runs.
                return Ok(json!({ "cycled": false, "waitMs": 0 }));
            }
            // A stale standby reading would cut a PC just started by hand.
            if !reading["age"]
                .as_u64()
                .is_some_and(|a| a <= FRESH_READING_S)
            {
                return Err(MethodError::new(
                    UNREACHABLE,
                    "Couldn't get a fresh reading from the plug; try again.",
                ));
            }
            // Standby: off, the minimum off time, on, all on the switch.
            let mut cmnds = vec![config.off()];
            cmnds.extend(delays(min_off_ms));
            cmnds.push(config.on());
            send(cmnds).await?;
            self.note_cut(machine_id).await;
            let answer = json!({ "cycled": true, "waitMs": min_off_ms });
            locked(&self.pending).insert(
                machine_id.to_string(),
                (answer.clone(), now_ms() + min_off_ms),
            );
            return Ok(answer);
        }
        let cut = self.last_cut(machine_id, &config, &password).await;
        let wait = cut.map_or(0, |c| (c + min_off_ms).saturating_sub(now_ms()));
        if wait == 0 {
            tasmota::command(&config.address, &password, &config.on()).await?;
            return Ok(json!({ "cycled": false, "waitMs": 0 }));
        }
        let mut cmnds = delays(wait);
        cmnds.push(config.on());
        send(cmnds).await?;
        let answer = json!({ "cycled": false, "waitMs": wait });
        locked(&self.pending).insert(machine_id.to_string(), (answer.clone(), now_ms() + wait));
        Ok(answer)
    }

    /// The phone's own cut, kept with the plug (it outlives a restart).
    async fn note_cut(&self, machine_id: &str) {
        let (store, id) = (self.store.clone(), machine_id.to_string());
        let _ = blocking(move || {
            store
                .set_plug_cut(&id, now_ms())
                .map_err(|_| MethodError::internal())
        })
        .await;
    }

    /// The last cut (Unix ms): the phone's, or the desktop rule's `Mem11` when
    /// the bridge has Threadgarden's rule (read, never written). Unknown: none.
    async fn last_cut(&self, machine_id: &str, config: &PlugConfig, password: &str) -> Option<u64> {
        let ours = self.store.plug_cut(machine_id);
        let mut theirs = None;
        for slot in 1..=3 {
            let Ok(rule) =
                tasmota::command(&config.address, password, &format!("Rule{slot}")).await
            else {
                break;
            };
            let text = field(&rule, &format!("Rule{slot}"))
                .and_then(|r| r["Rules"].as_str())
                .unwrap_or_default();
            if text.contains("Event#tga do") {
                if let Ok(mem) = tasmota::command(&config.address, password, "Mem11").await {
                    let secs = field(&mem, "Mem11").and_then(|v| match v {
                        Value::String(s) => s.trim().parse::<u64>().ok(),
                        v => v.as_u64(),
                    });
                    theirs = secs.filter(|s| *s > 0).map(|s| s * 1000);
                }
                break;
            }
        }
        ours.max(theirs)
    }

    fn note_measurement(&self, p: &Value) -> Answer {
        let machine_id = string_param(p, "machineId")?;
        let mut config = self.config(machine_id).ok_or_else(not_configured)?;
        let watts = p["watts"]
            .as_f64()
            .ok_or_else(|| MethodError::invalid("watts: expected a number"))?;
        match p["kind"].as_str() {
            Some("running") => config.measured.0 = Some(watts),
            Some("standby") => config.measured.1 = Some(watts),
            _ => return Err(MethodError::invalid("kind: running or standby")),
        }
        self.store
            .set_plug(machine_id, Some(config.to_json()))
            .map_err(|_| MethodError::internal())?;
        Ok(json!({}))
    }

    pub fn register(&self, router: &mut Router) {
        let me = self.clone();
        router.answer("power.list", move |_| Ok(me.list()));
        router.in_order("power.list");
        let me = self.clone();
        router.register("power.configure", move |p| {
            let me = me.clone();
            async move { me.configure(p).await }
        });
        let me = self.clone();
        router.register("power.reading", move |p| {
            let me = me.clone();
            async move { me.reading(string_param(&p, "machineId")?).await }
        });
        let me = self.clone();
        router.register("power.turnOn", move |p| {
            let me = me.clone();
            async move { me.turn_on(string_param(&p, "machineId")?.to_string()).await }
        });
        // The core keeps the password itself: one handed over from a keychain changes nothing.
        let me = self.clone();
        router.answer("power.unlock", move |p| {
            let machine_id = string_param(&p, "machineId")?;
            string_param(&p, "password")?;
            me.config(machine_id).ok_or_else(not_configured)?;
            Ok(json!({}))
        });
        let me = self.clone();
        router.answer_blocking("power.noteMeasurement", move |p| me.note_measurement(&p));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delays_split_at_tasmotas_longest() {
        assert_eq!(delays(10_000), ["Delay 100"]);
        assert_eq!(delays(600_000), ["Delay 3600", "Delay 2400"]);
        assert_eq!(delays(150), ["Delay 2"]);
        assert!(delays(0).is_empty());
    }

    #[test]
    fn details_read_with_the_protocols_defaults() {
        let c = PlugConfig::read(&json!({ "kind": "tasmota-zigbee", "address": " 192.168.1.106 ", "device": "DeskPlug" })).unwrap();
        assert_eq!(
            c.to_json(),
            json!({ "kind": "tasmota-zigbee", "address": "192.168.1.106", "device": "DeskPlug", "offWatts": 5,
                    "minOffSeconds": 90, "measured": { "running": null, "standby": null } })
        );
        assert_eq!(c.on(), r#"ZbSend {"Device":"DeskPlug","Send":{"Power":1}}"#);
        let wifi = PlugConfig::read(
            &json!({ "kind": "tasmota-plug", "address": "plug.local", "device": "ignored" }),
        )
        .unwrap();
        assert_eq!(
            (wifi.on(), wifi.off(), wifi.device),
            ("Power 1".to_string(), "Power 0".to_string(), None)
        );
        assert!(
            PlugConfig::read(&json!({ "kind": "tasmota-zigbee", "address": "x", "device": null }))
                .is_err()
        );
        assert!(
            PlugConfig::read(
                &json!({ "kind": "tasmota-plug", "address": "x", "device": null, "offWatts": 0.1 })
            )
            .is_err()
        );
    }
}
