//! The contract with the protocol: every answer the core gives is written to
//! `packages/protocol/test/fixtures/core-answers/`, where
//! `core-contract.test.ts` parses each with the method's zod schemas. The
//! fixtures are committed, so the TypeScript side runs without Rust; this test
//! fails when they no longer match what the core answers.
//!
//! After a change to an answer: `THREADGARDEN_WRITE_FIXTURES=1 cargo test --test contract`.

mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use support::{block_on, call, core, open};
use threadgarden_core::{MAX_REQUEST_BYTES, PROTOCOL_VERSION, REFUSED};

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../packages/protocol/test/fixtures/core-answers")
}

/// The requests, in order, on one fresh core: every answered method at least once.
fn cases() -> Vec<(&'static str, Value)> {
    vec![
        (
            "hello",
            json!({ "protocolVersion": 11, "client": "threadgarden-desktop" }),
        ),
        ("settings.get", json!({})),
        (
            "settings.set",
            json!({ "theme": "dark", "accent": "teal", "idleShutdownMinutes": null, "codeFont": "Fira Code; x" }),
        ),
        ("settings.get", json!({})),
        ("uiState.get", json!({ "key": "tabs" })),
        (
            "uiState.set",
            json!({ "key": "tabs", "value": { "open": ["m1:s1"], "active": "m1:s1" } }),
        ),
        ("uiState.get", json!({ "key": "tabs" })),
        ("drafts.get", json!({ "key": "new:m1" })),
        (
            "drafts.set",
            json!({ "key": "new:m1", "text": "Half a thought" }),
        ),
        ("drafts.get", json!({ "key": "new:m1" })),
        ("places.counts", json!({})),
        ("projects.list", json!({})),
        (
            "sessions.list",
            json!({ "place": { "kind": "active" }, "limit": 50 }),
        ),
        ("sessions.summaries", json!({ "sessionIds": ["s1"] })),
        ("search.quick", json!({ "query": "plan", "limit": 20 })),
        ("scheduled.list", json!({})),
        ("usage.get", json!({ "refresh": true })),
        ("chat.models", json!({ "cwd": "/home/someone/project" })),
        ("chat.commands", json!({ "cwd": "/home/someone/project" })),
        (
            "files.suggest",
            json!({ "cwd": "/home/someone/project", "query": "src", "limit": 20 }),
        ),
        ("system.status", json!({})),
        ("work.stopAll", json!({})),
        ("ui.visibility", json!({ "visible": true })),
        (
            "ui.error",
            json!({ "where": "test", "message": "Something broke" }),
        ),
        ("away.list", json!({})),
        ("copies.get", json!({ "machineId": "m1" })),
        (
            "copies.chat",
            json!({ "machineId": "m1", "sessionId": "s1" }),
        ),
        ("copies.tails", json!({ "machineId": "m1" })),
        ("machines.list", json!({})),
        // Nobody listens on port 1: the error the screens show (pairing itself is in `pairing.rs`).
        (
            "machines.pair",
            json!({ "address": "127.0.0.1", "port": 1, "code": "ABCD-EFGH-JKMN", "deviceName": "Phone" }),
        ),
        (
            "machines.update",
            json!({ "machineId": "m1", "name": "Desk" }),
        ),
        (
            "machines.unlock",
            json!({ "machineId": "m1", "token": "a".repeat(64) }),
        ),
        (
            "machines.remove",
            json!({ "machineId": "m1", "revoke": true }),
        ),
        ("power.list", json!({})),
        // No machine here, so no plug: the errors the screens show (Turn on itself is in `power.rs`).
        (
            "power.configure",
            json!({ "machineId": "m1", "config": { "kind": "tasmota-zigbee", "address": "192.0.2.20", "device": "DeskPlug" }, "password": "p" }),
        ),
        ("power.reading", json!({ "machineId": "m1" })),
        ("power.turnOn", json!({ "machineId": "m1" })),
        (
            "power.unlock",
            json!({ "machineId": "m1", "password": "p" }),
        ),
        (
            "power.noteMeasurement",
            json!({ "machineId": "m1", "kind": "running", "watts": 48.5 }),
        ),
        // Somewhere that refuses at once (never GitHub from a test): the error the screens ignore.
        ("update.latest", json!({})),
        (
            "alerts.setActive",
            json!({ "machineId": "m1", "sessionId": "s1" }),
        ),
        ("alerts.setActive", json!(null)),
    ]
}

