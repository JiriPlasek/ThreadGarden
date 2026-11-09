//! The methods the screens call on their local client, and what the phone
//! answers to each. The UI was written for a local service that runs This
//! PC's chats; on the phone there's no This PC, so:
//!
//! - **real answers** where the screens keep their own state here: `hello`,
//!   `settings.*`, `uiState.*`, `drafts.*`;
//! - **empty answers**, valid for the method's result schema, where the
//!   screens ask at start-up or in the background and expect a list or a
//!   count: This PC simply has no chats, projects or usage;
//! - **`METHOD_NOT_FOUND`** for the rest ([`REFUSED`]): asked only for a
//!   chat or project of This PC (there are none), or from a screen the phone
//!   doesn't show, and every call site of these handles an error.
//!
//! `core-contract.test.ts` parses every answer with the protocol's schemas.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::PROTOCOL_VERSION;
use crate::settings;
use crate::store::Store;

/// `MachineInfoSchema.platform` allows `win32`, `darwin` and `linux` only, and
/// the protocol doesn't change in this plan. Android runs on Linux, and the UI
/// uses a machine's platform only for a paired machine's path separator.
pub const PLATFORM: &str = "linux";

/// The most a single stored value (a `uiState` value, a draft) may take, as
/// JSON or UTF-8 bytes: the whole store is rewritten on each change.
pub const MAX_STORED_VALUE_BYTES: usize = 1024 * 1024;

/// Why a method failed, as the protocol's `{ code, message }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MethodError {
    pub code: &'static str,
    pub message: String,
}

impl MethodError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        MethodError {
            code,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID_PARAMS", message)
    }

    /// A store or secrets failure: the screens get the service's plain answer, the details stay here.
    pub fn internal() -> Self {
        Self::new("INTERNAL", "Internal error")
    }
}

pub type Answer = Result<Value, MethodError>;
type Handler = Arc<dyn Fn(Value) -> BoxFuture<'static, Answer> + Send + Sync>;

/// Methods by name. Later parts of the core (pairing, power, alerts) register
/// theirs next to these; a name nobody registered answers `METHOD_NOT_FOUND`.
#[derive(Default, Clone)]
pub struct Router {
    handlers: HashMap<&'static str, Handler>,
    /// The methods that write the store: one screen's are applied in the order it sent them.
    ordered: HashSet<&'static str>,
}

/// A request frame read as the protocol has it.
pub struct Request {
    pub id: Value,
    pub method: String,
    pub params: Value,
}

