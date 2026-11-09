//! For `packages/service/test/core-pairing.test.ts`: pairs a fresh core with
//! the machine at `<address> <port>` using `<code>`, lists, then removes it
//! (revoking), the way the screens ask, and prints each answer as a line of
//! JSON: `{"step":"pair"|"list"|"remove","answer":{…}}`. The service test
//! checks the machine's side, so the two implementations can't drift.
//!
//! `cargo run --example pair_check -- 127.0.0.1 47380 ABCD-EFGH-JKMN`

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use threadgarden_core::secrets::MemorySecrets;
use threadgarden_core::{Core, CoreConfig};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [address, port, code] = args.as_slice() else {
        eprintln!("usage: pair_check <address> <port> <code>");
        std::process::exit(2);
    };
    let port: u16 = port.parse().expect("a port");
    let dir = tempfile::tempdir().expect("a temp dir");
    let core = Core::spawn(CoreConfig {
        data_dir: dir.path().to_path_buf(),
        secrets: Arc::new(MemorySecrets::default()),
        machine_name: "Phone".into(),
    })
    .expect("the core starts");

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let mut req = format!("ws://127.0.0.1:{}/", core.port())
            .into_client_request()
            .unwrap();
        let protocol = HeaderValue::from_str(&format!("threadgarden.{}", core.token())).unwrap();
        req.headers_mut().insert("Sec-WebSocket-Protocol", protocol);
        let (mut ws, _) = tokio_tungstenite::connect_async(req)
            .await
            .expect("the core answers");
        let mut call = async |id: u64, method: &str, params: Value| -> Value {
            ws.send(Message::text(
                json!({ "id": id, "method": method, "params": params }).to_string(),
            ))
            .await
            .unwrap();
            while let Some(Ok(msg)) = ws.next().await {
                if let Message::Text(t) = msg {
                    let v: Value = serde_json::from_str(t.as_str()).unwrap();
                    if v["id"] == json!(id) {
                        return v;
                    }
                }
            }
            panic!("the core closed");
        };
        let pair =
            json!({ "address": address, "port": port, "code": code, "deviceName": "Core check" });
        let paired = call(1, "machines.pair", pair).await;
        println!("{}", json!({ "step": "pair", "answer": paired }));
        let listed = call(2, "machines.list", json!({})).await;
        println!("{}", json!({ "step": "list", "answer": listed }));
        let id = paired["result"]["machine"]["id"].clone();
        let removed = call(
            3,
            "machines.remove",
            json!({ "machineId": id, "revoke": true }),
        )
        .await;
        println!("{}", json!({ "step": "remove", "answer": removed }));
    });
    core.stop();
}
