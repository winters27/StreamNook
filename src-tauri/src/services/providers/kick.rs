//! Kick chat adapter.
//!
//! Reads a channel's live chat over Kick's public Pusher WebSocket (the same
//! socket the website uses) and normalizes each message into the shared
//! `ChatMessage`, published onto the local-WS bus via `publish_chat_message`.
//! Anonymous: no Kick login is needed to read. Sending (official OAuth API) is
//! a later step; `send_capability` reports read-only for now.
//!
//! Flow: resolve the chatroom id from `kick.com/api/v2/channels/{slug}`, connect
//! to Pusher, subscribe to `chatrooms.{id}.v2`, and decode the (double-encoded)
//! `App\Events\ChatMessageEvent` payload.

use super::kick_emotes;
use super::{
    app_handle, dec_bridge_users, inc_bridge_users, key, publish_chat_message, publish_frame,
    ChatProvider, SendCapability, SendOutcome,
};
use crate::models::chat_layout::{
    Badge, ChatMessage, LayoutResult, MessageMetadata, MessageSegment, ReplyInfo,
};
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};

// Kick's public Pusher app. The key occasionally rotates; if messages stop,
// re-read it from the website's websocket URL in DevTools.
const PUSHER_URL: &str = "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false";
// Pusher's idle activity timeout is ~120s; ping before then.
const READ_TIMEOUT_SECS: u64 = 100;
const RECONNECT_DELAY_SECS: u64 = 3;

static FALLBACK_SEQ: AtomicU64 = AtomicU64::new(0);

struct Connection {
    consumers: HashSet<String>,
    // None while the chatroom id is still resolving; Some once the stream task is
    // spawned. Reserving the slot (task None) before the slow resolve stops a
    // concurrent connect for the same slug from spinning a second resolver.
    task: Option<JoinHandle<()>>,
}

pub struct KickProvider {
    // Active stream tasks keyed by lowercase slug.
    conns: Mutex<HashMap<String, Connection>>,
    // Default client for the official api.kick.com OAuth chat send. The
    // Cloudflare-gated kick.com READS can't use reqwest at all (its TLS
    // fingerprint is 403'd), so those go through the hidden webview resolver.
    http: reqwest::Client,
}

impl KickProvider {
    pub fn new() -> Self {
        Self {
            conns: Mutex::new(HashMap::new()),
            http: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl ChatProvider for KickProvider {
    fn id(&self) -> &'static str {
        "kick"
    }

    async fn connect(&self, channel: &str, window: &str) -> Result<()> {
        let slug = channel.to_lowercase();
        {
            let mut conns = self.conns.lock().await;
            if let Some(conn) = conns.get_mut(&slug) {
                // Already connected or connecting: just record the new consumer.
                conn.consumers.insert(window.to_string());
                return Ok(());
            }
            // Reserve the slot (task None) before the slow resolve so a concurrent
            // connect for this slug doesn't spin a second resolver webview.
            let mut consumers = HashSet::new();
            consumers.insert(window.to_string());
            conns.insert(slug.clone(), Connection { consumers, task: None });
        }

        // Count this pending connection as a bridge user IMMEDIATELY - before the
        // slow (hidden-webview) resolve. Otherwise there's a multi-second window
        // where the shared local-WS bridge is up but BRIDGE_USERS is still 0, so a
        // concurrent Twitch start_chat sees "no providers" and does a FULL stop()
        // that tears the bridge down and moves its port, refusing every open
        // socket (the Twitch<->Kick "clash"). Counting now makes that start_chat
        // do a soft IRC-only restart that preserves the bridge instead.
        inc_bridge_users();

        // Resolve the chatroom id (+ meta, sub badges, native emotes) outside the
        // lock via the hidden webview. Kick's endpoints sit behind Cloudflare, which
        // 403s a plain reqwest, so a real (Chromium) page context is what clears
        // them. The webview is kept deliberately light: it fetches what we need at
        // document-start and is closed the moment the data is in.
        let resolved = resolve_via_webview(&slug).await;
        let chatroom_id = match resolved {
            Ok(id) => id,
            Err(e) => {
                // Resolution failed: release the bridge-user count we took above
                // and free the reserved slot so a retry can run.
                dec_bridge_users();
                self.conns.lock().await.remove(&slug);
                return Err(e);
            }
        };

        let task = {
            let slug_for_task = slug.clone();
            tokio::spawn(async move { run_connection(slug_for_task, chatroom_id).await })
        };
        // Attach the task to the reserved slot. If a racing connect already filled
        // it, or every consumer left while resolving, abort this task so there's
        // exactly one stream per slug.
        let mut conns = self.conns.lock().await;
        match conns.get_mut(&slug) {
            Some(conn) if conn.task.is_none() => conn.task = Some(task),
            _ => {
                task.abort();
                dec_bridge_users();
            }
        }
        Ok(())
    }

    async fn disconnect(&self, channel: &str, window: &str) -> Result<()> {
        let slug = channel.to_lowercase();
        let mut conns = self.conns.lock().await;
        let drop_it = if let Some(conn) = conns.get_mut(&slug) {
            conn.consumers.remove(window);
            conn.consumers.is_empty()
        } else {
            false
        };
        if drop_it {
            if let Some(conn) = conns.remove(&slug) {
                // The bridge-user count is taken at connect() reservation (before
                // the resolve). A LIVE connection (task Some) is released here; a
                // still-resolving one (task None) is released by connect()'s own
                // attach/failure path when it finds the slot gone, so we must not
                // double-release it here.
                if let Some(task) = conn.task {
                    task.abort();
                    dec_bridge_users();
                }
            }
        }
        Ok(())
    }

    async fn send(&self, channel: &str, text: &str, reply_to: Option<&str>) -> Result<SendOutcome> {
        let slug = channel.to_lowercase();
        let drop = |reason: &str| SendOutcome {
            message_id: None,
            is_sent: false,
            drop_reason: Some(reason.to_string()),
        };

        let Some(token) = crate::services::kick_auth_service::access_token().await else {
            return Ok(drop("Connect your Kick account to send"));
        };
        // The official chat API addresses the channel by its numeric broadcaster
        // user id, which we captured into the channel metadata during resolve.
        let Some(broadcaster_user_id) = channel_meta(&slug).and_then(|m| m.user_id) else {
            return Ok(drop("Kick channel isn't resolved yet — try again in a moment"));
        };

        let mut body = json!({
            "broadcaster_user_id": broadcaster_user_id,
            "content": text,
            "type": "user",
        });
        // Kick replies carry the parent message's UUID; the API renders the reply chip.
        if let Some(parent) = reply_to.filter(|s| !s.is_empty()) {
            body["reply_to_message_id"] = json!(parent);
        }

        let resp = self
            .http
            .post("https://api.kick.com/public/v1/chat")
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            log::warn!("[Kick] send failed (HTTP {}): {}", status, body);
            return Ok(drop(&format!("Kick send failed (HTTP {status})")));
        }
        let v: Value = resp.json().await.unwrap_or(Value::Null);
        let message_id = v
            .pointer("/data/message_id")
            .and_then(|x| x.as_str())
            .map(String::from);
        Ok(SendOutcome {
            message_id,
            is_sent: true,
            drop_reason: None,
        })
    }

    async fn send_capability(&self, _channel: &str) -> SendCapability {
        if crate::services::kick_auth_service::is_connected() {
            SendCapability::Sendable
        } else {
            SendCapability::NeedsLogin
        }
    }
}

// --- Outgoing moderation (official API: POST/DELETE /public/v1/moderation/bans) --
// Needs the `moderation:ban` scope (granted on a fresh Kick connect). The broadcaster
// and target are addressed by numeric Kick user id; the frontend passes the channel's
// broadcaster id (the resolved meta user_id) + the chatter's user id.

/// Ban (duration None) or time out (duration Some(minutes), 1..=10080) a Kick user.
pub async fn ban_user(
    broadcaster_user_id: u64,
    target_user_id: u64,
    duration_minutes: Option<u32>,
    reason: Option<String>,
) -> Result<()> {
    let token = crate::services::kick_auth_service::access_token()
        .await
        .ok_or_else(|| anyhow!("Connect your Kick account to moderate"))?;
    let mut body = json!({
        "broadcaster_user_id": broadcaster_user_id,
        "user_id": target_user_id,
    });
    if let Some(d) = duration_minutes {
        body["duration"] = json!(d.clamp(1, 10080));
    }
    if let Some(r) = reason.filter(|r| !r.is_empty()) {
        body["reason"] = json!(r.chars().take(100).collect::<String>());
    }
    let resp = reqwest::Client::new()
        .post("https://api.kick.com/public/v1/moderation/bans")
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Kick ban failed (HTTP {}): {}", status, text));
    }
    Ok(())
}

