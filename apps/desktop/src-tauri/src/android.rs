//! The Android shell around the phone's core: the part that needs no Android,
//! so it's tested on any host. The Kotlin foreground service (`CoreService`)
//! and the JNI between it and Rust (`android/shell.rs`) stay thin around it.
//!
//! - The core runs once per process: the activity being destroyed and made
//!   again, or the app swiped away, finds the same core (same port and token).
//! - After a reboot the service starts only if the core was connected before
//!   (the owner didn't choose Disconnect).
//! - The chat on screen doesn't alert, but only while the app is in front.
//! - An opened alert waits here until the screens can show its chat.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use threadgarden_core::secrets::Secrets;
use threadgarden_core::{AlertKind, Core, CoreConfig, CoreError, CoreHandle, LinkStatus};

#[cfg(target_os = "android")]
pub mod shell;

/// A chat: (machine id, session id).
pub type Chat = (String, String);

/// How a core is started: [`Core::start`] on the phone; tests start their own.
pub type Starter = fn(CoreConfig) -> Result<CoreHandle, CoreError>;

/// The app's hold on its core, one per process.
pub struct Keeper {
    starter: Starter,
    core: Mutex<Option<CoreHandle>>,
    screen: Mutex<Screen>,
    opened: Mutex<Option<Chat>>,
}

#[derive(Default)]
struct Screen {
    /// What the screens last said is on screen (`alerts_set_active`).
    chat: Option<Chat>,
    /// The app is in front. In the background nothing is on screen, whatever
    /// the screens last said (their `visibilitychange` may come late or not at all).
    front: bool,
}

