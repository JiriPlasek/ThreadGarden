//! Pairing with a machine, as `machine/pairing-client.ts` does it: the
//! machine proves it knows the code for the certificate it shows, and only
//! then is the code sent. The token goes to `Secrets`, never to the store.

#[path = "support/machine.rs"]
mod machine;
mod support;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::SinkExt;
use machine::{Behaviour, FakeMachine};
use serde_json::{Value, json};
use support::{Next, Ws, block_on, call, core_with_secrets, next, open};
use threadgarden_core::secrets::Secrets;
use tokio_tungstenite::tungstenite::Message;

const CODE: &str = "abcd-efgh-jkmn";

fn pair_params(port: u16, code: &str) -> Value {
    json!({ "address": "127.0.0.1", "port": port, "code": code, "deviceName": "Phone" })
}

/// Sends a request; its answer and the events that came before it.
async fn call_with_events(
    ws: &mut Ws,
    id: u64,
    method: &str,
    params: Value,
) -> (Value, Vec<Value>) {
    ws.send(Message::text(
        json!({ "id": id, "method": method, "params": params }).to_string(),
    ))
    .await
    .unwrap();
    let mut events = Vec::new();
    loop {
        match next(ws).await {
            Next::Frame(v) if v["id"] == json!(id) => return (v, events),
            Next::Frame(v) => events.push(v),
            other => panic!("no answer to {method}: {other:?}"),
        }
    }
}

/// Waits for `machines.changed` with `want`: among `seen`, or still to come
/// (an event may arrive just after the answer it goes with).
async fn changed_to(ws: &mut Ws, seen: &[Value], want: Value) {
    let is_it = |e: &Value| e["event"] == "machines.changed" && e["data"] == want;
    if seen.iter().any(is_it) {
        return;
    }
    loop {
        match next(ws).await {
            Next::Frame(e) if is_it(&e) => return,
            Next::Frame(_) => continue,
            other => panic!("no machines.changed with {want}: {other:?}"),
        }
    }
}

/// Every file under `dir`, as text.
fn files_under(dir: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(files_under(&path));
        } else {
            let text = String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned();
            out.push((path.display().to_string(), text));
        }
    }
    out
}

