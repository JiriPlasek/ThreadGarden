//! The phone's core: what takes the local Threadgarden service's place on
//! Android, where there's no Node and no Claude Code. The screens (the same
//! Svelte UI) talk to it exactly as to a local service: a WebSocket on
//! 127.0.0.1 with a token, answering the local methods they need.
//!
//! It runs on its own tokio runtime, so it outlives the webview: Android may
//! destroy the screens while the core keeps the links to the machines (and
//! with them the alerts). [`Core::start`] keeps one core per process, so the
//! service and a webview made again both find the same one.

use std::fmt;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::runtime::Runtime;
use tokio::sync::{broadcast, watch};

mod alerts;
mod machines;
mod methods;
mod pairing;
mod power;
mod relay;
pub mod secrets;
mod server;
mod settings;
pub mod store;
mod tasmota;

pub use methods::{PLATFORM, REFUSED};

use methods::{LocalEvents, Router};
use secrets::Secrets;
use store::Store;

/// The protocol version the core speaks (`PROTOCOL_VERSION` in `packages/protocol`, pinned by the contract test).
pub const PROTOCOL_VERSION: u32 = 11;
/// Largest request frame accepted, in bytes (`MAX_REQUEST_BYTES` in `packages/protocol`).
pub const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
/// The protocol versions a machine may speak to this phone (`REMOTE_PROTOCOL_RANGE`):
/// its own, one older and one newer.
pub const REMOTE_PROTOCOL_RANGE: (u64, u64) = (10, 12);

/// `acceptsRemoteProtocol` of `packages/protocol`: a whole number in
/// `REMOTE_PROTOCOL_RANGE` (pinned by `test/fixtures/protocol-range.json`).
pub fn accepts_remote_protocol(version: &serde_json::Value) -> bool {
    let Some(v) = version.as_f64() else {
        return false;
    };
    v.fract() == 0.0 && v >= REMOTE_PROTOCOL_RANGE.0 as f64 && v <= REMOTE_PROTOCOL_RANGE.1 as f64
}

pub struct CoreConfig {
    /// Where the store lives (the app's private files on Android).
    pub data_dir: PathBuf,
    pub secrets: Arc<dyn Secrets>,
    /// This phone's name as a machine, in `hello`.
    pub machine_name: String,
}

/// What the core tells the app around it (the Android service), with or
/// without screens. Alerts come with Task 9.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum CoreEvent {
    /// A link to a machine never opened or stopped answering: for a debug
    /// log. The machine and why, never a frame or a token.
    LinkFailed { machine_id: String, reason: String },
    /// A chat needs you, or finished, on a machine (the alert to post).
    Alert {
        machine_id: String,
        machine_name: String,
        session_id: String,
        chat_title: String,
        kind: AlertKind,
    },
    /// The links changed: for the permanent notification.
    Status(LinkStatus),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlertKind {
    /// `‹machine›: ‹chat› needs you`.
    NeedsYou,
    /// `‹machine›: ‹chat› finished`.
    Finished,
}

/// The alert links now: `connected` of `machines` are open ("Connected to
/// your machines"; fewer: reconnecting). `on` is false after Disconnect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkStatus {
    pub on: bool,
    pub machines: usize,
    pub connected: usize,
}

/// How long a relay waits for its machine, and how often an open link is
/// pinged (a pong not back by the next ping means the link is dead): the
/// service's 10 s and 15 s.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub link_timeout: Duration,
    pub ping: Duration,
    /// All of pairing: connecting, the proof, the claim and closing.
    pub pairing: Duration,
    /// An alert link's first wait after a failure, doubling up to `backoff_max`.
    pub backoff_start: Duration,
    pub backoff_max: Duration,
    /// After a network change, how long an open link has to answer a ping
    /// before it's dropped and made again.
    pub network_check: Duration,
    /// Between asking a plug to report and reading what it says (`readWaitMs`).
    pub plug_read_wait: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            link_timeout: Duration::from_secs(10),
            ping: Duration::from_secs(15),
            pairing: Duration::from_secs(10),
            backoff_start: Duration::from_secs(2),
            backoff_max: Duration::from_secs(60),
            network_check: Duration::from_secs(4),
            plug_read_wait: Duration::from_millis(1500),
        }
    }
}

