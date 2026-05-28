// 7TV EventAPI WebSocket client.
//
// One shared connection for the whole app (not per window), mirroring the
// channel_points_websocket_service pattern. It subscribes to a channel's 7TV
// resources when the channel is JOINed (refcount 0 to 1 in irc_service) and
// unsubscribes when the last consumer leaves (1 to 0). Updates are pushed to
// every WebView window via app_handle.emit, the same idiom eventsub_service
// uses, since these events are infrequent.
//
// Phase B (shipped here): emote_set.update -> live emote add/remove/rename in
// the channel's emote set, with an in chat notice.
// Phase C (cosmetics over entitlement.* / cosmetic.*) plugs into the same
// connection and subscription manager later.

use futures_util::{SinkExt, StreamExt};
use log::{debug, error, warn};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, RwLock};
use tokio::time::{sleep, timeout, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::services::emote_service::EmoteService;
use crate::services::irc_service::IrcService;

const EVENTAPI_URL: &str = "wss://events.7tv.io/v3";
const SEVENTV_USER_URL: &str = "https://7tv.io/v3/users/twitch/";

// Server opcodes we care about. (Client opcodes: SUBSCRIBE=35, UNSUBSCRIBE=36.)
const OP_DISPATCH: u64 = 0;
const OP_RECONNECT: u64 = 4;
const OP_END_OF_STREAM: u64 = 7;

// If no frame (including 7TV's own heartbeats, ~every 25s) arrives in this
// window, treat the socket as dead and reconnect.
const READ_TIMEOUT_SECS: u64 = 60;
const RECONNECT_DELAY_SECS: u64 = 5;

/// Desired subscription state for one channel. The map of these is the single
/// source of truth: the connection task re-subscribes every entry on each
/// (re)connect, so a dropped socket self-heals.
#[derive(Clone)]
struct ChannelSub {
    channel_name: String, // lowercase twitch login (chat key)
    channel_id: String,   // twitch user id
    emote_set_id: Option<String>,
    // Channel broadcaster's 7TV user id. Used as the subject of the passive
    // presence POST that triggers 7TV to deliver present users' cosmetics.
    seventv_user_id: Option<String>,
}

enum Cmd {
    Subscribe(ChannelSub),
    Unsubscribe(ChannelSub),
}

struct Service {
    http: reqwest::Client,
    subs: Arc<RwLock<HashMap<String, ChannelSub>>>, // keyed by lowercase channel name
    cmd_tx: mpsc::UnboundedSender<Cmd>,
}

static SERVICE: OnceLock<Service> = OnceLock::new();

/// Initialize the singleton and spawn its connection task. Idempotent.
pub fn init(app_handle: AppHandle, emote_service: Arc<RwLock<EmoteService>>) {
    if SERVICE.get().is_some() {
        return;
    }

    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<Cmd>();
    let subs: Arc<RwLock<HashMap<String, ChannelSub>>> = Arc::new(RwLock::new(HashMap::new()));
    let http = crate::services::http::client().clone();

    let service = Service {
        http: http.clone(),
        subs: subs.clone(),
        cmd_tx,
    };

    // The connection task connects immediately and idles until the first
    // subscribe; it re-subscribes from `subs` on every (re)connect.
    // Use tauri::async_runtime::spawn (not tokio::spawn): init() runs from the
    // Tauri setup hook, which is OUTSIDE the Tokio runtime context, so a bare
    // tokio::spawn panics with "there is no reactor running".
    tauri::async_runtime::spawn(connection_loop(
        app_handle,
        emote_service,
        http,
        subs,
        cmd_rx,
    ));

    let _ = SERVICE.set(service);
}

/// Subscribe to a channel's 7TV resources. Resolves the channel's 7TV emote set
/// id and 7TV user id (one REST call), then registers + signals the connection
/// task. No-op if the channel is not on 7TV or is already subscribed.
pub async fn subscribe_channel(channel_name: &str, channel_id: &str) {
    let Some(svc) = SERVICE.get() else {
        return;
    };

    let key = channel_name.to_lowercase();
    if svc.subs.read().await.contains_key(&key) {
        return; // already subscribed (e.g. IRC reconnect re-running the hook)
    }

    let (emote_set_id, seventv_user_id) = resolve_ids(&svc.http, channel_id).await;
    if emote_set_id.is_none() && seventv_user_id.is_none() {
        debug!(
            "[7TV EventAPI] {} not on 7TV, skipping subscription",
            channel_name
        );
        return;
    }

    let sub = ChannelSub {
        channel_name: key.clone(),
        channel_id: channel_id.to_string(),
        emote_set_id,
        seventv_user_id,
    };
    svc.subs.write().await.insert(key, sub.clone());
    let _ = svc.cmd_tx.send(Cmd::Subscribe(sub));
    debug!("[7TV EventAPI] subscribed channel {}", channel_name);
}

/// Unsubscribe a channel (last consumer left).
pub async fn unsubscribe_channel(channel_name: &str) {
    let Some(svc) = SERVICE.get() else {
        return;
    };
    let key = channel_name.to_lowercase();
    if let Some(sub) = svc.subs.write().await.remove(&key) {
        let _ = svc.cmd_tx.send(Cmd::Unsubscribe(sub));
        debug!("[7TV EventAPI] unsubscribed channel {}", key);
    }
}

/// Drop all subscriptions (full chat teardown). The socket stays up but idle.
pub async fn clear_all() {
    let Some(svc) = SERVICE.get() else {
        return;
    };
    let drained: Vec<ChannelSub> = {
        let mut map = svc.subs.write().await;
        map.drain().map(|(_, v)| v).collect()
    };
    for sub in drained {
        let _ = svc.cmd_tx.send(Cmd::Unsubscribe(sub));
    }
}

/// Resolve (emote_set_id, seventv_user_id) from the public 7TV user endpoint.
/// The root object is the 7TV user (its `id`); `emote_set.id` is the active set.
async fn resolve_ids(http: &reqwest::Client, channel_id: &str) -> (Option<String>, Option<String>) {
    let url = format!("{}{}", SEVENTV_USER_URL, channel_id);
    match http.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<Value>().await {
            Ok(json) => {
                let emote_set_id = json
                    .pointer("/emote_set/id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let seventv_user_id = json
                    .pointer("/id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                (emote_set_id, seventv_user_id)
            }
            Err(e) => {
                warn!("[7TV EventAPI] failed to parse user payload: {}", e);
                (None, None)
            }
        },
        Ok(_) => (None, None), // not on 7TV
        Err(e) => {
            warn!(
                "[7TV EventAPI] user lookup failed for {}: {}",
                channel_id, e
            );
            (None, None)
        }
    }
}

// Cosmetics entitlement event types subscribed per channel. Paired with the
// passive presence POST in bootstrap_presence, which triggers 7TV to deliver
// the currently-present users' entitlements to our session; the subscription
// then carries deltas (new arrivals, paint/badge changes, removals).
const ENTITLEMENT_TYPES: [&str; 3] = [
    "entitlement.create",
    "entitlement.update",
    "entitlement.delete",
];

// Subscription frames sent over the socket for a channel: the channel's emote
// set (live emote add/remove/rename) plus the channel cosmetics entitlements.
fn subscribe_frames(sub: &ChannelSub) -> Vec<String> {
    frames_for(sub, 35)
}

fn unsubscribe_frames(sub: &ChannelSub) -> Vec<String> {
    frames_for(sub, 36)
}

fn frames_for(sub: &ChannelSub, op: u64) -> Vec<String> {
    let mut frames = Vec::new();
    if let Some(set_id) = &sub.emote_set_id {
        frames.push(
            json!({
                "op": op,
                "d": { "type": "emote_set.update", "condition": { "object_id": set_id } }
            })
            .to_string(),
        );
    }
    for t in ENTITLEMENT_TYPES {
        frames.push(
            json!({
                "op": op,
                "d": {
                    "type": t,
                    "condition": { "ctx": "channel", "platform": "TWITCH", "id": sub.channel_id }
                }
            })
            .to_string(),
        );
    }
    frames
}

// POST a passive presence so 7TV delivers the channel's currently-present users'
// cosmetics to our EventAPI session. Mirrors the official extension's self/
// passive bootstrap. No auth required. Subject is the broadcaster's 7TV user id.
async fn bootstrap_presence(http: &reqwest::Client, sub: &ChannelSub, session_id: Option<&str>) {
    let (Some(subject), Some(session)) = (sub.seventv_user_id.as_deref(), session_id) else {
        return;
    };
    let url = format!("https://7tv.io/v3/users/{}/presences", subject);
    let body = json!({
        "kind": 1,
        "passive": true,
        "session_id": session,
        "data": { "platform": "TWITCH", "id": sub.channel_id }
    });
    if let Err(e) = http.post(&url).json(&body).send().await {
        warn!(
            "[7TV EventAPI] presence post failed for {}: {}",
            sub.channel_name, e
        );
    }
}

async fn connection_loop(
    app_handle: AppHandle,
    emote_service: Arc<RwLock<EmoteService>>,
    http: reqwest::Client,
    subs: Arc<RwLock<HashMap<String, ChannelSub>>>,
    mut cmd_rx: mpsc::UnboundedReceiver<Cmd>,
) {
    loop {
        if let Err(e) =
            connect_and_run(&app_handle, &emote_service, &http, &subs, &mut cmd_rx).await
        {
            error!("[7TV EventAPI] connection ended: {}", e);
        }
        sleep(Duration::from_secs(RECONNECT_DELAY_SECS)).await;
        debug!("[7TV EventAPI] reconnecting...");
    }
}

async fn connect_and_run(
    app_handle: &AppHandle,
    emote_service: &Arc<RwLock<EmoteService>>,
    http: &reqwest::Client,
    subs: &Arc<RwLock<HashMap<String, ChannelSub>>>,
    cmd_rx: &mut mpsc::UnboundedReceiver<Cmd>,
) -> anyhow::Result<()> {
    let (ws, _) = connect_async(EVENTAPI_URL).await?;
    let (mut write, mut read) = ws.split();

    // Read until HELLO (op 1) to capture the session id, which the passive
    // presence POST needs so 7TV delivers cosmetics back to THIS session.
    let mut session_id: Option<String> = None;
    while session_id.is_none() {
        match timeout(Duration::from_secs(READ_TIMEOUT_SECS), read.next()).await {
            Ok(Some(Ok(Message::Text(txt)))) => {
                if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                    if v.get("op").and_then(|o| o.as_u64()) == Some(1) {
                        session_id = v
                            .pointer("/d/session_id")
                            .and_then(|s| s.as_str())
                            .map(String::from);
                    }
                }
            }
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => return Ok(()),
            Ok(Some(Err(e))) => return Err(e.into()),
            Err(_) => {
                warn!(
                    "[7TV EventAPI] no HELLO in {}s, reconnecting",
                    READ_TIMEOUT_SECS
                );
                return Ok(());
            }
            _ => {}
        }
    }
    debug!("[7TV EventAPI] connected (session {:?})", session_id);

    // Re-subscribe the full desired state (covers reconnect + channels added
    // while the socket was down), and bootstrap presence so present users'
    // cosmetics are delivered to this session.
    {
        let map = subs.read().await;
        for sub in map.values() {
            for frame in subscribe_frames(sub) {
                write.send(Message::text(frame)).await?;
            }
            bootstrap_presence(http, sub, session_id.as_deref()).await;
        }
    }

    loop {
        tokio::select! {
            read_res = timeout(Duration::from_secs(READ_TIMEOUT_SECS), read.next()) => {
                match read_res {
                    Err(_) => {
                        warn!("[7TV EventAPI] no frames in {}s, reconnecting", READ_TIMEOUT_SECS);
                        return Ok(());
                    }
                    Ok(None) => return Ok(()),
                    Ok(Some(Ok(Message::Text(txt)))) => {
                        handle_text(&txt, app_handle, emote_service, subs).await;
                    }
                    Ok(Some(Ok(Message::Close(_)))) => return Ok(()),
                    Ok(Some(Err(e))) => return Err(e.into()),
                    Ok(Some(Ok(_))) => {} // ping/pong/binary: ignore
                }
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(Cmd::Subscribe(sub)) => {
                        for frame in subscribe_frames(&sub) {
                            write.send(Message::text(frame)).await?;
                        }
                        bootstrap_presence(http, &sub, session_id.as_deref()).await;
                    }
                    Some(Cmd::Unsubscribe(sub)) => {
                        for frame in unsubscribe_frames(&sub) {
                            write.send(Message::text(frame)).await?;
                        }
                    }
                    None => return Ok(()), // sender dropped (never, SERVICE holds it)
                }
            }
        }
    }
}