impl Screen {
    fn on_screen(&self) -> Option<Chat> {
        self.chat.clone().filter(|_| self.front)
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic elsewhere leaves the value whole: keep using it.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Keeper {
    pub const fn new(starter: Starter) -> Self {
        Keeper {
            starter,
            core: Mutex::new(None),
            screen: Mutex::new(Screen {
                chat: None,
                front: false,
            }),
            opened: Mutex::new(None),
        }
    }

    /// The running core, started on the first call. The second value is true
    /// when this call started it (the caller then follows its events). Later
    /// calls get the same core, whatever their arguments.
    pub fn start(
        &self,
        data_dir: PathBuf,
        secrets: Arc<dyn Secrets>,
        machine_name: String,
    ) -> Result<(CoreHandle, bool), String> {
        let mut core = lock(&self.core);
        if let Some(c) = core.as_ref().filter(|c| !c.is_stopped()) {
            return Ok((c.clone(), false));
        }
        let started = (self.starter)(CoreConfig {
            data_dir,
            secrets,
            machine_name,
        })
        .map_err(|e| e.to_string())?;
        // A new core knows nothing of the screens yet.
        started.set_active(lock(&self.screen).on_screen());
        *core = Some(started.clone());
        Ok((started, true))
    }

    /// The core, if it runs.
    pub fn core(&self) -> Option<CoreHandle> {
        lock(&self.core).clone().filter(|c| !c.is_stopped())
    }

    /// Whether a boot starts the service: only if the core was connected
    /// when it last ran.
    pub fn boot_starts(data_dir: &Path) -> bool {
        Core::was_connected(data_dir)
    }

    /// The screens say which chat is on screen (none: `None`). Returns the chat
    /// now on screen, whose alert can go.
    pub fn show(&self, chat: Option<Chat>) -> Option<Chat> {
        let mut screen = lock(&self.screen);
        screen.chat = chat;
        self.tell(&screen)
    }

    /// The app came to the front, or went to the background.
    pub fn front(&self, front: bool) -> Option<Chat> {
        let mut screen = lock(&self.screen);
        screen.front = front;
        self.tell(&screen)
    }

    fn tell(&self, screen: &Screen) -> Option<Chat> {
        let on_screen = screen.on_screen();
        if let Some(core) = self.core() {
            core.set_active(on_screen.clone());
        }
        on_screen
    }

    /// An alert was opened: its chat waits for the screens, which may not be
    /// listening yet (the activity is still being made).
    pub fn opened(&self, chat: Chat) {
        *lock(&self.opened) = Some(chat);
    }

    /// The opened alert's chat, once.
    pub fn take_opened(&self) -> Option<Chat> {
        lock(&self.opened).take()
    }
}

/// An alert's title, as the plan's copy: `‹machine›: ‹chat› needs you` or
/// `‹machine›: ‹chat› finished`.
pub fn alert_title(machine: &str, chat: &str, kind: AlertKind) -> String {
    match kind {
        AlertKind::NeedsYou => format!("{machine}: {chat} needs you"),
        AlertKind::Finished => format!("{machine}: {chat} finished"),
    }
}

/// The permanent notification's text under `Connected to your machines`.
pub fn status_text(s: LinkStatus) -> String {
    let machines = |n: usize| if n == 1 { "machine" } else { "machines" };
    if !s.on {
        "Disconnected".into()
    } else if s.machines == 0 {
        "No machines yet".into()
    } else if s.connected >= s.machines {
        format!("{} {} reachable", s.machines, machines(s.machines))
    } else {
        format!(
            "{} of {} {} reachable, reconnecting",
            s.connected,
            s.machines,
            machines(s.machines)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use threadgarden_core::secrets::MemorySecrets;
    use threadgarden_core::store::{Store, StoredMachine};

    /// A core of its own per test (`Core::start` is one per process, and tests run in parallel).
    fn keeper() -> Keeper {
        Keeper::new(Core::spawn)
    }

    fn secrets() -> Arc<dyn Secrets> {
        Arc::new(MemorySecrets::default())
    }

    /// A data dir with one paired machine (a boot has nothing to reconnect to
    /// without one). It has no token here, so no link is tried.
    fn paired() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        Store::open(dir.path())
            .unwrap()
            .add_machine(StoredMachine {
                id: "m1".into(),
                name: "Desk".into(),
                address: "127.0.0.1".into(),
                port: 9,
                fingerprint: "00".into(),
                cert_der: String::new(),
                device_id: "d1".into(),
                added_at: 0,
            })
            .unwrap();
        dir
    }

    #[test]
    fn start_twice_returns_the_same_core() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let keeper = keeper();
        let (first, new) = keeper
            .start(dir.path().into(), secrets(), "Test phone".into())
            .unwrap();
        assert!(new);
        // The activity made again, the service started again: the same core,
        // and a later caller's data dir isn't used.
        let (second, new) = keeper
            .start(other.path().into(), secrets(), "Test phone".into())
            .unwrap();
        assert!(!new);
        assert_eq!(first.port(), second.port());
        assert_eq!(first.token(), second.token());
        assert_eq!(keeper.core().unwrap().port(), first.port());
        // Once it has stopped, the next start makes a new one.
        first.stop();
        assert!(keeper.core().is_none());
        let (third, new) = keeper
            .start(dir.path().into(), secrets(), "Test phone".into())
            .unwrap();
        assert!(new);
        assert_ne!(third.token(), first.token());
        third.stop();
    }

    #[test]
    fn after_disconnect_a_boot_doesnt_start_it() {
        let dir = paired();
        let keeper = keeper();
        let (core, _) = keeper
            .start(dir.path().into(), secrets(), "Test phone".into())
            .unwrap();
        core.disconnect().unwrap();
        core.stop();
        drop(core);
        assert!(!Keeper::boot_starts(dir.path()));
        // Opening the app connects again, and a boot then starts it.
        let (core, _) = keeper
            .start(dir.path().into(), secrets(), "Test phone".into())
            .unwrap();
        assert!(!core.link_status().on);
        core.connect().unwrap();
        core.stop();
        assert!(Keeper::boot_starts(dir.path()));
    }

    #[test]
    fn a_boot_starts_it_if_it_was_connected() {
        let dir = paired();
        assert!(Keeper::boot_starts(dir.path()));
        let (core, _) = keeper()
            .start(dir.path().into(), secrets(), "Test phone".into())
            .unwrap();
        assert!(core.link_status().on);
        core.stop();
        drop(core);
        assert!(Keeper::boot_starts(dir.path()));
        // The rebooted process's core is connected.
        let (core, _) = keeper()
            .start(dir.path().into(), secrets(), "Test phone".into())
            .unwrap();
        assert!(core.link_status().on);
        core.stop();
    }

    #[test]
    fn the_chat_on_screen_counts_only_while_the_app_is_in_front() {
        let dir = tempfile::tempdir().unwrap();
        let keeper = keeper();
        let chat = ("m1".to_string(), "s1".to_string());
        // Said before the core runs, and kept for it.
        assert_eq!(keeper.front(true), None);
        assert_eq!(keeper.show(Some(chat.clone())), Some(chat.clone()));
        let (core, _) = keeper
            .start(dir.path().into(), secrets(), "Test phone".into())
            .unwrap();
        assert_eq!(keeper.front(false), None);
        assert_eq!(keeper.front(true), Some(chat.clone()));
        assert_eq!(keeper.show(None), None);
        core.stop();
    }

    #[test]
    fn an_opened_alert_waits_for_the_screens_once() {
        let keeper = keeper();
        assert_eq!(keeper.take_opened(), None);
        keeper.opened(("m1".into(), "s1".into()));
        keeper.opened(("m1".into(), "s2".into()));
        assert_eq!(keeper.take_opened(), Some(("m1".into(), "s2".into())));
        assert_eq!(keeper.take_opened(), None);
    }

    #[test]
    fn the_notifications_say_the_plans_copy() {
        assert_eq!(
            alert_title("Desk", "Fix the tests", AlertKind::NeedsYou),
            "Desk: Fix the tests needs you"
        );
        assert_eq!(
            alert_title("Desk", "Fix the tests", AlertKind::Finished),
            "Desk: Fix the tests finished"
        );
        let s = |on, machines, connected| {
            status_text(LinkStatus {
                on,
                machines,
                connected,
            })
        };
        assert_eq!(s(true, 0, 0), "No machines yet");
        assert_eq!(s(true, 1, 1), "1 machine reachable");
        assert_eq!(s(true, 3, 3), "3 machines reachable");
        assert_eq!(s(true, 3, 1), "1 of 3 machines reachable, reconnecting");
        assert_eq!(s(false, 3, 0), "Disconnected");
    }
}
