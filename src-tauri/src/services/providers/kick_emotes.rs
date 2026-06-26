//! 7TV emotes for Kick channels.
//!
//! 7TV supports Kick natively: `https://7tv.io/v3/users/kick/{kick_user_id}`
//! returns the channel's active emote set (the same shape as the Twitch path),
//! and `https://7tv.io/v3/emote-sets/global` is the shared global set. We fetch
//! both, build a per-slug `name -> emote` map, and the Kick chat parser bakes
//! matching words into emote segments — parity with the Twitch 7TV path.
//!
//! (BTTV/FFZ don't support Kick, so this is 7TV-only by design.)

use crate::services::emote_service::{Emote, EmoteProvider, EmoteSet};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Clone)]
pub struct KickEmote {
    pub id: String,
    pub url: String,
    pub zero_width: bool,
}

struct ChannelEmotes {
    map: HashMap<String, KickEmote>, // emote name -> emote
    fetched_at: Instant,
}

static STORE: OnceLock<Mutex<HashMap<String, ChannelEmotes>>> = OnceLock::new();

fn store() -> &'static Mutex<HashMap<String, ChannelEmotes>> {
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One of Kick's OWN emotes (a channel sub emote, a Global emote, or an Emoji),
/// as reported by the resolver webview. `set` is the group label Kick gives the
/// set (the channel name for sub emotes, "Global", "Emojis") and drives the
/// picker's section headers. The image is `files.kick.com/emotes/{id}/fullsize`.
///
/// Doubles as the wire type the `report_kick_chatroom` command deserializes, so
/// the JS reports `{ id, name, set }` directly.
#[derive(Clone, serde::Deserialize)]
pub struct KickNativeEmoteEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub set: String,
}

// Per-slug native emotes, captured from kick.com/emotes/{slug} during resolve.
// Unlike the 7TV set above, this endpoint is Cloudflare-gated, so the resolver
// webview pushes the data in (store_native) rather than us fetching it directly.
static NATIVE: OnceLock<Mutex<HashMap<String, Vec<KickNativeEmoteEntry>>>> = OnceLock::new();

fn native_store() -> &'static Mutex<HashMap<String, Vec<KickNativeEmoteEntry>>> {
    NATIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record a channel's native Kick emotes (reported by the resolver webview).
/// Replaces any prior set for the slug. Skips an empty report so a later failed
/// re-resolve can't wipe a good set.
pub fn store_native(slug: &str, emotes: Vec<KickNativeEmoteEntry>) {
    if emotes.is_empty() {
        return;
    }
    if let Ok(mut s) = native_store().lock() {
        s.insert(slug.to_lowercase(), emotes);
    }
}

// Re-fetch a channel's 7TV set at most this often (it changes rarely).
const TTL: Duration = Duration::from_secs(10 * 60);

/// Look up a single word against a channel's 7TV emotes. Cheap (one uncontended
/// lock); the Kick parser calls it per word.
pub fn lookup(slug: &str, word: &str) -> Option<KickEmote> {
    let s = store().lock().ok()?;
    s.get(&slug.to_lowercase())?.map.get(word).cloned()
}

/// The channel's emotes (Kick native sets + 7TV) as an `EmoteSet` for the
/// frontend emote picker — parity with Twitch's `fetch_channel_emotes`. Waits for
/// the channel resolve to populate its caches (see `wait_for_resolve`), then fills
/// the 7TV slot (channel set + globals) and the Kick slot (native sets).
pub async fn channel_emote_set(slug: &str) -> EmoteSet {
    // A picker/add emote fetch can fire right after a Kick channel is added,
    // racing ahead of the multi-second, Cloudflare-clearing resolve that populates
    // the meta + native-emote caches. Without this wait the fetch reads empty
    // caches and the frontend caches an EMPTY set for good (the "second Kick
    // channel shows 0 emotes" bug). channel_meta appears the moment the resolver
    // reports back, and the native emotes are stored just before it, so waiting on
    // meta guarantees both are ready.
    let meta = wait_for_resolve(slug).await;
    if let Some(uid) = meta.as_ref().and_then(|m| m.user_id) {
        refresh(slug, uid).await;
    }
    let display = meta.and_then(|m| m.username);

    let mut set = EmoteSet::new();
    if let Ok(s) = store().lock() {
        if let Some(c) = s.get(&slug.to_lowercase()) {
            set.seven_tv = c
                .map
                .iter()
                .map(|(name, e)| Emote {
                    id: e.id.clone(),
                    name: name.clone(),
                    url: e.url.clone(),
                    provider: EmoteProvider::SevenTV,
                    is_zero_width: Some(e.zero_width),
                    local_url: None,
                    emote_type: None,
                    owner_id: None,
                    owner_name: None,
                    width: None,
                })
                .collect();
        }
    }
    // Kick's own native emotes (channel sub set + Global + Emojis). The set label
    // rides along in `emote_type` so the picker groups them under section headers.
    if let Ok(s) = native_store().lock() {
        if let Some(list) = s.get(&slug.to_lowercase()) {
            set.kick = list
                .iter()
                .map(|e| Emote {
                    id: e.id.clone(),
                    name: e.name.clone(),
                    url: format!("https://files.kick.com/emotes/{}/fullsize", e.id),
                    provider: EmoteProvider::Kick,
                    is_zero_width: Some(false),
                    local_url: None,
                    emote_type: Some(kick_set_label(&e.set, slug, display.as_deref())),
                    owner_id: None,
                    owner_name: None,
                    width: None,
                })
                .collect();
        }
    }
    set
}

