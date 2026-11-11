//! Task 10 starts the core from Tauri's async context: starting (and
//! stopping) it inside a tokio runtime must work. Its own test binary, so it's
//! alone with the process's core.

mod support;

use serde_json::json;
use support::{call, config, open};
use threadgarden_core::Core;

#[tokio::test(flavor = "multi_thread")]
async fn the_core_starts_inside_a_tokio_runtime() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::start(config(dir.path())).unwrap();
    let mut ws = open(&core).await;
    let answer = call(
        &mut ws,
        1,
        "hello",
        json!({ "protocolVersion": 11, "client": "threadgarden-desktop" }),
    )
    .await;
    assert_eq!(answer["result"]["protocolVersion"], 11);
    core.stop();
    assert!(core.is_stopped());
}
