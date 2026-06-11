//! JSON-RPC 2.0 over stdio with Content-Length framing, the plugin side of
//! StreamNook's plugin protocol (docs/plugins/PROTOCOL.md). Mirrors the
//! host's transport: one framed envelope per message, length-prefixed.

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Stdin, Stdout};
use tokio::sync::{oneshot, Mutex};
use tokio::time::timeout;

const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

struct HostInner {
    stdout: Mutex<Stdout>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
}

/// Handle the plugin uses to talk back to the host. Cheaply cloneable.
#[derive(Clone)]
pub struct Host {
    inner: Arc<HostInner>,
}

impl Host {
    pub fn new(stdout: Stdout) -> Self {
        Self {
            inner: Arc::new(HostInner {
                stdout: Mutex::new(stdout),
                pending: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
            }),
        }
    }

    async fn write_frame(&self, message: &Value) -> Result<()> {
        let body = serde_json::to_vec(message)?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        let mut out = self.inner.stdout.lock().await;
        out.write_all(header.as_bytes()).await?;
        out.write_all(&body).await?;
        out.flush().await?;
        Ok(())
    }

    /// Sends a request and awaits its response (default 130s, long enough to
    /// cover the host's credential consent prompt).
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().await.insert(id, tx);
        let frame = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(e) = self.write_frame(&frame).await {
            self.inner.pending.lock().await.remove(&id);
            return Err(e);
        }
        match timeout(Duration::from_secs(130), rx).await {
            Ok(Ok(response)) => {
                if let Some(err) = response.get("error") {
                    Err(anyhow!("host error: {err}"))
                } else {
                    Ok(response.get("result").cloned().unwrap_or(Value::Null))
                }
            }
            Ok(Err(_)) => Err(anyhow!("response channel dropped")),
            Err(_) => {
                self.inner.pending.lock().await.remove(&id);
                Err(anyhow!("host request '{method}' timed out"))
            }
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.write_frame(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
            .await
    }

    pub async fn respond(&self, id: Value, result: Value) -> Result<()> {
        self.write_frame(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))
            .await
    }

    pub async fn respond_error(&self, id: Value, code: i64, message: &str) -> Result<()> {
        self.write_frame(
            &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
        )
        .await
    }

    pub async fn log(&self, level: &str, message: impl Into<String>) {
        let _ = self
            .notify("log", json!({ "level": level, "message": message.into() }))
            .await;
    }

    pub async fn notify_user(&self, level: &str, message: impl Into<String>) {
        let _ = self
            .request("notify", json!({ "level": level, "message": message.into() }))
            .await;
    }

    /// Resolves an in-flight request with the host's response frame.
    async fn resolve(&self, id: u64, frame: Value) {
        if let Some(tx) = self.inner.pending.lock().await.remove(&id) {
            let _ = tx.send(frame);
        }
    }
}

/// Reads one framed envelope. Ok(None) on clean EOF at a frame boundary.
async fn read_frame(reader: &mut BufReader<Stdin>) -> Result<Option<Value>> {
    let mut content_length: Option<usize> = None;
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            if content_length.is_none() {
                return Ok(None);
            }
            bail!("EOF mid-header");
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            if key.eq_ignore_ascii_case("content-length") {
                content_length = Some(value.trim().parse().map_err(|_| anyhow!("bad length"))?);
            }
        }
    }
    let len = content_length.ok_or_else(|| anyhow!("missing Content-Length"))?;
    if len > MAX_FRAME_BYTES {
        bail!("frame too large");
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).await?;
    Ok(Some(serde_json::from_slice(&body)?))
}

/// An inbound message the engine acts on. The initialize/ping/shutdown
/// requests are answered inline in the read loop and not forwarded.
pub enum Inbound {
    Initialized,
    FollowedLive(Value),
    WatchTick,
    PanelChange(Value),
}

/// Reads stdin for the life of the process. Resolves responses, answers
/// ping/shutdown inline, exits on `exit`, and forwards everything the engine
/// cares about over the channel.
pub async fn read_loop(stdin: Stdin, host: Host, tx: tokio::sync::mpsc::Sender<Inbound>) {
    let mut reader = BufReader::new(stdin);
    loop {
        let frame = match read_frame(&mut reader).await {
            Ok(Some(f)) => f,
            Ok(None) => std::process::exit(0),
            Err(_) => std::process::exit(1),
        };
        let has_id = frame.get("id").is_some();
        let method = frame.get("method").and_then(|m| m.as_str()).map(String::from);
        match (has_id, method.as_deref()) {
            // Response to one of our requests.
            (true, None) => {
                if let Some(id) = frame.get("id").and_then(|i| i.as_u64()) {
                    host.resolve(id, frame).await;
                }
            }
            // Host request.
            (true, Some(m)) => {
                let id = frame.get("id").cloned().unwrap_or(Value::Null);
                match m {
                    "initialize" => {
                        // Hooks are static for this plugin, so answer inline.
                        let _ = host
                            .respond(id, json!({ "plugin_version": env!("CARGO_PKG_VERSION"), "hooks": ["on_followed_live", "on_watch_tick", "on_panel_change"] }))
                            .await;
                    }
                    "ping" => {
                        let _ = host.respond(id, json!({})).await;
                    }
                    "shutdown" => {
                        let _ = host.respond(id, Value::Null).await;
                    }
                    other => {
                        let _ = host
                            .respond_error(id, -32601, &format!("method not found: {other}"))
                            .await;
                    }
                }
            }
            // Notification.
            (false, Some(m)) => match m {
                "initialized" => {
                    let _ = tx.send(Inbound::Initialized).await;
                }
                "on_followed_live" => {
                    let _ = tx
                        .send(Inbound::FollowedLive(
                            frame.get("params").cloned().unwrap_or(Value::Null),
                        ))
                        .await;
                }
                "on_watch_tick" => {
                    let _ = tx.send(Inbound::WatchTick).await;
                }
                "on_panel_change" => {
                    let _ = tx
                        .send(Inbound::PanelChange(
                            frame.get("params").cloned().unwrap_or(Value::Null),
                        ))
                        .await;
                }
                "exit" => std::process::exit(0),
                _ => {}
            },
            (false, None) => {}
        }
    }
}
