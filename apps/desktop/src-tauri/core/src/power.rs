//! Turn on a machine through its plug, from the phone: the plug details the
//! owner typed here (`power.configure`), the password in `Secrets` only, and
//! exactly what the desktop's `power/hub.ts` does (Ruling R16):
//!
//! - a fresh reading first, every time;
//! - a plug that's on and drawing power (at least `offWatts`) is left alone:
//!   the machine runs;
//! - on but below `offWatts` (standby), with a reading at most 5 s old, it's
//!   cycled with `Event tgw`: Threadgarden's own rule on the bridge (which the
//!   desktop installs) cuts, restores and writes the cut to `Mem11`. Without
//!   that rule there's no cycle from here ("Set up power control on the
//!   desktop first"); an older reading never drives a cut;
//! - off: on, once the minimum off time since the last cut (`Mem11`, and the
//!   phone's own) is over; what's left of it is waited out here, as the hub's
//!   `hold` does, then the plug's own on;
//! - after a Turn on, the wake is cleared (`Timer16 {"Enable":0}`, best
//!   effort, on a bridge with Threadgarden's rule), as the hub does;
//! - one operation at a time per machine: a second Turn on gets the first's
//!   answer, and one waiting out the off time gets that wait.
//!
//! Nothing else on the bridge is ever touched: reads, the plug's own on and
//! off, `Event tgw` and Threadgarden's `Timer16`. No rule is installed, no
//! `power.adopt` sent, and nothing is polled: a reading happens when a screen
//! asks (kept 3 s).

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
/// The longest a Zigbee plug's name may be (`isZigbeeName`).
const ZIGBEE_NAME_MAX: usize = 32;
/// What a standby cycle needs, and the bridge lacks without the desktop's setup.
const NEEDS_DESKTOP: &str = "Set up power control on the desktop first";
/// The bridge's rule cuts another plug than these details name.
const OTHER_PLUG: &str =
    "This bridge's power rule is set up for another plug. Set it up on the desktop.";

/// What Threadgarden's rule on a bridge is to these details.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuleState {
    /// No Threadgarden rule on the bridge.
    Missing,
    /// It's there, and its Mem12/Mem13 are this plug's off and on.
    Ours,
    /// It's there for another plug (the grow light, another machine).
    Other,
}

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

/// A Zigbee plug's name as Tasmota takes it in a command (`isZigbeeName`):
/// never an address (`0x…`) or a bare number, which the bridge would read as
/// another device.
fn is_zigbee_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= ZIGBEE_NAME_MAX
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !s.to_ascii_lowercase().starts_with("0x")
        && !s.chars().all(|c| c.is_ascii_digit())
}

