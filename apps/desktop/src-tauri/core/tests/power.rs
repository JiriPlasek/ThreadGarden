//! Turn on through a machine's plug, as the desktop's `power/hub.ts` does it
//! (a fresh reading, the minimum off time, a plug drawing power left alone,
//! one operation at a time), with the plug details the owner typed on the
//! phone. The password lives in `Secrets` only. No rule is installed on the
//! switch, and nothing is ever polled.

#[path = "support/machine.rs"]
mod machine;
mod support;
#[path = "support/tasmota.rs"]
mod tasmota;

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use machine::{Behaviour, FakeMachine};
use serde_json::{Value, json};
use support::{block_on, call, config, open};
use tasmota::{DEVICE, FakeTasmota, PASSWORD, Plug};
use threadgarden_core::secrets::{MemorySecrets, Secrets};
use threadgarden_core::{Core, CoreConfig, CoreHandle, Timing};

const DESK: &str = "machine-desk";
const MIN_OFF: u64 = 10;

fn core(dir: &std::path::Path) -> (CoreHandle, Arc<MemorySecrets>) {
    let secrets = Arc::new(MemorySecrets::default());
    let config = CoreConfig {
        secrets: secrets.clone(),
        ..config(dir)
    };
    // No wait between asking the plug to report and reading it.
    let timing = Timing {
        plug_read_wait: Duration::ZERO,
        ..Timing::default()
    };
    let core = Core::spawn_with_timing(config, timing).unwrap();
    // Only the plug here: no alert links.
    core.disconnect().unwrap();
    (core, secrets)
}

async fn pair(core: &CoreHandle, machine: &FakeMachine) {
    let mut ws = open(core).await;
    let params = json!({ "address": "127.0.0.1", "port": machine.port, "code": "ABCD-EFGH-JKMN", "deviceName": "Phone" });
    let answer = call(&mut ws, 1, "machines.pair", params).await;
    assert!(answer.get("result").is_some(), "{answer}");
}

fn details(plug: &FakeTasmota) -> Value {
    if plug.is_zigbee() {
        json!({ "kind": "tasmota-zigbee", "address": plug.address, "device": DEVICE, "minOffSeconds": MIN_OFF })
    } else {
        json!({ "kind": "tasmota-plug", "address": plug.address, "device": null, "minOffSeconds": MIN_OFF })
    }
}

/// The plug details as typed on the phone: `power.configure`.
async fn configure(core: &CoreHandle, plug: &FakeTasmota, password: &str) -> Value {
    let mut ws = open(core).await;
    call(
        &mut ws,
        1,
        "power.configure",
        json!({ "machineId": DESK, "config": details(plug), "password": password }),
    )
    .await
}

async fn turn_on(core: &CoreHandle) -> Value {
    let mut ws = open(core).await;
    call(&mut ws, 1, "power.turnOn", json!({ "machineId": DESK })).await
}

/// A paired machine with a plug set up, ready to be turned on.
fn set_up(
    dir: &std::path::Path,
    plug: &FakeTasmota,
) -> (CoreHandle, Arc<MemorySecrets>, FakeMachine) {
    let (core, secrets) = core(dir);
    let desk = FakeMachine::start(Behaviour::default());
    block_on(async {
        pair(&core, &desk).await;
        let set = configure(&core, plug, PASSWORD).await;
        assert!(set.get("result").is_some(), "{set}");
    });
    (core, secrets, desk)
}

fn off() -> Plug {
    Plug {
        on: false,
        watts: 0.0,
        last_seen: 1,
    }
}

