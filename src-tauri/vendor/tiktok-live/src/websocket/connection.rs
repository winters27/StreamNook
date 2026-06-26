use std::time::Duration;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use prost::Message;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::interval;
use tracing::{debug, error, info, warn};

use crate::decode::mapper;
use crate::errors::TikTokLiveError;
use crate::structs::proto::frames::WebcastPushFrame;
use crate::structs::proto::messages::WebcastResponse;
use crate::structs::TikTokLiveEvent;
use crate::websocket::frames::{build_ack, build_enter_room, build_heartbeat, decompress_if_gzipped};

type WsMessage = tokio_tungstenite::tungstenite::Message;

pub async fn run_websocket(ws_url: &str, cookies: &str, user_agent: &str, room_id: &str, heartbeat_interval: Duration, stale_timeout: Duration, proxy: Option<&str>, accept_language: &str, tx: mpsc::Sender<TikTokLiveEvent>) -> Result<(), TikTokLiveError> {
    let host = url_host(ws_url)?;
    let ws_key = generate_ws_key();

    let request = http::Request::builder()
        .method("GET")
        .uri(ws_url)
        .header("Host", &host)
        .header("Upgrade", "websocket")
        .header("Connection", "Upgrade")
        .header("Sec-WebSocket-Key", &ws_key)
        .header("Sec-WebSocket-Version", "13")
        .header("User-Agent", user_agent)
        .header("Referer", "https://www.tiktok.com/")
        .header("Origin", "https://www.tiktok.com")
        .header("Accept-Language", accept_language)
        .header("Accept-Encoding", "gzip, deflate")
        .header("Cache-Control", "no-cache")
        .header("Cookie", cookies)
        .body(())
        .map_err(|e| TikTokLiveError::invalid(format!("ws request build: {e}")))?;

    if let Some(proxy_url) = proxy {
        let tunnel = connect_proxy_tunnel(proxy_url, &host).await?;
        let (ws_stream, _) = handle_ws_handshake(
            tokio_tungstenite::client_async_tls_with_config(request, tunnel, None, None).await
        )?;
        ws_event_loop(ws_stream, room_id, heartbeat_interval, stale_timeout, tx).await
    } else {
        let (ws_stream, _) = handle_ws_handshake(
            tokio_tungstenite::connect_async(request).await
        )?;
        ws_event_loop(ws_stream, room_id, heartbeat_interval, stale_timeout, tx).await
    }
}

fn handle_ws_handshake<S>(
    result: Result<(tokio_tungstenite::WebSocketStream<S>, http::Response<Option<Vec<u8>>>), tokio_tungstenite::tungstenite::Error>,
) -> Result<(tokio_tungstenite::WebSocketStream<S>, http::Response<Option<Vec<u8>>>), TikTokLiveError> {
    match result {
        Ok(pair) => Ok(pair),
        Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => {
            let handshake_msg = extract_header(&resp, "Handshake-Msg");

            if handshake_msg == "DEVICE_BLOCKED" {
                return Err(TikTokLiveError::DeviceBlocked);
            }

            let handshake_status = extract_header(&resp, "Handshake-Status");

            Err(TikTokLiveError::invalid(format!(
                "handshake rejected: msg={handshake_msg} status={handshake_status}"
            )))
        }
        Err(e) => Err(e.into()),
    }
}

