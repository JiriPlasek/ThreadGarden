//! `/relay?machine=<id>`: a screen's socket piped to the machine over a link
//! pinned to its certificate, as the service's `server/relay.ts`. Frames go
//! through verbatim; the screen learns why a relay ended from `RELAY_CLOSE`:
//! 4404 locked, 4409 another certificate, 4403 refused, 4502 unreachable.

#[path = "support/machine.rs"]
mod machine;
mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::SinkExt;
use machine::{Behaviour, FakeMachine};
use serde_json::json;
use support::{Next, Ws, block_on, call, config, next, open, open_with};
use threadgarden_core::secrets::{MemorySecrets, Secrets};
use threadgarden_core::{Core, CoreConfig, CoreEvent, CoreHandle, Timing};
use tokio_tungstenite::tungstenite::Message;

/// Short enough for a test, the same rules as the 10 s and 15 s of the service.
const LINK_TIMEOUT: Duration = Duration::from_millis(600);
const PING: Duration = Duration::from_millis(200);

fn core(dir: &std::path::Path) -> (CoreHandle, Arc<MemorySecrets>) {
    let secrets = Arc::new(MemorySecrets::default());
    let config = CoreConfig {
        secrets: secrets.clone(),
        ..config(dir)
    };
    let timing = Timing {
        link_timeout: LINK_TIMEOUT,
        ping: PING,
        ..Timing::default()
    };
    let core = Core::spawn_with_timing(config, timing).unwrap();
    // Only the screens' relays here: the alert links (`alerts.rs`) would be machines' sockets too.
    core.disconnect().unwrap();
    (core, secrets)
}

/// Pairs the core with `machine` (its id is `machine-desk` unless the behaviour says otherwise).
async fn pair(core: &CoreHandle, machine: &FakeMachine) {
    let mut ws = open(core).await;
    let params = json!({ "address": "127.0.0.1", "port": machine.port, "code": "ABCD-EFGH-JKMN", "deviceName": "Phone" });
    let answer = call(&mut ws, 1, "machines.pair", params).await;
    assert!(answer.get("result").is_some(), "{answer}");
}

async fn relay(core: &CoreHandle, machine_id: &str) -> Ws {
    let protocols = [format!("threadgarden.{}", core.token())];
    open_with(
        core.port(),
        &format!("/relay?machine={machine_id}"),
        &protocols,
    )
    .await
    .expect("the relay socket opens")
}

/// How the relay socket ends, and when.
async fn closes(ws: &mut Ws) -> (Option<u16>, Instant) {
    loop {
        match next(ws).await {
            Next::Closed(code) => return (code, Instant::now()),
            Next::Frame(_) => continue,
            other => panic!("not closed: {other:?}"),
        }
    }
}

#[test]
fn frames_pass_through_verbatim_both_ways() {
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    block_on(async {
        pair(&core, &desk).await;
        let mut ws = relay(&core, "machine-desk").await;
        // Sent at once, before the link can be up: they wait for it, in order.
        let odd = "{ \"id\":1,  \"method\" : \"chat.open\" ,\"params\":{\"x\":\"\\u00e9\"} }";
        ws.send(Message::text(odd)).await.unwrap();
        let bytes: Vec<u8> = vec![0, 159, 146, 150, 255, 1];
        ws.send(Message::binary(bytes.clone())).await.unwrap();
        ws.send(Message::text("not json at all")).await.unwrap();
        let mut back = Vec::new();
        while back.len() < 3 {
            match tokio::time::timeout(
                Duration::from_secs(5),
                futures_util::StreamExt::next(&mut ws),
            )
            .await
            {
                Ok(Some(Ok(m @ (Message::Text(_) | Message::Binary(_))))) => back.push(m),
                Ok(Some(Ok(_))) => continue,
                other => panic!("{other:?}"),
            }
        }
        // The machine got exactly what the screen sent, and the screen what the machine sent.
        // (After pairing's `pair.proof` and `pair.claim`.)
        assert_eq!(desk.frames()[2..], [odd, "not json at all"]);
        assert_eq!(desk.binaries(), std::slice::from_ref(&bytes));
        assert_eq!(
            back,
            [
                Message::text(odd),
                Message::binary(bytes),
                Message::text("not json at all")
            ]
        );
        assert_eq!(
            desk.protocols().last().unwrap(),
            &format!("threadgarden-device.{}", desk.token)
        );
    });
    core.stop();
}

