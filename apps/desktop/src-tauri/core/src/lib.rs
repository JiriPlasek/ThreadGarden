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

mod machines;
mod methods;
pub mod secrets;
mod server;
mod settings;
pub mod store;

pub use methods::{PLATFORM, REFUSED};

use methods::Router;
use secrets::Secrets;
use store::Store;

/// The protocol version the core speaks (`PROTOCOL_VERSION` in `packages/protocol`, pinned by the contract test).
pub const PROTOCOL_VERSION: u32 = 11;
/// Largest request frame accepted, in bytes (`MAX_REQUEST_BYTES` in `packages/protocol`).
pub const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;

pub struct CoreConfig {
    /// Where the store lives (the app's private files on Android).
    pub data_dir: PathBuf,
    pub secrets: Arc<dyn Secrets>,
    /// This phone's name as a machine, in `hello`.
    pub machine_name: String,
}

/// What the core tells the app around it (the Android service), with or
/// without screens. None yet: alerts come with Task 9.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum CoreEvent {}

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
pub(crate) fn router(store: Arc<Store>, secrets: Arc<dyn Secrets>, machine_name: String) -> Router {
    let mut router = Router::default();
    methods::register(
        &mut router,
        methods::Deps {
            store: store.clone(),
            machine_name,
        },
    );
    machines::Machines::new(store, secrets).register(&mut router);
    router
}

struct Inner {
    port: u16,
    token: String,
    methods: Vec<&'static str>,
    events: broadcast::Sender<CoreEvent>,
    shutdown: watch::Sender<bool>,
    runtime: Mutex<Option<Runtime>>,
}

impl Inner {
    fn stop(&self) {
        let _ = self.shutdown.send(true);
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
        let store = Arc::new(Store::open(&config.data_dir)?);
        let token: String = store::random_bytes::<32>()?
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let router = router(store, config.secrets, config.machine_name);
        let methods = router.methods();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("threadgarden-core")
            .enable_all()
            .build()?;
        // 127.0.0.1 only, never 0.0.0.0 or ::1: nothing off this phone can reach it.
        let listener = runtime.block_on(tokio::net::TcpListener::bind(("127.0.0.1", 0)))?;
        let port = listener.local_addr()?.port();
        let (shutdown, stopped) = watch::channel(false);
        let server = Arc::new(server::Server {
            token: token.clone(),
            router,
        });
        runtime.spawn(server::serve(listener, server, stopped));
        let (events, _) = broadcast::channel(64);
        Ok(CoreHandle(Arc::new(Inner {
            port,
            token,
            methods,
            events,
            shutdown,
            runtime: Mutex::new(Some(runtime)),
        })))
    }
}
