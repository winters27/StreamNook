use crate::models::settings::AppState;
use crate::services::auth_proxy;
use crate::services::multi_nook_server::MultiNookServer;
use crate::services::twitch_resolver as tr;
use log::debug;
use tauri::State;

/// Maximum number of concurrent streams allowed
const MAX_STREAMS: usize = 25;

/// Extract the channel login from a twitch.tv live URL. MultiNook tiles are
/// always live channels, so this is enough.
fn channel_from_url(url: &str) -> Option<String> {
    let after = url.split("twitch.tv/").nth(1)?;
    let seg = after.split(['/', '?', '#']).next()?.trim();
    if seg.is_empty() || seg == "videos" || seg == "directory" {
        return None;
    }
    Some(seg.to_lowercase())
}

/// Start a stream for multi-stream mode. Each tile resolves natively (same
/// pipeline as the solo player) and gets its own proxy server.
#[tauri::command]
pub async fn start_multi_nook(
    stream_id: String,
    url: String,
    quality: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    debug!(
        "[MultiNook] start_multi_nook called: id='{}', url='{}', quality='{}'",
        stream_id, url, quality
    );

    let current_count = MultiNookServer::active_count().await;
    if current_count >= MAX_STREAMS {
        return Err(format!(
            "Maximum of {} concurrent streams reached",
            MAX_STREAMS
        ));
    }

    let (use_proxy, proxy_playlist, retry_streams, stream_timeout) = {
        let settings = state.settings.lock().unwrap();
        (
            settings.streamlink.use_proxy,
            settings.streamlink.proxy_playlist.clone(),
            settings.streamlink.retry_streams,
            settings.streamlink.stream_timeout,
        )
    };

    let channel =
        channel_from_url(&url).ok_or_else(|| format!("Unrecognized Twitch URL: {}", url))?;
    let oauth = state.twitch_auth.get_token().await.ok();
    let bases = auth_proxy::parse_proxy_bases(&proxy_playlist);

    let r = tr::resolve_live_resilient(
        &channel,
        oauth.as_deref(),
        &bases,
        use_proxy,
        &quality,
        retry_streams,
        stream_timeout,
    )
    .await
    .map_err(|e| e.to_string())?;

    let port = MultiNookServer::start_proxy(&stream_id, r.url)
        .await
        .map_err(|e| e.to_string())?;

    let proxy_url = format!(
        "http://localhost:{}/stream.m3u8?t={}",
        port,
        chrono::Utc::now().timestamp_millis()
    );

    debug!(
        "[MultiNook] '{}' ({}) → {} (mode={})",
        stream_id, channel, proxy_url, r.status.mode
    );

    Ok(proxy_url)
}

/// Stop a specific stream in multi-stream mode
#[tauri::command]
pub async fn stop_multi_nook(stream_id: String) -> Result<(), String> {
    debug!("[MultiNook] Stopping stream: {}", stream_id);
    MultiNookServer::stop_instance(&stream_id)
        .await
        .map_err(|e| e.to_string())
}

/// Stop all streams in multi-stream mode (cleanup)
#[tauri::command]
pub async fn stop_all_multi_nooks() -> Result<(), String> {
    debug!("[MultiNook] Stopping all multi-stream instances");
    MultiNookServer::stop_all().await.map_err(|e| e.to_string())
}

/// Get a list of active multi-stream IDs
#[tauri::command]
pub async fn get_active_multi_nooks() -> Result<Vec<String>, String> {
    Ok(MultiNookServer::get_active_streams().await)
}