impl Router {
    /// Registers an async handler: for methods that wait (on a machine, a plug).
    pub fn register<F, Fut>(&mut self, method: &'static str, handler: F)
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Answer> + Send + 'static,
    {
        let previous = self
            .handlers
            .insert(method, Arc::new(move |p| Box::pin(handler(p))));
        assert!(previous.is_none(), "{method} registered twice");
    }

    /// Registers a handler that answers at once.
    pub fn answer<F>(&mut self, method: &'static str, handler: F)
    where
        F: Fn(Value) -> Answer + Send + Sync + 'static,
    {
        let handler = Arc::new(handler);
        self.register(method, move |p| {
            let handler = handler.clone();
            async move { handler(p) }
        });
    }

    /// Registers a handler that blocks (it writes the store to disk): it
    /// runs on tokio's blocking threads, never on the core's two workers.
    pub fn answer_blocking<F>(&mut self, method: &'static str, handler: F)
    where
        F: Fn(Value) -> Answer + Send + Sync + 'static,
    {
        let handler = Arc::new(handler);
        self.ordered.insert(method);
        self.register(method, move |p| {
            let handler = handler.clone();
            async move {
                tokio::task::spawn_blocking(move || handler(p))
                    .await
                    .unwrap_or_else(|_| Err(MethodError::internal()))
            }
        });
    }

    pub fn methods(&self) -> Vec<&'static str> {
        let mut names: Vec<_> = self.handlers.keys().copied().collect();
        names.sort_unstable();
        names
    }

    /// Answers one request frame (`{ id, method, params }`) with the response
    /// frame. The server parses first instead, to keep a screen's writes in order.
    #[cfg(test)]
    pub async fn dispatch(&self, frame: &str) -> Value {
        match Router::parse(frame) {
            Ok(req) => self.answer_request(req).await,
            Err(refusal) => refusal,
        }
    }

    /// Reads a request frame, or the answer to one that isn't a request.
    pub fn parse(frame: &str) -> Result<Request, Value> {
        parse_request(frame)
            .map(|(id, method, params)| Request { id, method, params })
            .ok_or_else(|| {
                json!({ "id": 0, "error": { "code": "INVALID_PARAMS", "message": "Malformed request" } })
            })
    }

    /// Puts a method that reads the store in the screen's order too, so it
    /// sees the writes that screen sent before it (as on the service, where
    /// they're handled one message after the other).
    pub fn in_order(&mut self, method: &'static str) {
        assert!(
            self.handlers.contains_key(method),
            "{method} isn't registered"
        );
        self.ordered.insert(method);
    }

    /// Whether `method` touches the store, so must wait for the screen's earlier writes.
    pub fn is_ordered(&self, method: &str) -> bool {
        self.ordered.contains(method)
    }

    /// The response frame to a request.
    pub async fn answer_request(&self, req: Request) -> Value {
        let Request { id, method, params } = req;
        let answer = match self.handlers.get(method.as_str()) {
            Some(handler) => handler(params).await,
            None => Err(MethodError::new(
                "METHOD_NOT_FOUND",
                format!("Unknown method {method}"),
            )),
        };
        match answer {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(e) => json!({ "id": id, "error": { "code": e.code, "message": e.message } }),
        }
    }
}

/// `RequestSchema`: a numeric id, a method name, and any params (absent is fine).
fn parse_request(frame: &str) -> Option<(Value, String, Value)> {
    let Value::Object(mut req) = serde_json::from_str(frame).ok()? else {
        return None;
    };
    let id = req.remove("id").filter(Value::is_number)?;
    let method = match req.remove("method")? {
        Value::String(m) => m,
        _ => return None,
    };
    Some((id, method, req.remove("params").unwrap_or(Value::Null)))
}

/// A string param, or INVALID_PARAMS naming it.
pub fn string_param<'a>(params: &'a Value, name: &str) -> Result<&'a str, MethodError> {
    params
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| MethodError::invalid(format!("{name}: expected a string")))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Events for the screens on the loopback socket (`machines.changed`, …),
/// as the service's `emitLocal`: never sent to a machine.
#[derive(Clone)]
pub struct LocalEvents(broadcast::Sender<Arc<str>>);

impl Default for LocalEvents {
    fn default() -> Self {
        LocalEvents(broadcast::channel(64).0)
    }
}

impl LocalEvents {
    pub fn emit(&self, event: &str, data: Value) {
        // Nobody listening (no screen open) is fine.
        let _ = self
            .0
            .send(json!({ "event": event, "data": data }).to_string().into());
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<str>> {
        self.0.subscribe()
    }
}

/// Runs `f` on tokio's blocking threads (the store's disk, a keystore).
pub async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, MethodError> + Send + 'static,
) -> Result<T, MethodError> {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|_| Err(MethodError::internal()))
}

/// What the local answers need.
pub struct Deps {
    pub store: Arc<Store>,
    pub machine_name: String,
}