fn on_command(zigbee: bool) -> String {
    if zigbee {
        format!(r#"ZbSend {{"Device":"{DEVICE}","Send":{{"Power":1}}}}"#)
    } else {
        "Power 1".into()
    }
}

fn off_command(zigbee: bool) -> String {
    if zigbee {
        format!(r#"ZbSend {{"Device":"{DEVICE}","Send":{{"Power":0}}}}"#)
    } else {
        "Power 0".into()
    }
}

/// Waits (up to 5 s) for `done`.
fn until(what: &str, done: impl Fn() -> bool) {
    let started = std::time::Instant::now();
    while !done() {
        assert!(started.elapsed() < Duration::from_secs(10), "never: {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn turn_on_sends_the_plugs_on() {
    for zigbee in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let plug = FakeTasmota::start(zigbee, off());
        let (core, _, _desk) = set_up(dir.path(), &plug);
        let answer = block_on(turn_on(&core));
        assert_eq!(
            answer["result"],
            json!({ "cycled": false, "waitMs": 0 }),
            "{answer}"
        );
        until("the plug is on", || plug.plug().on);
        assert!(
            plug.commands().contains(&on_command(zigbee)),
            "{:?}",
            plug.commands()
        );
        core.stop();
    }
}

#[test]
fn a_machine_drawing_power_is_not_cycled() {
    let dir = tempfile::tempdir().unwrap();
    let plug = FakeTasmota::start(
        true,
        Plug {
            on: true,
            watts: 60.0,
            last_seen: 1,
        },
    );
    let (core, _, _desk) = set_up(dir.path(), &plug);
    let answer = block_on(turn_on(&core));
    assert_eq!(answer["result"], json!({ "cycled": false, "waitMs": 0 }));
    std::thread::sleep(Duration::from_millis(200));
    assert!(plug.plug().on);
    assert!(
        !plug.commands().contains(&off_command(true)),
        "{:?}",
        plug.commands()
    );
    core.stop();
}

#[test]
fn a_plug_reading_on_but_below_off_watts_is_cycled_as_on_the_desktop() {
    let dir = tempfile::tempdir().unwrap();
    // On, in standby (2 W, under the default 5 W), heard from a second ago, on a
    // bridge the desktop set up (Threadgarden's rule in a slot).
    let plug = FakeTasmota::start(
        true,
        Plug {
            on: true,
            watts: 2.0,
            last_seen: 1,
        },
    );
    plug.with_desktop_rule(0);
    let (core, _, _desk) = set_up(dir.path(), &plug);
    let answer = block_on(turn_on(&core));
    assert_eq!(
        answer["result"],
        json!({ "cycled": true, "waitMs": MIN_OFF * 1000 }),
        "{answer}"
    );
    // The rule cuts and restores: the phone only asks for it, and clears the wake after.
    let sent = plug.commands();
    assert!(sent.contains(&"Event tgw".to_string()), "{sent:?}");
    assert!(
        sent.contains(&r#"Timer16 {"Enable":0}"#.to_string()),
        "{sent:?}"
    );
    assert!(
        !sent
            .iter()
            .any(|c| c.starts_with("Backlog") || c.contains("Delay")),
        "{sent:?}"
    );
    until("the rule restored it", || plug.plug().on);

    // A reading from long ago never drives a cut: the PC may have been started since.
    let dir = tempfile::tempdir().unwrap();
    let stale = FakeTasmota::start(
        true,
        Plug {
            on: true,
            watts: 2.0,
            last_seen: 30,
        },
    );
    stale.with_desktop_rule(0);
    let (core2, _, _desk2) = set_up(dir.path(), &stale);
    let answer = block_on(turn_on(&core2));
    assert_eq!(
        answer["error"],
        json!({ "code": "POWER_UNREACHABLE", "message": "Couldn't get a fresh reading from the plug; try again." })
    );
    assert!(!stale.commands().contains(&"Event tgw".to_string()));
    core.stop();
    core2.stop();
}

#[test]
fn a_bridge_without_threadgardens_rule_is_never_cycled() {
    let dir = tempfile::tempdir().unwrap();
    let plug = FakeTasmota::start(
        true,
        Plug {
            on: true,
            watts: 2.0,
            last_seen: 1,
        },
    );
    let (core, _, _desk) = set_up(dir.path(), &plug);
    let answer = block_on(turn_on(&core));
    assert_eq!(
        answer["error"],
        json!({ "code": "POWER_NOT_CONFIGURED", "message": "Set up power control on the desktop first" })
    );
    let sent = plug.commands();
    assert!(
        !sent
            .iter()
            .any(|c| c == "Event tgw" || c.contains("\"Send\"") || c.starts_with("Timer")),
        "{sent:?}"
    );
    assert!(plug.plug().on);
    core.stop();
}

#[test]
fn the_minimum_off_time_holds() {
    let dir = tempfile::tempdir().unwrap();
    let plug = FakeTasmota::start(true, off());
    // Cut 6 s ago (Mem11 has whole seconds: 4 to 5 s of the minimum off time are left,
    // room for a slow runner's set-up before the turn-on is asked).
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    plug.with_desktop_rule(now - (MIN_OFF - 4));
    let (core, _, _desk) = set_up(dir.path(), &plug);
    let answer = block_on(turn_on(&core));
    let wait = answer["result"]["waitMs"]
        .as_u64()
        .unwrap_or_else(|| panic!("{answer}"));
    assert_eq!(answer["result"]["cycled"], false);
    assert!((1_500..=5_100).contains(&wait), "{wait}");
    // Waited out here, not on the switch: nothing but reads went yet.
    let sent = plug.commands();
    assert!(
        !sent
            .iter()
            .any(|c| c == &on_command(true) || c.starts_with("Backlog")),
        "{sent:?}"
    );
    assert!(!plug.plug().on);
    // Asked again meanwhile: the same answer, nothing more sent.
    let before = plug.commands().len();
    let again = block_on(turn_on(&core));
    assert_eq!(again["result"], answer["result"]);
    assert_eq!(plug.commands().len(), before);
    // Then the plug's own on, and the wake cleared.
    until("the plug is on", || plug.plug().on);
    until("the wake is cleared", || {
        plug.commands()
            .contains(&r#"Timer16 {"Enable":0}"#.to_string())
    });
    core.stop();
}

#[test]
fn the_phones_own_cut_holds_across_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let standby = FakeTasmota::start(
        true,
        Plug {
            on: true,
            watts: 2.0,
            last_seen: 1,
        },
    );
    standby.with_desktop_rule(0);
    let (first, secrets, desk) = set_up(dir.path(), &standby);
    assert_eq!(block_on(turn_on(&first))["result"]["cycled"], true);
    first.stop();
    standby.set_plug(off());
    let config = CoreConfig {
        secrets,
        ..support::config(dir.path())
    };
    let timing = Timing {
        plug_read_wait: Duration::ZERO,
        ..Timing::default()
    };
    let second = Core::spawn_with_timing(config, timing).unwrap();
    let answer = block_on(turn_on(&second));
    let wait = answer["result"]["waitMs"]
        .as_u64()
        .unwrap_or_else(|| panic!("{answer}"));
    assert!(wait > 8_000 && wait <= MIN_OFF * 1000, "{wait}");
    drop(desk);
    second.stop();
}

#[test]
fn a_wait_for_details_cleared_meanwhile_sends_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let plug = FakeTasmota::start(true, off());
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    plug.with_desktop_rule(now - (MIN_OFF - 2));
    let (core, _, _desk) = set_up(dir.path(), &plug);
    let answer = block_on(turn_on(&core));
    assert!(
        answer["result"]["waitMs"].as_u64().is_some_and(|w| w > 0),
        "{answer}"
    );
    block_on(async {
        let mut ws = open(&core).await;
        call(
            &mut ws,
            1,
            "power.configure",
            json!({ "machineId": DESK, "config": null }),
        )
        .await;
    });
    std::thread::sleep(Duration::from_millis(3_500));
    assert!(!plug.plug().on);
    assert!(!plug.commands().contains(&on_command(true)));
    core.stop();
}

#[test]
fn a_failed_rule_or_mem_read_fails_turn_on() {
    let dir = tempfile::tempdir().unwrap();
    let plug = FakeTasmota::start(true, off());
    plug.with_desktop_rule(0);
    let (core, _, _desk) = set_up(dir.path(), &plug);
    plug.break_reads();
    let answer = block_on(turn_on(&core));
    assert_eq!(answer["error"]["code"], "POWER_NOT_TASMOTA", "{answer}");
    std::thread::sleep(Duration::from_millis(200));
    assert!(!plug.commands().contains(&on_command(true)));
    assert!(!plug.plug().on);
    core.stop();
}

#[test]
fn a_zigbee_plug_is_known_to_the_bridge_by_that_name() {
    let dir = tempfile::tempdir().unwrap();
    let plug = FakeTasmota::start(true, off());
    let (core, _) = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    block_on(async {
        pair(&core, &desk).await;
        let mut ws = open(&core).await;
        let mut typo = details(&plug);
        typo["device"] = json!("DeskPlg");
        let answer = call(
            &mut ws,
            1,
            "power.configure",
            json!({ "machineId": DESK, "config": typo, "password": PASSWORD }),
        )
        .await;
        assert_eq!(
            answer["error"],
            json!({ "code": "POWER_NOT_CONFIGURED", "message": "The bridge has no plug called DeskPlg." })
        );
        assert_eq!(
            call(&mut ws, 2, "power.list", json!({})).await["result"],
            json!([])
        );
        for (i, bad) in ["0x1234", "1234", &"p".repeat(33)].into_iter().enumerate() {
            let mut d = details(&plug);
            d["device"] = json!(bad);
            let answer = call(
                &mut ws,
                10 + i as u64,
                "power.configure",
                json!({ "machineId": DESK, "config": d, "password": PASSWORD }),
            )
            .await;
            assert!(answer.get("error").is_some(), "{bad}: {answer}");
        }
    });
    core.stop();
}

/// Everything the phone may send a bridge: reads, the plug's own on and off,
/// Threadgarden's cycle and its wake timer. Nothing else.
fn allowed(cmnd: &str) -> bool {
    let reads = [
        "Status 2", "Status 8", "Power", "Rule1", "Rule2", "Rule3", "Mem11", "Mem12", "Mem13",
    ];
    reads.contains(&cmnd)
        || cmnd == format!("ZbStatus3 {DEVICE}")
        || cmnd == format!(r#"ZbSend {{"Device":"{DEVICE}","Read":{{"ActivePower":true}}}}"#)
        || cmnd == on_command(true)
        || cmnd == on_command(false)
        || cmnd == "Event tgw"
        || cmnd == r#"Timer16 {"Enable":0}"#
}

#[test]
fn nothing_else_on_the_bridge_is_touched() {
    for zigbee in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let plug = FakeTasmota::start(
            zigbee,
            Plug {
                on: true,
                watts: 2.0,
                last_seen: 1,
            },
        );
        plug.with_desktop_rule(0);
        let (core, _, _desk) = set_up(dir.path(), &plug);
        block_on(async {
            let mut ws = open(&core).await;
            call(&mut ws, 1, "power.reading", json!({ "machineId": DESK })).await;
            // A cycle from standby, then off and on after the off time.
            assert_eq!(
                call(&mut ws, 2, "power.turnOn", json!({ "machineId": DESK })).await["result"]["cycled"],
                true
            );
        });
        until("the rule restored it", || plug.plug().on);
        // Off, with some of the minimum off time left: waited out, then the plug's on.
        let mut ps = plug.plug();
        ps.on = false;
        plug.set_plug(ps);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        plug.with_desktop_rule(now - (MIN_OFF - 2));
        let core2_dir = tempfile::tempdir().unwrap();
        let (core2, _, _desk2) = set_up(core2_dir.path(), &plug);
        let answer = block_on(turn_on(&core2));
        assert!(
            answer["result"]["waitMs"].as_u64().is_some_and(|w| w > 0),
            "{answer}"
        );
        until("on after the wait", || plug.plug().on);
        core2.stop();
        let sent = plug.commands();
        for cmnd in &sent {
            assert!(allowed(cmnd), "sent {cmnd:?} ({sent:?})");
            // Every Zigbee command names exactly the configured plug.
            if let Some(json) = cmnd.strip_prefix("ZbSend ") {
                let v: Value = serde_json::from_str(json).unwrap();
                assert_eq!(v["Device"], DEVICE, "{cmnd}");
            }
        }
        core.stop();
    }
}

#[test]
fn a_rule_set_up_for_another_plug_is_never_used() {
    for standby in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let plug = FakeTasmota::start(
            true,
            Plug {
                on: standby,
                watts: 2.0,
                last_seen: 1,
            },
        );
        // The bridge's Threadgarden rule cuts the grow light, not this plug.
        plug.with_desktop_rule_for(Some("GrowLight"), 0);
        let (core, _, _desk) = set_up(dir.path(), &plug);
        let answer = block_on(turn_on(&core));
        assert_eq!(
            answer["error"],
            json!({ "code": "POWER_NOT_CONFIGURED",
                    "message": "This bridge's power rule is set up for another plug. Set it up on the desktop." }),
            "standby {standby}"
        );
        std::thread::sleep(Duration::from_millis(200));
        let sent = plug.commands();
        assert!(
            !sent
                .iter()
                .any(|c| c == "Event tgw" || c.starts_with("Timer")),
            "{sent:?}"
        );
        assert!(!sent.contains(&on_command(true)), "{sent:?}");
        for cmnd in &sent {
            assert!(allowed(cmnd), "sent {cmnd:?}");
        }
        core.stop();
    }
}

#[test]
fn details_changed_during_a_turn_on_stop_it() {
    let dir = tempfile::tempdir().unwrap();
    // Slow answers: there's time to change the details while it reads.
    let plug = FakeTasmota::start_with(true, off(), Duration::from_millis(300));
    let (core, _, _desk) = set_up(dir.path(), &plug);
    let (answer, _) = block_on(async {
        let clearing = async {
            tokio::time::sleep(Duration::from_millis(150)).await;
            let mut ws = open(&core).await;
            call(
                &mut ws,
                1,
                "power.configure",
                json!({ "machineId": DESK, "config": null }),
            )
            .await
        };
        tokio::join!(turn_on(&core), clearing)
    });
    assert_eq!(
        answer["error"],
        json!({ "code": "POWER_NOT_CONFIGURED", "message": "Power control for this machine changed meanwhile." }),
        "{answer}"
    );
    std::thread::sleep(Duration::from_millis(700));
    assert!(!plug.commands().contains(&on_command(true)));
    assert!(!plug.plug().on);
    core.stop();
}

#[test]
fn one_operation_at_a_time_per_machine() {
    let dir = tempfile::tempdir().unwrap();
    let plug = FakeTasmota::start_with(true, off(), Duration::from_millis(150));
    let (core, _, _desk) = set_up(dir.path(), &plug);
    let (a, b) = block_on(async { tokio::join!(turn_on(&core), turn_on(&core)) });
    assert_eq!(a["result"], json!({ "cycled": false, "waitMs": 0 }), "{a}");
    assert_eq!(b["result"], a["result"]);
    until("the plug is on", || plug.plug().on);
    let ons = plug
        .commands()
        .iter()
        .filter(|c| **c == on_command(true))
        .count();
    assert_eq!(ons, 1, "{:?}", plug.commands());
    core.stop();
}

#[test]
fn a_wrong_password_says_so_and_is_not_retried_in_a_loop() {
    let dir = tempfile::tempdir().unwrap();
    let plug = FakeTasmota::start(true, off());
    let (core, secrets) = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    block_on(async {
        pair(&core, &desk).await;
        // Typed wrong: refused, and nothing kept.
        let answer = configure(&core, &plug, "not-it").await;
        assert_eq!(
            answer["error"],
            json!({ "code": "POWER_AUTH", "message": "The switch refused the password." })
        );
        let mut ws = open(&core).await;
        assert_eq!(
            call(&mut ws, 1, "power.list", json!({})).await["result"],
            json!([])
        );
    });
    assert_eq!(secrets.get(&format!("plug-password:{DESK}")), Ok(None));
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(plug.requests(), 1, "it was tried again");

    // Changed on the switch since: Turn on says so, once.
    block_on(async {
        assert!(
            configure(&core, &plug, PASSWORD)
                .await
                .get("result")
                .is_some()
        )
    });
    secrets
        .set(&format!("plug-password:{DESK}"), "changed-since")
        .unwrap();
    let before = plug.requests();
    let answer = block_on(turn_on(&core));
    assert_eq!(answer["error"]["code"], "POWER_AUTH", "{answer}");
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(plug.requests(), before + 1);
    core.stop();
}

#[test]
fn an_unreachable_bridge_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let mut plug = FakeTasmota::start(true, off());
    let (core, _, _desk) = set_up(dir.path(), &plug);
    let address = plug.address.clone();
    plug.stop();
    let answer = block_on(turn_on(&core));
    assert_eq!(
        answer["error"],
        json!({ "code": "POWER_UNREACHABLE", "message": format!("The switch at {address} did not answer.") })
    );
    let mut ws_answer = Value::Null;
    block_on(async {
        let mut ws = open(&core).await;
        ws_answer = call(&mut ws, 1, "power.reading", json!({ "machineId": DESK })).await;
    });
    assert_eq!(ws_answer["error"]["code"], "POWER_UNREACHABLE");
    core.stop();
}

#[test]
fn no_polling_without_a_screen_open() {
    let dir = tempfile::tempdir().unwrap();
    let plug = FakeTasmota::start(true, off());
    let (core, _, _desk) = set_up(dir.path(), &plug);
    let after_setup = plug.requests();
    // Nobody asks, with or without a screen: nobody reads.
    std::thread::sleep(Duration::from_millis(700));
    block_on(async {
        let _screen = open(&core).await;
        tokio::time::sleep(Duration::from_millis(500)).await;
    });
    assert_eq!(plug.requests(), after_setup);
    // A screen asking reads (once, for a few seconds).
    block_on(async {
        let mut ws = open(&core).await;
        let reading = call(&mut ws, 1, "power.reading", json!({ "machineId": DESK })).await;
        let r = &reading["result"];
        assert_eq!(
            (r["on"].clone(), r["watts"].clone(), r["age"].clone()),
            (json!(false), json!(0.0), json!(1))
        );
        assert!(r["at"].as_u64().is_some());
        let again = call(&mut ws, 2, "power.reading", json!({ "machineId": DESK })).await;
        assert_eq!(again["result"], reading["result"]);
    });
    assert!(plug.requests() > after_setup);
    core.stop();
}

#[test]
fn the_password_never_reaches_the_store_file_or_a_log() {
    let dir = tempfile::tempdir().unwrap();
    let plug = FakeTasmota::start(true, off());
    let (core, secrets, _desk) = set_up(dir.path(), &plug);
    let mut events = core.events();
    block_on(turn_on(&core));
    assert_eq!(
        secrets.get(&format!("plug-password:{DESK}")),
        Ok(Some(PASSWORD.to_string()))
    );
    // Neither on disk,
    for entry in std::fs::read_dir(dir.path()).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            assert!(
                !String::from_utf8_lossy(&std::fs::read(&path).unwrap()).contains(PASSWORD),
                "{path:?}"
            );
        }
    }
    // nor in what the core says of itself or its errors.
    while let Ok(e) = events.try_recv() {
        assert!(!format!("{e:?}").contains(PASSWORD));
    }
    let wrong = block_on(configure(&core, &plug, "another-wrong-one"));
    assert!(!wrong.to_string().contains("another-wrong-one"));
    // And the answers never carry it.
    block_on(async {
        let mut ws = open(&core).await;
        let list = call(&mut ws, 1, "power.list", json!({})).await;
        assert!(!list.to_string().contains(PASSWORD));
        assert_eq!(list["result"][0]["machineId"], DESK);
    });
    core.stop();
}

