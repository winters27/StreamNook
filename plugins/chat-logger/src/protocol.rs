//! JSON-RPC 2.0 over stdio with Content-Length framing, the plugin side of
//! StreamNook's plugin protocol (docs/plugins/PROTOCOL.md). Mirrors the
//! host's transport: one framed envelope per message, length-prefixed.

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Stdin, Stdout};
use tokio::sync::Mutex;

const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

struct HostInner {
    stdout: Mutex<Stdout>,
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

    /// Sends a request without waiting for the response. This plugin only
    /// issues fire-and-forget host calls (register_panel) and one call whose
    /// result it needs (get_panel_values); the read loop routes that result
    /// back as an inbound message instead of tracking pending ids.
    pub async fn request(&self, id: u64, method: &str, params: Value) -> Result<()> {
        self.write_frame(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await
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

/// The request id this plugin uses for its single get_panel_values call, so
/// the read loop can recognize the response and forward it to the engine.
pub const PANEL_VALUES_REQ_ID: u64 = 1;

/// An inbound message the engine acts on. The initialize/ping/shutdown
/// requests are answered inline in the read loop and not forwarded
/// (initialize additionally forwards its params, which carry data_dir).
pub enum Inbound {
    /// The initialize request's params: granted capabilities and data_dir.
    Init(Value),
    Initialized,
    /// One chat message from a channel the app has open.
    ChatMessage(Value),
    /// The user changed values in the host-rendered settings panel.
    PanelChange(Value),
    /// The host's response to our get_panel_values request.
    PanelValues(Value),
}

/// Reads stdin for the life of the process. Answers ping/shutdown inline,
/// exits on `exit`, and forwards everything the engine cares about over the
/// channel.
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
                if frame.get("id").and_then(|i| i.as_u64()) == Some(PANEL_VALUES_REQ_ID) {
                    let values = frame
                        .get("result")
                        .and_then(|r| r.get("values"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    let _ = tx.send(Inbound::PanelValues(values)).await;
                }
            }
            // Host request.
            (true, Some(m)) => {
                let id = frame.get("id").cloned().unwrap_or(Value::Null);
                match m {
                    "initialize" => {
                        let params = frame.get("params").cloned().unwrap_or(Value::Null);
                        let _ = tx.send(Inbound::Init(params)).await;
                        // Hooks are static for this plugin, so answer inline.
                        let _ = host
                            .respond(id, json!({ "plugin_version": env!("CARGO_PKG_VERSION"), "hooks": ["on_chat_message", "on_panel_change"] }))
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
                "on_chat_message" => {
                    let _ = tx
                        .send(Inbound::ChatMessage(
                            frame.get("params").cloned().unwrap_or(Value::Null),
                        ))
                        .await;
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
