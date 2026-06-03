use crate::models::settings::AppState;
use crate::services::auth_proxy;
use crate::services::stream_server::StreamServer;
use crate::services::twitch_resolver as tr;
use log::debug;
use serde::Serialize;
use tauri::State;

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

#[tauri::command]
pub async fn start_stream(
    url: String,
    quality: String,
    state: State<'_, AppState>,
) -> Result<StreamStartResult, String> {
    debug!("[Streaming] start_stream called for URL: {}", url);

    // Reset any prior auto-pivot context up front; only a proxied live resolve
    // below re-arms it (keeps a stale pivot off a clip/VOD/entitled stream).
    crate::services::stream_server::clear_active_stream();

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
    let bases = auth_proxy::parse_proxy_bases(&streamlink_settings.proxy_playlist);
    // retry_streams = delay between attempts, stream_timeout = total budget, so a
    // channel that just went live connects once its playlist appears.
    let r = tr::resolve_live_resilient(
        &channel,
        oauth.as_deref(),
        &bases,
        streamlink_settings.use_proxy,
        &quality,
        streamlink_settings.retry_streams,
        streamlink_settings.stream_timeout,
    )
    .await
    .map_err(|e| e.to_string())?;

    log::info!(
        "[Streaming] {} '{}' → '{}' (mode={}) available={:?}",
        channel,
        quality,
        r.quality,
        r.status.mode,
        r.available
    );
    auth_proxy::set_status(r.status.clone());
    // Arm the ad auto-pivot only for proxied streams (entitled Turbo/sub streams
    // are already ad-free and must not pivot).
    if r.status.mode == "proxy" {
        crate::services::stream_server::set_active_stream(
            channel.clone(),
            quality.clone(),
            bases.clone(),
            r.status.proxy_base.clone(),
            state.twitch_auth.clone(),
        );
    }
    let port = StreamServer::start_proxy_server(r.url)
        .await
        .map_err(|e| e.to_string())?;
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
    let (use_proxy, proxy_playlist) = {
        let settings = state.settings.lock().unwrap();
        (
            settings.streamlink.use_proxy,
            settings.streamlink.proxy_playlist.clone(),
        )
    };
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
        let bases = auth_proxy::parse_proxy_bases(&proxy_playlist);
        tr::resolve_live(&channel, oauth.as_deref(), &bases, use_proxy, "best")
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
