use crate::models::settings::AppState;
use crate::services::stream_server::StreamServer;
use crate::services::streamlink_manager::{StreamlinkDiagnostics, StreamlinkManager};
use anyhow::Result;
use tauri::State;

#[tauri::command]
pub async fn start_stream(
    url: String,
    quality: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Get settings values and determine which args to use
    let (streamlink_args, streamlink_settings) = {
        let settings = state.settings.lock().unwrap();
        let args = if settings.ttvlol_plugin.enabled {
            // Use the ttvlol plugin args
            settings.streamlink_args.clone()
        } else {
            // Don't use any special args if plugin is disabled
            String::new()
        };
        (args, settings.streamlink.clone())
    };

    // Always use the bundled streamlink path (relative to exe location)
    // This works regardless of which drive the app is installed on
    let streamlink_path = StreamlinkManager::get_effective_path("");

    // Start Streamlink with enhanced settings to get stream URL
    let stream_url = StreamlinkManager::get_stream_url_with_settings(
        &url,
        &quality,
        &streamlink_path,
        &streamlink_args,
        &streamlink_settings,
    )
    .await
    .map_err(|e| e.to_string())?;

    // Start local HTTP server to proxy the stream
    let port = StreamServer::start_proxy_server(stream_url)
        .await
        .map_err(|e| e.to_string())?;

    Ok(format!(
        "http://localhost:{}/stream.m3u8?t={}",
        port,
        chrono::Utc::now().timestamp_millis()
    ))
}

#[tauri::command]
pub async fn stop_stream() -> Result<(), String> {
    StreamServer::stop().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_stream_qualities(
    url: String,
    _state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    // Always use the bundled streamlink path (relative to exe location)
    let streamlink_path = StreamlinkManager::get_effective_path("");

    StreamlinkManager::get_qualities(&url, &streamlink_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn change_stream_quality(
    url: String,
    quality: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Don't stop the server - just update the stream URL
    // The server will keep running on the same port
    start_stream(url, quality, state).await
}

/// Get comprehensive streamlink diagnostics for debugging
/// This helps identify why streamlink might not be found on some systems
#[tauri::command]
pub async fn get_streamlink_diagnostics() -> Result<StreamlinkDiagnostics, String> {
    Ok(StreamlinkManager::get_diagnostics_with_version().await)
}

/// Quick check if streamlink is available
/// Returns true if streamlink.exe is found at the expected location
#[tauri::command]
pub fn is_streamlink_available() -> bool {
    StreamlinkManager::is_bundled_available()
}