/// Lift a ban / timeout on a Kick user.
pub async fn unban_user(broadcaster_user_id: u64, target_user_id: u64) -> Result<()> {
    let token = crate::services::kick_auth_service::access_token()
        .await
        .ok_or_else(|| anyhow!("Connect your Kick account to moderate"))?;
    let resp = reqwest::Client::new()
        .delete("https://api.kick.com/public/v1/moderation/bans")
        .bearer_auth(&token)
        .json(&json!({
            "broadcaster_user_id": broadcaster_user_id,
            "user_id": target_user_id,
        }))
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Kick unban failed (HTTP {}): {}", status, text));
    }
    Ok(())
}

/// Delete a single chat message (DELETE /public/v1/chat/{message_id}, scope
/// `moderation:chat_message:manage`). `message_id` is the Kick message UUID.
pub async fn delete_message(message_id: &str) -> Result<()> {
    let token = crate::services::kick_auth_service::access_token()
        .await
        .ok_or_else(|| anyhow!("Connect your Kick account to moderate"))?;
    let url = format!("https://api.kick.com/public/v1/chat/{}", message_id);
    let resp = reqwest::Client::new()
        .delete(&url)
        .bearer_auth(&token)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Kick delete failed (HTTP {}): {}", status, text));
    }
    Ok(())
}

// --- Cloudflare-gated chatroom-id resolution via a hidden webview -----------
// kick.com/api/v2/channels/{slug} sits behind Cloudflare and 403s plain HTTP
// clients. A hidden WebView2 (real Chromium) clears the challenge, then fetches
// the same endpoint from the page context (cf_clearance cookie + browser TLS)
// and reports the chatroom id back via the report_kick_chatroom command. The
// per-platform profile persists the clearance so repeat lookups are fast.

/// Channel chrome the resolver webview reports back FIRST (as soon as the channel
/// API fetch lands), so chat connect + the name/viewers/uptime resolve without
/// waiting on the slower native-emote fetch (which is reported separately).
struct ResolvedChannel {
    chatroom_id: u64,
    sub_badges: Vec<(u32, String)>, // (months, badge image src)
    meta: Option<KickChannelMeta>,
}

/// Subscriber-badge entry deserialized from the report command.
#[derive(serde::Deserialize)]
pub struct KickSubBadge {
    pub months: u32,
    pub src: String,
}

/// Live channel metadata for the chat chrome (viewers, uptime, title, avatar),
/// captured from the channel API during resolve. Kick-driven equivalents of what
/// the Twitch path reads from Helix. `start_time` is normalized to ISO-UTC so the
/// frontend's uptime ticker (`new Date(...)`) reads it correctly.
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct KickChannelMeta {
    pub user_id: Option<u64>,
    /// The channel record id (`data.id`), distinct from `user_id`. This is the id
    /// Kick's Pusher uses for the `channel.{id}` socket that carries follows, host
    /// and stream-live/offline events (the chatroom socket does not).
    pub channel_id: Option<u64>,
    /// The channel owner's properly-cased username (the slug is lowercased), so
    /// tabs/headers can show "LarryWheels" instead of "larrywheels".
    pub username: Option<String>,
    pub viewer_count: Option<u64>,
    pub start_time: Option<String>,
    pub title: Option<String>,
    pub profile_pic: Option<String>,
    pub is_live: bool,
}

// Per-channel live metadata captured during resolve, keyed by lowercase slug.
static KICK_META: OnceLock<std::sync::Mutex<HashMap<String, KickChannelMeta>>> = OnceLock::new();

fn kick_meta_cache() -> &'static std::sync::Mutex<HashMap<String, KickChannelMeta>> {
    KICK_META.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// The cached live metadata for a slug, if resolved. Returned by the
/// `get_kick_channel_meta` command for the chat chrome.
pub fn channel_meta(slug: &str) -> Option<KickChannelMeta> {
    kick_meta_cache()
        .lock()
        .ok()
        .and_then(|m| m.get(&slug.to_lowercase()).cloned())
}

static PENDING: OnceLock<Mutex<HashMap<String, oneshot::Sender<ResolvedChannel>>>> = OnceLock::new();
// Native emotes are reported AFTER the channel chrome (separate, slower fetch), so
// they ride their own pending channel keyed by the same resolver label.
static PENDING_EMOTES: OnceLock<Mutex<HashMap<String, oneshot::Sender<Vec<kick_emotes::KickNativeEmoteEntry>>>>> =
    OnceLock::new();