/// What changes from run to run (a new data dir, a release) is replaced, so the fixtures don't.
fn steady(method: &str, mut result: Value) -> Value {
    if method == "hello" {
        assert_eq!(result["serviceVersion"], env!("CARGO_PKG_VERSION"));
        result["serviceVersion"] = json!("0.0.0");
        assert!(
            result["machine"]["id"]
                .as_str()
                .is_some_and(|id| id.len() == 36)
        );
        result["machine"]["id"] = json!("00000000-0000-4000-8000-000000000000");
    }
    result
}

/// The fixture files, by name, as the core answers now.
fn answers() -> BTreeMap<String, Value> {
    // SAFETY: this binary's only test, before the core (and its threads) start.
    unsafe { std::env::set_var("THREADGARDEN_RELEASES_URL", "https://127.0.0.1:1/latest") };
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    let answered: BTreeSet<&str> = core.answered_methods().into_iter().collect();
    let mut by_method: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    block_on(async {
        let mut ws = open(&core).await;
        for (i, (method, params)) in cases().into_iter().enumerate() {
            let answer = call(&mut ws, i as u64 + 1, method, params.clone()).await;
            let case = match (answer.get("result"), answer.get("error")) {
                (Some(result), None) => {
                    json!({ "params": params, "result": steady(method, result.clone()) })
                }
                (None, Some(error)) => {
                    json!({ "params": params, "error": { "code": error["code"] } })
                }
                _ => panic!("{method}: {answer}"),
            };
            by_method.entry(method.to_string()).or_default().push(case);
        }
    });
    core.stop();
    let tried: BTreeSet<&str> = by_method.keys().map(String::as_str).collect();
    assert_eq!(
        tried, answered,
        "every method the core answers has a case, and only those"
    );

    let mut files: BTreeMap<String, Value> = by_method
        .into_iter()
        .map(|(method, cases)| {
            (
                format!("{method}.json"),
                json!({ "method": method, "cases": cases }),
            )
        })
        .collect();
    files.insert(
        "methods.json".into(),
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "maxRequestBytes": MAX_REQUEST_BYTES,
            "answered": answered,
            "refused": REFUSED.iter().collect::<BTreeSet<_>>(),
        }),
    );
    files
}

fn on_disk(dir: &Path) -> BTreeMap<String, Value> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return BTreeMap::new();
    };
    entries
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| {
            let text = std::fs::read_to_string(&p).unwrap();
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            let value = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
            (name, value)
        })
        .collect()
}

#[test]
fn the_contract_fixtures_match_the_answers() {
    let dir = fixtures_dir();
    let now = answers();
    if std::env::var_os("THREADGARDEN_WRITE_FIXTURES").is_some() {
        std::fs::create_dir_all(&dir).unwrap();
        for name in on_disk(&dir).keys() {
            if !now.contains_key(name) {
                std::fs::remove_file(dir.join(name)).unwrap();
            }
        }
        for (name, value) in &now {
            let text = serde_json::to_string_pretty(value).unwrap() + "\n";
            std::fs::write(dir.join(name), text).unwrap();
        }
        return;
    }
    // Compared as values: a reformatting (prettier) doesn't make them stale.
    assert!(
        on_disk(&dir) == now,
        "The core's answers no longer match {}. Run `THREADGARDEN_WRITE_FIXTURES=1 cargo test --test contract` \
         in apps/desktop/src-tauri/core, then the protocol tests.",
        dir.display()
    );
}
