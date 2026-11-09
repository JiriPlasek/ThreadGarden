//! The core as the UI sees it: a loopback WebSocket with a token, answering
//! the local methods the screens need.

mod support;

use std::net::{IpAddr, Ipv6Addr, SocketAddr, TcpStream, UdpSocket};
use std::time::Duration;

use futures_util::SinkExt;
use serde_json::{Value, json};
use support::{Next, block_on, call, core, next, open, open_with};
use threadgarden_core::MAX_REQUEST_BYTES;
use tokio_tungstenite::tungstenite::Message;

fn hello_params() -> Value {
    json!({ "protocolVersion": 11, "client": "threadgarden-desktop" })
}

#[test]
fn refuses_a_socket_without_the_token() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    block_on(async {
        let wrong = format!("threadgarden.{}", "0".repeat(64));
        // A subprotocol not ours isn't echoed, so that handshake fails (in a browser too).
        let other = vec!["other".to_string()];
        assert!(open_with(core.port(), "/", &other).await.is_err());
        for offered in [vec![], vec!["threadgarden.".to_string()], vec![wrong]] {
            // As the service does: the handshake completes, then the socket closes 4401 unanswered.
            let mut ws = open_with(core.port(), "/", &offered)
                .await
                .expect("the handshake completes");
            let _ = ws
                .send(Message::text(
                    json!({ "id": 1, "method": "hello", "params": hello_params() }).to_string(),
                ))
                .await;
            match next(&mut ws).await {
                Next::Closed(Some(4401)) => {}
                other => panic!("{offered:?} was not refused: {other:?}"),
            }
        }
        // The same token as the subprotocol works.
        let mut ws = open(&core).await;
        let answer = call(&mut ws, 1, "hello", hello_params()).await;
        assert_eq!(answer["result"]["protocolVersion"], 11);
    });
    core.stop();
}

/// An address of this host that is not loopback, when it has one.
fn outward_address() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    // A UDP connect only picks the route; nothing is sent (192.0.2.0/24 is TEST-NET-1).
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

#[test]
fn binds_only_127_0_0_1() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    let reach = |ip: IpAddr| {
        TcpStream::connect_timeout(&SocketAddr::new(ip, core.port()), Duration::from_secs(2))
            .is_ok()
    };
    assert!(reach(IpAddr::from([127, 0, 0, 1])));
    assert!(!reach(IpAddr::V6(Ipv6Addr::LOCALHOST)), "listening on ::1");
    // Another loopback address is not 127.0.0.1 either.
    assert!(
        !reach(IpAddr::from([127, 0, 0, 2])),
        "listening on all of 127/8"
    );
    if let Some(ip) = outward_address() {
        assert!(!reach(ip), "reachable at {ip}");
    }
    core.stop();
}

fn is_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.iter().map(|p| p.len()).eq([8, 4, 4, 4, 12])
        && parts.iter().all(|p| {
            p.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        })
}

#[test]
fn hello_says_protocol_11_and_an_empty_non_headless_machine() {
    let dir = tempfile::tempdir().unwrap();
    let first = core(dir.path());
    let hello = block_on(async {
        let mut ws = open(&first).await;
        call(&mut ws, 1, "hello", hello_params()).await["result"].clone()
    });
    first.stop();
    assert_eq!(hello["protocolVersion"], 11);
    assert_eq!(hello["serviceVersion"], env!("CARGO_PKG_VERSION"));
    let machine = &hello["machine"];
    let id = machine["id"].as_str().expect("an id").to_string();
    assert!(is_uuid(&id), "{id}");
    assert_eq!(
        machine,
        &json!({
            "id": id,
            "name": "Phone",
            // `MachineInfoSchema` has no `android`: see `methods::PLATFORM`.
            "platform": "linux",
            "headless": false,
            "home": "",
            "capabilities": [],
        })
    );

    // The id is kept: the same data dir says the same id after a restart, another one another.
    let again = core(dir.path());
    let other_dir = tempfile::tempdir().unwrap();
    let other = core(other_dir.path());
    let ids = block_on(async {
        let mut a = open(&again).await;
        let mut b = open(&other).await;
        (
            call(&mut a, 1, "hello", hello_params()).await["result"]["machine"]["id"].clone(),
            call(&mut b, 1, "hello", hello_params()).await["result"]["machine"]["id"].clone(),
        )
    });
    assert_eq!(ids.0, json!(id));
    assert_ne!(ids.1, json!(id));
    again.stop();
    other.stop();
}