/// Registers the phone's local answers.
pub fn register(router: &mut Router, deps: Deps) {
    let store = deps.store;

    let hello = json!({
        "serviceVersion": env!("CARGO_PKG_VERSION"),
        "protocolVersion": PROTOCOL_VERSION,
        "machine": {
            "id": store.machine_id(),
            "name": deps.machine_name,
            "platform": PLATFORM,
            // The phone has screens: it's never a headless machine, and runs nothing.
            "headless": false,
            "home": "",
            "capabilities": [],
        },
    });
    router.answer("hello", move |_| Ok(hello.clone()));

    // ── kept here: the screens' own state ──────────────────────────────────
    let s = store.clone();
    router.answer("settings.get", move |_| Ok(settings::read(&s.settings())));
    let s = store.clone();
    router.answer_blocking("settings.set", move |p| {
        let patch = settings::check_patch(&p).map_err(MethodError::invalid)?;
        s.patch_settings(patch)
            .map_err(|_| MethodError::internal())?;
        Ok(settings::read(&s.settings()))
    });
    let s = store.clone();
    router.answer("uiState.get", move |p| {
        let key = string_param(&p, "key")?;
        Ok(json!({ "value": s.ui_state(key).unwrap_or(Value::Null) }))
    });
    let s = store.clone();
    router.answer_blocking("uiState.set", move |p| {
        let key = string_param(&p, "key")?;
        let value = p.get("value").cloned().unwrap_or(Value::Null);
        let size = serde_json::to_vec(&value).map_or(usize::MAX, |b| b.len());
        if size > MAX_STORED_VALUE_BYTES {
            return Err(MethodError::invalid("value: at most 1 MiB"));
        }
        s.set_ui_state(key, value)
            .map_err(|_| MethodError::internal())?;
        Ok(json!({}))
    });
    let s = store.clone();
    router.answer("drafts.get", move |p| {
        let key = string_param(&p, "key")?;
        Ok(json!({ "text": s.draft(key).unwrap_or_default() }))
    });
    let s = store;
    router.answer_blocking("drafts.set", move |p| {
        let key = string_param(&p, "key")?;
        let text = string_param(&p, "text")?;
        if text.len() > MAX_STORED_VALUE_BYTES {
            return Err(MethodError::invalid("text: at most 1 MiB"));
        }
        s.set_draft(key, text, now_ms())
            .map_err(|_| MethodError::internal())?;
        Ok(json!({}))
    });

    for read in ["settings.get", "uiState.get", "drafts.get"] {
        router.in_order(read);
    }

    // ── This PC has nothing: empty answers ────────────────────────────────
    let empties = [
        (
            "places.counts",
            json!({ "needsYou": 0, "running": 0, "all": 0, "active": 0, "onHold": 0, "archived": 0 }),
        ),
        ("projects.list", json!([])),
        ("sessions.list", json!({ "items": [] })),
        ("sessions.summaries", json!({ "items": [] })),
        ("search.quick", json!({ "items": [] })),
        ("scheduled.list", json!({ "items": [] })),
        // `usageEmpty`: no windows known, no chat refused.
        ("usage.get", json!({ "windows": [], "refused": [] })),
        ("chat.models", json!([])),
        ("chat.commands", json!([])),
        ("files.suggest", json!([])),
        (
            "system.status",
            json!({ "claude": { "found": false }, "externalAvailable": false, "indexing": { "done": 0, "total": 0 } }),
        ),
        // Stop all work: nothing runs here (the machines are asked on their own links).
        ("work.stopAll", json!({ "stopped": 0 })),
        // Stage two keeps copies and waiting messages; until then there are none.
        ("away.list", json!({ "items": [], "states": [] })),
        ("copies.get", Value::Null),
        ("copies.chat", Value::Null),
        ("copies.tails", json!({})),
        // The plug (Task 8) fills this.
        ("power.list", json!([])),
        // Whether a window is focused: the core alerts on its own (Task 9), never by this.
        ("ui.visibility", json!({})),
        // A screen's error report: there's no service log on the phone to keep it in.
        ("ui.error", json!({})),
    ];
    for (method, answer) in empties {
        router.answer(method, move |_| Ok(answer.clone()));
    }
}