async fn ws_event_loop<S>(ws_stream: tokio_tungstenite::WebSocketStream<S>, room_id: &str, heartbeat_interval: Duration, stale_timeout: Duration, tx: mpsc::Sender<TikTokLiveEvent>) -> Result<(), TikTokLiveError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut write, mut read) = ws_stream.split();

    info!("websocket connected");

    let hb_bytes = build_heartbeat(room_id)?;
    write.send(WsMessage::Binary(hb_bytes.into())).await?;

    let enter_bytes = build_enter_room(room_id)?;
    write.send(WsMessage::Binary(enter_bytes.into())).await?;

    let mut heartbeat_tick = interval(heartbeat_interval);
    heartbeat_tick.tick().await; // skip first immediate tick

    let room_id_owned = room_id.to_string();

    let stale_sleep = tokio::time::sleep(stale_timeout);
    tokio::pin!(stale_sleep);

    loop {
        tokio::select! {
            _ = heartbeat_tick.tick() => {
                let hb = build_heartbeat(&room_id_owned)?;
                if let Err(e) = write.send(WsMessage::Binary(hb.into())).await {
                    error!("heartbeat send failed: {e}");
                    break;
                }
                debug!("heartbeat sent");
            }
            _ = &mut stale_sleep => {
                info!("stale: no data for {:?}, closing", stale_timeout);
                break;
            }
            msg = read.next() => {
                // Reset stale timer on any message
                stale_sleep.as_mut().reset(tokio::time::Instant::now() + stale_timeout);

                match msg {
                    Some(Ok(WsMessage::Binary(data))) => {
                        if let Err(e) = process_binary(&data, &mut write, &tx).await {
                            warn!("frame processing error: {e}");
                        }
                    }
                    Some(Ok(WsMessage::Ping(data))) => {
                        let _ = write.send(WsMessage::Pong(data)).await;
                    }
                    Some(Ok(WsMessage::Close(_))) => {
                        info!("server sent close frame");
                        break;
                    }
                    Some(Err(e)) => {
                        error!("websocket read error: {e}");
                        break;
                    }
                    None => {
                        info!("websocket stream ended");
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    Ok(())
}

async fn process_binary<S>(data: &[u8], write: &mut S, tx: &mpsc::Sender<TikTokLiveEvent>) -> Result<(), TikTokLiveError>
where
    S: SinkExt<WsMessage> + Unpin,
    S::Error: std::fmt::Display,
{
    let frame = WebcastPushFrame::decode(data)?;

    match frame.payload_type.as_str() {
        "msg" => {
            let decompressed = decompress_if_gzipped(&frame.payload)?;
            let response = WebcastResponse::decode(decompressed.as_slice())?;

            if response.needs_ack && !response.internal_ext.is_empty() {
                let ack = build_ack(frame.log_id, response.internal_ext.as_bytes())?;
                let _ = write.send(WsMessage::Binary(ack.into())).await;
            }

            for message in &response.messages {
                let events = mapper::decode_message(&message.r#type, &message.payload);
                for event in events {
                    let _ = tx.send(event).await;
                }
            }
        }
        "im_enter_room_resp" => {
            info!("room entry confirmed");
        }
        "hb" => {
            debug!("heartbeat response");
        }
        other => {
            debug!("unhandled payload type: {other}");
        }
    }

    Ok(())
}

/// Establish a TCP tunnel through an HTTP proxy via CONNECT method.
///
/// Connects to the proxy, sends `CONNECT target_host:443`, validates the 200
/// response, and returns the raw TCP stream. The caller (via `client_async_tls_with_config`)
/// handles the TLS handshake over this tunnel.
async fn connect_proxy_tunnel(proxy_url: &str, target_host: &str) -> Result<TcpStream, TikTokLiveError> {
    let (proxy_host, proxy_port) = parse_proxy_addr(proxy_url)?;

    let mut tcp = TcpStream::connect((&*proxy_host, proxy_port)).await?;

    // HTTP CONNECT tunnel request
    let connect_req = format!(
        "CONNECT {target_host}:443 HTTP/1.1\r\nHost: {target_host}:443\r\n\r\n"
    );
    tcp.write_all(connect_req.as_bytes()).await?;

    // Read the proxy response — we need at least the status line + header terminator
    let mut buf = vec![0u8; 4096];
    let mut total = 0usize;
    loop {
        let n = tcp.read(&mut buf[total..]).await?;
        if n == 0 {
            return Err(TikTokLiveError::invalid("proxy closed connection during CONNECT handshake"));
        }
        total += n;
        // Look for end of HTTP headers (\r\n\r\n)
        if find_header_end(&buf[..total]).is_some() {
            let header_str = std::str::from_utf8(&buf[..total])
                .map_err(|e| TikTokLiveError::invalid(format!("proxy response not utf8: {e}")))?;
            let status_line = header_str.lines().next()
                .ok_or_else(|| TikTokLiveError::invalid("proxy returned empty response"))?;
            if !status_line.contains("200") {
                return Err(TikTokLiveError::invalid(format!("proxy CONNECT failed: {status_line}")));
            }
            break;
        }
        if total >= buf.len() {
            return Err(TikTokLiveError::invalid("proxy response headers too large"));
        }
    }

    Ok(tcp)
}

/// Parse proxy URL into (host, port). Supports http:// and https:// schemes.
/// SOCKS5 proxies are not supported for WSS tunneling.
fn parse_proxy_addr(proxy_url: &str) -> Result<(String, u16), TikTokLiveError> {
    let stripped = proxy_url
        .strip_prefix("http://")
        .or_else(|| proxy_url.strip_prefix("https://"))
        .ok_or_else(|| TikTokLiveError::InvalidUrl(
            format!("proxy url must start with http:// or https://: {proxy_url}")
        ))?;

    // Remove any trailing path
    let authority = stripped.split('/').next()
        .ok_or_else(|| TikTokLiveError::InvalidUrl("empty proxy host".into()))?;

    // Remove userinfo (user:pass@) if present
    let host_port = match authority.rsplit_once('@') {
        Some((_, hp)) => hp,
        None => authority,
    };

    // Split host:port
    match host_port.rsplit_once(':') {
        Some((host, port_str)) => {
            let port: u16 = port_str.parse()
                .map_err(|e| TikTokLiveError::InvalidUrl(format!("proxy port: {e}")))?;
            Ok((host.to_string(), port))
        }
        None => {
            // Default port based on scheme
            let port = if proxy_url.starts_with("https://") { 443 } else { 8080 };
            Ok((host_port.to_string(), port))
        }
    }
}

/// Find the `\r\n\r\n` that marks end of HTTP headers. Returns the byte offset
/// of the first byte *after* the blank line.
fn find_header_end(buf: &[u8]) -> Option<usize> {
    for i in 0..buf.len().saturating_sub(3) {
        if buf[i] == b'\r' && buf[i + 1] == b'\n' && buf[i + 2] == b'\r' && buf[i + 3] == b'\n' {
            return Some(i + 4);
        }
    }
    None
}

fn url_host(url: &str) -> Result<String, TikTokLiveError> {
    let stripped = url
        .strip_prefix("wss://")
        .or_else(|| url.strip_prefix("ws://"))
        .ok_or_else(|| TikTokLiveError::InvalidUrl("not a ws/wss url".into()))?;

    let host = stripped.split('/').next().ok_or_else(|| TikTokLiveError::InvalidUrl("no host in url".into()))?;

    Ok(host.to_string())
}

fn generate_ws_key() -> String {
    let bytes: [u8; 16] = rand::random();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn extract_header(resp: &http::Response<Option<Vec<u8>>>, name: &str) -> String {
    match resp.headers().get(name) {
        Some(v) => match v.to_str() {
            Ok(s) => s.to_string(),
            Err(_) => "?".to_string(),
        },
        None => "?".to_string(),
    }
}
