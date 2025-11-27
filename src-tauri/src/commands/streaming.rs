use crate::models::settings::AppState;
use crate::services::{stream_server::StreamServer, streamlink_manager::StreamlinkManager};
use anyhow::Result;
use tauri::State;

#[tauri::command]
pub async fn start_stream(
    url: String,
    quality: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Get settings values and determine which args to use
    let (streamlink_path, streamlink_args, streamlink_settings) = {
        let settings = state.settings.lock().unwrap();
        let args = if settings.ttvlol_plugin.enabled {
            // Use the ttvlol plugin args
            settings.streamlink_args.clone()
        } else {
            // Don't use any special args if plugin is disabled
            String::new()
        };
        (
            settings.streamlink_path.clone(),
            args,
            settings.streamlink.clone(),
        )
    };

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

    Ok(format!("http://localhost:{}/stream.m3u8", port))
}

#[tauri::command]
pub async fn stop_stream() -> Result<(), String> {
    StreamServer::stop().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_stream_qualities(
    url: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let streamlink_path = {
        let settings = state.settings.lock().unwrap();
        settings.streamlink_path.clone()
    };

    StreamlinkManager::get_qualities(&url, &streamlink_path)
        .await
        .map_err(|e| e.to_string())
}