static RESOLVE_SEQ: AtomicU64 = AtomicU64::new(0);
// Per-channel custom subscriber badges (months -> image src) captured from the
// channel API during resolution, keyed by slug. std Mutex for sync reads from
// the (sync) message parser.
static SUB_BADGES: OnceLock<std::sync::Mutex<HashMap<String, Vec<(u32, String)>>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, oneshot::Sender<ResolvedChannel>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pending_emotes(
) -> &'static Mutex<HashMap<String, oneshot::Sender<Vec<kick_emotes::KickNativeEmoteEntry>>>> {
    PENDING_EMOTES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sub_badges_cache() -> &'static std::sync::Mutex<HashMap<String, Vec<(u32, String)>>> {
    SUB_BADGES.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Called by `report_kick_chatroom` when the resolver webview (keyed by its unique
/// label) reports the channel chrome: chatroom id + subscriber badges + live meta.
/// Fired the instant the channel API fetch lands, before native emotes.
pub async fn resolve_pending(
    label: &str,
    chatroom_id: u64,
    sub_badges: Vec<(u32, String)>,
    meta: Option<KickChannelMeta>,
) {
    if let Some(tx) = pending().lock().await.remove(label) {
        let _ = tx.send(ResolvedChannel {
            chatroom_id,
            sub_badges,
            meta,
        });
    }
}

/// Called by `report_kick_emotes` when the (slower) native-emote fetch completes
/// in the resolver webview. Delivers them to the still-open resolver task, which
/// stores them and closes the webview.
pub async fn resolve_emotes_pending(label: &str, native_emotes: Vec<kick_emotes::KickNativeEmoteEntry>) {
    if let Some(tx) = pending_emotes().lock().await.remove(label) {
        let _ = tx.send(native_emotes);
    }
}

async fn resolve_via_webview(slug: &str) -> Result<u64> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let app = app_handle().ok_or_else(|| anyhow!("app handle not available for Kick resolver"))?;
    let slug_lc = slug.to_lowercase();
    // Tauri window labels only allow `[A-Za-z0-9-/:_]`, so sanitize the slug into
    // the label (a space or other stray char would otherwise crash the resolver).
    // The trailing seq still guarantees uniqueness, so collapsing odd chars is safe.
    let safe_slug: String = slug_lc
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    // Unique per attempt so a retry/concurrent resolve never collides on the
    // webview label (the bug behind "a webview with label ... already exists").
    let label = format!(
        "kick-resolve-{}-{}",
        safe_slug,
        RESOLVE_SEQ.fetch_add(1, Ordering::Relaxed)
    );

    let (tx, rx) = oneshot::channel::<ResolvedChannel>();
    let (tx_emotes, rx_emotes) = oneshot::channel::<Vec<kick_emotes::KickNativeEmoteEntry>>();
    pending().lock().await.insert(label.clone(), tx);
    pending_emotes().lock().await.insert(label.clone(), tx_emotes);

    let profile = kick_resolve_profile_dir(&app);
    let script = kick_resolve_script(&slug_lc, &label);
    let parsed = "https://kick.com/"
        .parse()
        .map_err(|e| anyhow!("bad url: {}", e))?;

    let win = match WebviewWindowBuilder::new(&app, label.clone(), WebviewUrl::External(parsed))
        .data_directory(profile)
        .initialization_script(&script)
        .visible(false)
        .skip_taskbar(true)
        // Don't steal focus, and keep the viewport tiny: the resolver only needs a
        // page context to run one fetch, so a 1x1 viewport means none of the
        // homepage's below-the-fold images/video ever lazy-load.
        .focused(false)
        .inner_size(1.0, 1.0)
        .build()
    {
        Ok(w) => w,
        Err(e) => {
            pending().lock().await.remove(&label);
            pending_emotes().lock().await.remove(&label);
            return Err(anyhow!("Kick resolver webview failed: {}", e));
        }
    };

    // Wait only for the channel chrome (chatroom id + meta + sub badges) — NOT the
    // native emotes — so chat connect and the name/viewers/uptime resolve as fast
    // as the channel API fetch.
    let result = timeout(Duration::from_secs(30), rx).await;
    pending().lock().await.remove(&label);

    match result {
        Ok(Ok(resolved)) => {
            if !resolved.sub_badges.is_empty() {
                if let Ok(mut m) = sub_badges_cache().lock() {
                    m.insert(slug_lc.clone(), resolved.sub_badges);
                }
            }
            if let Some(meta) = resolved.meta {
                let uid = meta.user_id;
                if let Ok(mut m) = kick_meta_cache().lock() {
                    m.insert(slug_lc.clone(), meta);
                }
                // Warm the channel's 7TV emotes now that its numeric Kick id is
                // known (the fetch self-throttles, so this won't re-hit 7TV).
                if let Some(uid) = uid {
                    let slug_owned = slug_lc.clone();
                    tokio::spawn(async move {
                        kick_emotes::refresh(&slug_owned, uid).await;
                    });
                }
            }
            // Keep the (hidden) resolver webview alive just long enough to collect
            // the native emotes it's still fetching, then store them and close it.
            // Detached so the chrome above is already live for the caller.
            let slug_owned = slug_lc.clone();
            let label_owned = label.clone();
            tokio::spawn(async move {
                if let Ok(Ok(emotes)) = timeout(Duration::from_secs(15), rx_emotes).await {
                    kick_emotes::store_native(&slug_owned, emotes);
                }
                pending_emotes().lock().await.remove(&label_owned);
                let _ = win.close();
            });
            Ok(resolved.chatroom_id)
        }
        other => {
            // Chrome never arrived: drop the emote channel + close the webview now.
            pending_emotes().lock().await.remove(&label);
            let _ = win.close();
            match other {
                Ok(Err(_)) => Err(anyhow!("Kick resolver channel closed for '{}'", slug)),
                _ => Err(anyhow!(
                    "Kick channel lookup for '{}' timed out (Cloudflare challenge?)",
                    slug
                )),
            }
        }
    }
}