async fn handle_text(
    txt: &str,
    app_handle: &AppHandle,
    emote_service: &Arc<RwLock<EmoteService>>,
    subs: &Arc<RwLock<HashMap<String, ChannelSub>>>,
) {
    let Ok(msg) = serde_json::from_str::<Value>(txt) else {
        return;
    };
    let op = msg.get("op").and_then(|v| v.as_u64()).unwrap_or(u64::MAX);

    match op {
        OP_DISPATCH => {
            let d = match msg.get("d") {
                Some(d) => d,
                None => return,
            };
            let dispatch_type = d.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if dispatch_type == "emote_set.update" {
                if let Some(body) = d.get("body") {
                    handle_emote_set_update(body, app_handle, emote_service, subs).await;
                }
            } else if dispatch_type.starts_with("entitlement.") {
                handle_entitlement(d, dispatch_type, app_handle);
            }
        }
        OP_RECONNECT | OP_END_OF_STREAM => {
            debug!("[7TV EventAPI] server asked to reconnect (op {})", op);
            // The read loop will see the socket close shortly; nothing to do.
        }
        _ => {} // HELLO / HEARTBEAT / ACK / ERROR: no action needed
    }
}

async fn handle_emote_set_update(
    body: &Value,
    app_handle: &AppHandle,
    emote_service: &Arc<RwLock<EmoteService>>,
    subs: &Arc<RwLock<HashMap<String, ChannelSub>>>,
) {
    let set_id = body.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if set_id.is_empty() {
        return;
    }

    // Map the emote set back to the channel we subscribed it for.
    let channel = {
        let map = subs.read().await;
        map.values()
            .find(|s| s.emote_set_id.as_deref() == Some(set_id))
            .map(|s| (s.channel_name.clone(), s.channel_id.clone()))
    };
    let Some((channel_name, channel_id)) = channel else {
        return; // an emote set we are no longer tracking
    };

    let actor_name = body
        .pointer("/actor/display_name")
        .and_then(|v| v.as_str())
        .or_else(|| body.pointer("/actor/username").and_then(|v| v.as_str()))
        .unwrap_or("Someone")
        .to_string();

    // ActiveEmote.name is the channel alias shown in chat. pushed = added,
    // pulled = removed, updated = renamed (old.name -> value.name).
    let added: Vec<String> = body
        .get("pushed")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    c.pointer("/value/name")
                        .and_then(|v| v.as_str())
                        .map(String::from)
                })
                .collect()
        })
        .unwrap_or_default();

    let removed: Vec<String> = body
        .get("pulled")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    c.pointer("/old_value/name")
                        .or_else(|| c.pointer("/value/name"))
                        .and_then(|v| v.as_str())
                        .map(String::from)
                })
                .collect()
        })
        .unwrap_or_default();

    let renamed: Vec<(String, String)> = body
        .get("updated")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    let old = c.pointer("/old_value/name").and_then(|v| v.as_str())?;
                    let new = c.pointer("/value/name").and_then(|v| v.as_str())?;
                    if old == new {
                        None
                    } else {
                        Some((old.to_string(), new.to_string()))
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    if added.is_empty() && removed.is_empty() && renamed.is_empty() {
        return;
    }

    // Authoritatively refresh both Rust caches by re-fetching the set. Reuses
    // all existing parsing; emote set changes are rare so the extra fetch is
    // cheap. Invalidate first so the 5 minute TTL does not return a stale set.
    {
        let svc = emote_service.read().await;
        svc.invalidate_channel(&channel_id).await;
    }
    IrcService::fetch_and_store_emotes(&channel_name, emote_service.clone()).await;

    let renamed_json: Vec<Value> = renamed
        .iter()
        .map(|(old, new)| json!({ "old": old, "new": new }))
        .collect();

    let _ = app_handle.emit(
        "7tv://emote-set-update",
        json!({
            "channel": channel_name,
            "channel_id": channel_id,
            "actor_name": actor_name,
            "added": added,
            "removed": removed,
            "renamed": renamed_json,
        }),
    );

    debug!(
        "[7TV EventAPI] {} emote set: +{} -{} ~{} (by {})",
        channel_name,
        added.len(),
        removed.len(),
        renamed.len(),
        actor_name
    );
}

// A user's cosmetics entitlement changed in a subscribed channel (they became
// present, changed, or removed a paint/badge). We extract their Twitch id and
// let the frontend re-resolve the authoritative cosmetics via the existing v4
// GQL path (correct render shape, cheap, cached, coalesced). The WS is the
// trigger; GQL is the resolver. We do NOT parse the v3 cosmetic payload here.
fn handle_entitlement(d: &Value, dispatch_type: &str, app_handle: &AppHandle) {
    let Some(body) = d.get("body") else {
        return;
    };
    let twitch_id = body
        .pointer("/object/user/connections")
        .and_then(|c| c.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|c| c.get("platform").and_then(|p| p.as_str()) == Some("TWITCH"))
        })
        .and_then(|c| c.get("id"))
        .and_then(|i| i.as_str());

    let Some(twitch_id) = twitch_id else {
        return; // delete events without a user object, or non-twitch users
    };

    let action = dispatch_type
        .strip_prefix("entitlement.")
        .unwrap_or("update");

    let _ = app_handle.emit(
        "7tv://cosmetic-update",
        json!({ "twitch_id": twitch_id, "action": action }),
    );
}
