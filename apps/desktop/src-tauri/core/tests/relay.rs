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
    };
    (Core::spawn_with_timing(config, timing).unwrap(), secrets)
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
            took >= PING,
            "closed after {took:?}: before a ping went unanswered"
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