#[test]
fn the_chat_lists_answer_empty() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    block_on(async {
        let mut ws = open(&core).await;
        let cases = [
            (
                "sessions.list",
                json!({ "place": { "kind": "active" }, "limit": 50 }),
                json!({ "items": [] }),
            ),
            (
                "sessions.list",
                json!({ "place": { "kind": "needsYou" }, "limit": 50 }),
                json!({ "items": [] }),
            ),
            (
                "sessions.summaries",
                json!({ "sessionIds": ["s1"] }),
                json!({ "items": [] }),
            ),
            (
                "places.counts",
                json!({}),
                json!({ "needsYou": 0, "running": 0, "all": 0, "active": 0, "onHold": 0, "archived": 0 }),
            ),
            ("projects.list", json!({}), json!([])),
            (
                "search.quick",
                json!({ "query": "a", "limit": 20 }),
                json!({ "items": [] }),
            ),
            ("scheduled.list", json!({}), json!({ "items": [] })),
            (
                "usage.get",
                json!({}),
                json!({ "windows": [], "refused": [] }),
            ),
            ("machines.list", json!({}), json!([])),
            ("power.list", json!({}), json!([])),
            ("away.list", json!({}), json!({ "items": [], "states": [] })),
            ("work.stopAll", json!({}), json!({ "stopped": 0 })),
        ];
        for (i, (method, params, want)) in cases.into_iter().enumerate() {
            let answer = call(&mut ws, i as u64 + 1, method, params).await;
            assert_eq!(answer["result"], want, "{method}: {answer}");
        }
    });
    core.stop();
}

#[test]
fn settings_and_ui_state_round_trip_across_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let first = core(dir.path());
    let (defaults, set) = block_on(async {
        let mut ws = open(&first).await;
        let defaults = call(&mut ws, 1, "settings.get", json!({})).await["result"].clone();
        let set = call(
            &mut ws,
            2,
            "settings.set",
            json!({ "theme": "dark", "accent": "teal", "idleShutdownMinutes": null, "codeFont": "Fira Code; x" }),
        )
        .await["result"]
            .clone();
        let tabs = json!({ "open": ["m1:s1"], "active": "m1:s1" });
        assert_eq!(
            call(
                &mut ws,
                3,
                "uiState.set",
                json!({ "key": "tabs", "value": tabs })
            )
            .await["result"],
            json!({})
        );
        assert_eq!(
            call(
                &mut ws,
                4,
                "drafts.set",
                json!({ "key": "new:m1", "text": "Half a thought" })
            )
            .await["result"],
            json!({})
        );
        assert_eq!(
            call(
                &mut ws,
                5,
                "drafts.set",
                json!({ "key": "gone", "text": "x" })
            )
            .await["result"],
            json!({})
        );
        assert_eq!(
            call(
                &mut ws,
                6,
                "drafts.set",
                json!({ "key": "gone", "text": "" })
            )
            .await["result"],
            json!({})
        );
        (defaults, set)
    });
    first.stop();

    // The desktop service's defaults, field for field (`settingsDefaults` in the protocol).
    assert_eq!(
        defaults,
        json!({
            "claudePath": null,
            "idleReclaimMinutes": 15,
            "idleShutdownMinutes": 60,
            "notifications": true,
            "enterToSend": true,
            "theme": "system",
            "startOnLogin": false,
            "externalPolling": true,
            "notifyOnFinish": true,
            "autoTitles": true,
            "accent": "graphite",
            "darkStyle": "default",
            "lightStyle": "default",
            "uiFont": "inter",
            "codeFont": null,
        })
    );
    let mut want = defaults.clone();
    want["theme"] = json!("dark");
    want["accent"] = json!("teal");
    want["idleShutdownMinutes"] = json!(null);
    want["codeFont"] = json!("Fira Code x");
    assert_eq!(set, want);

    let second = core(dir.path());
    block_on(async {
        let mut ws = open(&second).await;
        assert_eq!(
            call(&mut ws, 1, "settings.get", json!({})).await["result"],
            want
        );
        assert_eq!(
            call(&mut ws, 2, "uiState.get", json!({ "key": "tabs" })).await["result"],
            json!({ "value": { "open": ["m1:s1"], "active": "m1:s1" } })
        );
        assert_eq!(
            call(&mut ws, 3, "uiState.get", json!({ "key": "never" })).await["result"],
            json!({ "value": null })
        );
        assert_eq!(
            call(&mut ws, 4, "drafts.get", json!({ "key": "new:m1" })).await["result"],
            json!({ "text": "Half a thought" })
        );
        assert_eq!(
            call(&mut ws, 5, "drafts.get", json!({ "key": "gone" })).await["result"],
            json!({ "text": "" })
        );
    });
    second.stop();
}

