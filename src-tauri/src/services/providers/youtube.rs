//! YouTube live chat adapter (read-only).
//!
//! Reads a live stream's chat over YouTube's internal "InnerTube" API, the same
//! private API the website uses, and normalizes each message into the shared
//! `ChatMessage` published onto the local-WS bus. Anonymous: no YouTube login is
//! needed to read public live chat. Sending needs the viewer's identity (Data-API
//! quota or a logged-in session), so `send_capability` reports read-only for now.
//!
//! Flow (no browser, plain HTTP — YouTube isn't Cloudflare-gated like Kick):
//!   1. resolve the currently-live video from a handle / channel id / video id by
//!      fetching its watch page and scraping the InnerTube key + client version +
//!      the initial live-chat continuation token,
//!   2. long-poll `youtubei/v1/live_chat/get_live_chat` on the server-provided
//!      `timeoutMs`, decoding `addChatItemAction` renderers into chat messages.
//!
//! A consent cookie (`SOCS=CAI`) is sent so a server-side fetch skips the EU
//! interstitial. If a future host IP ever gets bot-challenged, the documented
//! fallback is the same hidden-webview page-context fetch the Kick adapter uses.

use super::{
    dec_bridge_users, inc_bridge_users, key, publish_chat_message, publish_frame, ChatProvider,
    SendCapability, SendOutcome,
};
use crate::models::chat_layout::{
    Badge, ChatMessage, LayoutResult, MessageMetadata, MessageSegment,
};
use crate::services::youtube_auth_service;
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use base64::Engine;
use futures::FutureExt;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
// Fallback poll cadence when the response omits a timeoutMs (it usually carries one).
const DEFAULT_POLL_MS: u64 = 5000;
// After a stream ends / errors, wait this long before re-resolving (catches a
// channel that drops and comes back, or a brief network blip).
const RE_RESOLVE_DELAY_SECS: u64 = 15;

static FALLBACK_SEQ: AtomicU64 = AtomicU64::new(0);

struct Connection {
    consumers: HashSet<String>,
    // None while the live video is still resolving; Some once the stream task is
    // spawned. Reserving the slot before the (network) resolve stops a concurrent
    // connect for the same channel from spinning a second resolve+stream.
    task: Option<JoinHandle<()>>,
}

pub struct YouTubeProvider {
    // Active stream tasks keyed by the lowercased identifier.
    conns: Mutex<HashMap<String, Connection>>,
    // One client reused for both the watch-page scrape and the InnerTube long-poll:
    // desktop-Chrome UA + a consent cookie so a server-side fetch isn't bounced to
    // the EU "before you continue" interstitial.
    http: reqwest::Client,
}

impl YouTubeProvider {
    pub fn new() -> Self {
        Self {
            conns: Mutex::new(HashMap::new()),
            http: build_client(),
        }
    }
}

fn build_client() -> reqwest::Client {
    let mut headers = reqwest::header::HeaderMap::new();
    if let Ok(v) = reqwest::header::HeaderValue::from_str("SOCS=CAI") {
        headers.insert(reqwest::header::COOKIE, v);
    }
    if let Ok(v) = reqwest::header::HeaderValue::from_str("en-US,en;q=0.9") {
        headers.insert(reqwest::header::ACCEPT_LANGUAGE, v);
    }
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .default_headers(headers)
        // get_live_chat returns immediately (the timeoutMs is a client-side wait, not
        // a server hold), and page fetches are quick — so without these a stuck
        // connection blocks the poll loop forever and the pane sits on "Waiting for
        // messages" until a hard refresh. A bounded timeout turns a hang into an error
        // the loop recovers from by re-resolving.
        .timeout(Duration::from_secs(12))
        .connect_timeout(Duration::from_secs(8))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

#[async_trait]
impl ChatProvider for YouTubeProvider {
    fn id(&self) -> &'static str {
        "youtube"
    }

    async fn connect(&self, channel: &str, window: &str) -> Result<()> {
        // YouTube video + channel ids are case-sensitive, but the composite key the
        // store routes by is lowercased — so a reconnect/restore can hand us the
        // identifier lowercased. Resolve with the original case remembered from the
        // first (add-time) connect; the conn map + bus key stay lowercased so
        // disconnect + the frontend slice key still line up.
        let identifier = canonical_identifier(channel);
        let channel = identifier.as_str();
        let id_lc = channel.to_lowercase();
        {
            let mut conns = self.conns.lock().await;
            if let Some(conn) = conns.get_mut(&id_lc) {
                conn.consumers.insert(window.to_string());
                return Ok(());
            }
            let mut consumers = HashSet::new();
            consumers.insert(window.to_string());
            conns.insert(id_lc.clone(), Connection { consumers, task: None });
        }

        // Count this as a bridge user BEFORE the (network) resolve, for the same
        // reason as Kick: otherwise a concurrent Twitch start_chat could see "no
        // providers" mid-resolve and tear the shared local-WS bridge down.
        inc_bridge_users();

        // Resolve the live video now so a clear error (not live / members-only /
        // chat disabled) surfaces on the pane immediately, the way Kick's resolve
        // does. On success the meta is cached for the chrome and the streaming task
        // takes over (it re-resolves on its own if the stream later ends).
        let resolved = match resolve_live_video(&self.http, channel).await {
            Ok(r) => r,
            Err(e) => {
                dec_bridge_users();
                self.conns.lock().await.remove(&id_lc);
                return Err(e);
            }
        };
        store_meta(&id_lc, resolved.meta.clone());

        let task = {
            let http = self.http.clone();
            let identifier = channel.to_string();
            let channel_key = key::make_key("youtube", channel);
            tokio::spawn(async move {
                run_connection(http, identifier, channel_key, resolved.ctx).await
            })
        };
        let mut conns = self.conns.lock().await;
        match conns.get_mut(&id_lc) {
            Some(conn) if conn.task.is_none() => conn.task = Some(task),
            _ => {
                task.abort();
                dec_bridge_users();
            }
        }
        Ok(())
    }

    async fn disconnect(&self, channel: &str, window: &str) -> Result<()> {
        let id_lc = channel.to_lowercase();
        let mut conns = self.conns.lock().await;
        let drop_it = if let Some(conn) = conns.get_mut(&id_lc) {
            conn.consumers.remove(window);
            conn.consumers.is_empty()
        } else {
            false
        };
        if drop_it {
            if let Some(conn) = conns.remove(&id_lc) {
                if let Some(task) = conn.task {
                    task.abort();
                    dec_bridge_users();
                }
            }
        }
        Ok(())
    }

    async fn send(&self, channel: &str, text: &str, _reply_to: Option<&str>) -> Result<SendOutcome> {
        let drop = |reason: &str| SendOutcome {
            message_id: None,
            is_sent: false,
            drop_reason: Some(reason.to_string()),
        };
        if !youtube_auth_service::is_connected() {
            return Ok(drop("Connect your YouTube account to send"));
        }
        let Some(meta) = channel_meta(channel) else {
            return Ok(drop("YouTube channel isn't resolved yet — try again in a moment"));
        };
        let (Some(channel_id), Some(video_id), Some(api_key)) = (
            meta.user_id.as_deref(),
            meta.video_id.as_deref(),
            meta.api_key.as_deref(),
        ) else {
            return Ok(drop("YouTube channel isn't fully resolved yet"));
        };
        let params = send_message_params(channel_id, video_id);
        let body = json!({ "richMessage": { "textSegments": [{ "text": text }] }, "params": params });
        match post_innertube_authed("send_message", api_key, &meta, body).await {
            Ok(v) => {
                // The send response can say WE were timed out instead of accepting.
                if let Some(us) = v.get("timeoutDurationUsec").and_then(|x| x.as_str()) {
                    let secs = us.parse::<i64>().unwrap_or(0) / 1_000_000;
                    return Ok(drop(&format!("You're in timeout for {}s", secs)));
                }
                // The response carries the FULL rendered message (author, id, runs).
                // Publish it immediately so our own line shows at once instead of
                // waiting for the next read poll (~5s); the read loop's later echo of
                // the same id is deduped by the store's seenMessageIds.
                let item = v.pointer("/actions/0/addChatItemAction/item");
                let message_id = item
                    .and_then(|i| i.pointer("/liveChatTextMessageRenderer/id"))
                    .and_then(|x| x.as_str())
                    .map(String::from);
                if let Some(item) = item {
                    let channel_key = key::make_key("youtube", channel);
                    if let Some(msg) = parse_item(item, &channel_key) {
                        publish_chat_message(&msg).await;
                    }
                }
                Ok(SendOutcome {
                    message_id,
                    is_sent: true,
                    drop_reason: None,
                })
            }
            Err(e) => {
                log::warn!("[YouTube] send failed: {}", e);
                let detail: String = e.to_string().chars().take(160).collect();
                Ok(drop(&format!("YouTube send failed: {}", detail)))
            }
        }
    }

    async fn send_capability(&self, _channel: &str) -> SendCapability {
        if youtube_auth_service::is_connected() {
            SendCapability::Sendable
        } else {
            SendCapability::NeedsLogin
        }
    }
}

