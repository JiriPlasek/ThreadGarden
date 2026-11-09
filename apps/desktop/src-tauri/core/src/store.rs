//! What the core keeps on disk: its machine id, settings, UI state, drafts
//! and the paired machines. Never a secret: tokens and passwords go to
//! `Secrets`.
//!
//! One JSON document, `core.json`, replaced whole on every change (written to
//! a temporary file, synced, then renamed over the old one, so a crash leaves
//! the old or the new version, never half of one). Stage one's data is small
//! and the core is its only writer, so a database would buy nothing but a C
//! build for every Android target. Stage two's saved copies and waiting
//! messages are bigger and change on their own: they get documents of their
//! own next to this one (a copy per machine, replaced whole as
//! `copies.saveLists` replaces the last copy; the queue, with images in
//! separate files), through the same `write_atomic`.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The store's file in the data dir.
pub const FILE: &str = "core.json";
/// The prefix of where an unreadable store file is moved (`-<unix ms>` follows), so a fresh one can start.
pub const UNREADABLE: &str = "core.json.unreadable";
const FORMAT: u32 = 1;

/// A paired machine as stored: where it is, its pinned certificate and this
/// phone's device id there. The device token is a secret and never part of it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMachine {
    pub id: String,
    pub name: String,
    pub address: String,
    pub port: u16,
    /// The pin: the certificate's SHA-256, as Node's `fingerprint256`.
    pub fingerprint: String,
    /// The certificate itself (DER, base64), for the relay's date check.
    #[serde(default)]
    pub cert_der: String,
    /// This phone's id on the machine, for `devices.revoke`.
    #[serde(default)]
    pub device_id: String,
    pub added_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Draft {
    text: String,
    updated_at: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Data {
    #[serde(default)]
    format: u32,
    #[serde(default)]
    machine_id: Option<String>,
    /// The values set, by key, as `settings.set` stored them; the defaults
    /// apply to the rest when read (as the service's settings table).
    #[serde(default)]
    settings: Map<String, Value>,
    #[serde(default)]
    ui_state: Map<String, Value>,
    #[serde(default)]
    drafts: BTreeMap<String, Draft>,
    #[serde(default)]
    machines: Vec<StoredMachine>,
    /// What a newer build wrote that this one doesn't know: kept as it is.
    #[serde(flatten)]
    rest: Map<String, Value>,
}

pub struct Store {
    path: PathBuf,
    data: Mutex<Data>,
    /// Held for a whole change, the write to disk included.
    writing: Mutex<()>,
}

impl Store {
    /// Opens (or creates) the store in `dir`. A file that isn't a store any
    /// more is set aside as `core.json.unreadable-<unix ms>` and a fresh one started:
    /// the phone must come up, and pairing again beats a core that can't
    /// start. A file that can't be read at all is an error.
    pub fn open(dir: &Path) -> io::Result<Store> {
        fs::create_dir_all(dir)?;
        let path = dir.join(FILE);
        let data = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Data>(&bytes) {
                Ok(data) => data,
                Err(_) => {
                    fs::rename(&path, set_aside_path(dir))?;
                    Data::default()
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => Data::default(),
            Err(e) => return Err(e),
        };
        let store = Store {
            path,
            data: Mutex::new(data),
            writing: Mutex::new(()),
        };
        if store.lock().machine_id.is_none() {
            let id = random_uuid()?;
            store.change(|d| d.machine_id = Some(id))?;
        }
        Ok(store)
    }

    fn lock(&self) -> MutexGuard<'_, Data> {
        // Changes are made on a copy and swapped in once written, so the data is whole even after a panic.
        self.data.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Applies `f` to a copy, writes it, and only then keeps it: a failed
    /// write leaves memory as the disk is. Writers wait for each other (no
    /// change is lost), but readers only wait for the copy and the swap,
    /// never for the disk. It blocks on the disk: call it off the runtime
    /// (the handlers use `spawn_blocking`).
    fn change<R>(&self, f: impl FnOnce(&mut Data) -> R) -> io::Result<R> {
        let _one_writer = self.writing.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = self.lock().clone();
        let out = f(&mut next);
        next.format = FORMAT;
        let bytes = serde_json::to_vec_pretty(&next).map_err(io::Error::other)?;
        write_atomic(&self.path, &bytes)?;
        *self.lock() = next;
        Ok(out)
    }

    /// This phone's id as a machine: made once, kept for good.
    pub fn machine_id(&self) -> String {
        self.lock().machine_id.clone().unwrap_or_default()
    }

    pub fn settings(&self) -> Map<String, Value> {
        self.lock().settings.clone()
    }

    /// Stores each value of `patch` (already checked) over the one before.
    pub fn patch_settings(&self, patch: Map<String, Value>) -> io::Result<()> {
        self.change(|d| d.settings.extend(patch))
    }

    pub fn ui_state(&self, key: &str) -> Option<Value> {
        self.lock().ui_state.get(key).cloned()
    }

    pub fn set_ui_state(&self, key: &str, value: Value) -> io::Result<()> {
        self.change(|d| {
            d.ui_state.insert(key.to_string(), value);
        })
    }

    pub fn draft(&self, key: &str) -> Option<String> {
        self.lock().drafts.get(key).map(|d| d.text.clone())
    }

    /// An empty draft is no draft: it's forgotten.
    pub fn set_draft(&self, key: &str, text: &str, now: u64) -> io::Result<()> {
        self.change(|d| {
            if text.is_empty() {
                d.drafts.remove(key);
            } else {
                d.drafts.insert(
                    key.to_string(),
                    Draft {
                        text: text.to_string(),
                        updated_at: now,
                    },
                );
            }
        })
    }

    /// The paired machines, in the order they were added.
    pub fn machines(&self) -> Vec<StoredMachine> {
        self.lock().machines.clone()
    }

    /// Adds a machine after the others; false (and nothing changed) when
    /// one with its id is there already. Checked and added in one change, so
    /// two pairings of the same machine can't both add it.
    pub fn add_machine(&self, machine: StoredMachine) -> io::Result<bool> {
        self.change(|d| {
            if d.machines.iter().any(|m| m.id == machine.id) {
                return false;
            }
            d.machines.push(machine);
            true
        })
    }

    /// Changes the machine `id` with `f`, in one change; None (and nothing
    /// changed) when it isn't there, so an update racing a remove can't bring
    /// it back.
    pub fn update_machine(
        &self,
        id: &str,
        f: impl FnOnce(&mut StoredMachine),
    ) -> io::Result<Option<StoredMachine>> {
        self.change(|d| {
            let m = d.machines.iter_mut().find(|m| m.id == id)?;
            f(m);
            Some(m.clone())
        })
    }

    /// Forgets a machine; false when there was none with that id.
    pub fn remove_machine(&self, id: &str) -> io::Result<bool> {
        self.change(|d| {
            let before = d.machines.len();
            d.machines.retain(|m| m.id != id);
            d.machines.len() != before
        })
    }
}

/// A name no earlier set-aside copy has: `core.json.unreadable-<unix ms>`,
/// so a second reset never overwrites the first copy.
fn set_aside_path(dir: &Path) -> PathBuf {
    let mut ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    loop {
        let path = dir.join(format!("{UNREADABLE}-{ms}"));
        if !path.exists() {
            return path;
        }
        ms += 1;
    }
}

/// Replaces `path` with `bytes` all at once: a temporary file next to it,
/// synced, then renamed over it.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    // The rename itself is durable once the directory is synced (not possible everywhere).
    if let Some(dir) = path.parent()
        && let Ok(d) = fs::File::open(dir)
    {
        let _ = d.sync_all();
    }
    Ok(())
}

/// `n` random bytes from the system.
pub(crate) fn random_bytes<const N: usize>() -> io::Result<[u8; N]> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(io::Error::other)?;
    Ok(bytes)
}

