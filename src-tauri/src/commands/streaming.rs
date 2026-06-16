use crate::models::settings::AppState;
use crate::services::auth_proxy;
use crate::services::stream_server::StreamServer;
use crate::services::twitch_resolver as tr;
use log::debug;
use serde::Serialize;
use serde_json::json;
use tauri::State;

/// The hook a resolution-owning plugin fills (see docs/plugins/HOOKS.md): the
/// host invokes this action with the channel and quality, and the plugin
/// answers with a master playlist for the relay to serve.
pub(crate) const PLAYBACK_RESOLVE_HOOK: &str = "playback.resolve";

/// Hand a non-entitled live resolution to an installed playback plugin, when
/// one provides the `playback.resolve` hook.
///
/// `core` is the core resolver's own result: entitled resolutions are never
/// delegated (Turbo or a channel sub is already ad-free), and a successful
/// core master rides along in the action args so the plugin can graft the
/// above-1080p tiers the viewer's login unlocks onto whatever master it
/// resolves. Returns `None` whenever the plugin path does not produce a
/// playable result, so the caller falls back to the core resolution.
pub(crate) async fn resolve_via_plugin(
    state: &State<'_, AppState>,
    stream_id: &str,
    channel: &str,
    quality: &str,
    core: &Result<tr::ResolvedLive, anyhow::Error>,
) -> Option<tr::ResolvedLive> {
    if core.as_ref().map(|r| r.status.entitled).unwrap_or(false) {
        return None;
    }
    state.plugin_host.provides(PLAYBACK_RESOLVE_HOOK).await?;
    let auth_master = core.as_ref().ok().map(|r| r.master.clone());
    let args = json!({
        "stream_id": stream_id,
        "channel": channel,
        "quality": quality,
        "auth_master": auth_master,
    });
    let answer = match state
        .plugin_host
        .invoke_action(PLAYBACK_RESOLVE_HOOK, args)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            debug!("[Streaming] {} plugin resolve failed: {}", channel, e);
            return None;
        }
    };
    if answer
        .get("declined")
        .and_then(|d| d.as_bool())
        .unwrap_or(false)
    {
        return None;
    }
    let master = answer.get("master")?.as_str()?.to_string();
    let base = answer
        .get("base")
        .and_then(|b| b.as_str())
        .map(String::from);
    let region = answer
        .get("region")
        .and_then(|r| r.as_str())
        .map(String::from);
    match tr::resolve_from_master(channel, master, quality, base, region) {
        Ok(r) => {
            debug!(
                "[Streaming] {} resolved by a playback plugin (region={:?})",
                channel, r.status.proxy_region
            );
            Some(r)
        }
        Err(e) => {
            debug!(
                "[Streaming] {} plugin master unusable ({}); using the core resolution",
                channel, e
            );
            None
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamStartResult {
    /// Local proxy URL (or direct MP4 for clips) the player should load.
    pub url: String,
    /// The literal quality the resolver served. May differ from the requested
    /// quality if the requested one wasn't offered for this stream (closest-match
    /// fallback). The frontend compares this against the user's saved preference
    /// to decide whether to notify.
    pub quality: String,
    /// How the resolver served this live stream:
    /// "turbo" | "subscribed" | "proxy" | "auth-only". None for VOD/clips.
    /// Drives the UI's ad-source badge.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// True when playing Twitch's own ad-free entitlement, with no proxy in use
    /// (i.e. the viewer's Turbo or channel subscription is doing the work).
    pub entitled: bool,
    /// Proxy region label (e.g. "EU") when the ad-block proxy path was used.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_region: Option<String>,
    /// The quality menu the resolver discovered for this stream (variant names
    /// plus best/worst). The player builds its quality selector from this, so it
    /// always matches what was actually resolved — no separate probe needed.
    #[serde(default)]
    pub available: Vec<String>,
}

/// Extract the channel login from a twitch.tv live URL (e.g.
/// `https://twitch.tv/shroud` → `shroud`). Returns None for VOD/clip URLs and
/// anything that isn't a plain channel path.
fn channel_from_url(url: &str) -> Option<String> {
    let after = url.split("twitch.tv/").nth(1)?;
    let seg = after.split(['/', '?', '#']).next()?.trim();
    if seg.is_empty() || seg == "videos" || seg == "directory" {
        return None;
    }
    Some(seg.to_lowercase())
}

/// The localhost URL the player polls, with a cache-busting timestamp.
fn local_player_url(port: u16) -> String {
    format!(
        "http://localhost:{}/stream.m3u8?t={}",
        port,
        chrono::Utc::now().timestamp_millis()
    )
}

/// Resolve a Twitch clip to its signed MP4 URL WITHOUT touching any global live-
/// stream state (no solo-session reset, no proxy server, no `currentStream`
/// swap). The in-chat clip modal plays that MP4 directly in its own `<video>`,
/// so the main stream/chat keeps running underneath and the user lands back
/// exactly where they were when the modal closes.
#[tauri::command]
pub async fn resolve_clip_media(
    url: String,
    quality: String,
    state: State<'_, AppState>,
) -> Result<StreamStartResult, String> {
    let slug = tr::clip_slug_from_url(&url).ok_or_else(|| format!("Not a clip URL: {}", url))?;
    let oauth = state.twitch_auth.get_token().await.ok();
    let r = tr::resolve_clip(&slug, oauth.as_deref(), &quality)
        .await
        .map_err(|e| e.to_string())?;
    debug!("[Streaming] clip modal {} → '{}'", slug, r.quality);
    Ok(StreamStartResult {
        url: r.url,
        quality: r.quality,
        mode: None,
        entitled: false,
        proxy_region: None,
        available: r.available,
    })
}

#[tauri::command]
pub async fn start_stream(
    url: String,
    quality: String,
    state: State<'_, AppState>,
) -> Result<StreamStartResult, String> {
    debug!("[Streaming] start_stream called for URL: {}", url);

    // Clear the prior solo session up front; only a live resolve below
    // re-registers it (keeps a stale session off clip/VOD playback).
    crate::services::stream_server::set_solo_session(None);

    let streamlink_settings = { state.settings.lock().unwrap().streamlink.clone() };
    let oauth = state.twitch_auth.get_token().await.ok();

    // Clip → signed MP4, loaded directly by the player (no HLS proxy).
    if let Some(slug) = tr::clip_slug_from_url(&url) {
        let r = tr::resolve_clip(&slug, oauth.as_deref(), &quality)
            .await
            .map_err(|e| e.to_string())?;
        debug!("[Streaming] clip {} → '{}'", slug, r.quality);
        return Ok(StreamStartResult {
            url: r.url,
            quality: r.quality,
            mode: None,
            entitled: false,
            proxy_region: None,
            available: r.available,
        });
    }

    // VOD → HLS media playlist, relayed through the local stream server.
    if let Some(vod_id) = tr::vod_id_from_url(&url) {
        let r = tr::resolve_vod(&vod_id, oauth.as_deref(), &quality)
            .await
            .map_err(|e| e.to_string())?;
        let port = StreamServer::start_proxy_server(r.url)
            .await
            .map_err(|e| e.to_string())?;
        debug!("[Streaming] vod {} → '{}'", vod_id, r.quality);
        return Ok(StreamStartResult {
            url: local_player_url(port),
            quality: r.quality,
            mode: None,
            entitled: false,
            proxy_region: None,
            available: r.available,
        });
    }

    // Live channel.
    let channel =
        channel_from_url(&url).ok_or_else(|| format!("Unrecognized Twitch URL: {}", url))?;
    // retry_streams = delay between attempts, stream_timeout = total budget, so a
    // channel that just went live connects once its playlist appears.
    let core = tr::resolve_live_resilient(
        &channel,
        oauth.as_deref(),
        &quality,
        streamlink_settings.retry_streams,
        streamlink_settings.stream_timeout,
    )
    .await;

    // A resolution-owning plugin takes the non-entitled case when installed;
    // otherwise (or when it declines or fails) the core resolution serves.
    let r = match resolve_via_plugin(
        &state,
        crate::services::stream_server::SOLO_STREAM_ID,
        &channel,
        &quality,
        &core,
    )
    .await
    {
        Some(plugin_resolved) => plugin_resolved,
        None => core.map_err(|e| e.to_string())?,
    };

    log::info!(
        "[Streaming] {} '{}' → '{}' (mode={}) available={:?}",
        channel,
        quality,
        r.quality,
        r.status.mode,
        r.available
    );
    auth_proxy::set_status(r.status.clone());
    let port = StreamServer::start_proxy_server(r.url)
        .await
        .map_err(|e| e.to_string())?;
    // Register the live solo session AFTER the relay is serving it, so the
    // plugin protocol's "solo" stream id (set_upstream, on_ad_window) always
    // addresses a live relay.
    crate::services::stream_server::set_solo_session(Some(channel.clone()));
    Ok(StreamStartResult {
        url: local_player_url(port),
        quality: r.quality,
        mode: Some(r.status.mode),
        entitled: r.status.entitled,
        proxy_region: r.status.proxy_region,
        available: r.available,
    })
}

#[tauri::command]
pub async fn stop_stream() -> Result<(), String> {
    StreamServer::stop().await.map_err(|e| e.to_string())
}

/// Whether the relay's LL-HLS origin is actively serving parts for this stream.
/// True ⇒ hls.js should run in `lowLatencyMode` (a real `#EXT-X-PART` playlist with
/// blocking reload is being served). The player reads this once at construction to
/// pick the hls.js mode. NOT the same as "the channel is low-latency" — see
/// `get_stream_prefetch_present`.
#[tauri::command]
pub fn get_stream_low_latency() -> bool {
    crate::services::stream_server::is_low_latency()
}

/// Enable or disable the experimental parts-based low-latency origin at runtime.
/// Default is DISABLED: the stable whole-segment path serves every stream, which plays
/// cleanly on all channels and hardware. Turning this on lets the synthesized spec
/// LL-HLS origin (`#EXT-X-PART` + blocking reload, ~Twitch latency) take over on
/// low-latency channels. Takes effect on the next stream start (the origin is probed at
/// start), so the caller should restart the active stream after toggling. Kept as a
/// runtime switch (not a compile flag) so it can be A/B tested and proven per machine
/// before it is ever made the default.
#[tauri::command]
pub fn set_experimental_low_latency(enabled: bool) {
    crate::services::ll_origin::set_disabled(!enabled);
}

/// Report which video codecs this machine can decode and the user allows (families:
/// "av1","hevc","h264"), most-preferred first. The frontend probes
/// `MediaSource.isTypeSupported` and the `enhanced_codecs` setting and calls this at
/// startup and whenever the setting changes. The resolver then prefers the most
/// efficient decodable codec at a given resolution (which also routes AV1/HEVC CMAF
/// streams through the low-latency origin). H.264 is always kept as the fallback, so
/// selection can never resolve to a codec this machine can't play.
#[tauri::command]
pub fn set_codec_preference(prefs: Vec<String>) {
    crate::services::twitch_resolver::set_codec_preference(prefs);
}

/// Start a low-latency diagnostic recording session. Returns the full path of the
/// JSONL file the frontend (and origin) will append timestamped records to, so a
/// live drift/A-V-sync session can be analyzed from recorded facts. Rotates files.
#[tauri::command]
pub fn start_ll_diag(label: String) -> Result<String, String> {
    crate::services::ll_diagnostics::start_session(&label)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

/// Append a batch of already-serialized JSON-line records to the diagnostic
/// session identified by `path` (records from superseded sessions are dropped,
/// see `ll_diagnostics::append_lines`). Best-effort; never errors playback.
#[tauri::command]
pub fn append_ll_diag(lines: Vec<String>, path: String) {
    crate::services::ll_diagnostics::append_lines(&lines, &path);
}

/// End the diagnostic session identified by `path` (no-op if superseded).
#[tauri::command]
pub fn stop_ll_diag(path: String) {
    crate::services::ll_diagnostics::stop_session(&path);
}

/// Current ad-detection state for the live stream the local player is pulling.
/// The detector scans every media-playlist poll for Twitch ad-stitch markers,
/// so this reflects whether ads are slipping through the proxy right now.
#[tauri::command]
pub async fn get_ad_detection() -> crate::services::stream_server::AdDetectionState {
    crate::services::stream_server::ad_state()
}

#[tauri::command]
pub async fn get_stream_qualities(
    url: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let oauth = state.twitch_auth.get_token().await.ok();

    // Resolve once at "best" and surface the variant menu it discovered. The
    // 20s master cache means the subsequent start_stream is a cache hit.
    if let Some(slug) = tr::clip_slug_from_url(&url) {
        tr::resolve_clip(&slug, oauth.as_deref(), "best")
            .await
            .map(|r| r.available)
            .map_err(|e| e.to_string())
    } else if let Some(vod_id) = tr::vod_id_from_url(&url) {
        tr::resolve_vod(&vod_id, oauth.as_deref(), "best")
            .await
            .map(|r| r.available)
            .map_err(|e| e.to_string())
    } else {
        let channel =
            channel_from_url(&url).ok_or_else(|| format!("Unrecognized Twitch URL: {}", url))?;
        tr::resolve_live(&channel, oauth.as_deref(), "best")
            .await
            .map(|r| r.available)
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn change_stream_quality(
    url: String,
    quality: String,
    state: State<'_, AppState>,
) -> Result<StreamStartResult, String> {
    // Don't stop the server - just update the stream URL.
    // The server keeps running on the same port.
    start_stream(url, quality, state).await
}

#[tauri::command]
pub async fn register_active_channel(
    channel_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let bg_service = state.background_service.lock().await;
    let ws_service_mutex = bg_service.websocket_service.clone();
    let ws_service = ws_service_mutex.lock().await;
    ws_service.register_active_channel(&channel_id).await;
    Ok(())
}

#[tauri::command]
pub async fn unregister_active_channel(
    channel_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let bg_service = state.background_service.lock().await;
    let ws_service_mutex = bg_service.websocket_service.clone();
    let ws_service = ws_service_mutex.lock().await;
    ws_service.unregister_active_channel(&channel_id).await;
    Ok(())
}