fn kick_resolve_profile_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    let base = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let dir = base.join("platform_web_profiles").join("kick");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn kick_resolve_script(slug: &str, label: &str) -> String {
    let js_slug = serde_json::to_string(slug).unwrap_or_else(|_| "\"\"".to_string());
    let js_label = serde_json::to_string(label).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(function() {{
  var slug = {js_slug};
  var label = {js_label};
  var reportedChannel = false;
  var reportedEmotes = false;
  function extract(data) {{
    return ((data && data.subscriber_badges) || []).map(function(b) {{
      return {{ months: b.months, src: (b.badge_image && b.badge_image.src) || '' }};
    }}).filter(function(b) {{ return b.src; }});
  }}
  // Live chrome metadata (viewers/uptime/title/avatar + the owner user id used by
  // 7TV-for-Kick). start_time is normalized to ISO-UTC so the frontend uptime
  // ticker reads it as UTC rather than local time.
  function extractMeta(data) {{
    var ls = data && data.livestream;
    var raw = ls && ls.start_time;
    var st = raw ? (String(raw).indexOf('T') >= 0 ? String(raw) : String(raw).replace(' ', 'T') + 'Z') : null;
    return {{
      user_id: (data && data.user_id) || null,
      channel_id: (data && data.id) || null,
      username: (data && data.user && data.user.username) || null,
      viewer_count: ls ? (ls.viewer_count || 0) : null,
      start_time: st,
      title: (ls && ls.session_title) || null,
      profile_pic: (data && data.user && data.user.profile_pic) || null,
      is_live: !!ls
    }};
  }}
  // Kick's OWN emotes (channel sub set + Global + Emojis) from a SEPARATE,
  // also-Cloudflare-gated endpoint. Returns an array of sets, each with a name
  // and an emotes list; flatten to {{ id, name, set }} carrying the set label.
  function extractEmotes(payload) {{
    var sets = Array.isArray(payload) ? payload : (payload && payload.data) || [];
    var out = [];
    sets.forEach(function(set) {{
      if (!set) return;
      var setLabel = String(set.name || set.id || 'Emotes');
      (set.emotes || []).forEach(function(e) {{
        if (e && e.id != null && e.name) out.push({{ id: String(e.id), name: String(e.name), set: setLabel }});
      }});
    }});
    return out;
  }}
  // Best-effort native-emote fetch. Resolves to [] (never rejects) so it can
  // never block reporting the chatroom id that chat connect depends on. Run only
  // AFTER the channel fetch proves Cloudflare is cleared, so its first try hits.
  function fetchEmotes(tries) {{
    return fetch('https://kick.com/emotes/' + slug + '?_cb=' + Date.now(), {{ headers: {{ 'Accept': 'application/json' }}, cache: 'no-store' }})
      .then(function(r) {{ if (!r.ok) throw r.status; return r.json(); }})
      .then(extractEmotes)
      .catch(function() {{
        if (tries < 3) return new Promise(function(res) {{ setTimeout(res, 700); }}).then(function() {{ return fetchEmotes(tries + 1); }});
        return [];
      }});
  }}
  // Report the channel chrome (chatroom id + sub badges + live meta) the INSTANT
  // the channel fetch lands, so chat connect + name/viewers/uptime resolve first.
  function reportChannel(id, sb, meta) {{
    if (reportedChannel || !id) return;
    reportedChannel = true;
    window.__TAURI_INTERNALS__.invoke('report_kick_chatroom', {{ label: label, chatroomId: id, subBadges: sb, meta: meta }});
  }}
  // Report native emotes separately, once their (slower) fetch finishes.
  function reportEmotes(emotes) {{
    if (reportedEmotes) return;
    reportedEmotes = true;
    window.__TAURI_INTERNALS__.invoke('report_kick_emotes', {{ label: label, nativeEmotes: emotes || [] }});
  }}
  // One fetch from the (Cloudflare-cleared) page context carries the chatroom id
  // + the channel's subscriber_badges + live meta. Report the chrome on the first
  // response that has the id, with whatever badges it lists -- an EMPTY array is a
  // legitimate answer (most channels set no custom subscriber badges), so we must
  // not retry waiting for it or chat connect would stall. Retries cover only a
  // failed/incomplete fetch (a Cloudflare interstitial that hasn't cleared yet).
  // Native emotes are fetched + reported separately so they never delay the chrome.
  function tryFetch(tries) {{
    if (tries > 6) return;
    fetch('https://kick.com/api/v2/channels/' + slug + '?_cb=' + Date.now(), {{ headers: {{ 'Accept': 'application/json' }}, cache: 'no-store' }})
      .then(function(r) {{ if (!r.ok) throw r.status; return r.json(); }})
      .then(function(data) {{
        var id = data && data.chatroom && data.chatroom.id;
        if (!id) {{ setTimeout(function() {{ tryFetch(tries + 1); }}, 800); return; }}
        reportChannel(id, extract(data), extractMeta(data));
        fetchEmotes(0).then(reportEmotes);
      }})
      .catch(function() {{ setTimeout(function() {{ tryFetch(tries + 1); }}, 1000); }});
  }}
  // Fire at document-start (this script is an initialization script, so it runs
  // before the page's own scripts). fetch() needs only the origin + cookies, NOT a
  // loaded DOM, so we don't wait for `load` -- that lets the resolver grab what it
  // needs and be closed before the heavy homepage bundle finishes loading.
  tryFetch(0);
}})();"#
    )
}

/// Connect + stream forever, reconnecting on drop, until the task is aborted.
async fn run_connection(slug: String, chatroom_id: u64) {
    let channel_key = key::make_key("kick", &slug);
    loop {
        // The channel-scoped socket (follows / host / stream-live) keys off the
        // channel record id, captured into the meta during resolve. Re-read it each
        // attempt so a late-populating resolve is still picked up.
        let channel_id = channel_meta(&slug).and_then(|m| m.channel_id);
        if let Err(e) = connect_and_stream(chatroom_id, channel_id, &channel_key).await {
            log::warn!("[Kick] '{}' stream error: {}", slug, e);
        }
        tokio::time::sleep(Duration::from_secs(RECONNECT_DELAY_SECS)).await;
    }
}