#[test]
fn a_good_machine_pairs_and_its_token_is_stored_as_a_secret() {
    let dir = tempfile::tempdir().unwrap();
    let (core, secrets) = core_with_secrets(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    block_on(async {
        let mut ws = open(&core).await;
        let (answer, events) =
            call_with_events(&mut ws, 1, "machines.pair", pair_params(desk.port, CODE)).await;
        let result = &answer["result"];
        let listed = json!({
            "id": "machine-desk",
            "name": "Desk",
            "address": "127.0.0.1",
            "port": desk.port,
            "fingerprint": desk.fingerprint,
            "addedAt": result["machine"]["addedAt"],
            "unlocked": true,
        });
        assert_eq!(result["machine"], listed, "{answer}");
        assert!(result["machine"]["addedAt"].as_u64().is_some_and(|t| t > 0));
        // Returned this once, as the protocol has it.
        assert_eq!(result["token"], desk.token);
        assert_eq!(
            secrets.get("machine-token:machine-desk"),
            Ok(Some(desk.token.clone()))
        );
        // Proof first, then the code (normalised), and nothing else.
        assert_eq!(desk.methods(), ["pair.proof", "pair.claim"]);
        assert_eq!(desk.protocols(), ["threadgarden-pair"]);
        let claim: Value = serde_json::from_str(&desk.frames()[1]).unwrap();
        assert_eq!(
            claim["params"],
            json!({ "code": "ABCDEFGHJKMN", "deviceName": "Phone" })
        );
        // The other screens hear of it.
        changed_to(&mut ws, &events, json!([listed])).await;

        let list = call(&mut ws, 2, "machines.list", json!({})).await;
        assert_eq!(list["result"], json!([listed]));
    });
    core.stop();
}

#[test]
fn a_machine_failing_the_proof_never_gets_the_code() {
    let dir = tempfile::tempdir().unwrap();
    let (core, secrets) = core_with_secrets(dir.path());
    // It shows another code, so it can't prove this one.
    let liar = FakeMachine::start(Behaviour {
        code: Some("ZZZZZZZZZZZZ".into()),
        ..Behaviour::default()
    });
    // No code out at all: its proof is null.
    let blank = FakeMachine::start(Behaviour {
        code: None,
        ..Behaviour::default()
    });
    block_on(async {
        let mut ws = open(&core).await;
        let answer = call(&mut ws, 1, "machines.pair", pair_params(liar.port, CODE)).await;
        assert_eq!(
            answer["error"],
            json!({ "code": "PAIRING_PROOF_FAILED",
                    "message": "The machine could not prove it knows the pairing code; the code was not sent" })
        );
        assert_eq!(liar.methods(), ["pair.proof"]);
        for frame in liar.frames() {
            assert!(
                !frame
                    .to_uppercase()
                    .replace('-', "")
                    .contains("ABCDEFGHJKMN"),
                "{frame}"
            );
        }
        let answer = call(&mut ws, 2, "machines.pair", pair_params(blank.port, CODE)).await;
        // 503 on the pairing socket: no code is out.
        assert_eq!(answer["error"]["code"], "PAIRING_INVALID");
        assert!(blank.methods().is_empty());
        assert_eq!(
            call(&mut ws, 3, "machines.list", json!({})).await["result"],
            json!([])
        );
    });
    assert_eq!(secrets.get("machine-token:machine-desk"), Ok(None));
    core.stop();
}

#[test]
fn a_relayed_proof_under_another_certificate_fails() {
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core_with_secrets(dir.path());
    let real = FakeMachine::start(Behaviour::default());
    // In the middle: it knows the code (it relays the real machine's proof), under its own certificate.
    let middle = FakeMachine::start(Behaviour {
        proof_fingerprint: Some(real.fingerprint.clone()),
        ..Behaviour::default()
    });
    block_on(async {
        let mut ws = open(&core).await;
        let answer = call(&mut ws, 1, "machines.pair", pair_params(middle.port, CODE)).await;
        assert_eq!(answer["error"]["code"], "PAIRING_PROOF_FAILED");
        assert_eq!(middle.methods(), ["pair.proof"]);
    });
    core.stop();
}

#[test]
fn the_wrong_code_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core_with_secrets(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    let expired = FakeMachine::start(Behaviour {
        claim_error: Some("PAIRING_EXPIRED"),
        ..Behaviour::default()
    });
    block_on(async {
        let mut ws = open(&core).await;
        // Not a code at all: refused here, without a connection.
        for (i, bad) in ["ABCD-EFGH", "ABCD-EFGH-JKM0", "ABCD-EFGH-JKMNP"]
            .into_iter()
            .enumerate()
        {
            let answer = call(
                &mut ws,
                i as u64 + 1,
                "machines.pair",
                pair_params(desk.port, bad),
            )
            .await;
            assert_eq!(
                answer["error"],
                json!({ "code": "PAIRING_INVALID", "message": "The pairing code is not valid" }),
                "{bad}"
            );
        }
        assert_eq!(desk.connections(), 0);
        // A well-formed but wrong code: the machine can't prove it, and says nothing more.
        let answer = call(
            &mut ws,
            10,
            "machines.pair",
            pair_params(desk.port, "ZZZZ-ZZZZ-ZZZZ"),
        )
        .await;
        assert_eq!(answer["error"]["code"], "PAIRING_PROOF_FAILED");
        // The machine's own refusal of the claim comes through.
        let answer = call(
            &mut ws,
            11,
            "machines.pair",
            pair_params(expired.port, CODE),
        )
        .await;
        assert_eq!(
            answer["error"],
            json!({ "code": "PAIRING_EXPIRED", "message": "The pairing code has expired" })
        );
        // Nobody there.
        let gone = {
            let mut m = FakeMachine::start(Behaviour::default());
            let p = m.port;
            m.stop();
            p
        };
        let answer = call(&mut ws, 12, "machines.pair", pair_params(gone, CODE)).await;
        assert_eq!(
            answer["error"],
            json!({ "code": "PAIRING_UNREACHABLE", "message": "The machine could not be reached" })
        );
    });
    core.stop();
}

#[test]
fn an_already_paired_machine_is_refused_before_the_code_goes() {
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core_with_secrets(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    let again = FakeMachine::start(Behaviour::default());
    block_on(async {
        let mut ws = open(&core).await;
        let first = call(&mut ws, 1, "machines.pair", pair_params(desk.port, CODE)).await;
        assert!(first.get("result").is_some(), "{first}");
        // The same machine (by id) answering elsewhere.
        let answer = call(&mut ws, 2, "machines.pair", pair_params(again.port, CODE)).await;
        assert_eq!(
            answer["error"],
            json!({ "code": "PAIRING_DUPLICATE", "message": "Already paired as Desk" })
        );
        assert_eq!(again.methods(), ["pair.proof"]);

        // This phone itself.
        let me = call(
            &mut ws,
            3,
            "hello",
            json!({ "protocolVersion": 11, "client": "t" }),
        )
        .await;
        let my_id = me["result"]["machine"]["id"].as_str().unwrap().to_string();
        let mirror = FakeMachine::start(Behaviour {
            machine_id: my_id,
            ..Behaviour::default()
        });
        let answer = call(&mut ws, 4, "machines.pair", pair_params(mirror.port, CODE)).await;
        assert_eq!(
            answer["error"],
            json!({ "code": "PAIRING_SELF", "message": "This is this machine" })
        );
        assert_eq!(mirror.methods(), ["pair.proof"]);
    });
    core.stop();
}

#[test]
fn removing_forgets_the_token_first_then_revokes_if_reachable() {
    let dir = tempfile::tempdir().unwrap();
    let (core, secrets) = core_with_secrets(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    let forgotten_first = Arc::new(AtomicBool::new(false));
    {
        let (secrets, flag, store) = (
            secrets.clone(),
            forgotten_first.clone(),
            dir.path().join("core.json"),
        );
        desk.on_revoke(move || {
            let gone = secrets.get("machine-token:machine-desk") == Ok(None)
                && !std::fs::read_to_string(&store)
                    .unwrap()
                    .contains("machine-desk");
            flag.store(gone, Ordering::SeqCst);
        });
    }
    block_on(async {
        let mut ws = open(&core).await;
        assert!(
            call(&mut ws, 1, "machines.pair", pair_params(desk.port, CODE))
                .await
                .get("result")
                .is_some()
        );
        let (answer, events) = call_with_events(
            &mut ws,
            2,
            "machines.remove",
            json!({ "machineId": "machine-desk", "revoke": true }),
        )
        .await;
        assert_eq!(answer["result"], json!({ "revoked": true }));
        assert!(
            forgotten_first.load(Ordering::SeqCst),
            "the machine was asked before it was forgotten"
        );
        // Over the pinned link, as this device, for its own id.
        assert_eq!(
            desk.protocols().last().unwrap(),
            &format!("threadgarden-device.{}", desk.token)
        );
        let revoke: Value = serde_json::from_str(desk.frames().last().unwrap()).unwrap();
        assert_eq!(revoke["method"], "devices.revoke");
        assert_eq!(revoke["params"], json!({ "deviceId": desk.device_id }));
        changed_to(&mut ws, &events, json!([])).await;
        assert_eq!(
            call(&mut ws, 3, "machines.list", json!({})).await["result"],
            json!([])
        );
    });

    // Unreachable: forgotten all the same, `revoked: false`.
    let mut away = FakeMachine::start(Behaviour {
        machine_id: "machine-away".into(),
        ..Behaviour::default()
    });
    block_on(async {
        let mut ws = open(&core).await;
        assert!(
            call(&mut ws, 1, "machines.pair", pair_params(away.port, CODE))
                .await
                .get("result")
                .is_some()
        );
        away.stop();
        let answer = call(
            &mut ws,
            2,
            "machines.remove",
            json!({ "machineId": "machine-away", "revoke": true }),
        )
        .await;
        assert_eq!(answer["result"], json!({ "revoked": false }));
        assert_eq!(
            call(&mut ws, 3, "machines.list", json!({})).await["result"],
            json!([])
        );
    });
    assert_eq!(secrets.get("machine-token:machine-away"), Ok(None));
    core.stop();
}

#[test]
fn tokens_never_reach_the_store_file_or_a_log() {
    let dir = tempfile::tempdir().unwrap();
    let (core, secrets) = core_with_secrets(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    block_on(async {
        let mut ws = open(&core).await;
        assert!(
            call(&mut ws, 1, "machines.pair", pair_params(desk.port, CODE))
                .await
                .get("result")
                .is_some()
        );
        let renamed = call(
            &mut ws,
            2,
            "machines.update",
            json!({ "machineId": "machine-desk", "name": "Study" }),
        )
        .await;
        assert_eq!(renamed["result"]["name"], "Study", "{renamed}");
    });
    core.stop();
    assert_eq!(
        secrets.get("machine-token:machine-desk"),
        Ok(Some(desk.token.clone()))
    );
    let files = files_under(dir.path());
    assert!(!files.is_empty());
    for (path, text) in files {
        assert!(!text.contains(&desk.token), "the token is in {path}");
        assert!(!text.contains("ABCDEFGHJKMN"), "the code is in {path}");
    }
    // Nor in what the core shows of itself.
    assert!(!format!("{core:?}").contains(&desk.token));
}

#[test]
fn a_machine_is_renamed_and_moved_its_pin_kept() {
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core_with_secrets(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    block_on(async {
        let mut ws = open(&core).await;
        assert!(
            call(&mut ws, 1, "machines.pair", pair_params(desk.port, CODE))
                .await
                .get("result")
                .is_some()
        );
        let moved = call(
            &mut ws,
            2,
            "machines.update",
            json!({ "machineId": "machine-desk", "name": "  Study  ", "address": "desk.local", "port": 47381 }),
        )
        .await;
        let m = &moved["result"];
        assert_eq!(
            (m["name"].clone(), m["address"].clone(), m["port"].clone()),
            (json!("Study"), json!("desk.local"), json!(47381))
        );
        assert_eq!(m["fingerprint"], desk.fingerprint);
        for (i, bad) in [
            json!({ "machineId": "machine-desk", "name": "" }),
            json!({ "machineId": "machine-desk", "name": "x".repeat(41) }),
            json!({ "machineId": "machine-desk", "address": "no spaces" }),
            json!({ "machineId": "machine-desk", "port": 0 }),
        ]
        .into_iter()
        .enumerate()
        {
            let answer = call(&mut ws, 10 + i as u64, "machines.update", bad.clone()).await;
            assert_eq!(answer["error"]["code"], "INVALID_PARAMS", "{bad}");
        }
        let answer = call(
            &mut ws,
            20,
            "machines.update",
            json!({ "machineId": "nope", "name": "X" }),
        )
        .await;
        assert_eq!(
            answer["error"],
            json!({ "code": "NOT_FOUND", "message": "No such machine" })
        );
        let answer = call(
            &mut ws,
            21,
            "machines.unlock",
            json!({ "machineId": "machine-desk", "token": "a".repeat(64) }),
        )
        .await;
        assert_eq!(answer["result"], json!({}));
    });
    core.stop();
}

#[test]
fn a_revoke_answered_by_a_4403_close_counts_as_revoked() {
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core_with_secrets(dir.path());
    let desk = FakeMachine::start(Behaviour {
        revoke_closes: true,
        ..Behaviour::default()
    });
    block_on(async {
        let mut ws = open(&core).await;
        assert!(
            call(&mut ws, 1, "machines.pair", pair_params(desk.port, CODE))
                .await
                .get("result")
                .is_some()
        );
        let answer = call(
            &mut ws,
            2,
            "machines.remove",
            json!({ "machineId": "machine-desk", "revoke": true }),
        )
        .await;
        assert_eq!(answer["result"], json!({ "revoked": true }));
    });
    core.stop();
}

/// Secrets that can't be written (a Keystore key that's gone).
struct Unwritable;

impl Secrets for Unwritable {
    fn get(&self, _: &str) -> Result<Option<String>, threadgarden_core::secrets::SecretsError> {
        Ok(None)
    }
    fn set(&self, _: &str, _: &str) -> Result<(), threadgarden_core::secrets::SecretsError> {
        Err(threadgarden_core::secrets::SecretsError(
            "no keystore".into(),
        ))
    }
    fn delete(&self, _: &str) -> Result<(), threadgarden_core::secrets::SecretsError> {
        Ok(())
    }
}

#[test]
fn a_pairing_that_cant_be_kept_is_undone_on_the_machine() {
    let dir = tempfile::tempdir().unwrap();
    let config = threadgarden_core::CoreConfig {
        secrets: Arc::new(Unwritable),
        ..support::config(dir.path())
    };
    let core = threadgarden_core::Core::spawn(config).unwrap();
    let desk = FakeMachine::start(Behaviour::default());
    block_on(async {
        let mut ws = open(&core).await;
        let answer = call(&mut ws, 1, "machines.pair", pair_params(desk.port, CODE)).await;
        assert_eq!(answer["error"]["code"], "INTERNAL", "{answer}");
        assert_eq!(
            call(&mut ws, 2, "machines.list", json!({})).await["result"],
            json!([])
        );
        // The machine is asked to forget the device it just made.
        let asked = async {
            while !desk.methods().contains(&"devices.revoke".to_string()) {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(5), asked)
            .await
            .expect("devices.revoke");
    });
    core.stop();
}

#[test]
fn removing_a_machine_moved_to_an_impostor_sends_it_no_token() {
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core_with_secrets(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    let impostor = FakeMachine::start(Behaviour::default());
    block_on(async {
        let mut ws = open(&core).await;
        assert!(
            call(&mut ws, 1, "machines.pair", pair_params(desk.port, CODE))
                .await
                .get("result")
                .is_some()
        );
        let moved = call(
            &mut ws,
            2,
            "machines.update",
            json!({ "machineId": "machine-desk", "port": impostor.port }),
        )
        .await;
        assert!(moved.get("result").is_some(), "{moved}");
        let answer = call(
            &mut ws,
            3,
            "machines.remove",
            json!({ "machineId": "machine-desk", "revoke": true }),
        )
        .await;
        assert_eq!(answer["result"], json!({ "revoked": false }));
    });
    // The pinned link failed in the TLS handshake: no upgrade, so no token, and no frame.
    assert!(impostor.connections() >= 1);
    assert!(
        impostor.protocols().is_empty(),
        "{:?}",
        impostor.protocols()
    );
    assert!(impostor.frames().is_empty());
    core.stop();
}

#[test]
fn pairing_with_a_machine_that_stops_answering_ends_by_its_deadline() {
    let dir = tempfile::tempdir().unwrap();
    let deadline = std::time::Duration::from_millis(600);
    let timing = threadgarden_core::Timing {
        pairing: deadline,
        ..threadgarden_core::Timing::default()
    };
    let core =
        threadgarden_core::Core::spawn_with_timing(support::config(dir.path()), timing).unwrap();
    let silent = FakeMachine::start(Behaviour {
        stall_pairing: true,
        ..Behaviour::default()
    });
    block_on(async {
        let mut ws = open(&core).await;
        let started = std::time::Instant::now();
        let answer = call(&mut ws, 1, "machines.pair", pair_params(silent.port, CODE)).await;
        let took = started.elapsed();
        assert_eq!(answer["error"]["code"], "PAIRING_UNREACHABLE", "{answer}");
        // The deadline covers closing the socket too.
        assert!(
            took < deadline + std::time::Duration::from_millis(300),
            "took {took:?}"
        );
    });
    core.stop();
}

/// Secrets that count their reads (a Keystore call each, on Android).
#[derive(Default)]
struct Counting {
    inner: threadgarden_core::secrets::MemorySecrets,
    gets: std::sync::atomic::AtomicUsize,
}

impl Secrets for Counting {
    fn get(&self, key: &str) -> Result<Option<String>, threadgarden_core::secrets::SecretsError> {
        self.gets.fetch_add(1, Ordering::SeqCst);
        self.inner.get(key)
    }
    fn set(&self, key: &str, value: &str) -> Result<(), threadgarden_core::secrets::SecretsError> {
        self.inner.set(key, value)
    }
    fn delete(&self, key: &str) -> Result<(), threadgarden_core::secrets::SecretsError> {
        self.inner.delete(key)
    }
}

#[test]
fn listing_machines_never_asks_the_keystore() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(Counting::default());
    let config = threadgarden_core::CoreConfig {
        secrets: secrets.clone(),
        ..support::config(dir.path())
    };
    let core = threadgarden_core::Core::spawn(config).unwrap();
    let desk = FakeMachine::start(Behaviour::default());
    block_on(async {
        let mut ws = open(&core).await;
        assert!(
            call(&mut ws, 1, "machines.pair", pair_params(desk.port, CODE))
                .await
                .get("result")
                .is_some()
        );
        let before = secrets.gets.load(Ordering::SeqCst);
        for id in 2..7 {
            let list = call(&mut ws, id, "machines.list", json!({})).await;
            assert_eq!(list["result"][0]["unlocked"], true);
        }
        assert_eq!(secrets.gets.load(Ordering::SeqCst), before);
    });
    core.stop();
}

#[cfg(unix)]
#[test]
fn a_remove_the_store_cant_write_keeps_the_token() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let (core, secrets) = core_with_secrets(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    block_on(async {
        let mut ws = open(&core).await;
        assert!(
            call(&mut ws, 1, "machines.pair", pair_params(desk.port, CODE))
                .await
                .get("result")
                .is_some()
        );
        // The store can't be written now (a full disk, say).
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
        let answer = call(
            &mut ws,
            2,
            "machines.remove",
            json!({ "machineId": "machine-desk", "revoke": true }),
        )
        .await;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(answer["error"]["code"], "INTERNAL", "{answer}");
        // Still paired, still with its token (so it can be removed, and revoked, again).
        assert_eq!(
            call(&mut ws, 3, "machines.list", json!({})).await["result"][0]["unlocked"],
            true
        );
        assert!(!desk.methods().contains(&"devices.revoke".to_string()));
        let again = call(
            &mut ws,
            4,
            "machines.remove",
            json!({ "machineId": "machine-desk", "revoke": true }),
        )
        .await;
        assert_eq!(again["result"], json!({ "revoked": true }));
    });
    assert_eq!(secrets.get("machine-token:machine-desk"), Ok(None));
    core.stop();
}