// --- Outgoing send / moderation (authenticated InnerTube, webview-session) ---
// All actions POST a protobuf `params` to youtubei/v1 with the user's SAPISIDHASH
// auth (youtube_auth_service). The param builders are ported from masterchat's
// assembler and validated against its fixtures in the tests below.

/// POST an authenticated InnerTube live-chat request (send_message / moderate). Adds
/// the user's session auth headers; merges `extra` (params / richMessage) into the
/// standard `{context:{client}}` body. Errors on non-2xx or an `error` payload.
async fn post_innertube_authed(
    endpoint: &str,
    api_key: &str,
    meta: &YouTubeChannelMeta,
    extra: Value,
) -> Result<Value> {
    let headers = youtube_auth_service::auth_headers()
        .ok_or_else(|| anyhow!("Sign into YouTube to do that"))?;
    let mut client = json!({
        "clientName": "WEB",
        "clientVersion": meta.client_version.as_deref().unwrap_or("2.20240101.00.00"),
        "hl": "en",
        "gl": "US",
    });
    if let Some(vd) = &meta.visitor_data {
        client["visitorData"] = json!(vd);
    }
    let mut body = json!({ "context": { "client": client } });
    if let Some(obj) = extra.as_object() {
        for (k, v) in obj {
            body[k] = v.clone();
        }
    }
    let url = format!(
        "https://www.youtube.com/youtubei/v1/live_chat/{}?key={}&prettyPrint=false",
        endpoint, api_key
    );
    let mut req = reqwest::Client::new()
        .post(url)
        .header("User-Agent", USER_AGENT);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req.json(&body).send().await?;
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(anyhow!("{} HTTP {}: {}", endpoint, status, v));
    }
    if let Some(err) = v.get("error") {
        return Err(anyhow!("{}: {}", endpoint, err));
    }
    Ok(v)
}

/// Pull the (channel id, video id, api key) a moderation call needs from the cached
/// resolve, or a clear error if the channel isn't resolved.
fn mod_ctx(meta: &YouTubeChannelMeta) -> Result<(String, String, String)> {
    match (
        meta.user_id.clone(),
        meta.video_id.clone(),
        meta.api_key.clone(),
    ) {
        (Some(c), Some(v), Some(k)) => Ok((c, v, k)),
        _ => Err(anyhow!("YouTube channel isn't fully resolved yet")),
    }
}

/// Delete a single chat message (the `message_id` is the live-chat item id).
pub async fn delete_message(channel: &str, message_id: &str) -> Result<()> {
    let meta = channel_meta(channel).ok_or_else(|| anyhow!("YouTube channel not resolved"))?;
    let (channel_id, video_id, api_key) = mod_ctx(&meta)?;
    let params = remove_message_params(message_id, &channel_id, &video_id);
    post_innertube_authed("moderate", &api_key, &meta, json!({ "params": params })).await?;
    Ok(())
}

/// Time out (`duration_seconds` Some — YouTube's fixed ~300s timeout) or permanently
/// hide/ban (`duration_seconds` None) a user, addressed by their channel id.
pub async fn ban_user(
    channel: &str,
    target_channel_id: &str,
    duration_seconds: Option<u32>,
) -> Result<()> {
    let meta = channel_meta(channel).ok_or_else(|| anyhow!("YouTube channel not resolved"))?;
    let (channel_id, video_id, api_key) = mod_ctx(&meta)?;
    let params = if duration_seconds.is_some() {
        timeout_params(target_channel_id, &channel_id, &video_id)
    } else {
        hide_params(target_channel_id, &channel_id, &video_id, false)
    };
    post_innertube_authed("moderate", &api_key, &meta, json!({ "params": params })).await?;
    Ok(())
}

/// Lift a hide/ban on a user (unhide), addressed by their channel id.
pub async fn unban_user(channel: &str, target_channel_id: &str) -> Result<()> {
    let meta = channel_meta(channel).ok_or_else(|| anyhow!("YouTube channel not resolved"))?;
    let (channel_id, video_id, api_key) = mod_ctx(&meta)?;
    let params = hide_params(target_channel_id, &channel_id, &video_id, true);
    post_innertube_authed("moderate", &api_key, &meta, json!({ "params": params })).await?;
    Ok(())
}

// --- Mod-capability probe ----------------------------------------------------
// YouTube exposes no "are you a mod" flag, but a message's context menu offers the
// moderation actions ONLY to someone who can moderate. So we POST a recent message's
// context-menu params and check whether the response carries moderate endpoints.

// Latest seen context-menu params per channel (any recent message works to probe).
static CONTEXT_PARAMS: OnceLock<std::sync::Mutex<HashMap<String, String>>> = OnceLock::new();
// Cached probe result per channel, so the gate doesn't re-probe every render.
static CAN_MOD: OnceLock<std::sync::Mutex<HashMap<String, bool>>> = OnceLock::new();

fn store_context_params(channel_key: &str, params: &str) {
    let slug = key::parse_key(channel_key).channel;
    if let Ok(mut m) = CONTEXT_PARAMS
        .get_or_init(|| std::sync::Mutex::new(HashMap::new()))
        .lock()
    {
        m.insert(slug, params.to_string());
    }
}

/// Whether the connected account can moderate this channel's chat. Cached after the
/// first successful probe; false when signed out or no message has been seen yet.
pub async fn can_moderate(channel: &str) -> bool {
    let slug = channel.to_lowercase();
    if let Some(b) = CAN_MOD
        .get_or_init(|| std::sync::Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|m| m.get(&slug).copied())
    {
        return b;
    }
    if !youtube_auth_service::is_connected() {
        return false;
    }
    let Some(meta) = channel_meta(&slug) else {
        return false;
    };
    let Some(api_key) = meta.api_key.clone() else {
        return false;
    };
    let Some(params) = CONTEXT_PARAMS
        .get_or_init(|| std::sync::Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|m| m.get(&slug).cloned())
    else {
        return false; // no message seen yet — can't probe
    };
    let is_mod = match post_innertube_authed(
        "get_item_context_menu",
        &api_key,
        &meta,
        json!({ "params": params }),
    )
    .await
    {
        Ok(v) => menu_grants_moderation(&v),
        Err(_) => false,
    };
    if let Ok(mut m) = CAN_MOD
        .get_or_init(|| std::sync::Mutex::new(HashMap::new()))
        .lock()
    {
        m.insert(slug, is_mod);
    }
    is_mod
}

/// True only if the context-menu response offers a REAL moderation action (Remove /
/// Timeout / Hide) — a menu item with a DIRECT `moderateLiveChatEndpoint`. "Block",
/// which everyone has, wraps its moderate endpoint inside a confirm-dialog, so it
/// doesn't count (matching on it bare was the false-positive that made non-mods look
/// like mods).
fn menu_grants_moderation(v: &Value) -> bool {
    match v {
        Value::Object(map) => {
            if let Some(item) = map.get("menuServiceItemRenderer") {
                if item
                    .pointer("/serviceEndpoint/moderateLiveChatEndpoint")
                    .is_some()
                {
                    return true;
                }
            }
            map.values().any(menu_grants_moderation)
        }
        Value::Array(arr) => arr.iter().any(menu_grants_moderation),
        _ => false,
    }
}

// --- InnerTube param protobufs (ported verbatim from masterchat's assembler.ts) --
// The encoder primitives are validated byte-for-byte against masterchat's fixtures
// in the tests. Every value we emit is < 128, so varints are single-byte.

mod pb {
    use base64::Engine;

    pub fn leb128(mut n: u64) -> Vec<u8> {
        let mut out = Vec::new();
        while n >> 7 != 0 {
            out.push(0x80 | (n & 0x7f) as u8);
            n >>= 7;
        }
        out.push(n as u8);
        out
    }

    fn pbh(fid: u64, wt: u64) -> Vec<u8> {
        leb128((fid << 3) | wt)
    }

    /// Length-delimited field: [header][len][payload].
    pub fn ld(fid: u64, payload: &[u8]) -> Vec<u8> {
        let mut v = pbh(fid, 2);
        v.extend(leb128(payload.len() as u64));
        v.extend_from_slice(payload);
        v
    }

    /// Varint field. masterchat writes the value as minimal big-endian bytes
    /// (`bitou8`), which equals a standard varint for the < 128 values we use.
    pub fn vt(fid: u64, val: u64) -> Vec<u8> {
        let mut v = pbh(fid, 0);
        if val == 0 {
            v.push(0);
        } else {
            let be = val.to_be_bytes();
            let start = be.iter().position(|&b| b != 0).unwrap_or(7);
            v.extend_from_slice(&be[start..]);
        }
        v
    }