async fn connect_and_stream(chatroom_id: u64, channel_id: Option<u64>, channel_key: &str) -> Result<()> {
    let (ws, _) = connect_async(PUSHER_URL).await?;
    let (mut write, mut read) = ws.split();

    let subscribe = json!({
        "event": "pusher:subscribe",
        "data": { "channel": format!("chatrooms.{}.v2", chatroom_id) }
    });
    write.send(Message::text(subscribe.to_string())).await?;

    // Also join the channel-scoped socket, which carries the broadcaster events the
    // chatroom socket doesn't: new followers, hosts/raids, and stream live/offline.
    // Both subscriptions ride this one connection; events from either arrive in the
    // same read loop and dispatch by event name. Kick has used both a dotted and a
    // legacy underscore form for this channel, so subscribe to both to be safe.
    if let Some(cid) = channel_id {
        for ch in [format!("channel.{}", cid), format!("channel_{}", cid)] {
            let sub = json!({ "event": "pusher:subscribe", "data": { "channel": ch } });
            let _ = write.send(Message::text(sub.to_string())).await;
        }
    }

    loop {
        match timeout(Duration::from_secs(READ_TIMEOUT_SECS), read.next()).await {
            // Idle: keep the connection alive with a Pusher ping.
            Err(_) => {
                let ping = json!({ "event": "pusher:ping", "data": {} });
                if write.send(Message::text(ping.to_string())).await.is_err() {
                    return Ok(());
                }
            }
            Ok(None) => return Ok(()),
            Ok(Some(Ok(Message::Text(txt)))) => {
                let Ok(frame) = serde_json::from_str::<Value>(&txt) else {
                    continue;
                };
                match frame.get("event").and_then(|e| e.as_str()).unwrap_or("") {
                    "pusher:ping" => {
                        let pong = json!({ "event": "pusher:pong", "data": {} });
                        let _ = write.send(Message::text(pong.to_string())).await;
                    }
                    "App\\Events\\ChatMessageEvent" => {
                        if let Some(msg) = parse_chat_message(&frame, channel_key) {
                            publish_chat_message(&msg).await;
                        }
                    }
                    // Subscriptions and gifted subs arrive as their own chatroom
                    // events (not chat messages). Normalize each into a synthetic
                    // ChatMessage carrying the SAME Twitch tags (`msg-id` +
                    // `system-msg`) so the existing subscription-card decoration
                    // renders with no frontend changes.
                    "App\\Events\\SubscriptionEvent" => {
                        if let Some(msg) = parse_subscription(&frame, channel_key) {
                            publish_chat_message(&msg).await;
                        }
                    }
                    "App\\Events\\GiftedSubscriptionsEvent" => {
                        if let Some(msg) = parse_gifted_subs(&frame, channel_key) {
                            publish_chat_message(&msg).await;
                        }
                    }
                    // Moderation events Kick broadcasts to EVERY viewer (so they
                    // populate the chat-deletion overlay + mod pane even when we
                    // aren't a mod). Each is normalized into the SAME control frame
                    // the Twitch IRC path emits (CLEARMSG / CLEARCHAT), which the
                    // frontend already routes by `channel` -> the `kick:slug` slice.
                    // Unlike Twitch IRC, Kick names the acting moderator, so we
                    // thread it through.
                    "App\\Events\\MessageDeletedEvent" => {
                        if let Some(frame) = build_clearmsg(&frame, channel_key) {
                            publish_frame(frame).await;
                        }
                    }
                    "App\\Events\\UserBannedEvent" => {
                        if let Some(frame) = build_clearchat(&frame, channel_key) {
                            publish_frame(frame).await;
                        }
                    }
                    // Pinned messages: Kick broadcasts the full pinned message +
                    // who pinned it. Normalize into a PINNED/UNPINNED control frame
                    // the frontend turns into the same pinned banner Twitch uses.
                    "App\\Events\\PinnedMessageCreatedEvent" => {
                        if let Some(frame) = build_pinned(&frame, channel_key) {
                            publish_frame(frame).await;
                        }
                    }
                    "App\\Events\\PinnedMessageDeletedEvent" => {
                        let unpin = json!({ "type": "UNPINNED", "provider": "kick", "channel": channel_key });
                        publish_frame(unpin.to_string()).await;
                    }
                    name => {
                        // Surface any other Kick event ONCE per occurrence so a live
                        // run reveals the real payload shapes (follows, host/raid,
                        // stream live/offline) instead of guessing. Logs the Pusher
                        // channel too so we can tell the chatroom socket from the
                        // channel socket. Grep `[Kick][discover]`. Pusher's own
                        // lifecycle frames don't carry the `App\Events\` prefix, so
                        // they stay quiet.
                        if name.starts_with("App\\Events\\") {
                            log::info!(
                                "[Kick][discover] event {} on {}: {}",
                                name,
                                frame.get("channel").and_then(|c| c.as_str()).unwrap_or("?"),
                                frame.get("data").and_then(|d| d.as_str()).unwrap_or("")
                            );
                        }
                    }
                }
            }
            Ok(Some(Ok(Message::Ping(p)))) => {
                let _ = write.send(Message::Pong(p)).await;
            }
            Ok(Some(Ok(Message::Close(_)))) => return Ok(()),
            Ok(Some(Err(e))) => return Err(e.into()),
            Ok(Some(Ok(_))) => {}
        }
    }
}