#[derive(Debug)]
pub enum CoreError {
    /// The store or the listener could not be opened.
    Io(io::Error),
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CoreError::Io(e) => write!(f, "the core could not start: {e}"),
        }
    }
}

impl std::error::Error for CoreError {}

impl From<io::Error> for CoreError {
    fn from(e: io::Error) -> Self {
        CoreError::Io(e)
    }
}

/// Every method the core answers: the local answers, then the machines'.
/// Later parts register theirs here.
pub(crate) fn router(
    store: Arc<Store>,
    secrets: Arc<dyn Secrets>,
    machine_name: String,
    events: LocalEvents,
    relays: Arc<relay::Relays>,
    alerts: Arc<alerts::Alerts>,
    timing: Timing,
) -> Router {
    let mut router = Router::default();
    methods::register(
        &mut router,
        methods::Deps {
            store: store.clone(),
            machine_name,
        },
    );
    alerts.register(&mut router);
    let power = power::Power::new(store.clone(), secrets.clone(), timing.plug_read_wait);
    power.register(&mut router);
    machines::Machines::new(
        store,
        secrets,
        events,
        relays,
        alerts,
        power,
        timing.pairing,
    )
    .register(&mut router);
    router
}

struct Inner {
    port: u16,
    token: String,
    methods: Vec<&'static str>,
    events: broadcast::Sender<CoreEvent>,
    alerts: Arc<alerts::Alerts>,
    /// Sockets the server is serving now.
    live: Arc<std::sync::atomic::AtomicUsize>,
    shutdown: watch::Sender<bool>,
    runtime: Mutex<Option<Runtime>>,
}

impl Inner {
    fn stop(&self) {
        let _ = self.shutdown.send(true);
        // The sockets close themselves (screens and relays 1001) before the
        // runtime goes: shutting it down cancels whatever is still running.
        if tokio::runtime::Handle::try_current().is_err() {
            let deadline = std::time::Instant::now() + Duration::from_secs(1);
            while self.live.load(std::sync::atomic::Ordering::SeqCst) > 0
                && std::time::Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        let Some(runtime) = self
            .runtime
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        else {
            return;
        };
        if tokio::runtime::Handle::try_current().is_ok() {
            // Inside an async context a runtime can't wait for its tasks: they end on their own.
            runtime.shutdown_background();
        } else {
            runtime.shutdown_timeout(Duration::from_secs(2));
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.stop();
    }
}

/// A running core. Clones are the same core; the last one dropped stops it.
#[derive(Clone)]
pub struct CoreHandle(Arc<Inner>);

impl fmt::Debug for CoreHandle {
    /// The port, never the token.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CoreHandle")
            .field("port", &self.0.port)
            .finish_non_exhaustive()
    }
}

impl CoreHandle {
    /// The loopback port the screens connect to.
    pub fn port(&self) -> u16 {
        self.0.port
    }

    /// The bearer token the screens offer as `threadgarden.<token>`: random,
    /// made per core, and only handed to this app's own webview.
    pub fn token(&self) -> &str {
        &self.0.token
    }

    pub fn events(&self) -> broadcast::Receiver<CoreEvent> {
        self.0.events.subscribe()
    }

    /// Stops the core: the listener closes, open sockets are closed 1001.
    /// The store is already on disk (every change is written before it's
    /// answered). Stopping twice is fine.
    pub fn stop(&self) {
        self.0.stop();
    }

    pub fn is_stopped(&self) -> bool {
        *self.0.shutdown.borrow()
    }

    /// Disconnect (the notification's action): every alert link closes, and
    /// none starts again until [`CoreHandle::connect`], after a restart too.
    /// The links close either way; the error says the choice couldn't be
    /// kept for the next start (the store couldn't be written).
    pub fn disconnect(&self) -> Result<(), CoreError> {
        Ok(self.0.alerts.disconnect()?)
    }

    pub fn connect(&self) -> Result<(), CoreError> {
        Ok(self.0.alerts.connect()?)
    }