#[test]
fn a_different_certificate_gets_no_token() {
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    let other = FakeMachine::start(Behaviour::default());
    block_on(async {
        pair(&core, &desk).await;
        // The address now answers with another certificate.
        let mut ws = open(&core).await;
        let moved = call(
            &mut ws,
            2,
            "machines.update",
            json!({ "machineId": "machine-desk", "port": other.port }),
        )
        .await;
        assert!(moved.get("result").is_some(), "{moved}");
        let mut relayed = relay(&core, "machine-desk").await;
        relayed.send(Message::text("{\"id\":1}")).await.unwrap();
        assert_eq!(closes(&mut relayed).await.0, Some(4409));
    });
    // It got a TCP connection and a TLS hello, never the upgrade (and the token in it).
    assert!(other.connections() >= 1);
    assert!(other.protocols().is_empty(), "{:?}", other.protocols());
    assert!(other.frames().is_empty());
    core.stop();
}

#[test]
fn a_revoked_device_closes_4403() {
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path());
    for (i, code) in [4403, 4401].into_iter().enumerate() {
        let id = format!("machine-{i}");
        let desk = FakeMachine::start(Behaviour {
            machine_id: id.clone(),
            device_close: Some(code),
            ..Behaviour::default()
        });
        block_on(async {
            pair(&core, &desk).await;
            let mut ws = relay(&core, &id).await;
            assert_eq!(
                closes(&mut ws).await.0,
                Some(4403),
                "the machine closed {code}"
            );
        });
    }
    core.stop();
}

#[test]
fn no_token_here_closes_4404() {
    let dir = tempfile::tempdir().unwrap();
    let (core, secrets) = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    block_on(async {
        // An unknown machine, and none named.
        for path in ["/relay?machine=nope", "/relay"] {
            let protocols = [format!("threadgarden.{}", core.token())];
            let mut ws = open_with(core.port(), path, &protocols).await.unwrap();
            assert_eq!(closes(&mut ws).await.0, Some(4404), "{path}");
        }
        // A known machine whose token is gone.
        pair(&core, &desk).await;
        secrets.delete("machine-token:machine-desk").unwrap();
        let mut ws = relay(&core, "machine-desk").await;
        assert_eq!(closes(&mut ws).await.0, Some(4404));
    });
    // The machine was never asked for a device socket.
    assert_eq!(desk.protocols(), ["threadgarden-pair"]);
    core.stop();
}

#[test]
fn frames_sent_before_the_link_is_up_wait_10_s_then_4502() {
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    // Takes the TCP connection and never says a word (a machine waking up).
    let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let silent_port = silent.local_addr().unwrap().port();
    block_on(async {
        pair(&core, &desk).await;
        let mut ws = open(&core).await;
        call(
            &mut ws,
            2,
            "machines.update",
            json!({ "machineId": "machine-desk", "port": silent_port }),
        )
        .await;
        let mut relayed = relay(&core, "machine-desk").await;
        let started = Instant::now();
        relayed
            .send(Message::text("{\"id\":1,\"method\":\"hello\"}"))
            .await
            .unwrap();
        let (code, at) = closes(&mut relayed).await;
        assert_eq!(code, Some(4502));
        let waited = at - started;
        assert!(
            waited >= LINK_TIMEOUT - Duration::from_millis(50),
            "closed after {waited:?}"
        );
        assert!(waited < LINK_TIMEOUT * 3, "closed after {waited:?}");
    });
    drop(silent);
    core.stop();
}

#[test]
fn the_link_waits_ten_seconds_by_default() {
    assert_eq!(Timing::default().link_timeout, Duration::from_secs(10));
    assert_eq!(Timing::default().ping, Duration::from_secs(15));
}

#[test]
fn a_dead_link_is_noticed_within_two_pings() {
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path());
    let desk = FakeMachine::start(Behaviour {
        stall: true,
        ..Behaviour::default()
    });
    block_on(async {
        pair(&core, &desk).await;
        let mut ws = relay(&core, "machine-desk").await;
        let started = Instant::now();
        let (code, at) = closes(&mut ws).await;
        assert_eq!(code, Some(4502));
        let took = at - started;
        assert!(
            took >= PING * 2,
            "closed after {took:?}: before the first ping's pong was due"
        );
        assert!(took <= PING * 3, "closed after {took:?}");
    });
    core.stop();
}