/// Wait for a Kick channel to finish resolving before building its emote set, so a
/// picker/add fetch issued right after the channel is added doesn't read empty
/// caches and cache an empty set. Async-sleeps, never blocks a thread.
///
/// Two phases: first wait for the channel chrome (`channel_meta`, ~10s cap) — that
/// is the moment the resolve landed — then, since native emotes are reported on a
/// separate, slightly later round-trip, give them a brief window (~4s) to arrive.
/// Real channels always carry the Global + Emoji sets, so phase 2 normally returns
/// the instant they land.
async fn wait_for_resolve(slug: &str) -> Option<super::kick::KickChannelMeta> {
    let mut meta = None;
    for _ in 0..50 {
        if let Some(m) = super::kick::channel_meta(slug) {
            meta = Some(m);
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    if meta.is_some() {
        for _ in 0..20 {
            if native_present(slug) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
    meta
}

/// Whether the channel's native emotes have been stored (the separate, post-chrome
/// resolver report has landed).
fn native_present(slug: &str) -> bool {
    native_store()
        .lock()
        .map(|s| s.contains_key(&slug.to_lowercase()))
        .unwrap_or(false)
}

/// The picker section header for a Kick emote set. Kick names the Global/Emoji
/// sets ("Global"/"Emojis") but gives the channel set only its numeric channel id,
/// so swap a numeric (or empty) label for the channel's display name.
fn kick_set_label(raw: &str, slug: &str, display: Option<&str>) -> String {
    if raw.is_empty() || raw.chars().all(|c| c.is_ascii_digit()) {
        return display
            .map(String::from)
            .unwrap_or_else(|| if raw.is_empty() { slug.to_string() } else { raw.to_string() });
    }
    raw.to_string()
}

/// Fetch + cache a Kick channel's 7TV emotes (channel set over globals). Safe to
/// call repeatedly — it self-throttles to the TTL. Spawned during channel resolve
/// once the numeric Kick `user_id` is known.
pub async fn refresh(slug: &str, user_id: u64) {
    let slug = slug.to_lowercase();
    {
        if let Ok(s) = store().lock() {
            if let Some(c) = s.get(&slug) {
                if c.fetched_at.elapsed() < TTL {
                    return;
                }
            }
        }
    }

    let client = reqwest::Client::new();
    let mut map: HashMap<String, KickEmote> = HashMap::new();
    // Globals first so the channel set overrides on name collisions.
    fetch_into(&client, "https://7tv.io/v3/emote-sets/global", "/emotes", &mut map).await;
    let chan_url = format!("https://7tv.io/v3/users/kick/{user_id}");
    fetch_into(&client, &chan_url, "/emote_set/emotes", &mut map).await;

    let count = map.len();
    if let Ok(mut s) = store().lock() {
        s.insert(
            slug.clone(),
            ChannelEmotes {
                map,
                fetched_at: Instant::now(),
            },
        );
    }
    log::info!("[Kick] 7TV emotes for {slug} (user {user_id}): {count} loaded");
}

async fn fetch_into(
    client: &reqwest::Client,
    url: &str,
    pointer: &str,
    map: &mut HashMap<String, KickEmote>,
) {
    let resp = match client.get(url).timeout(Duration::from_secs(6)).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return,
    };
    let v: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return,
    };
    let Some(emotes) = v.pointer(pointer).and_then(|e| e.as_array()) else {
        return;
    };
    for e in emotes {
        let (Some(name), Some(id)) = (
            e.get("name").and_then(|x| x.as_str()),
            e.get("id").and_then(|x| x.as_str()),
        ) else {
            continue;
        };
        // Zero-width flag (bit 256) lives on the emote data; fall back to the
        // active-emote flags.
        let flags = e
            .pointer("/data/flags")
            .and_then(|x| x.as_i64())
            .or_else(|| e.get("flags").and_then(|x| x.as_i64()))
            .unwrap_or(0);
        map.insert(
            name.to_string(),
            KickEmote {
                id: id.to_string(),
                url: format!("https://cdn.7tv.app/emote/{id}/2x.webp"),
                zero_width: (flags & 256) == 256,
            },
        );
    }
}