    /// The phone's network changed (Wi-Fi to mobile data, Tailscale up):
    /// every link retries now, and the back-off starts over.
    pub fn network_changed(&self) {
        self.0.alerts.network_changed();
    }

    /// The chat on screen (`machine id`, `session id`), or none: it doesn't
    /// alert. The screens say so with `alerts.setActive` too.
    pub fn set_active(&self, chat: Option<(String, String)>) {
        self.0.alerts.set_active(chat);
    }

    pub fn link_status(&self) -> LinkStatus {
        self.0.alerts.status()
    }

    /// The methods this core answers (the contract test lists them).
    #[doc(hidden)]
    pub fn answered_methods(&self) -> Vec<&'static str> {
        self.0.methods.clone()
    }
}

pub struct Core;

/// The process's core, while it runs.
static SHARED: Mutex<Option<CoreHandle>> = Mutex::new(None);

impl Core {
    /// The process's one core: started on the first call, the same running
    /// core after that (the config of a later call is not used). Once it's
    /// stopped, the next call starts a new one.
    pub fn start(config: CoreConfig) -> Result<CoreHandle, CoreError> {
        let mut shared = SHARED.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(core) = shared.as_ref().filter(|c| !c.is_stopped()) {
            return Ok(core.clone());
        }
        let core = Core::spawn(config)?;
        *shared = Some(core.clone());
        Ok(core)
    }

    /// A new core of its own, whatever else runs: for tests, and for
    /// [`Core::start`]. Two on one data dir would overwrite each other's store.
    pub fn spawn(config: CoreConfig) -> Result<CoreHandle, CoreError> {
        Core::spawn_with_timing(config, Timing::default())
    }

    /// [`Core::spawn`] with other relay timings (tests: a link timeout of
    /// 10 s and pings every 15 s are too slow to wait for).
    pub fn spawn_with_timing(config: CoreConfig, timing: Timing) -> Result<CoreHandle, CoreError> {
        let store = Arc::new(Store::open(&config.data_dir)?);
        let token: String = store::random_bytes::<32>()?
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        // 127.0.0.1 only, never 0.0.0.0 or ::1: nothing off this phone can reach it.
        // Bound without the runtime (no `block_on`), so a caller inside one (Tauri) can start it.
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("threadgarden-core")
            .enable_all()
            .build()?;
        let registered = {
            let _in_runtime = runtime.enter();
            tokio::net::TcpListener::from_std(listener)
        };
        let listener = match registered {
            Ok(l) => l,
            Err(e) => {
                // Dropping a runtime inside an async context would panic.
                runtime.shutdown_background();
                return Err(e.into());
            }
        };
        let local_events = LocalEvents::default();
        let (events, _) = broadcast::channel(256);
        let relays = Arc::new(relay::Relays::new(
            store.clone(),
            config.secrets.clone(),
            timing,
            events.clone(),
        ));
        let alerts = alerts::Alerts::new(
            store.clone(),
            config.secrets.clone(),
            timing,
            events.clone(),
            runtime.handle().clone(),
        );
        let router = router(
            store,
            config.secrets,
            config.machine_name,
            local_events.clone(),
            relays.clone(),
            alerts.clone(),
            timing,
        );
        let methods = router.methods();
        let (shutdown, stopped) = watch::channel(false);
        let live = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let server = Arc::new(server::Server {
            token: token.clone(),
            router,
            events: local_events,
            relays,
            live: live.clone(),
        });
        runtime.spawn(server::serve(listener, server, stopped));
        // A link to every paired machine, unless the owner chose Disconnect.
        alerts.start_all();
        Ok(CoreHandle(Arc::new(Inner {
            port,
            token,
            methods,
            events,
            alerts,
            live,
            shutdown,
            runtime: Mutex::new(Some(runtime)),
        })))
    }

    /// Whether the core was connected when it last ran (the owner didn't
    /// choose Disconnect): after a reboot, the app starts it only then.
    /// A read of the store file only: nothing is created or changed. False
    /// with no machine paired, or no store at all.
    pub fn was_connected(data_dir: &std::path::Path) -> bool {
        store::peek_connected(data_dir)
    }
}