/// Decode one `ChatMessageEvent` Pusher frame into a unified ChatMessage. The
/// frame's `data` field is a JSON-encoded string (double-encoded).
fn parse_chat_message(frame: &Value, channel_key: &str) -> Option<ChatMessage> {
    let data_str = frame.get("data")?.as_str()?;
    let data: Value = serde_json::from_str(data_str).ok()?;

    let slug = key::parse_key(channel_key).channel;
    let content = data.get("content").and_then(|c| c.as_str()).unwrap_or("");
    let (segments, plain) = parse_segments(content, &slug);

    let sender = data.get("sender");
    let username = sender
        .and_then(|s| s.get("slug"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let display_name = sender
        .and_then(|s| s.get("username"))
        .and_then(|x| x.as_str())
        .map(String::from)
        .unwrap_or_else(|| username.clone());
    let user_id = sender
        .and_then(|s| s.get("id"))
        .and_then(|x| x.as_u64())
        .map(|n| n.to_string())
        .unwrap_or_default();
    let color = sender
        .and_then(|s| s.get("identity"))
        .and_then(|i| i.get("color"))
        .and_then(|x| x.as_str())
        .map(String::from);

    let id = data
        .get("id")
        .and_then(|x| x.as_str())
        .map(String::from)
        .unwrap_or_else(|| format!("kick-{}", FALLBACK_SEQ.fetch_add(1, Ordering::Relaxed)));
    let timestamp = data
        .get("created_at")
        .and_then(|x| x.as_str())
        .map(String::from)
        .unwrap_or_default();

    let badges = parse_badges(sender.and_then(|s| s.get("identity")), &slug);

    // Replies carry a sibling `metadata` with the original sender + message. The
    // original sender exposes only id + cased username (no slug/color/badges).
    let reply_info = if data.get("type").and_then(|t| t.as_str()) == Some("reply") {
        data.get("metadata").map(|m| {
            let parent_name = m
                .pointer("/original_sender/username")
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string();
            let parent_id = m.pointer("/original_sender/id").map_or_else(String::new, |i| {
                i.as_u64()
                    .map(|n| n.to_string())
                    .or_else(|| i.as_str().map(String::from))
                    .unwrap_or_default()
            });
            ReplyInfo {
                parent_msg_id: m
                    .pointer("/original_message/id")
                    .and_then(|i| i.as_str())
                    .unwrap_or("")
                    .to_string(),
                parent_display_name: parent_name.clone(),
                parent_msg_body: m
                    .pointer("/original_message/content")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string(),
                parent_user_id: parent_id,
                parent_user_login: parent_name.to_lowercase(),
            }
        })
    } else {
        None
    };
    let has_reply = reply_info.is_some();

    // The renderer reads the display name from the `display-name` tag (a Twitch
    // convention); stamp the cased username so Kick names aren't shown lowercase.
    let mut tags = HashMap::new();
    tags.insert("display-name".to_string(), display_name.clone());
    // Mirror the message id into the `id` tag (a Twitch convention the frontend's
    // delete / pin / mod paths read) so deleting a Kick message can address it.
    tags.insert("id".to_string(), id.clone());

    // NOTE: no `first-msg` tag for Kick. Twitch's first-message flag is
    // server-authoritative (the user's genuine first message in the channel,
    // ever); Kick's public Pusher payload exposes NO equivalent — not at the top
    // level, in `metadata` (just `message_ref`), or in `sender.identity`
    // (verified against captured samples). "First time WE saw them this session"
    // is not the same thing — it would falsely flag every regular who chats right
    // after we connect, and re-flag everyone on reconnect — so we don't fake it.

    Some(ChatMessage {
        id,
        user_id,
        username,
        display_name,
        color,
        badges,
        timestamp,
        content: plain,
        provider: "kick".to_string(),
        channel: channel_key.to_string(),
        emotes: Vec::new(),
        tags,
        layout: LayoutResult {
            height: 0.0,
            width: 0.0,
            has_reply,
            is_first_message: false,
        },
        segments,
        metadata: MessageMetadata {
            reply_info,
            ..Default::default()
        },
    })
}

/// Build a synthetic ChatMessage for a Kick room event (sub, gift sub) that
/// reuses Twitch's subscription-card decoration. The card is driven entirely by
/// the `msg-id` + `system-msg` tags (mirrored into `metadata`), so no frontend
/// change is needed — Kick just has to speak the same tag vocabulary.
fn build_event_message(
    channel_key: &str,
    display_name: &str,
    msg_id: &str,
    system_msg: &str,
) -> ChatMessage {
    let id = format!("kick-evt-{}", FALLBACK_SEQ.fetch_add(1, Ordering::Relaxed));
    let mut tags = HashMap::new();
    tags.insert("display-name".to_string(), display_name.to_string());
    tags.insert("msg-id".to_string(), msg_id.to_string());
    tags.insert("system-msg".to_string(), system_msg.to_string());
    ChatMessage {
        id,
        user_id: String::new(),
        username: display_name.to_lowercase(),
        display_name: display_name.to_string(),
        color: None,
        badges: Vec::new(),
        timestamp: String::new(),
        content: String::new(),
        provider: "kick".to_string(),
        channel: channel_key.to_string(),
        emotes: Vec::new(),
        tags,
        layout: LayoutResult {
            height: 0.0,
            width: 0.0,
            has_reply: false,
            is_first_message: false,
        },
        segments: Vec::new(),
        metadata: MessageMetadata {
            msg_type: Some(msg_id.to_string()),
            system_message: Some(system_msg.to_string()),
            ..Default::default()
        },
    }
}

/// Pull a display name out of a JSON value that may be either a bare string
/// (Pusher's flat shape, e.g. `username: "Foo"`) or an object carrying a
/// `username`/`slug` field (the object shape Kick uses in the official webhook
/// and some Pusher payloads, e.g. `gifter: { username: "Foo" }`). Lets the
/// parsers below accept whichever shape the live socket actually sends.
fn name_from(v: Option<&Value>) -> Option<String> {
    let v = v?;
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    v.get("username")
        .or_else(|| v.get("slug"))
        .and_then(|x| x.as_str())
        .map(String::from)
}

/// Decode `App\Events\SubscriptionEvent` (a subscribe or resub). Like the chat
/// event, `data` is a double-encoded JSON string. Documented shape (KickLib /
/// kick.py): `{ chatroom_id, username, months }`; tolerant of a nested
/// subscriber/user object too. NEEDS LIVE CONFIRMATION — the unhandled-event
/// logger above captures the real payload if these field names are off.
fn parse_subscription(frame: &Value, channel_key: &str) -> Option<ChatMessage> {
    let data: Value = serde_json::from_str(frame.get("data")?.as_str()?).ok()?;
    // TEMP: confirm the real field names (months/duration/tier) + whether the event
    // carries the subscriber's identity/badges, so the activity row can be enriched.
    log::info!("[Kick][sub] SubscriptionEvent raw: {}", data);
    let username = name_from(data.get("username"))
        .or_else(|| name_from(data.get("subscriber")))
        .or_else(|| name_from(data.get("user")))?;
    let months = data
        .get("months")
        .or_else(|| data.get("duration"))
        .and_then(|x| x.as_u64())
        .unwrap_or(1);
    let (msg_id, system_msg) = if months > 1 {
        (
            "resub",
            format!("{} subscribed for {} months!", username, months),
        )
    } else {
        ("sub", format!("{} subscribed!", username))
    };
    let mut msg = build_event_message(channel_key, &username, msg_id, &system_msg);
    // Carry the cumulative months in the Twitch tag vocabulary so the activity feed's
    // generic producer surfaces the resub duration (like Twitch), not just "resubbed".
    msg.tags
        .insert("msg-param-cumulative-months".to_string(), months.to_string());
    Some(msg)
}

/// Decode `App\Events\GiftedSubscriptionsEvent`. Documented Pusher shape:
/// `{ chatroom_id, gifted_usernames: [..], gifter_username }`; also tolerant of
/// the object shape (`gifter: {..}`, `giftees: [{..}]`). One recipient renders
/// as a single gift (`subgift`); many as a community gift (`submysterygift`).
/// NEEDS LIVE CONFIRMATION of the field names.
fn parse_gifted_subs(frame: &Value, channel_key: &str) -> Option<ChatMessage> {
    let data: Value = serde_json::from_str(frame.get("data")?.as_str()?).ok()?;
    let gifter = name_from(data.get("gifter_username"))
        .or_else(|| name_from(data.get("gifter")))
        .unwrap_or_else(|| "Anonymous".to_string());
    let recipients: Vec<String> = data
        .get("gifted_usernames")
        .or_else(|| data.get("giftees"))
        .or_else(|| data.get("gifted"))
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|v| name_from(Some(v))).collect())
        .unwrap_or_default();
    if recipients.is_empty() {
        return None;
    }
    let (msg_id, system_msg) = if recipients.len() == 1 {
        (
            "subgift",
            format!("{} gifted a subscription to {}!", gifter, recipients[0]),
        )
    } else {
        (
            "submysterygift",
            format!("{} gifted {} subscriptions!", gifter, recipients.len()),
        )
    };
    Some(build_event_message(channel_key, &gifter, msg_id, &system_msg))
}