#[test]
fn moving_a_machine_closes_its_relays_4502() {
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    block_on(async {
        pair(&core, &desk).await;
        let mut relayed = relay(&core, "machine-desk").await;
        relayed.send(Message::text("{\"n\":1}")).await.unwrap();
        // Up: the machine echoes it.
        assert!(matches!(next(&mut relayed).await, Next::Frame(v) if v == json!({ "n": 1 })));
        let mut ws = open(&core).await;
        // A rename keeps it.
        call(
            &mut ws,
            2,
            "machines.update",
            json!({ "machineId": "machine-desk", "name": "Study" }),
        )
        .await;
        relayed.send(Message::text("{\"n\":2}")).await.unwrap();
        assert!(matches!(next(&mut relayed).await, Next::Frame(v) if v == json!({ "n": 2 })));
        // A move doesn't.
        call(
            &mut ws,
            3,
            "machines.update",
            json!({ "machineId": "machine-desk", "address": "localhost" }),
        )
        .await;
        assert_eq!(closes(&mut relayed).await.0, Some(4502));

        // Removing it closes the next one 4404.
        let mut relayed = relay(&core, "machine-desk").await;
        relayed.send(Message::text("{\"n\":3}")).await.unwrap();
        assert!(matches!(next(&mut relayed).await, Next::Frame(v) if v == json!({ "n": 3 })));
        call(
            &mut ws,
            4,
            "machines.remove",
            json!({ "machineId": "machine-desk", "revoke": false }),
        )
        .await;
        assert_eq!(closes(&mut relayed).await.0, Some(4404));
    });
    core.stop();
}

#[test]
fn a_certificate_date_error_reads_as_unreachable_not_another_machine() {
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path());
    let mut events = core.events();
    for (i, years) in [(2001, 2002), (2090, 2091)].into_iter().enumerate() {
        let id = format!("machine-{i}");
        let desk = FakeMachine::start(Behaviour {
            machine_id: id.clone(),
            valid_years: Some(years),
            ..Behaviour::default()
        });
        block_on(async {
            // Pairing takes any certificate, as the service's does.
            pair(&core, &desk).await;
            let mut ws = relay(&core, &id).await;
            assert_eq!(closes(&mut ws).await.0, Some(4502), "{years:?}");
        });
        // The token never went: the certificate failed before the upgrade.
        assert_eq!(desk.protocols(), ["threadgarden-pair"]);
        // Said why, for a log (never a token or a frame).
        let CoreEvent::LinkFailed { machine_id, reason } = events.try_recv().expect("an event")
        else {
            panic!("not a link failure")
        };
        assert_eq!(machine_id, id);
        assert!(reason.contains("certificate date check failed"), "{reason}");
        assert!(!reason.contains(&desk.token));
    }
    core.stop();
}

#[test]
fn a_healthy_link_stays_open_past_three_pings() {
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    block_on(async {
        pair(&core, &desk).await;
        let mut ws = relay(&core, "machine-desk").await;
        ws.send(Message::text("{\"n\":1}")).await.unwrap();
        assert!(matches!(next(&mut ws).await, Next::Frame(v) if v == json!({ "n": 1 })));
        // Pings go out and pongs come back: nothing ends.
        tokio::time::sleep(PING * 4).await;
        ws.send(Message::text("{\"n\":2}")).await.unwrap();
        assert!(matches!(next(&mut ws).await, Next::Frame(v) if v == json!({ "n": 2 })));
    });
    core.stop();
}

/// Has the machine stream to every relay until about 32 MiB went out (or the link backs up).
fn stream_hard(desk: &FakeMachine) {
    let chunk = "x".repeat(512 * 1024);
    for seq in 0..64 {
        desk.emit(
            "chat.items",
            json!({ "sessionId": "s1", "seq": seq, "text": chunk }),
        );
    }
}

