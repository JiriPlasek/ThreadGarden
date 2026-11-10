//! One core per process: the Android service and the screens may both start
//! it, and a webview Android destroyed and made again must find the same one.
//! Its own test binary, so no other test shares the process's core.

mod support;

use serde_json::json;
use support::{block_on, call, config, open};
use threadgarden_core::Core;

#[test]
fn start_twice_returns_the_same_core() {
    let dir = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let first = Core::start(config(dir.path())).unwrap();
    // A second start, even with another config, gets the running core.
    let second = Core::start(config(other.path())).unwrap();
    assert_eq!(second.port(), first.port());
    assert_eq!(second.token(), first.token());
    assert!(!other.path().join("core.json").exists());
    block_on(async {
        let mut ws = open(&second).await;
        let answer = call(&mut ws, 1, "uiState.set", json!({ "key": "k", "value": 1 })).await;
        assert_eq!(answer["result"], json!({}));
    });

    // Once it's stopped, the next start makes a new one.
    first.stop();
    assert!(second.is_stopped());
    let third = Core::start(config(dir.path())).unwrap();
    assert_ne!(third.token(), first.token());
    block_on(async {
        let mut ws = open(&third).await;
        let answer = call(&mut ws, 1, "uiState.get", json!({ "key": "k" })).await;
        assert_eq!(answer["result"], json!({ "value": 1 }));
    });
    third.stop();
}