/// The protocol's methods the phone deliberately answers with
/// `METHOD_NOT_FOUND`, so the choice is written down (and the contract test
/// checks each is a protocol method the core doesn't answer). Each group says
/// why the screens are fine with it.
pub const REFUSED: &[&str] = &[
    // Only for a chat of This PC (none on the phone); each call site handles the error.
    "chat.open",
    "chat.older",
    "chat.since",
    "chat.create",
    "chat.send",
    "chat.interrupt",
    "chat.end",
    "chat.setModel",
    "chat.setPermissionMode",
    "chat.setEffort",
    "chat.respond",
    "chat.fork",
    "chat.resumeCheck",
    "chat.resumeCommand",
    "chat.stopTask",
    "chat.markSeen",
    "chat.setBucket",
    "chat.archiveOlder",
    "external.stop",
    "meta.update",
    "scheduled.create",
    "scheduled.get",
    "scheduled.update",
    "scheduled.cancel",
    "scheduled.sendNow",
    "move.check",
    "move.target",
    "move.exportBegin",
    "move.exportPart",
    "move.abort",
    "move.importPart",
    "move.commit",
    "move.markMoved",
    // Only for a project or folder of This PC (New chat never targets it on the phone).
    "projects.update",
    "projects.icon",
    "projects.createIn",
    "projects.create",
    "projects.clone",
    "projects.job",
    "projects.cancel",
    "projects.origins",
    "folders.list",
    "folders.complete",
    "folders.create",
    "github.status",
    "github.repos",
    // Screens the phone doesn't show: analytics says so itself, the rest show the error.
    "analytics.get",
    "auth.setApiKey",
    "service.shutdown",
    "update.latest",
    "update.start",
    "update.status",
    // Stage two (copies and waiting messages): not wired on the phone in stage one.
    "copies.saveLists",
    "copies.saveChat",
    "away.queue",
    "away.cancel",
    "away.retry",
    // The plug comes with Task 8: reading, Turn on and the setup dialog show the error.
    "power.probe",
    "power.pairPlug",
    "power.configure",
    "power.unlock",
    "power.reading",
    "power.turnOn",
    "power.rename",
    "power.noteMeasurement",
    // A machine's side, asked over a machine's link, never of the local client.
    "machine.get",
    "machine.rename",
    "pairing.create",
    "devices.list",
    "devices.revoke",
    "pair.proof",
    "pair.claim",
    "power.adopt",
    "power.status",
    "power.keepAwake",
    "power.shutdown",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<F: Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(f)
    }

    #[test]
    fn a_later_part_registers_its_own_methods() {
        let mut router = Router::default();
        router.register("machines.pair", |p| async move { Ok(json!({ "echo": p })) });
        let answer =
            block_on(router.dispatch(r#"{"id":3,"method":"machines.pair","params":{"a":1}}"#));
        assert_eq!(answer, json!({ "id": 3, "result": { "echo": { "a": 1 } } }));
        assert_eq!(router.methods(), ["machines.pair"]);
    }

    #[test]
    #[should_panic(expected = "registered twice")]
    fn a_method_is_registered_once() {
        let mut router = Router::default();
        router.answer("hello", |_| Ok(json!({})));
        router.answer("hello", |_| Ok(json!({})));
    }

    #[test]
    fn requests_are_read_as_the_protocol_has_them() {
        assert!(parse_request(r#"{"id":1,"method":"hello"}"#).is_some());
        assert!(parse_request(r#"{"id":1.5,"method":"hello","params":{}}"#).is_some());
        assert!(parse_request(r#"{"id":"1","method":"hello","params":{}}"#).is_none());
        assert!(parse_request(r#"{"method":"hello","params":{}}"#).is_none());
        assert!(parse_request(r#"{"id":1,"method":2,"params":{}}"#).is_none());
        assert!(parse_request(r#"[1]"#).is_none());
    }

    #[test]
    fn nothing_is_both_answered_and_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(dir.path()).unwrap());
        let secrets = Arc::new(crate::secrets::MemorySecrets::default());
        let relays = Arc::new(crate::relay::Relays::new(
            store.clone(),
            secrets.clone(),
            crate::Timing::default(),
            tokio::sync::broadcast::channel(1).0,
        ));
        let router = crate::router(
            store,
            secrets,
            "Phone".into(),
            LocalEvents::default(),
            relays,
            crate::alerts::for_tests(dir.path()),
            crate::Timing::default().pairing,
        );
        for m in router.methods() {
            assert!(!REFUSED.contains(&m), "{m}");
        }
    }
}