    pub fn cat(parts: &[Vec<u8>]) -> Vec<u8> {
        parts.concat()
    }

    /// b64e B1 = encodeURIComponent(standard_base64): only +, /, = need escaping.
    pub fn b1(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD
            .encode(bytes)
            .replace('+', "%2B")
            .replace('/', "%2F")
            .replace('=', "%3D")
    }

    /// b64e B2 = standard_base64(utf8(b1)).
    pub fn b2(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(b1(bytes).as_bytes())
    }
}

fn cv_token(channel_id: &str, video_id: &str) -> Vec<u8> {
    pb::ld(
        5,
        &pb::cat(&[
            pb::ld(1, channel_id.as_bytes()),
            pb::ld(2, video_id.as_bytes()),
        ]),
    )
}

fn truc(channel_id: &str) -> &str {
    channel_id.strip_prefix("UC").unwrap_or(channel_id)
}

/// `chatToken` = base64-decode the live-chat item id (url-safe tolerant).
fn chat_token(chat_id: &str) -> Vec<u8> {
    let norm = chat_id.replace('-', "+").replace('_', "/");
    let pad = (4 - norm.len() % 4) % 4;
    let padded = format!("{}{}", norm, "=".repeat(pad));
    base64::engine::general_purpose::STANDARD
        .decode(padded.as_bytes())
        .unwrap_or_default()
}

fn send_message_params(channel_id: &str, video_id: &str) -> String {
    pb::b2(&pb::cat(&[
        pb::ld(1, &cv_token(channel_id, video_id)),
        pb::vt(2, 2),
        pb::vt(3, 4),
    ]))
}

fn remove_message_params(chat_id: &str, channel_id: &str, video_id: &str) -> String {
    pb::b2(&pb::cat(&[
        pb::ld(1, &cv_token(channel_id, video_id)),
        pb::ld(2, &pb::ld(1, &chat_token(chat_id))),
        pb::vt(10, 1),
        pb::vt(11, 1),
    ]))
}

fn timeout_params(target: &str, channel_id: &str, video_id: &str) -> String {
    pb::b2(&pb::cat(&[
        pb::ld(1, &cv_token(channel_id, video_id)),
        pb::ld(6, &pb::ld(1, truc(target).as_bytes())),
        pb::vt(10, 2),
        pb::vt(11, 1),
    ]))
}

fn hide_params(target: &str, channel_id: &str, video_id: &str, undo: bool) -> String {
    let op = if undo { 5 } else { 4 };
    pb::b2(&pb::cat(&[
        pb::ld(1, &cv_token(channel_id, video_id)),
        pb::ld(op, &pb::ld(1, truc(target).as_bytes())),
        pb::vt(10, 2),
        pb::vt(11, 1),
    ]))
}

// --- Channel metadata (chrome: title / channel name / viewers / uptime / avatar) -

/// Live metadata for the MultiChat chrome, scraped from the watch page during
/// resolve. The JSON field names mirror `KickChannelMeta` so the frontend reads
/// both through one `ProviderChannelMeta` shape; `user_id` here is the channel id
/// string (UC…) rather than a number.
#[derive(Clone, Default, serde::Serialize)]
pub struct YouTubeChannelMeta {
    pub user_id: Option<String>,
    pub username: Option<String>,
    pub viewer_count: Option<u64>,
    pub start_time: Option<String>,
    pub title: Option<String>,
    pub profile_pic: Option<String>,
    pub is_live: bool,
    // Internal send/moderate context captured at resolve (the cvPair video id + the
    // scraped InnerTube creds). `serde(skip)` keeps them out of the frontend payload.
    #[serde(skip)]
    pub video_id: Option<String>,
    #[serde(skip)]
    pub api_key: Option<String>,
    #[serde(skip)]
    pub client_version: Option<String>,
    #[serde(skip)]
    pub visitor_data: Option<String>,
}

static YT_META: OnceLock<std::sync::Mutex<HashMap<String, YouTubeChannelMeta>>> = OnceLock::new();

fn yt_meta_cache() -> &'static std::sync::Mutex<HashMap<String, YouTubeChannelMeta>> {
    YT_META.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn store_meta(id_lc: &str, meta: YouTubeChannelMeta) {
    if let Ok(mut m) = yt_meta_cache().lock() {
        m.insert(id_lc.to_string(), meta);
    }
}

/// The cached live metadata for an identifier, if resolved. Returned by the
/// `get_youtube_channel_meta` command for the chat chrome.
pub fn channel_meta(identifier: &str) -> Option<YouTubeChannelMeta> {
    yt_meta_cache()
        .lock()
        .ok()
        .and_then(|m| m.get(&identifier.to_lowercase()).cloned())
}

// Original-case identifiers, keyed by their lowercase. Seeded on the first connect
// (which carries the add-time case) so a later lowercased identifier — from a
// reconnect that re-derives the channel from the lowercased composite key — still
// resolves a case-sensitive video/channel id correctly. (@handles are
// case-insensitive at YouTube, so they're unaffected either way.)
static ORIG_CASE: OnceLock<std::sync::Mutex<HashMap<String, String>>> = OnceLock::new();

fn canonical_identifier(channel: &str) -> String {
    let lc = channel.to_lowercase();
    let Ok(mut map) = ORIG_CASE
        .get_or_init(|| std::sync::Mutex::new(HashMap::new()))
        .lock()
    else {
        return channel.to_string();
    };
    if channel != lc {
        map.entry(lc.clone()).or_insert_with(|| channel.to_string());
    }
    map.get(&lc).cloned().unwrap_or_else(|| channel.to_string())
}

// --- Live-video resolution (scrape the watch page) --------------------------

/// Everything the long-poll needs, scraped once from the watch/live page.
struct LiveContext {
    api_key: String,
    client_version: String,
    visitor_data: Option<String>,
    continuation: String,
}

struct Resolved {
    ctx: LiveContext,
    meta: YouTubeChannelMeta,
}

/// Build the watch/live URL for an identifier. The frontend `@`-prefixes handles
/// so they're never confused with an 11-char video id.
fn live_page_url(identifier: &str) -> String {
    let id = identifier.trim();
    if let Some(handle) = id.strip_prefix('@') {
        return format!("https://www.youtube.com/@{}/live", handle);
    }
    if id.starts_with("UC") && id.len() == 24 {
        return format!("https://www.youtube.com/channel/{}/live", id);
    }
    if is_video_id(id) {
        return format!("https://www.youtube.com/watch?v={}", id);
    }
    // Bare handle (frontend normally adds the @, but be tolerant).
    format!("https://www.youtube.com/@{}/live", id)
}