/// Threadgarden's rule, as `rules.ts`'s `isOurs` knows it.
fn is_ours(rule: &str) -> bool {
    rule.contains("Event#tga do")
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
    /// `commandsFor(config).off`, as `memsFor` puts it in Mem12 (compared, never sent).
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
    /// Bumped when a machine's plug details change or go: a wait under way gives up.
    generations: Arc<Mutex<HashMap<String, u64>>>,
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
            generations: Arc::default(),
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

    fn generation(&self, machine_id: &str) -> u64 {
        locked(&self.generations)
            .get(machine_id)
            .copied()
            .unwrap_or(0)
    }

    /// Forgets readings and waits: a wait under way gives up (its on isn't sent).
    fn forget_state(&self, machine_id: &str) {
        *locked(&self.generations)
            .entry(machine_id.to_string())
            .or_insert(0) += 1;
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
            Ok(_) => {
                // A bridge that answers knows the plug by exactly this name, or it isn't the one.
                if config.zigbee {
                    let st = tasmota::command(
                        &config.address,
                        &password,
                        &format!("ZbStatus3 {}", config.device()),
                    )
                    .await?;
                    let named = field(&st, "ZbStatus3")
                        .and_then(|v| v.get(0))
                        .and_then(|d| d["Name"].as_str())
                        .is_some_and(|n| n == config.device());
                    if !named {
                        return Err(MethodError::new(
                            NOT_CONFIGURED,
                            format!("The bridge has no plug called {}.", config.device()),
                        ));
                    }
                }
            }
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
        // Power control may change or go while this waits on the switch: then it gives up (`check`).
        let generation = self.generation(machine_id);
        let check = || {
            if self.generation(machine_id) == generation {
                Ok(())
            } else {
                Err(MethodError::new(
                    NOT_CONFIGURED,
                    "Power control for this machine changed meanwhile.",
                ))
            }
        };
        let (config, password) = self.ready(machine_id).await?;
        let min_off_ms = config.min_off_seconds * 1000;
        locked(&self.cache).remove(machine_id);
        let reading = self.read_plug(&config, &password).await?;
        check()?;
        let Some(on) = reading["on"].as_bool() else {
            return Err(MethodError::new(
                UNREACHABLE,
                "The switch didn't report whether the plug is on.",
            ));
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
            // Standby: Threadgarden's rule cuts and restores (and writes Mem11), and only
            // when it's this plug's: otherwise `tgw` would cut whatever plug it names.
            match Self::rule_state(&config, &password).await? {
                RuleState::Missing => return Err(MethodError::new(NOT_CONFIGURED, NEEDS_DESKTOP)),
                RuleState::Other => return Err(MethodError::new(NOT_CONFIGURED, OTHER_PLUG)),
                RuleState::Ours => {}
            }
            check()?;
            self.note_cut(machine_id).await;
            tasmota::command(&config.address, &password, "Event tgw").await?;
            Self::clear_wake(&config, &password, RuleState::Ours).await;
            let answer = json!({ "cycled": true, "waitMs": min_off_ms });
            check()?;
            locked(&self.pending).insert(
                machine_id.to_string(),
                (answer.clone(), now_ms() + min_off_ms),
            );
            return Ok(answer);
        }
        let (cut, rule) = self.last_cut(machine_id, &config, &password).await?;
        let wait = cut.map_or(0, |c| (c + min_off_ms).saturating_sub(now_ms()));
        check()?;
        if wait == 0 {
            tasmota::command(&config.address, &password, &config.on()).await?;
            Self::clear_wake(&config, &password, rule).await;
            return Ok(json!({ "cycled": false, "waitMs": 0 }));
        }
        // What's left of the off time is waited out here, as the hub's `hold`; then the plug's on.
        let answer = json!({ "cycled": false, "waitMs": wait });
        locked(&self.pending).insert(machine_id.to_string(), (answer.clone(), now_ms() + wait));
        let (me, id) = (self.clone(), machine_id.to_string());
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(wait)).await;
            // The details changed or went meanwhile: nothing is sent.
            if me.generation(&id) != generation {
                return;
            }
            locked(&me.pending).remove(&id);
            locked(&me.cache).remove(&id);
            // A switch that stays unreachable leaves the plug off; the next reading shows it.
            if tasmota::command(&config.address, &password, &config.on())
                .await
                .is_ok()
            {
                Self::clear_wake(&config, &password, rule).await;
            }
        });
        Ok(answer)
    }

    /// Clears a wake left on the bridge, as the hub does after a Turn on (it
    /// would cut the running machine): Threadgarden's own `Timer16`, only when
    /// the bridge's rule is this plug's. Best effort.
    async fn clear_wake(config: &PlugConfig, password: &str, rule: RuleState) {
        if rule == RuleState::Ours {
            let _ = tasmota::command(&config.address, password, r#"Timer16 {"Enable":0}"#).await;
        }
    }

    fn not_tasmota(config: &PlugConfig) -> MethodError {
        MethodError::new(
            NOT_TASMOTA,
            format!("{} did not answer like a Tasmota device.", config.address),
        )
    }

    /// `Mem<n>`, as text; a read that fails fails this.
    async fn read_mem(config: &PlugConfig, password: &str, n: u8) -> Result<String, MethodError> {
        let mem = tasmota::command(&config.address, password, &format!("Mem{n}")).await?;
        match field(&mem, &format!("Mem{n}")) {
            Some(Value::String(s)) => Ok(s.trim().to_string()),
            Some(v @ Value::Number(_)) => Ok(v.to_string()),
            _ => Err(Self::not_tasmota(config)),
        }
    }

    /// Whether the bridge has Threadgarden's rule, and whether it's this
    /// plug's: its Mem12 and Mem13 are exactly the off and on `memsFor`
    /// builds from these details. Reads only; a read that fails fails this.
    async fn rule_state(config: &PlugConfig, password: &str) -> Result<RuleState, MethodError> {
        let mut found = false;
        for slot in 1..=3 {
            let rule = tasmota::command(&config.address, password, &format!("Rule{slot}")).await?;
            let Some(r) = field(&rule, &format!("Rule{slot}")).filter(|r| r.is_object()) else {
                return Err(Self::not_tasmota(config));
            };
            if is_ours(r["Rules"].as_str().unwrap_or_default()) {
                found = true;
                break;
            }
        }
        if !found {
            return Ok(RuleState::Missing);
        }
        let off = Self::read_mem(config, password, 12).await?;
        let on = Self::read_mem(config, password, 13).await?;
        Ok(if off == config.off() && on == config.on() {
            RuleState::Ours
        } else {
            RuleState::Other
        })
    }

    /// The phone's own cut, kept with the plug (it outlives a restart), noted
    /// before the cut is asked for.
    async fn note_cut(&self, machine_id: &str) {
        let (store, id) = (self.store.clone(), machine_id.to_string());
        let _ = blocking(move || {
            store
                .set_plug_cut(&id, now_ms())
                .map_err(|_| MethodError::internal())
        })
        .await;
    }

    /// The last cut (Unix ms), and the bridge's rule: `Mem11` (written by
    /// Threadgarden's rule, trusted only when the rule is this plug's), or the
    /// phone's own, whichever is later. A rule for another plug refuses, and a
    /// read that fails fails the Turn on, as the hub's `lastCut` throws.
    async fn last_cut(
        &self,
        machine_id: &str,
        config: &PlugConfig,
        password: &str,
    ) -> Result<(Option<u64>, RuleState), MethodError> {
        let ours = self.store.plug_cut(machine_id);
        let rule = Self::rule_state(config, password).await?;
        match rule {
            RuleState::Missing => return Ok((ours, rule)),
            RuleState::Other => return Err(MethodError::new(NOT_CONFIGURED, OTHER_PLUG)),
            RuleState::Ours => {}
        }
        let theirs = match Self::read_mem(config, password, 11).await?.as_str() {
            "" | "0" => None,
            t => t.parse::<u64>().ok().filter(|s| *s > 0).map(|s| s * 1000),
        };
        Ok((ours.max(theirs), rule))
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
        assert_eq!((wifi.on(), wifi.device), ("Power 1".to_string(), None));
        // Never an address or a bare number, never too long.
        for bad in ["0x1234", "0X1A", "1234", &"a".repeat(33), "has space"] {
            let v = json!({ "kind": "tasmota-zigbee", "address": "x", "device": bad });
            assert!(PlugConfig::read(&v).is_err(), "{bad}");
        }
        let v = json!({ "kind": "tasmota-zigbee", "address": "x", "device": "Plug-2" });
        assert!(PlugConfig::read(&v).is_ok());
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