/// Decode `App\Events\MessageDeletedEvent` into a `CLEARMSG` control frame (a
/// single message removed). Kick's payload carries the deleted message id and
/// usually the acting moderator. SHAPE-TOLERANT — the new arms log the raw
/// payload so the exact fields can be confirmed from a live run.
fn build_clearmsg(frame: &Value, channel_key: &str) -> Option<String> {
    let data: Value = serde_json::from_str(frame.get("data")?.as_str()?).ok()?;
    // Both delete shapes confirmed live: AUTO-mod deletes carry `aiModerated:true` +
    // `violatedRules`; manual deletes carry `aiModerated:false` and NO moderator
    // field (Kick's public delete event never names the human mod).
    let ai_moderated = data
        .get("aiModerated")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    // The DELETED MESSAGE id lives under `message.id`. The top-level `id` is the
    // event's own id (different), so don't fall back to it.
    let target_msg_id = data
        .pointer("/message/id")
        .and_then(|x| x.as_str())
        .or_else(|| data.get("message_id").and_then(|x| x.as_str()))?;
    let mut out = json!({
        "type": "CLEARMSG",
        "provider": "kick",
        "channel": channel_key,
        "target_msg_id": target_msg_id,
    });
    // Confirmed live: Kick's AUTO-moderation deletes carry `aiModerated:true` +
    // `violatedRules:[...]` and no human mod -> surface as AutoMod with the rules as
    // the reason. A human-mod delete (shape not yet seen) falls back to "A
    // moderator" frontend-side; the author + text are recovered from chat history.
    if ai_moderated {
        out["moderator"] = json!("AutoMod");
    } else if let Some(m) =
        name_from(data.get("deleted_by")).or_else(|| name_from(data.get("moderator")))
    {
        out["moderator"] = json!(m);
    }
    if let Some(rules) = data.get("violatedRules").and_then(|r| r.as_array()) {
        let joined = rules
            .iter()
            .filter_map(|r| r.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        if !joined.is_empty() {
            out["reason"] = json!(joined);
        }
    }
    Some(out.to_string())
}

/// Decode `App\Events\UserBannedEvent` into a `CLEARCHAT` control frame (ban or
/// timeout). A present `expires_at` means a timed ban (the frontend reads
/// `ban_duration` in seconds to distinguish timeout from a permanent ban); its
/// absence means a permanent ban. Carries the banned user + the acting moderator.
fn build_clearchat(frame: &Value, channel_key: &str) -> Option<String> {
    let data: Value = serde_json::from_str(frame.get("data")?.as_str()?).ok()?;
    // Both shapes CONFIRMED live: a permanent ban is `permanent:true` with no
    // expiry; a timeout is `permanent:false` with `duration:<minutes>` (e.g. 5) +
    // `expires_at:<ISO>`. Both carry `user{id,username}` + `banned_by{username}`
    // (Kick names the acting moderator, unlike Twitch's anonymous IRC).
    let permanent = data
        .get("permanent")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let user = data.get("user");
    let target_user_id = user
        .and_then(|u| u.get("id"))
        .and_then(|x| {
            x.as_u64()
                .map(|n| n.to_string())
                .or_else(|| x.as_str().map(String::from))
        })?;
    let target_user = user
        .and_then(|u| u.get("username").or_else(|| u.get("slug")))
        .and_then(|x| x.as_str())
        .map(String::from)
        .unwrap_or_default();
    let mut out = json!({
        "type": "CLEARCHAT",
        "provider": "kick",
        "channel": channel_key,
        "target_user_id": target_user_id,
        "target_user": target_user,
    });
    // Permanent ban => no `ban_duration` (the frontend reads its absence as a ban).
    // Timeout => `duration` is MINUTES (confirmed: duration:5 == a 5-min timeout),
    // so convert to seconds; fall back to computing from `expires_at` if absent.
    if !permanent {
        let secs = data
            .get("duration")
            .and_then(|x| x.as_i64())
            .or_else(|| {
                data.get("duration")
                    .and_then(|x| x.as_str())
                    .and_then(|s| s.parse().ok())
            })
            .map(|mins| mins * 60)
            .or_else(|| {
                data.get("expires_at")
                    .and_then(|x| x.as_str())
                    .and_then(kick_secs_until)
            });
        if let Some(s) = secs {
            out["ban_duration"] = json!(s);
        }
    }
    if let Some(m) = name_from(data.get("banned_by")).or_else(|| name_from(data.get("moderator"))) {
        out["moderator"] = json!(m);
    }
    Some(out.to_string())
}

/// Seconds from now until an RFC3339/ISO timestamp (Kick timeout `expires_at`),
/// clamped to at least 1. None if it can't be parsed or is already past.
fn kick_secs_until(iso: &str) -> Option<i64> {
    let when = chrono::DateTime::parse_from_rfc3339(iso).ok()?;
    let secs = when.timestamp() - chrono::Utc::now().timestamp();
    (secs > 0).then(|| secs.max(1))
}

/// Decode `App\Events\PinnedMessageCreatedEvent` into a `PINNED` control frame
/// shaped like the frontend's `PinnedMessage` (so it drives the SAME pinned banner
/// Twitch uses). Kick gives the whole message + who pinned it; we don't get an
/// avatar or Twitch-format badges, so those are left empty.
fn build_pinned(frame: &Value, channel_key: &str) -> Option<String> {
    let data: Value = serde_json::from_str(frame.get("data")?.as_str()?).ok()?;
    let msg = data.get("message")?;
    let message_id = msg.get("id").and_then(|x| x.as_str())?;
    let id_str = |v: Option<&Value>| {
        v.and_then(|x| {
            x.as_u64()
                .map(|n| n.to_string())
                .or_else(|| x.as_str().map(String::from))
        })
        .unwrap_or_default()
    };
    let sender = msg.get("sender");
    let pinned_by = data.get("pinnedBy");
    let pin = json!({
        "id": message_id,
        "message_id": message_id,
        "type": "kick",
        "message_text": strip_emote_tokens(msg.get("content").and_then(|x| x.as_str()).unwrap_or("")),
        "sender_id": id_str(sender.and_then(|s| s.get("id"))),
        "sender_name": sender.and_then(|s| s.get("username")).and_then(|x| x.as_str()).unwrap_or(""),
        "sender_color": sender.and_then(|s| s.pointer("/identity/color")).and_then(|x| x.as_str()).unwrap_or(""),
        "sender_avatar": "",
        "sender_badges": [],
        "pinned_by": pinned_by.and_then(|p| p.get("username")).and_then(|x| x.as_str()).unwrap_or(""),
        "pinned_by_id": id_str(pinned_by.and_then(|p| p.get("id"))),
        "pinned_by_avatar": "",
        "started_at": msg.get("created_at").and_then(|x| x.as_str()).unwrap_or(""),
    });
    let out = json!({ "type": "PINNED", "provider": "kick", "channel": channel_key, "pin": pin });
    Some(out.to_string())
}

/// Replace Kick's inline `[emote:<id>:<name>]` tokens with just the emote name,
/// for plain-text surfaces like the pinned-message banner.
fn strip_emote_tokens(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find("[emote:") {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let Some(end) = after.find(']') else {
            rest = after;
            break;
        };
        if let Some(colon) = after[7..end].find(':') {
            out.push_str(&after[7 + colon + 1..end]);
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// Map Kick's `identity.badges` into the unified Badge list. Kick global badges
/// (broadcaster/moderator/vip/og/founder/...) carry no image URL, so the
/// frontend maps the `name` (type) to a bundled icon; `version` carries the
/// subscriber month count. Custom per-channel subscriber art is a later pass.
fn parse_badges(identity: Option<&Value>, slug: &str) -> Vec<Badge> {
    let Some(identity) = identity else {
        return Vec::new();
    };
    // The channel's real custom subscriber badge art, if captured during resolve.
    // The cache is keyed by lowercased slug, so look up the same way.
    let subs = sub_badges_cache()
        .lock()
        .ok()
        .and_then(|m| m.get(&slug.to_lowercase()).cloned());

    // (sort_order, Badge). Kick renders the MERGED set of `badges` (role badges)
    // and `badges_v2` (level / gamification art) ordered by each entry's
    // `sort_order`, so collect both with their order and sort at the end.
    let mut ordered: Vec<(i64, Badge)> = Vec::new();

    // Role badges (broadcaster/moderator/vip/og/founder/subscriber/...). They
    // carry no image: the frontend maps the type to a bundled icon, except
    // `subscriber`, which resolves to the channel's real custom art by month tier.
    if let Some(arr) = identity.get("badges").and_then(|b| b.as_array()) {
        for b in arr {
            let Some(kind) = b.get("type").and_then(|t| t.as_str()) else {
                continue;
            };
            let text = b.get("text").and_then(|t| t.as_str()).unwrap_or(kind);
            let count = b.get("count").and_then(|c| c.as_u64());
            let sort = b.get("sort_order").and_then(|s| s.as_i64()).unwrap_or(1000);
            let image = if kind == "subscriber" {
                subs.as_ref()
                    .and_then(|s| match_sub_badge(s, count.unwrap_or(0) as u32))
            } else {
                None
            };
            ordered.push((
                sort,
                Badge {
                    name: kind.to_string(),
                    version: count
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "1".to_string()),
                    image_url_1x: image,
                    image_url_2x: None,
                    image_url_4x: None,
                    title: Some(text.to_string()),
                    description: None,
                },
            ));
        }
    }

    // `badges_v2`: Kick's newer badge set (the account-level / gamification badge,
    // and any badge whose art Kick bakes in) with a ready-to-render `image_url`.
    // The old `badges` array does NOT carry these, so without this the level badge
    // Kick shows next to every chatter would be missing.
    if let Some(arr) = identity.get("badges_v2").and_then(|b| b.as_array()) {
        for b in arr {
            let Some(name) = b.get("name").and_then(|t| t.as_str()) else {
                continue;
            };
            let Some(img) = b
                .get("image_url")
                .and_then(|t| t.as_str())
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let sort = b.get("sort_order").and_then(|s| s.as_i64()).unwrap_or(1000);
            // Friendly tooltip: "Level 16" when the metadata carries a level.
            let level = b.pointer("/metadata/level").and_then(|l| l.as_u64());
            let title = match (name, level) {
                ("level", Some(n)) => format!("Level {}", n),
                _ => name.to_string(),
            };
            ordered.push((
                sort,
                Badge {
                    name: name.to_string(),
                    version: level.map(|n| n.to_string()).unwrap_or_else(|| "1".to_string()),
                    image_url_1x: Some(img.to_string()),
                    image_url_2x: None,
                    image_url_4x: None,
                    title: Some(title),
                    description: None,
                },
            ));
        }
    }

    ordered.sort_by_key(|(s, _)| *s);
    ordered.into_iter().map(|(_, b)| b).collect()
}

/// Pick the subscriber badge for `months`: exact tier, else the highest tier the
/// chatter has passed.
fn match_sub_badge(subs: &[(u32, String)], months: u32) -> Option<String> {
    subs.iter()
        .find(|(m, _)| *m == months)
        .map(|(_, s)| s.clone())
        .or_else(|| {
            subs.iter()
                .filter(|(m, _)| *m <= months)
                .max_by_key(|(m, _)| *m)
                .map(|(_, s)| s.clone())
        })
}

/// Split Kick content into text + emote segments. Kick inlines its native emotes
/// as `[emote:<id>:<name>]` (image at files.kick.com); between those tokens we
/// match words against the channel's 7TV set so 7TV emotes render too. Returns
/// the segments plus a plain-text rendering (emote tokens replaced by their names).
fn parse_segments(content: &str, slug: &str) -> (Vec<MessageSegment>, String) {
    let mut segments: Vec<MessageSegment> = Vec::new();
    let mut plain = String::new();
    let mut rest = content;

    while let Some(start) = rest.find("[emote:") {
        if start > 0 {
            push_text_run(&mut segments, &mut plain, &rest[..start], slug);
        }
        let after = &rest[start..];
        if let Some(end_rel) = after.find(']') {
            let inner = &after[7..end_rel]; // between "[emote:" and "]"
            if let Some(colon) = inner.find(':') {
                let id = &inner[..colon];
                let name = &inner[colon + 1..];
                segments.push(MessageSegment::Emote {
                    content: name.to_string(),
                    emote_id: Some(id.to_string()),
                    emote_url: format!("https://files.kick.com/emotes/{}/fullsize", id),
                    is_zero_width: None,
                });
                plain.push_str(name);
            } else {
                push_text_run(&mut segments, &mut plain, &after[..=end_rel], slug);
            }
            rest = &after[end_rel + 1..];
        } else {
            // No closing bracket: treat the remainder as text.
            break;
        }
    }
    if !rest.is_empty() {
        push_text_run(&mut segments, &mut plain, rest, slug);
    }
    (segments, plain)
}

/// Emit a run of plain text, baking any whitespace-delimited word that matches the
/// channel's 7TV set into an emote segment (original whitespace preserved).
fn push_text_run(segments: &mut Vec<MessageSegment>, plain: &mut String, text: &str, slug: &str) {
    let mut buf = String::new(); // pending non-emote text (words + whitespace)
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            buf.push(chars[i]);
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && !chars[i].is_whitespace() {
            i += 1;
        }
        let word: String = chars[start..i].iter().collect();
        match kick_emotes::lookup(slug, &word) {
            Some(e) => {
                if !buf.is_empty() {
                    plain.push_str(&buf);
                    segments.push(MessageSegment::Text {
                        content: std::mem::take(&mut buf),
                    });
                }
                plain.push_str(&word);
                segments.push(MessageSegment::Emote {
                    content: word,
                    emote_id: Some(e.id),
                    emote_url: e.url,
                    is_zero_width: Some(e.zero_width),
                });
            }
            None => buf.push_str(&word),
        }
    }
    if !buf.is_empty() {
        plain.push_str(&buf);
        segments.push(MessageSegment::Text { content: buf });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_text_and_emotes() {
        let (segs, plain) = parse_segments("hi [emote:39261:KEKW] there", "test");
        assert_eq!(plain, "hi KEKW there");
        assert_eq!(segs.len(), 3);
        match &segs[1] {
            MessageSegment::Emote { emote_url, content, .. } => {
                assert!(emote_url.contains("39261"));
                assert_eq!(content, "KEKW");
            }
            _ => panic!("expected emote segment"),
        }
    }

    #[test]
    fn plain_text_is_one_segment() {
        let (segs, plain) = parse_segments("just talking", "test");
        assert_eq!(plain, "just talking");
        assert_eq!(segs.len(), 1);
    }
}