fn is_video_id(s: &str) -> bool {
    s.len() == 11 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Outcome of parsing a page we hoped was a live watch page.
enum WatchOutcome {
    /// A watch page with live chat: everything the long-poll needs.
    Resolved(Resolved),
    /// Not a watch page. YouTube handed us the channel browse shell instead, so the
    /// caller recovers candidate video ids from it and re-fetches their watch pages.
    BrowseShell,
}

/// GET a YouTube page's HTML, mapping the EU consent interstitial to a clear error.
async fn fetch_youtube_html(
    http: &reqwest::Client,
    url: &str,
    identifier: &str,
) -> Result<String> {
    let resp = http.get(url).send().await?;
    let final_url = resp.url().clone();
    let html = resp.text().await?;
    if final_url.as_str().contains("consent.youtube.com")
        || html.contains("Before you continue to YouTube")
    {
        return Err(anyhow!(
            "YouTube returned a consent page for '{}' (try again)",
            identifier
        ));
    }
    Ok(html)
}

/// Parse a fetched page as a live watch page. Returns `Resolved` on success,
/// `BrowseShell` when YouTube served the channel browse page instead of a watch
/// page (so the caller can re-resolve via /watch?v=), or an error for a real watch
/// page whose chat is gated (members-only / age / chat disabled).
async fn parse_watch_page(
    http: &reqwest::Client,
    html: &str,
    identifier: &str,
) -> Result<WatchOutcome> {
    let api_key = json_str_after(html, "\"INNERTUBE_API_KEY\":\"")
        .ok_or_else(|| anyhow!("couldn't read YouTube API key (is the channel valid?)"))?;
    let client_version = json_str_after(html, "\"INNERTUBE_CONTEXT_CLIENT_VERSION\":\"")
        .or_else(|| json_str_after(html, "\"clientVersion\":\""))
        .unwrap_or_else(|| "2.20240101.00.00".to_string());
    let visitor_data = json_str_after(html, "\"visitorData\":\"").map(|v| decode_json_escapes(&v));

    let player = extract_json(html, "ytInitialPlayerResponse");
    let initial = extract_json(html, "ytInitialData");

    // Playability gate: members-only / login-required / age-restricted streams have
    // no anonymous chat. Give a readable reason instead of a blank pane.
    if let Some(status) = player
        .as_ref()
        .and_then(|p| p.pointer("/playabilityStatus/status"))
        .and_then(|s| s.as_str())
    {
        if status != "OK" {
            let reason = player
                .as_ref()
                .and_then(|p| p.pointer("/playabilityStatus/reason"))
                .and_then(|r| r.as_str())
                .unwrap_or(status);
            return Err(anyhow!("YouTube: {}", reason));
        }
    }

    let live_chat_renderer = initial.as_ref().and_then(|d| {
        d.pointer("/contents/twoColumnWatchNextResults/conversationBar/liveChatRenderer")
    });
    let Some(lcr) = live_chat_renderer else {
        // No live-chat renderer. If this is a real watch page, its chat is genuinely
        // unavailable (disabled / gated / it's a VOD), a hard error. If it's the
        // channel browse shell (YouTube's /live shortcut sometimes fails to surface a
        // live stream), hand back the recovered video id so the caller re-fetches its
        // watch page, which always carries the chat token.
        let is_watch_page = initial
            .as_ref()
            .and_then(|d| d.pointer("/contents/twoColumnWatchNextResults"))
            .is_some();
        if is_watch_page {
            return Err(anyhow!(
                "'{}' isn't live right now (or its chat is unavailable)",
                identifier
            ));
        }
        return Ok(WatchOutcome::BrowseShell);
    };
    // The watch page's BOOTSTRAP continuation (continuations[0]) is the one
    // get_live_chat accepts — the watch page's view-selector tokens 400 against the
    // API. That bootstrap is the default "Top chat" view, which filters messages;
    // for the full "Live chat" firehose, fetch the dedicated live_chat page, whose
    // view-selector "Live chat" token IS get_live_chat-compatible. Fall back to the
    // bootstrap (Top chat) if that lookup fails.
    let bootstrap = bootstrap_continuation(lcr)
        .ok_or_else(|| anyhow!("couldn't read the YouTube live-chat continuation"))?;
    // Video id: prefer the player response, fall back to a direct scrape so a failed
    // player parse doesn't silently strand us on the filtered Top-chat view.
    let video_id = player
        .as_ref()
        .and_then(|p| p.pointer("/videoDetails/videoId"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| json_str_after(html, "\"videoId\":\""));
    let continuation = match video_id.as_deref() {
        Some(vid) => match fetch_live_continuation(http, vid).await {
            Some(live) => {
                log::info!("[YouTube] '{}' on the FULL Live chat view", identifier);
                live
            }
            None => {
                log::warn!(
                    "[YouTube] '{}' couldn't get the Live chat continuation (video {}); using Top chat (filtered)",
                    identifier, vid
                );
                bootstrap
            }
        },
        None => {
            log::warn!("[YouTube] '{}' has no video id; using Top chat bootstrap", identifier);
            bootstrap
        }
    };

    let mut meta = extract_meta(player.as_ref(), initial.as_ref(), html);
    // Stash the scraped InnerTube creds on the meta so send/moderate can reuse them
    // (kept internal via serde(skip)).
    meta.api_key = Some(api_key.clone());
    meta.client_version = Some(client_version.clone());
    meta.visitor_data = visitor_data.clone();

    Ok(WatchOutcome::Resolved(Resolved {
        ctx: LiveContext {
            api_key,
            client_version,
            visitor_data,
            continuation,
        },
        meta,
    }))
}

/// Distinct 11-char video ids in document order, capped at `max`. Used to pick the
/// live video off a channel browse shell, which carries no reliable "this one is
/// live" marker: the live stream is normally surfaced at the top, but a channel
/// trailer or pinned upload can precede it, so the caller probes the first few.
fn candidate_video_ids(html: &str, max: usize) -> Vec<String> {
    let marker = "\"videoId\":\"";
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut rest = html;
    while out.len() < max {
        let Some(pos) = rest.find(marker) else { break };
        let start = &rest[pos + marker.len()..];
        let Some(end) = start.find('"') else { break };
        let id = &start[..end];
        if is_video_id(id) && seen.insert(id.to_string()) {
            out.push(id.to_string());
        }
        rest = &start[end..];
    }
    out
}

/// Whether a scraped watch page is a stream that is live right now (not an ended
/// broadcast's VOD, whose replay chat we must not attach to). Used to gate the
/// /watch?v= fallback so a browse shell's non-live grid item is rejected.
fn is_currently_live(html: &str) -> bool {
    extract_json(html, "ytInitialPlayerResponse")
        .as_ref()
        .map(|p| {
            p.pointer("/videoDetails/isLive")
                .and_then(|b| b.as_bool())
                .unwrap_or(false)
                || p.pointer(
                    "/microformat/playerMicroformatRenderer/liveBroadcastDetails/isLiveNow",
                )
                .and_then(|b| b.as_bool())
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

/// Fetch the live page and extract the InnerTube config + the initial live-chat
/// continuation + the channel chrome. Errors (surfaced on the pane) distinguish
/// not-live / members-only / chat-disabled.
///
/// YouTube's `/@handle/live` (and `/channel/UC…/live`) shortcut normally serves the
/// live watch page, but it intermittently fails to surface a genuinely-live stream
/// and returns the channel's browse page instead (which carries no chat token). When
/// that happens we recover candidate video ids from the browse page and re-fetch their
/// watch pages directly, accepting the first one that is live right now.
async fn resolve_live_video(http: &reqwest::Client, identifier: &str) -> Result<Resolved> {
    let html = fetch_youtube_html(http, &live_page_url(identifier), identifier).await?;
    match parse_watch_page(http, &html, identifier).await? {
        WatchOutcome::Resolved(resolved) => return Ok(resolved),
        WatchOutcome::BrowseShell => {}
    }

    // /live handed us the channel browse shell instead of the live watch page. The
    // browse page has no reliable "this video is live" marker, so probe the first few
    // distinct video ids (the live stream is normally at the top, but a trailer/pinned
    // upload can precede it). Accept the first that is live now — its watch page always
    // carries the chat token; the is-live gate stops us attaching to a past stream's
    // replay chat when a non-live grid item comes first.
    let not_live = || {
        anyhow!(
            "'{}' isn't live right now (or its chat is unavailable)",
            identifier
        )
    };
    let candidates = candidate_video_ids(&html, 3);
    if candidates.is_empty() {
        return Err(not_live());
    }
    for vid in candidates {
        let watch_url = format!("https://www.youtube.com/watch?v={}", vid);
        let Ok(watch_html) = fetch_youtube_html(http, &watch_url, identifier).await else {
            continue;
        };
        if !is_currently_live(&watch_html) {
            continue;
        }
        match parse_watch_page(http, &watch_html, identifier).await {
            Ok(WatchOutcome::Resolved(resolved)) => {
                log::info!(
                    "[YouTube] '{}' resolved via /watch?v={} after /live returned a browse shell",
                    identifier,
                    vid
                );
                return Ok(resolved);
            }
            // A live candidate whose watch page still won't parse (e.g. members-only
            // playability): surface that reason rather than a misleading "not live".
            Ok(WatchOutcome::BrowseShell) => continue,
            Err(e) => return Err(e),
        }
    }
    Err(not_live())
}

/// The watch page's bootstrap live-chat continuation — the token get_live_chat
/// accepts (the watch page's view-selector tokens are for the chat iframe and 400
/// against the API). This is the default "Top chat" view; `fetch_live_continuation`
/// upgrades it to the full Live chat.
fn bootstrap_continuation(lcr: &Value) -> Option<String> {
    lcr.pointer("/continuations/0/reloadContinuationData/continuation")
        .or_else(|| lcr.pointer("/continuations/0/timedContinuationData/continuation"))
        .and_then(|c| c.as_str())
        .map(String::from)
}

/// Fetch the dedicated live_chat page and pull the "Live chat" view continuation,
/// which (unlike the watch page's) IS get_live_chat-compatible. None if the page or
/// the Live view isn't available (the caller falls back to the bootstrap/Top view).
async fn fetch_live_continuation(http: &reqwest::Client, video_id: &str) -> Option<String> {
    let url = format!("https://www.youtube.com/live_chat?v={}", video_id);
    // Retry: the live_chat page is the only reliable source of the full-Live-view
    // continuation (the watch page + the get_live_chat response only carry the
    // filtered Top view), so it's worth a few tries. Logs WHERE it fails so a Top-chat
    // fallback is diagnosable.
    for attempt in 0..3 {
        match http.get(&url).send().await {
            Ok(resp) => {
                let final_url = resp.url().as_str().to_string();
                match resp.text().await {
                    Ok(html) => {
                        if final_url.contains("consent.youtube.com") {
                            log::warn!("[YouTube] live_chat hit consent (attempt {})", attempt);
                        } else if let Some(init) = extract_json(&html, "ytInitialData") {
                            if let Some(c) = live_view_continuation(&init) {
                                return Some(c);
                            }
                            log::warn!(
                                "[YouTube] live_chat had no Live view selector (attempt {}, {} bytes)",
                                attempt, html.len()
                            );
                        } else {
                            log::warn!(
                                "[YouTube] live_chat had no ytInitialData (attempt {}, {} bytes)",
                                attempt, html.len()
                            );
                        }
                    }
                    Err(e) => log::warn!("[YouTube] live_chat read failed (attempt {}): {}", attempt, e),
                }
            }
            Err(e) => log::warn!("[YouTube] live_chat fetch failed (attempt {}): {}", attempt, e),
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    None
}

/// From the live_chat page's `ytInitialData`, the view-selector item whose title
/// isn't "Top chat" — the full live feed.
fn live_view_continuation(iframe_initial: &Value) -> Option<String> {
    let items = iframe_initial
        .pointer("/contents/liveChatRenderer/header/liveChatHeaderRenderer/viewSelector/sortFilterSubMenuRenderer/subMenuItems")?
        .as_array()?;
    let live = items.iter().find(|it| {
        it.get("title")
            .and_then(|t| t.as_str())
            .map(|t| !t.to_lowercase().contains("top"))
            .unwrap_or(false)
    })?;
    live.pointer("/continuation/reloadContinuationData/continuation")
        .and_then(|c| c.as_str())
        .map(String::from)
}

fn extract_meta(player: Option<&Value>, initial: Option<&Value>, html: &str) -> YouTubeChannelMeta {
    let vd = player.and_then(|p| p.get("videoDetails"));
    let title = vd
        .and_then(|d| d.get("title"))
        .and_then(|t| t.as_str())
        .map(String::from);
    let username = vd
        .and_then(|d| d.get("author"))
        .and_then(|t| t.as_str())
        .map(String::from);
    let user_id = vd
        .and_then(|d| d.get("channelId"))
        .and_then(|t| t.as_str())
        .map(String::from);
    let is_live = vd
        .and_then(|d| d.get("isLive").or_else(|| d.get("isLiveContent")))
        .and_then(|b| b.as_bool())
        .unwrap_or(true);
    let start_time = player
        .and_then(|p| {
            p.pointer("/microformat/playerMicroformatRenderer/liveBroadcastDetails/startTimestamp")
        })
        .and_then(|s| s.as_str())
        .map(String::from);
    // Concurrent viewers: best-effort from ytInitialData's view-count renderer.
    let viewer_count = json_str_after(html, "\"originalViewCount\":\"").and_then(|s| s.parse().ok());
    let profile_pic = initial.and_then(find_owner_avatar);
    let video_id = vd
        .and_then(|d| d.get("videoId"))
        .and_then(|v| v.as_str())
        .map(String::from);

    YouTubeChannelMeta {
        user_id,
        username,
        viewer_count,
        start_time,
        title,
        profile_pic,
        is_live,
        video_id,
        api_key: None,
        client_version: None,
        visitor_data: None,
    }
}

/// Best-effort: the channel owner's avatar from the secondary-info owner renderer.
fn find_owner_avatar(initial: &Value) -> Option<String> {
    let contents = initial
        .pointer("/contents/twoColumnWatchNextResults/results/results/contents")
        .and_then(|c| c.as_array())?;
    for item in contents {
        if let Some(thumbs) = item.pointer(
            "/videoSecondaryInfoRenderer/owner/videoOwnerRenderer/thumbnail/thumbnails",
        ) {
            if let Some(arr) = thumbs.as_array() {
                if let Some(url) = arr.last().and_then(|t| t.get("url")).and_then(|u| u.as_str()) {
                    return Some(url.to_string());
                }
            }
        }
    }
    None
}

// --- The long-poll stream loop ----------------------------------------------

/// Stream forever: run the live chat poll, and if it ends (stream over / token
/// expired / error) wait then re-resolve, until the task is aborted on disconnect.
async fn run_connection(
    http: reqwest::Client,
    identifier: String,
    channel_key: String,
    initial: LiveContext,
) {
    let id_lc = identifier.to_lowercase();
    let mut next_ctx = Some(initial);
    loop {
        let ctx = match next_ctx.take() {
            Some(c) => c,
            None => match resolve_live_video(&http, &identifier).await {
                Ok(r) => {
                    store_meta(&id_lc, r.meta);
                    r.ctx
                }
                Err(e) => {
                    log::info!("[YouTube] re-resolve '{}' failed: {}", identifier, e);
                    tokio::time::sleep(Duration::from_secs(RE_RESOLVE_DELAY_SECS)).await;
                    continue;
                }
            },
        };
        // A clean return means the stream/chat ended — back off before re-resolving so
        // we don't hammer an offline channel. An error (timeout, network blip, a bad
        // poll response) is transient on a live chat, so re-resolve quickly instead of
        // leaving the pane stuck on "Waiting for messages".
        //
        // The whole poll is wrapped in catch_unwind so one malformed YouTube payload
        // can't panic the task to death. A dead task is unrecoverable: its slot stays in
        // the conn map, so a later re-acquire finds it and never respawns the stream —
        // YouTube would go silently dead until an app restart. A caught panic recovers
        // like an error: log and re-resolve.
        let outcome = AssertUnwindSafe(stream_live_chat(&http, ctx, &channel_key))
            .catch_unwind()
            .await;
        let delay = match outcome {
            Ok(Ok(())) => RE_RESOLVE_DELAY_SECS,
            Ok(Err(e)) => {
                log::warn!("[YouTube] '{}' stream error: {}", identifier, e);
                3
            }
            Err(_) => {
                log::error!("[YouTube] '{}' poll panicked; recovering", identifier);
                3
            }
        };
        tokio::time::sleep(Duration::from_secs(delay)).await;
    }
}

/// Poll `get_live_chat` until the continuation runs out (stream ended) or a
/// request fails. Each response carries the next continuation + how long to wait.
async fn stream_live_chat(
    http: &reqwest::Client,
    mut ctx: LiveContext,
    channel_key: &str,
) -> Result<()> {
    let url = format!(
        "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key={}&prettyPrint=false",
        ctx.api_key
    );
    // Whether we've seen a live-chat block at all this session. Used to tell a real
    // stream-end (we were receiving, then it stopped) from a bad/stale first response
    // (resolve handed us a dud continuation) so the latter re-resolves fast.
    let mut got_chat = false;
    loop {
        let mut client = json!({
            "clientName": "WEB",
            "clientVersion": ctx.client_version,
            "hl": "en",
            "gl": "US",
        });
        if let Some(vd) = &ctx.visitor_data {
            client["visitorData"] = json!(vd);
        }
        let body = json!({ "context": { "client": client }, "continuation": ctx.continuation });

        let resp = http.post(&url).json(&body).send().await?;
        if !resp.status().is_success() {
            return Err(anyhow!("get_live_chat HTTP {}", resp.status()));
        }
        let v: Value = resp.json().await?;
        let Some(lcc) = v.pointer("/continuationContents/liveChatContinuation") else {
            // No live-chat block. If we'd been receiving, the stream/chat ended (clean
            // exit, back off). If we never got one, the resolve handed us a dud — error
            // so the loop re-resolves quickly instead of stalling on "Waiting".
            return if got_chat {
                Ok(())
            } else {
                Err(anyhow!("no live chat block in first response"))
            };
        };
        got_chat = true;

        // Next token + poll delay first, so we can pace this batch across the delay.
        // An absent continuations array means it's over.
        let Some(cont) = lcc
            .get("continuations")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
        else {
            return Ok(());
        };
        let (next, timeout_ms) = pick_next_continuation(cont);
        let Some(next) = next else { return Ok(()) };

        // Pace the batch across the poll interval. YouTube hands us one big clump per
        // poll (often a ~10s window), so dumping it all at once then freezing makes a
        // fast chat lurch. Spreading the messages out, paired with the faster cadence
        // from the clamp in pick_next_continuation, keeps it flowing like the site. The
        // per-message gap is capped so a quiet chat still shows messages promptly, and
        // any leftover time is slept so the overall cadence still honors timeout_ms.
        match lcc.get("actions").and_then(|a| a.as_array()) {
            Some(arr) if !arr.is_empty() => {
                let gap = (timeout_ms / arr.len() as u64).min(150);
                for action in arr {
                    process_action(action, channel_key).await;
                    tokio::time::sleep(Duration::from_millis(gap)).await;
                }
                let spent = gap.saturating_mul(arr.len() as u64);
                if spent < timeout_ms {
                    tokio::time::sleep(Duration::from_millis(timeout_ms - spent)).await;
                }
            }
            _ => tokio::time::sleep(Duration::from_millis(timeout_ms)).await,
        }
        ctx.continuation = next;
    }
}

/// Read the next continuation token + its poll delay from `continuations[0]`,
/// whichever sub-shape is present (live vs reload vs replay).
fn pick_next_continuation(c: &Value) -> (Option<String>, u64) {
    for kkey in [
        "invalidationContinuationData",
        "timedContinuationData",
        "reloadContinuationData",
        "liveChatReplayContinuationData",
    ] {
        if let Some(d) = c.get(kkey) {
            let cont = d
                .get("continuation")
                .and_then(|x| x.as_str())
                .map(String::from);
            let ms = d
                .get("timeoutMs")
                .and_then(|x| x.as_u64())
                .unwrap_or(DEFAULT_POLL_MS);
            // Cap well below YouTube's hint (it suggests ~10s and bundles the whole
            // window into one clump): a faster cadence pulls smaller batches so a busy
            // chat keeps up instead of arriving in 10s lurches. Verified to return no
            // duplicates/empties when polled at this rate.
            return (cont, ms.clamp(1000, 2000));
        }
    }
    (None, DEFAULT_POLL_MS)
}

/// Dispatch one live-chat action: a new chat item, or a moderation removal.
async fn process_action(action: &Value, channel_key: &str) {
    if let Some(item) = action.pointer("/addChatItemAction/item") {
        if let Some(msg) = parse_item(item, channel_key) {
            publish_chat_message(&msg).await;
        }
        return;
    }
    // A single message removed by a mod -> CLEARMSG (the frontend recovers the
    // author + text from chat history by the target id). YouTube emits two shapes:
    // `markChatItemAsDeletedAction` (the authed mod view, leaves a "[deleted]" tomb)
    // and `removeChatItemAction` (what an anonymous reader actually receives) — so
    // accept either, else viewer-side mod logs never populate.
    if let Some(id) = action
        .pointer("/markChatItemAsDeletedAction/targetItemId")
        .or_else(|| action.pointer("/removeChatItemAction/targetItemId"))
        .and_then(|x| x.as_str())
    {
        // TEMP: dump the full action so we can see what extra detail YouTube carries
        // (deletor name, deleted-state message, etc.) to enrich the mod log.
        log::info!("[YouTube][moddump] delete: {}", action);
        let frame = json!({
            "type": "CLEARMSG",
            "provider": "youtube",
            "channel": channel_key,
            "target_msg_id": id,
        });
        publish_frame(frame.to_string()).await;
        return;
    }
    // All of an author's messages removed (ban/timeout) -> CLEARCHAT by channel id.
    // Same two-shape story: `markChatItemsByAuthorAsDeletedAction` vs the anonymous
    // `removeChatItemByAuthorAction`.
    if let Some(uid) = action
        .pointer("/markChatItemsByAuthorAsDeletedAction/externalChannelId")
        .or_else(|| action.pointer("/removeChatItemByAuthorAction/externalChannelId"))
        .and_then(|x| x.as_str())
    {
        // TEMP: dump the full action so we can see whether YouTube distinguishes a
        // timeout from a permanent ban (and any duration / moderator detail) here.
        log::info!("[YouTube][moddump] author-removal: {}", action);
        let frame = json!({
            "type": "CLEARCHAT",
            "provider": "youtube",
            "channel": channel_key,
            "target_user_id": uid,
        });
        publish_frame(frame.to_string()).await;
    }
}

/// Decode one `addChatItemAction.item` renderer into a unified ChatMessage.
/// Normal text messages render natively; Super Chats / stickers / memberships are
/// stamped as event messages (msg_type + system message) so they show inline and
/// flow to the activity panel.
fn parse_item(item: &Value, channel_key: &str) -> Option<ChatMessage> {
    if let Some(r) = item.get("liveChatTextMessageRenderer") {
        return Some(parse_text_message(r, channel_key));
    }
    if let Some(r) = item.get("liveChatPaidMessageRenderer") {
        return Some(parse_paid(r, channel_key, "superchat"));
    }
    if let Some(r) = item.get("liveChatPaidStickerRenderer") {
        return Some(parse_paid(r, channel_key, "supersticker"));
    }
    if let Some(r) = item.get("liveChatMembershipItemRenderer") {
        return Some(parse_membership(r, channel_key));
    }
    if let Some(r) = item.get("liveChatSponsorshipsGiftPurchaseAnnouncementRenderer") {
        return Some(parse_gift_membership(r, channel_key));
    }
    // Engagement / system notices and anything else: ignore (logged for discovery).
    if let Some((name, _)) = item.as_object().and_then(|o| o.iter().next()) {
        if name.as_str() != "liveChatViewerEngagementMessageRenderer" {
            log::info!("[YouTube][discover] renderer {}", name);
        }
    }
    None
}

fn parse_text_message(r: &Value, channel_key: &str) -> ChatMessage {
    let (segments, plain) = parse_runs(r.get("message"));
    base_message(r, channel_key, segments, plain, None, None)
}

/// Super Chat + Super Sticker. The amount string drives a leading text segment so
/// the donation is visible inline; the renderer's header color tints the name.
fn parse_paid(r: &Value, channel_key: &str, kind: &str) -> ChatMessage {
    let amount_str = r
        .pointer("/purchaseAmountText/simpleText")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let (currency, amount_num) = parse_money(amount_str);
    let label = if kind == "supersticker" {
        format!("Super Sticker · {}", amount_str)
    } else {
        format!("Super Chat · {}", amount_str)
    };
    // The user's comment (empty for many super chats / all stickers).
    let (mut segments, comment) = parse_runs(r.get("message"));
    // Prepend the donation label so the line reads e.g. "Super Chat · $5.00  <msg>".
    let lead = format!("{}  ", label);
    segments.insert(0, MessageSegment::Text { content: lead.clone() });
    let plain = format!("{}{}", lead, comment);
    // The header background color is YouTube's tier indicator; use it for the name.
    let color = argb_to_hex(r.get("headerBackgroundColor").or_else(|| r.get("backgroundColor")));
    let display = r
        .pointer("/authorName/simpleText")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let system = format!("{} from {}", label, display);
    let mut msg = base_message(r, channel_key, segments, plain, color, Some((kind, system)));
    // Activity-feed fields: the amount (currency + number) + the raw comment, so the
    // feed shows the value pill + the message (the producer reads these `sc-*` tags).
    if !currency.is_empty() {
        msg.tags.insert("sc-currency".to_string(), currency);
    }
    if let Some(a) = amount_num {
        msg.tags.insert("sc-amount".to_string(), format!("{}", a));
    }
    if !comment.is_empty() {
        msg.tags.insert("sc-message".to_string(), comment);
    }
    msg
}

/// Split a YouTube money string ("$5.00", "¥500", "€10,50") into (currency symbol,
/// numeric amount). Best-effort across the common formats.
fn parse_money(s: &str) -> (String, Option<f64>) {
    match s.find(|c: char| c.is_ascii_digit()) {
        Some(i) => {
            let currency = s[..i].trim().to_string();
            let num: String = s[i..]
                .chars()
                .filter(|c| c.is_ascii_digit() || *c == '.' || *c == ',')
                .collect();
            // If it has a '.', commas are thousands separators; else a comma is the
            // decimal mark.
            let normalized = if num.contains('.') {
                num.replace(',', "")
            } else {
                num.replace(',', ".")
            };
            (currency, normalized.parse::<f64>().ok())
        }
        None => (s.trim().to_string(), None),
    }
}

fn parse_membership(r: &Value, channel_key: &str) -> ChatMessage {
    let header = runs_text(r.get("headerSubtext"))
        .or_else(|| runs_text(r.get("headerPrimaryText")))
        .unwrap_or_else(|| "New member".to_string());
    let (segments, plain) = parse_runs(r.get("message"));
    let display = r
        .pointer("/authorName/simpleText")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let system = format!("{} · {}", display, header);
    let (segments, plain) = if segments.is_empty() {
        (vec![MessageSegment::Text { content: header.clone() }], header)
    } else {
        (segments, plain)
    };
    base_message(r, channel_key, segments, plain, None, Some(("membership", system)))
}

fn parse_gift_membership(r: &Value, channel_key: &str) -> ChatMessage {
    // The announcement header lives under a nested membership renderer.
    let inner = r.pointer("/header/liveChatSponsorshipsHeaderRenderer");
    let primary = runs_text(inner.and_then(|h| h.get("primaryText")))
        .unwrap_or_else(|| "gifted memberships".to_string());
    // YouTube embeds the count in the header text ("Gifted 5 memberships" /
    // "Sent 1 <channel> gift memberships"); the count is the first integer (it
    // precedes the channel name), so pull that out for the activity row.
    let count = primary
        .split(|c: char| !c.is_ascii_digit())
        .find_map(|w| w.parse::<u64>().ok())
        .unwrap_or(1);
    let display = inner
        .and_then(|h| h.pointer("/authorName/simpleText"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let system = format!("{} {}", display, primary);
    let segs = vec![MessageSegment::Text { content: primary.clone() }];
    // Build off the inner header (it carries the gifter's name/badges/id).
    let mut msg = base_message(
        inner.unwrap_or(r),
        channel_key,
        segs,
        primary,
        None,
        Some(("membergift", system)),
    );
    // Reuse the Twitch mass-gift tag so the activity feed's gift-bomb row shows the
    // real count instead of "gifted 0".
    msg.tags
        .insert("msg-param-mass-gift-count".to_string(), count.to_string());
    msg
}

/// Assemble a ChatMessage from a renderer's common author fields + the prepared
/// segments. `event` (msg_type, system message) marks Super Chats / memberships.
fn base_message(
    r: &Value,
    channel_key: &str,
    segments: Vec<MessageSegment>,
    plain: String,
    color_override: Option<String>,
    event: Option<(&str, String)>,
) -> ChatMessage {
    let display_name = r
        .pointer("/authorName/simpleText")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let user_id = r
        .get("authorExternalChannelId")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let id = r
        .get("id")
        .and_then(|x| x.as_str())
        .map(String::from)
        .unwrap_or_else(|| format!("yt-{}", FALLBACK_SEQ.fetch_add(1, Ordering::Relaxed)));
    let timestamp = r
        .get("timestampUsec")
        .and_then(|x| x.as_str())
        .map(usec_to_iso)
        .unwrap_or_default();
    // YouTube exposes no per-user name color; derive a stable one from the channel
    // id so chatters are still distinguishable (donations keep the tier color).
    let color = color_override.or_else(|| Some(color_for(&user_id)));
    let badges = parse_badges(r.get("authorBadges"));

    // Stash this message's context-menu params so the mod-capability probe has a
    // real target to ask about (mod options appear only if WE can moderate).
    if let Some(p) = r
        .pointer("/contextMenuEndpoint/liveChatItemContextMenuEndpoint/params")
        .and_then(|x| x.as_str())
    {
        store_context_params(channel_key, p);
    }

    let mut tags = HashMap::new();
    tags.insert("display-name".to_string(), display_name.clone());
    tags.insert("id".to_string(), id.clone());
    // The chatter's profile picture rides every message; stamp it so the frontend
    // can render YouTube's native inline avatar (largest thumbnail).
    if let Some(url) = r
        .pointer("/authorPhoto/thumbnails")
        .and_then(|t| t.as_array())
        .and_then(|a| a.last())
        .and_then(|t| t.get("url"))
        .and_then(|u| u.as_str())
    {
        tags.insert("avatar".to_string(), url.to_string());
    }

    let metadata = match &event {
        Some((kind, system)) => {
            tags.insert("msg-id".to_string(), (*kind).to_string());
            tags.insert("system-msg".to_string(), system.clone());
            MessageMetadata {
                msg_type: Some((*kind).to_string()),
                system_message: Some(system.clone()),
                ..Default::default()
            }
        }
        None => MessageMetadata::default(),
    };

    ChatMessage {
        id,
        user_id,
        username: display_name.to_lowercase(),
        display_name,
        color,
        badges,
        timestamp,
        content: plain,
        provider: "youtube".to_string(),
        channel: channel_key.to_string(),
        emotes: Vec::new(),
        tags,
        layout: LayoutResult {
            height: 0.0,
            width: 0.0,
            has_reply: false,
            is_first_message: false,
        },
        segments,
        metadata,
    }
}

/// Parse a renderer's `message.runs[]` into text + emoji image segments. Custom
/// and standard emoji both carry a thumbnail, so they're baked as image segments
/// (the renderer needs no YouTube emote context, mirroring Kick).
fn parse_runs(message: Option<&Value>) -> (Vec<MessageSegment>, String) {
    let mut segments = Vec::new();
    let mut plain = String::new();
    let Some(runs) = message.and_then(|m| m.get("runs")).and_then(|r| r.as_array()) else {
        return (segments, plain);
    };
    for run in runs {
        if let Some(text) = run.get("text").and_then(|t| t.as_str()) {
            plain.push_str(text);
            segments.push(MessageSegment::Text {
                content: text.to_string(),
            });
        } else if let Some(emoji) = run.get("emoji") {
            let url = emoji
                .pointer("/image/thumbnails")
                .and_then(|t| t.as_array())
                .and_then(|a| a.last())
                .and_then(|t| t.get("url"))
                .and_then(|u| u.as_str())
                .unwrap_or("");
            // Label: the :shortcut: when present, else the emoji id (often the char).
            let label = emoji
                .pointer("/shortcuts/0")
                .and_then(|s| s.as_str())
                .or_else(|| emoji.get("emojiId").and_then(|e| e.as_str()))
                .unwrap_or("");
            if url.is_empty() {
                plain.push_str(label);
                segments.push(MessageSegment::Text {
                    content: label.to_string(),
                });
            } else {
                plain.push_str(label);
                segments.push(MessageSegment::Emote {
                    content: label.to_string(),
                    emote_id: emoji.get("emojiId").and_then(|e| e.as_str()).map(String::from),
                    emote_url: url.to_string(),
                    is_zero_width: None,
                });
            }
        }
    }
    (segments, plain)
}

/// Map YouTube author badges. Member badges carry real custom art (rendered via
/// `image_url_1x`); the icon-only role badges (moderator/verified) carry no image,
/// so the frontend resolves them to bundled YouTube art by `name`.
fn parse_badges(author_badges: Option<&Value>) -> Vec<Badge> {
    let mut out = Vec::new();
    let Some(arr) = author_badges.and_then(|b| b.as_array()) else {
        return out;
    };
    for b in arr {
        let Some(r) = b.get("liveChatAuthorBadgeRenderer") else {
            continue;
        };
        let tooltip = r.get("tooltip").and_then(|t| t.as_str()).unwrap_or("");
        if let Some(thumbs) = r.pointer("/customThumbnail/thumbnails").and_then(|t| t.as_array()) {
            // Member badge: real per-tier art.
            let img = thumbs
                .last()
                .and_then(|t| t.get("url"))
                .and_then(|u| u.as_str())
                .map(String::from);
            out.push(Badge {
                name: "subscriber".to_string(),
                version: member_months(tooltip),
                image_url_1x: img,
                image_url_2x: None,
                image_url_4x: None,
                title: Some(if tooltip.is_empty() {
                    "Member".to_string()
                } else {
                    tooltip.to_string()
                }),
                description: None,
            });
        } else if let Some(icon) = r.pointer("/icon/iconType").and_then(|i| i.as_str()) {
            let name = match icon {
                "MODERATOR" => "moderator",
                "VERIFIED" => "verified",
                "OWNER" => "broadcaster",
                _ => continue,
            };
            out.push(Badge {
                name: name.to_string(),
                version: "1".to_string(),
                image_url_1x: None,
                image_url_2x: None,
                image_url_4x: None,
                title: Some(if tooltip.is_empty() {
                    name.to_string()
                } else {
                    tooltip.to_string()
                }),
                description: None,
            });
        }
    }
    out
}

/// Pull a month count out of a member tooltip like "Member (6 months)".
fn member_months(tooltip: &str) -> String {
    tooltip
        .split(|c: char| !c.is_ascii_digit())
        .find(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| "1".to_string())
}

// --- Small helpers ----------------------------------------------------------

/// Read a JSON string value that immediately follows a `"key":"` marker, up to the
/// next quote. Used for flat ytcfg values (API key, client version, visitorData)
/// whose values contain no embedded quotes.
fn json_str_after(html: &str, marker: &str) -> Option<String> {
    let idx = html.find(marker)?;
    let after = &html[idx + marker.len()..];
    let end = after.find('"')?;
    Some(after[..end].to_string())
}

/// Decode the handful of JSON escapes (`=`, `\/`) that can appear in a raw
/// scraped value like visitorData.
fn decode_json_escapes(s: &str) -> String {
    serde_json::from_str::<String>(&format!("\"{}\"", s)).unwrap_or_else(|_| s.to_string())
}

/// Extract a brace-balanced JSON object that follows a marker (`ytInitialData`,
/// `ytInitialPlayerResponse`), respecting strings/escapes so nested braces don't
/// trip it up.
fn extract_json(html: &str, marker: &str) -> Option<Value> {
    let idx = html.find(marker)?;
    let after = &html[idx + marker.len()..];
    let start = after.find('{')?;
    let bytes = after.as_bytes();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    let mut end = None;
    for (i, &byte) in bytes.iter().enumerate().skip(start) {
        let c = byte as char;
        if in_str {
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
        } else {
            match c {
                '"' => in_str = true,
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(i);
                        break;
                    }
                }
                _ => {}
            }
        }
    }
    serde_json::from_str(&after[start..=end?]).ok()
}

/// Flatten a `{ runs: [...] }` or `{ simpleText }` text object to a plain string.
fn runs_text(v: Option<&Value>) -> Option<String> {
    let v = v?;
    if let Some(s) = v.get("simpleText").and_then(|s| s.as_str()) {
        return Some(s.to_string());
    }
    let runs = v.get("runs").and_then(|r| r.as_array())?;
    let s: String = runs
        .iter()
        .filter_map(|r| r.get("text").and_then(|t| t.as_str()))
        .collect();
    (!s.is_empty()).then_some(s)
}

/// Convert a microsecond epoch string to an ISO-8601 UTC timestamp (what the
/// frontend's timestamp formatter expects, matching the Kick path's ISO strings).
fn usec_to_iso(usec: &str) -> String {
    usec.parse::<i64>()
        .ok()
        .and_then(|us| chrono::DateTime::from_timestamp(us / 1_000_000, ((us % 1_000_000) * 1000) as u32))
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_default()
}

/// YouTube's color ints are ARGB; render as `#rrggbb` (drop alpha).
fn argb_to_hex(v: Option<&Value>) -> Option<String> {
    let n = v?.as_u64()?;
    Some(format!("#{:06x}", n & 0x00ff_ffff))
}

/// A stable, readable name color derived from the channel id (YouTube gives none).
fn color_for(channel_id: &str) -> String {
    const PALETTE: [&str; 14] = [
        "#ff4f4f", "#ff8c42", "#ffd23f", "#9ee493", "#4fd1c5", "#4f9dff", "#7c6cff", "#c77dff",
        "#ff6fae", "#f25c54", "#43aa8b", "#577590", "#e07a5f", "#81b29a",
    ];
    let mut hash: u32 = 2166136261;
    for b in channel_id.bytes() {
        hash ^= b as u32;
        hash = hash.wrapping_mul(16777619);
    }
    PALETTE[(hash as usize) % PALETTE.len()].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_identifiers() {
        assert!(live_page_url("@Repullze").contains("/@Repullze/live"));
        assert!(live_page_url("UC1234567890123456789012").contains("/channel/UC"));
        assert!(live_page_url("dQw4w9WgXcQ").contains("watch?v=dQw4w9WgXcQ"));
    }

    #[test]
    fn parses_a_text_message() {
        let item = json!({
            "liveChatTextMessageRenderer": {
                "id": "abc",
                "authorName": { "simpleText": "Alice" },
                "authorExternalChannelId": "UCxyz",
                "authorPhoto": { "thumbnails": [{ "url": "https://yt/a32.png" }, { "url": "https://yt/a64.png" }] },
                "timestampUsec": "1700000000000000",
                "message": { "runs": [
                    { "text": "hello " },
                    { "emoji": { "emojiId": "x", "shortcuts": [":smile:"],
                      "image": { "thumbnails": [{ "url": "https://e/x.png" }] } } }
                ] },
                "authorBadges": [
                    { "liveChatAuthorBadgeRenderer": { "icon": { "iconType": "MODERATOR" }, "tooltip": "Moderator" } }
                ]
            }
        });
        let msg = parse_item(&item, "youtube:test").expect("parsed");
        assert_eq!(msg.display_name, "Alice");
        assert_eq!(msg.user_id, "UCxyz");
        assert_eq!(msg.provider, "youtube");
        assert_eq!(msg.segments.len(), 2);
        assert_eq!(msg.content, "hello :smile:");
        assert_eq!(msg.badges.len(), 1);
        assert_eq!(msg.badges[0].name, "moderator");
        assert!(!msg.timestamp.is_empty());
        assert_eq!(msg.tags.get("avatar").map(String::as_str), Some("https://yt/a64.png"));
    }

    #[test]
    fn bootstrap_reads_watch_page_continuation() {
        let lcr = json!({ "continuations": [ { "reloadContinuationData": { "continuation": "BOOT" } } ] });
        assert_eq!(bootstrap_continuation(&lcr).as_deref(), Some("BOOT"));
    }

    #[test]
    fn live_view_prefers_non_top() {
        let iframe = json!({ "contents": { "liveChatRenderer": { "header": {
            "liveChatHeaderRenderer": { "viewSelector": { "sortFilterSubMenuRenderer": {
                "subMenuItems": [
                    { "title": "Top chat", "continuation": { "reloadContinuationData": { "continuation": "TOP" } } },
                    { "title": "Live chat", "continuation": { "reloadContinuationData": { "continuation": "LIVE" } } }
                ]
            } } } } } } });
        assert_eq!(live_view_continuation(&iframe).as_deref(), Some("LIVE"));
    }

    #[test]
    fn detects_currently_live() {
        // Live now: videoDetails.isLive true.
        let live = r#"var ytInitialPlayerResponse = {"videoDetails":{"isLive":true}};"#;
        assert!(is_currently_live(live));
        // Live now via the microformat broadcast details.
        let live2 = r#"ytInitialPlayerResponse = {"microformat":{"playerMicroformatRenderer":{"liveBroadcastDetails":{"isLiveNow":true}}}};"#;
        assert!(is_currently_live(live2));
        // Ended stream VOD (isLiveContent stays true, but isLive is false): reject,
        // so the browse-shell fallback never attaches to replay chat.
        let ended = r#"var ytInitialPlayerResponse = {"videoDetails":{"isLive":false,"isLiveContent":true}};"#;
        assert!(!is_currently_live(ended));
        // Plain upload / no player — reject.
        assert!(!is_currently_live(r#"var ytInitialPlayerResponse = {"videoDetails":{}};"#));
        assert!(!is_currently_live("no player here"));
    }

    #[test]
    fn collects_distinct_candidate_video_ids() {
        // Dedups repeats, skips non-11-char junk, preserves order, honors the cap.
        let html = concat!(
            r#"{"videoId":"AVfiMm5fK_U"}, {"videoId":"AVfiMm5fK_U"},"#,
            r#" {"videoId":"shortid"}, {"videoId":"qnuD9ZYOh9U"},"#,
            r#" {"videoId":"knjbSynIY5k"}, {"videoId":"jdkKmsj4ETY"}"#,
        );
        assert_eq!(
            candidate_video_ids(html, 3),
            vec![
                "AVfiMm5fK_U".to_string(),
                "qnuD9ZYOh9U".to_string(),
                "knjbSynIY5k".to_string(),
            ]
        );
        assert!(candidate_video_ids("no ids here", 3).is_empty());
    }

    #[test]
    fn next_continuation_reads_timeout() {
        // A long server-suggested interval is clamped down so fast chats don't lurch.
        let c = json!({ "timedContinuationData": { "continuation": "NEXT", "timeoutMs": 10000 } });
        let (next, ms) = pick_next_continuation(&c);
        assert_eq!(next.as_deref(), Some("NEXT"));
        assert_eq!(ms, 2000);
        // A value already inside the range passes through unchanged.
        let c2 = json!({ "timedContinuationData": { "continuation": "N2", "timeoutMs": 1500 } });
        assert_eq!(pick_next_continuation(&c2).1, 1500);
    }

    // Validate the protobuf encoder byte-for-byte against masterchat's own fixtures
    // (src/protobuf/assembler.test.ts). These exercise ld/vt/large-field-numbers/B1,
    // so matching them proves the primitives the send/moderate params are built from.
    #[test]
    fn protobuf_matches_masterchat_fixtures() {
        let t = pb::b1(&pb::cat(&[pb::ld(1, b"asr"), pb::ld(2, b"en"), pb::ld(3, b"")]));
        assert_eq!(t, "CgNhc3ISAmVuGgA%3D");

        let hdt = base64::engine::general_purpose::STANDARD.encode(pb::cat(&[
            pb::ld(1, &cv_token("bar", "foo")),
            pb::ld(3, &pb::ld(48687757, &pb::ld(1, b"foo"))),
            pb::vt(4, 1),
        ]));
        let lrc = pb::b1(&pb::ld(
            119693434,
            &pb::cat(&[pb::ld(3, hdt.as_bytes()), pb::vt(6, 1), pb::ld(16, &pb::vt(1, 4))]),
        ));
        assert_eq!(
            lrc,
            "0ofMyAMxGihDZ3dxQ2dvRFltRnlFZ05tYjI4YUMrcW8zYmtCQlFvRFptOXZJQUU9MAGCAQIIBA%3D%3D"
        );
    }
}
