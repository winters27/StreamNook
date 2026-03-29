use crate::models::settings::AppState;
use crate::services::multi_nook_server::MultiNookServer;
use crate::services::streamlink_manager::StreamlinkManager;
use log::debug;
use std::path::PathBuf;
use tauri::State;

/// Maximum number of concurrent streams allowed
const MAX_STREAMS: usize = 25;

/// Check if the ttvlol plugin exists (reused from streaming.rs logic)
fn is_ttvlol_plugin_installed(custom_folder: Option<&str>) -> bool {
    // Check custom folder plugins (for Portable versions)
    if let Some(folder) = custom_folder {
        if !folder.is_empty() {
            let custom_plugin = PathBuf::from(folder).join("plugins").join("twitch.py");
            if custom_plugin.exists() {
                return true;
            }
        }
    }

    // Check User AppData for installed Streamlink plugins
    if let Some(config_dir) = dirs::config_dir() {
        let appdata_plugin = config_dir
            .join("streamlink")
            .join("plugins")
            .join("twitch.py");
        if appdata_plugin.exists() {
            return true;
        }
    }

    // Check bundled location (production)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let plugin_path = exe_dir.join("streamlink").join("plugins").join("twitch.py");
            if plugin_path.exists() {
                return true;
            }
        }
    }

    // Development mode: check CWD and parent
    if let Ok(cwd) = std::env::current_dir() {
        let cwd_plugin = cwd.join("streamlink").join("plugins").join("twitch.py");
        if cwd_plugin.exists() {
            return true;
        }
        if let Some(parent) = cwd.parent() {
            let parent_plugin = parent.join("streamlink").join("plugins").join("twitch.py");
            if parent_plugin.exists() {
                return true;
            }
        }
    }

    false
}

/// Start a stream for multi-stream mode
/// Each stream gets its own Streamlink process and proxy server
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

    // Check stream count limit
    let current_count = MultiNookServer::active_count().await;
    if current_count >= MAX_STREAMS {
        return Err(format!(
            "Maximum of {} concurrent streams reached",
            MAX_STREAMS
        ));
    }

    // Check if streamlink is available
    let is_available = {
        let settings = state.settings.lock().unwrap();
        let custom_path = settings.streamlink.custom_streamlink_path.clone();
        let effective_path = StreamlinkManager::get_effective_path(custom_path.as_deref());
        std::path::Path::new(&effective_path).exists()
    };

    if !is_available {
        return Err("Streamlink not found. Please install Streamlink first.".to_string());
    }

    // Get settings values for Streamlink args
    let (streamlink_args, streamlink_settings, custom_path) = {
        let settings = state.settings.lock().unwrap();
        let custom = settings.streamlink.custom_streamlink_path.clone();
        let ttvlol_installed = is_ttvlol_plugin_installed(custom.as_deref());

        let proxy_args =
            if settings.streamlink.use_proxy && !settings.streamlink.proxy_playlist.is_empty() {
                settings.streamlink.proxy_playlist.clone()
            } else if !settings.streamlink_args.is_empty() {
                settings.streamlink_args.clone()
            } else {
                String::new()
            };

        let args = if settings.ttvlol_plugin.enabled && ttvlol_installed {
            proxy_args
        } else {
            String::new()
        };

        (args, settings.streamlink.clone(), custom)
    };

    // Get the effective Streamlink path
    let streamlink_path = StreamlinkManager::get_effective_path(custom_path.as_deref());

    // Start Streamlink to get the HLS stream URL
    let stream_url = StreamlinkManager::get_stream_url_with_settings(
        &url,
        &quality,
        &streamlink_path,
        &streamlink_args,
        &streamlink_settings,
    )
    .await
    .map_err(|e| e.to_string())?;

    // Start a dedicated proxy server for this stream
    let port = MultiNookServer::start_proxy(&stream_id, stream_url)
        .await
        .map_err(|e| e.to_string())?;

    let proxy_url = format!(
        "http://localhost:{}/stream.m3u8?t={}",
        port,
        chrono::Utc::now().timestamp_millis()
    );

    debug!(
        "[MultiNook] Stream '{}' proxied at: {}",
        stream_id, proxy_url
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
