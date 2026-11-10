//! A small Tasmota for the tests: the HTTP command API (`/cm?user=admin&
//! password=…&cmnd=…`) of a Zigbee bridge with one plug, or of a Wi-Fi plug,
//! answering the commands the core sends. `Backlog` runs its parts in order,
//! `Delay` (tenths of a second) included. Every command is written down.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub const PASSWORD: &str = "plug-secret-7";
pub const DEVICE: &str = "DeskPlug";

#[derive(Clone)]
pub struct Plug {
    pub on: bool,
    pub watts: f64,
    /// Seconds since the bridge last heard from the plug (Zigbee `LastSeen`).
    pub last_seen: u64,
}

#[derive(Default)]
struct State {
    plug: Option<Plug>,
    /// Every command, as received (a Backlog's parts after the Backlog).
    commands: Vec<(Instant, String)>,
    requests: usize,
    rules: HashMap<u8, String>,
    mems: HashMap<u8, String>,
}

pub struct FakeTasmota {
    pub address: String,
    zigbee: bool,
    state: Arc<Mutex<State>>,
    runtime: Option<tokio::runtime::Runtime>,
}

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                out.push(
                    u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap(), 16)
                        .unwrap(),
                );
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap()
}

/// Splits on `;` outside braces, as Tasmota's Backlog does with JSON arguments.
fn split_backlog(s: &str) -> Vec<String> {
    let (mut parts, mut depth, mut cur) = (Vec::new(), 0i32, String::new());
    for c in s.chars() {
        match c {
            '{' => depth += 1,
            '}' => depth -= 1,
            ';' if depth == 0 => {
                parts.push(cur.trim().to_string());
                cur.clear();
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    if !cur.trim().is_empty() {
        parts.push(cur.trim().to_string());
    }
    parts
}

impl FakeTasmota {
    /// A Zigbee bridge (`zigbee`) or a Wi-Fi plug, with the plug as given.
    pub fn start(zigbee: bool, plug: Plug) -> FakeTasmota {
        Self::start_with(zigbee, plug, Duration::ZERO)
    }

    /// As `start`, each answer `slow` late.
    pub fn start_with(zigbee: bool, plug: Plug, slow: Duration) -> FakeTasmota {
        let state = Arc::new(Mutex::new(State {
            plug: Some(plug),
            ..State::default()
        }));
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let std_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        std_listener.set_nonblocking(true).unwrap();
        let address = std_listener.local_addr().unwrap().to_string();
        let listener = {
            let _in = runtime.enter();
            TcpListener::from_std(std_listener).unwrap()
        };
        let s = state.clone();
        runtime.spawn(async move {
            while let Ok((mut tcp, _)) = listener.accept().await {
                let s = s.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 16 * 1024];
                    let mut got = Vec::new();
                    loop {
                        let Ok(n) = tcp.read(&mut buf).await else { return };
                        if n == 0 {
                            return;
                        }
                        got.extend_from_slice(&buf[..n]);
                        if got.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let head = String::from_utf8_lossy(&got).into_owned();
                    let target = head.split_whitespace().nth(1).unwrap_or("").to_string();
                    let query = target.split_once('?').map(|(_, q)| q.to_string()).unwrap_or_default();
                    let params: HashMap<String, String> = query
                        .split('&')
                        .filter_map(|kv| kv.split_once('='))
                        .map(|(k, v)| (k.to_string(), decode(v)))
                        .collect();
                    if !slow.is_zero() {
                        tokio::time::sleep(slow).await;
                    }
                    let (status, body) = if params.get("password").map(String::as_str) != Some(PASSWORD) {
                        s.lock().unwrap().requests += 1;
                        (401, "".to_string())
                    } else {
                        let cmnd = params.get("cmnd").cloned().unwrap_or_default();
                        let answer = Self::run(&s, zigbee, &cmnd);
                        (200, answer.to_string())
                    };
                    let reason = if status == 200 { "OK" } else { "Unauthorized" };
                    let reply = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = tcp.write_all(reply.as_bytes()).await;
                    let _ = tcp.shutdown().await;
                });
            }
        });
        FakeTasmota {
            address,
            zigbee,
            state,
            runtime: Some(runtime),
        }
    }

    fn run(state: &Arc<Mutex<State>>, zigbee: bool, cmnd: &str) -> Value {
        {
            let mut s = state.lock().unwrap();
            s.requests += 1;
        }
        Self::one(state, zigbee, cmnd)
    }

    fn one(state: &Arc<Mutex<State>>, zigbee: bool, cmnd: &str) -> Value {
        state
            .lock()
            .unwrap()
            .commands
            .push((Instant::now(), cmnd.to_string()));
        let (name, arg) = cmnd.split_once(' ').unwrap_or((cmnd, ""));
        let lower = name.to_lowercase();
        if lower == "backlog" {
            let parts = split_backlog(arg);
            let (s, z) = (state.clone(), zigbee);
            // Run in the background, as a real device does: the Backlog answers at once.
            std::thread::spawn(move || {
                for part in parts {
                    if let Some(n) = part.strip_prefix("Delay ") {
                        let tenths: u64 = n.trim().parse().unwrap_or(0);
                        s.lock()
                            .unwrap()
                            .commands
                            .push((Instant::now(), part.clone()));
                        std::thread::sleep(Duration::from_millis(tenths * 100));
                        continue;
                    }
                    Self::one(&s, z, &part);
                }
            });
            return json!({ "Backlog": "Done" });
        }
        let mut s = state.lock().unwrap();
        match (lower.as_str(), zigbee) {
            ("status", _) if arg == "2" => json!({ "StatusFWR": { "Version": "14.4.1" } }),
            ("status", false) if arg == "8" => {
                json!({ "StatusSNS": { "ENERGY": { "Power": s.plug.as_ref().map(|p| p.watts) } } })
            }
            ("power", false) => {
                if let Some(p) = s.plug.as_mut() {
                    match arg {
                        "1" => p.on = true,
                        "0" => p.on = false,
                        _ => {}
                    }
                }
                json!({ "POWER": if s.plug.as_ref().is_some_and(|p| p.on) { "ON" } else { "OFF" } })
            }
            ("zbsend", true) => {
                let v: Value = serde_json::from_str(arg).unwrap_or_default();
                if v["Device"] == DEVICE
                    && let Some(power) = v["Send"]["Power"].as_u64()
                    && let Some(p) = s.plug.as_mut()
                {
                    p.on = power == 1;
                }
                json!({ "ZbSend": "Done" })
            }
            ("zbstatus3", true) => {
                let p = s.plug.clone().unwrap();
                json!({ "ZbStatus3": [{ "Device": "0x1234", "Name": DEVICE, "Power": u8::from(p.on),
                                        "ActivePower": p.watts, "LastSeen": p.last_seen }] })
            }
            (r, _) if r.starts_with("rule") && r.len() == 5 => {
                let n: u8 = r[4..].parse().unwrap_or(0);
                let text = s.rules.get(&n).cloned().unwrap_or_default();
                json!({ format!("Rule{n}"): { "State": "ON", "Rules": text } })
            }
            (m, _) if m.starts_with("mem") => {
                let n: u8 = m[3..].parse().unwrap_or(0);
                json!({ format!("Mem{n}"): s.mems.get(&n).cloned().unwrap_or_default() })
            }
            _ => json!({ "Command": "Unknown" }),
        }
    }

    pub fn plug(&self) -> Plug {
        self.state.lock().unwrap().plug.clone().unwrap()
    }

    pub fn set_plug(&self, plug: Plug) {
        self.state.lock().unwrap().plug = Some(plug);
    }

    /// The commands it got, in order.
    pub fn commands(&self) -> Vec<String> {
        self.state
            .lock()
            .unwrap()
            .commands
            .iter()
            .map(|(_, c)| c.clone())
            .collect()
    }

    /// When each command came.
    pub fn timed_commands(&self) -> Vec<(Instant, String)> {
        self.state.lock().unwrap().commands.clone()
    }

    /// HTTP requests it got (wrong passwords included).
    pub fn requests(&self) -> usize {
        self.state.lock().unwrap().requests
    }

    /// Puts the desktop's Threadgarden rule in a slot, and when it last cut (Unix seconds) in Mem11.
    pub fn with_desktop_rule(&self, last_cut_secs: u64) {
        let mut s = self.state.lock().unwrap();
        s.rules
            .insert(2, "on Event#tga do Backlog Var14 0 endon".into());
        s.mems.insert(11, last_cut_secs.to_string());
    }

    pub fn is_zigbee(&self) -> bool {
        self.zigbee
    }

    /// Stops answering: the bridge is gone.
    pub fn stop(&mut self) {
        if let Some(rt) = self.runtime.take() {
            rt.shutdown_background();
        }
    }
}

impl Drop for FakeTasmota {
    fn drop(&mut self) {
        self.stop();
    }
}