#[test]
fn plug_details_are_kept_listed_and_forgotten() {
    let dir = tempfile::tempdir().unwrap();
    let plug = FakeTasmota::start(false, off());
    let (core, secrets, _desk) = set_up(dir.path(), &plug);
    block_on(async {
        let mut ws = open(&core).await;
        let list = call(&mut ws, 1, "power.list", json!({})).await;
        assert_eq!(
            list["result"],
            json!([{ "machineId": DESK, "config": { "kind": "tasmota-plug", "address": plug.address, "device": null,
                     "offWatts": 5, "minOffSeconds": MIN_OFF, "measured": { "running": null, "standby": null } } }])
        );
        let noted = call(
            &mut ws,
            2,
            "power.noteMeasurement",
            json!({ "machineId": DESK, "kind": "running", "watts": 48.5 }),
        )
        .await;
        assert_eq!(noted["result"], json!({}));
        let list = call(&mut ws, 3, "power.list", json!({})).await;
        assert_eq!(
            list["result"][0]["config"]["measured"],
            json!({ "running": 48.5, "standby": null })
        );
        // Handed over from a keychain: accepted, and changes nothing (the core keeps its own).
        let unlock = call(
            &mut ws,
            4,
            "power.unlock",
            json!({ "machineId": DESK, "password": "whatever" }),
        )
        .await;
        assert_eq!(unlock["result"], json!({}));
        // Bad details are refused.
        for (i, bad) in [
            json!({ "kind": "tasmota-zigbee", "address": plug.address, "device": "has space" }),
            json!({ "kind": "tasmota-plug", "address": "", "device": null }),
            json!({ "kind": "tasmota-plug", "address": plug.address, "device": null, "minOffSeconds": 5 }),
            json!({ "kind": "other", "address": plug.address, "device": null }),
        ]
        .into_iter()
        .enumerate()
        {
            let answer = call(&mut ws, 10 + i as u64, "power.configure", json!({ "machineId": DESK, "config": bad, "password": PASSWORD })).await;
            assert!(answer.get("error").is_some(), "{answer}");
        }
        // Not a machine this phone knows.
        let answer = call(
            &mut ws,
            20,
            "power.configure",
            json!({ "machineId": "nope", "config": details(&plug), "password": PASSWORD }),
        )
        .await;
        assert_eq!(answer["error"]["code"], "NOT_FOUND");
        // Cleared: gone, password too.
        let cleared = call(
            &mut ws,
            21,
            "power.configure",
            json!({ "machineId": DESK, "config": null }),
        )
        .await;
        assert_eq!(cleared["result"], Value::Null);
        assert_eq!(
            call(&mut ws, 22, "power.list", json!({})).await["result"],
            json!([])
        );
        let turn = call(&mut ws, 23, "power.turnOn", json!({ "machineId": DESK })).await;
        assert_eq!(turn["error"]["code"], "POWER_NOT_CONFIGURED");
    });
    assert_eq!(secrets.get(&format!("plug-password:{DESK}")), Ok(None));
    core.stop();
}

#[test]
fn removing_a_machine_forgets_its_plug() {
    let dir = tempfile::tempdir().unwrap();
    let plug = FakeTasmota::start(true, off());
    let (core, secrets, _desk) = set_up(dir.path(), &plug);
    block_on(async {
        let mut ws = open(&core).await;
        call(
            &mut ws,
            1,
            "machines.remove",
            json!({ "machineId": DESK, "revoke": false }),
        )
        .await;
        assert_eq!(
            call(&mut ws, 2, "power.list", json!({})).await["result"],
            json!([])
        );
    });
    assert_eq!(secrets.get(&format!("plug-password:{DESK}")), Ok(None));
    core.stop();
}