/// A random (version 4) UUID, as the service makes machine ids.
fn random_uuid() -> io::Result<String> {
    let mut b = random_bytes::<16>()?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn machine(id: &str) -> StoredMachine {
        StoredMachine {
            id: id.into(),
            name: "Desk".into(),
            address: "192.0.2.10".into(),
            port: 47380,
            fingerprint: "AB:CD".into(),
            cert_der: String::new(),
            device_id: "d".into(),
            added_at: 1,
        }
    }

    #[test]
    fn the_machine_id_is_a_uuid_kept_across_opens() {
        let dir = tempfile::tempdir().unwrap();
        let id = Store::open(dir.path()).unwrap().machine_id();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert_eq!(Store::open(dir.path()).unwrap().machine_id(), id);
    }

    #[test]
    fn an_unreadable_file_is_set_aside_and_a_fresh_store_starts() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE), b"{ half a store").unwrap();
        let store = Store::open(dir.path()).unwrap();
        assert!(store.settings().is_empty());
        assert_eq!(set_aside(dir.path()), [b"{ half a store".to_vec()]);
    }

    /// The set-aside copies, oldest first.
    fn set_aside(dir: &Path) -> Vec<Vec<u8>> {
        let mut names: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(UNREADABLE))
            .collect();
        names.sort();
        names
            .iter()
            .map(|n| fs::read(dir.join(n)).unwrap())
            .collect()
    }

    #[test]
    fn a_second_unreadable_file_keeps_the_first_copy() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE), b"first").unwrap();
        Store::open(dir.path()).unwrap();
        fs::write(dir.path().join(FILE), b"second").unwrap();
        Store::open(dir.path()).unwrap();
        assert_eq!(
            set_aside(dir.path()),
            [b"first".to_vec(), b"second".to_vec()]
        );
    }

    #[test]
    fn what_a_newer_build_wrote_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(FILE),
            br#"{"format":2,"machineId":"m","later":{"a":1}}"#,
        )
        .unwrap();
        let store = Store::open(dir.path()).unwrap();
        store.set_ui_state("k", json!(1)).unwrap();
        let written: Value =
            serde_json::from_slice(&fs::read(dir.path().join(FILE)).unwrap()).unwrap();
        assert_eq!(written["later"], json!({ "a": 1 }));
        assert_eq!(written["machineId"], "m");
    }

    #[test]
    fn a_machine_is_added_once_and_updated_only_while_it_is_there() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        assert!(store.add_machine(machine("a")).unwrap());
        // A second pairing of the same machine doesn't replace the first.
        let other = StoredMachine {
            name: "Other".into(),
            ..machine("a")
        };
        assert!(!store.add_machine(other).unwrap());
        assert_eq!(store.machines()[0].name, "Desk");
        let renamed = store
            .update_machine("a", |m| m.name = "Study".into())
            .unwrap();
        assert_eq!(renamed.map(|m| m.name), Some("Study".into()));
        // Removed meanwhile: an update doesn't bring it back.
        assert!(store.remove_machine("a").unwrap());
        assert_eq!(
            store
                .update_machine("a", |m| m.name = "Back".into())
                .unwrap(),
            None
        );
        assert!(store.machines().is_empty());
    }

    #[test]
    fn machines_are_added_replaced_and_removed_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store.add_machine(machine("a")).unwrap();
        store.add_machine(machine("b")).unwrap();
        store
            .update_machine("a", |m| m.name = "Renamed".into())
            .unwrap();
        let again = Store::open(dir.path()).unwrap();
        let names: Vec<_> = again
            .machines()
            .into_iter()
            .map(|m| (m.id, m.name))
            .collect();
        assert_eq!(
            names,
            [("a".into(), "Renamed".into()), ("b".into(), "Desk".into())]
        );
        assert!(again.remove_machine("a").unwrap());
        assert!(!again.remove_machine("a").unwrap());
        assert_eq!(again.machines().len(), 1);
    }

    #[test]
    fn no_temporary_file_is_left_behind() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store.set_draft("k", "text", 5).unwrap();
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, [FILE]);
    }
}