#[test]
fn a_screen_that_stops_reading_is_still_closed_by_a_move() {
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    block_on(async {
        pair(&core, &desk).await;
        let mut stalled = relay(&core, "machine-desk").await;
        stalled.send(Message::text("{\"n\":1}")).await.unwrap();
        assert!(matches!(next(&mut stalled).await, Next::Frame(_)));
        // The screen reads no more (a frozen webview) while the machine streams.
        stream_hard(&desk);
        tokio::time::sleep(Duration::from_millis(500)).await;
        let mut ws = open(&core).await;
        call(
            &mut ws,
            2,
            "machines.update",
            json!({ "machineId": "machine-desk", "port": 1 }),
        )
        .await;
        // The relay ends: its link to the machine closes, though the screen still doesn't read.
        let started = Instant::now();
        while desk.devices_open() > 0 {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "the relay is stuck"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        drop(stalled);
    });
    core.stop();
}

#[test]
fn a_screen_that_stops_reading_doesnt_hold_up_stopping() {
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    // One runtime for the screen throughout: it stays connected, unread.
    let rt = tokio::runtime::Runtime::new().unwrap();
    let stalled = rt.block_on(async {
        pair(&core, &desk).await;
        let mut stalled = relay(&core, "machine-desk").await;
        stalled.send(Message::text("{\"n\":1}")).await.unwrap();
        assert!(matches!(next(&mut stalled).await, Next::Frame(_)));
        stream_hard(&desk);
        tokio::time::sleep(Duration::from_millis(500)).await;
        stalled
    });
    let started = Instant::now();
    core.stop();
    // Every task ended by itself, well before the runtime's 2 s grace runs out.
    assert!(
        started.elapsed() < Duration::from_millis(1500),
        "stopping took {:?}",
        started.elapsed()
    );
    drop(stalled);
}

#[test]
fn stopping_the_core_closes_relays_1001() {
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    let rt = tokio::runtime::Runtime::new().unwrap();
    let mut ws = rt.block_on(async {
        pair(&core, &desk).await;
        let mut ws = relay(&core, "machine-desk").await;
        ws.send(Message::text("{\"n\":1}")).await.unwrap();
        assert!(matches!(next(&mut ws).await, Next::Frame(_)));
        ws
    });
    let stopping = std::thread::spawn(move || core.stop());
    rt.block_on(async { assert_eq!(closes(&mut ws).await.0, Some(1001)) });
    stopping.join().unwrap();
}

#[test]
fn more_than_32_mib_before_the_link_is_up_closes_1009() {
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let silent_port = silent.local_addr().unwrap().port();
    block_on(async {
        pair(&core, &desk).await;
        let mut ws = open(&core).await;
        call(
            &mut ws,
            2,
            "machines.update",
            json!({ "machineId": "machine-desk", "port": silent_port }),
        )
        .await;
        let mut relayed = relay(&core, "machine-desk").await;
        // Two frames under the screen's limit each, over it together.
        let big = "y".repeat(threadgarden_core::MAX_REQUEST_BYTES / 2 + 1);
        relayed.send(Message::text(big.clone())).await.unwrap();
        let _ = relayed.send(Message::text(big)).await;
        assert_eq!(closes(&mut relayed).await.0, Some(1009));
    });
    drop(silent);
    core.stop();
}

#[test]
fn the_screen_leaving_closes_the_link_1000() {
    let dir = tempfile::tempdir().unwrap();
    let (core, _) = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    block_on(async {
        pair(&core, &desk).await;
        let mut ws = relay(&core, "machine-desk").await;
        ws.send(Message::text("{\"n\":1}")).await.unwrap();
        assert!(matches!(next(&mut ws).await, Next::Frame(_)));
        ws.close(None).await.unwrap();
        let started = Instant::now();
        while desk.closes().is_empty() {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "the link never closed"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    });
    assert_eq!(desk.closes(), [Some(1000)]);
    core.stop();
}

/// Secrets whose first read waits until the test lets it go (a slow Keystore).
struct Gated {
    inner: MemorySecrets,
    gate: std::sync::Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
}

impl Secrets for Gated {
    fn get(&self, key: &str) -> Result<Option<String>, threadgarden_core::secrets::SecretsError> {
        // Read now, handed back later: what a read that was under way gives.
        let value = self.inner.get(key);
        let gate = self.gate.lock().unwrap().take();
        if let Some((entered, release)) = gate {
            entered.send(()).unwrap();
            release.recv().unwrap();
        }
        value
    }
    fn set(&self, key: &str, value: &str) -> Result<(), threadgarden_core::secrets::SecretsError> {
        self.inner.set(key, value)
    }
    fn delete(&self, key: &str) -> Result<(), threadgarden_core::secrets::SecretsError> {
        self.inner.delete(key)
    }
}

#[test]
fn a_machine_removed_while_its_relay_starts_gets_no_link() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(Gated {
        inner: MemorySecrets::default(),
        gate: std::sync::Mutex::new(None),
    });
    let config = CoreConfig {
        secrets: secrets.clone(),
        ..config(dir.path())
    };
    let timing = Timing {
        link_timeout: LINK_TIMEOUT,
        ping: PING,
        ..Timing::default()
    };
    let core = Core::spawn_with_timing(config, timing).unwrap();
    core.disconnect().unwrap();
    let desk = FakeMachine::start(Behaviour::default());
    block_on(async {
        pair(&core, &desk).await;
        let (entered_tx, entered) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        *secrets.gate.lock().unwrap() = Some((entered_tx, release_rx));
        // The relay reads the token (and waits there) ...
        let mut relayed = relay(&core, "machine-desk").await;
        tokio::task::spawn_blocking(move || entered.recv().unwrap())
            .await
            .unwrap();
        // ... while the machine is removed.
        let mut ws = open(&core).await;
        let removed = call(
            &mut ws,
            1,
            "machines.remove",
            json!({ "machineId": "machine-desk", "revoke": false }),
        )
        .await;
        assert_eq!(removed["result"], json!({ "revoked": false }));
        release.send(()).unwrap();
        assert_eq!(closes(&mut relayed).await.0, Some(4404));
    });
    // No link was opened for it.
    assert_eq!(desk.protocols(), ["threadgarden-pair"]);
    core.stop();
}