#[test]
fn a_setting_the_protocol_refuses_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    block_on(async {
        let mut ws = open(&core).await;
        for (i, patch) in [
            json!({ "theme": "sepia" }),
            json!({ "notifications": "yes" }),
            json!({ "idleShutdownMinutes": 4 }),
            json!({ "idleShutdownMinutes": 60.5 }),
            json!({ "codeFont": "x".repeat(257) }),
            json!({ "theme": "dark", "accent": null }),
        ]
        .into_iter()
        .enumerate()
        {
            let answer = call(&mut ws, i as u64 + 1, "settings.set", patch.clone()).await;
            assert_eq!(
                answer["error"]["code"], "INVALID_PARAMS",
                "{patch}: {answer}"
            );
        }
        let settings = call(&mut ws, 99, "settings.get", json!({})).await["result"].clone();
        assert_eq!(settings["theme"], "system");
        // Keys the protocol doesn't know are dropped, as zod strips them.
        let answer = call(&mut ws, 100, "settings.set", json!({ "volume": 11 })).await;
        assert!(answer["result"].get("volume").is_none(), "{answer}");
    });
    core.stop();
}

#[test]
fn an_unknown_method_gets_method_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    block_on(async {
        let mut ws = open(&core).await;
        let answer = call(&mut ws, 7, "no.such", json!({})).await;
        assert_eq!(
            answer,
            json!({ "id": 7, "error": { "code": "METHOD_NOT_FOUND", "message": "Unknown method no.such" } })
        );
        // A protocol method the phone deliberately doesn't do answers the same way.
        let answer = call(
            &mut ws,
            8,
            "chat.open",
            json!({ "sessionId": "s1", "tail": 50 }),
        )
        .await;
        assert_eq!(answer["error"]["code"], "METHOD_NOT_FOUND");
        // A frame that isn't a request is answered as the service does, and the socket stays.
        ws.send(Message::text("{ not json")).await.unwrap();
        match next(&mut ws).await {
            Next::Frame(v) => {
                assert_eq!(
                    v,
                    json!({ "id": 0, "error": { "code": "INVALID_PARAMS", "message": "Malformed request" } })
                )
            }
            other => panic!("{other:?}"),
        }
        let answer = call(&mut ws, 9, "uiState.get", json!({ "key": 5 })).await;
        assert_eq!(answer["error"]["code"], "INVALID_PARAMS");
        let answer = call(&mut ws, 10, "hello", hello_params()).await;
        assert_eq!(answer["result"]["protocolVersion"], 11);
    });
    core.stop();
}

#[test]
fn an_oversized_frame_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    block_on(async {
        // Large but allowed: answered.
        let mut ws = open(&core).await;
        let big = "x".repeat(2 * 1024 * 1024);
        let answer = call(
            &mut ws,
            1,
            "uiState.set",
            json!({ "key": "big", "value": big }),
        )
        .await;
        assert_eq!(answer["result"], json!({}));

        // One byte over the protocol's limit: closed 1009 (as `ws` does), unanswered.
        let head = r#"{"id":2,"method":"uiState.set","params":{"key":"huge","value":""#;
        let tail = r#""}}"#;
        let filler = "y".repeat(MAX_REQUEST_BYTES + 1 - head.len() - tail.len());
        let frame = format!("{head}{filler}{tail}");
        assert_eq!(frame.len(), MAX_REQUEST_BYTES + 1);
        let _ = ws.send(Message::text(frame)).await;
        match next(&mut ws).await {
            Next::Closed(Some(1009)) => {}
            other => panic!("not refused: {other:?}"),
        }

        // The core is still there for the next screen, and nothing was stored.
        let mut ws = open(&core).await;
        let answer = call(&mut ws, 3, "uiState.get", json!({ "key": "huge" })).await;
        assert_eq!(answer["result"], json!({ "value": null }));
    });
    core.stop();
}

#[test]
fn a_relay_is_closed_until_the_core_has_machines() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    block_on(async {
        let protocols = [format!("threadgarden.{}", core.token())];
        let mut ws = open_with(core.port(), "/relay?machine=m1", &protocols)
            .await
            .unwrap();
        match next(&mut ws).await {
            // RELAY_CLOSE.locked, as a service without paired machines closes it.
            Next::Closed(Some(4404)) => {}
            other => panic!("{other:?}"),
        }
    });
    core.stop();
}

#[test]
fn a_stopped_core_listens_no_more() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    let addr = SocketAddr::from(([127, 0, 0, 1], core.port()));
    core.stop();
    assert!(core.is_stopped());
    assert!(TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_err());
    // Stopping again is harmless.
    core.stop();
}

#[test]
fn the_core_carries_the_apps_version() {
    // `hello` reports the crate's version; the screens compare it with the app's.
    let app =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../Cargo.toml")).unwrap();
    let version = app
        .lines()
        .find_map(|l| l.strip_prefix("version = \""))
        .and_then(|v| v.strip_suffix('"'))
        .expect("the app's version");
    assert_eq!(version, env!("CARGO_PKG_VERSION"));
}
