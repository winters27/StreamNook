use crate::models::settings::AppState;
use crate::services::stream_server::StreamServer;
use crate::services::streamlink_manager::{StreamlinkDiagnostics, StreamlinkManager};
use anyhow::Result;
use std::path::PathBuf;
use tauri::State;

/// Check if the ttvlol plugin (twitch.py) actually exists
/// Uses the same 3-step resolution as get_plugins_directory:
/// 1. Custom folder plugins
/// 2. AppData plugins (for installed Streamlink)
/// 3. Bundled location
fn is_ttvlol_plugin_installed(custom_folder: Option<&str>) -> bool {
    // Step 1: Check custom folder plugins (for Portable versions)
    if let Some(folder) = custom_folder {
        if !folder.is_empty() {
            let custom_plugin = PathBuf::from(folder).join("plugins").join("twitch.py");
            if custom_plugin.exists() {
                println!(
                    "[Streaming] ✅ Found ttvlol plugin in custom folder: {:?}",
                    custom_plugin
                );
                return true;
            } else {
                println!(
                    "[Streaming] No ttvlol in custom folder {:?}, checking AppData...",
                    custom_plugin
                );
            }
        }
    }

    // Step 2: Check User AppData for installed Streamlink plugins
    // This is where the standard installer puts plugins: %APPDATA%/streamlink/plugins
    if let Some(config_dir) = dirs::config_dir() {
        let appdata_plugin = config_dir
            .join("streamlink")
            .join("plugins")
            .join("twitch.py");
        if appdata_plugin.exists() {
            println!(
                "[Streaming] ✅ Found ttvlol plugin in AppData: {:?}",
                appdata_plugin
            );
            return true;
        } else {
            println!(
                "[Streaming] No ttvlol in AppData {:?}, checking bundled...",
                appdata_plugin
            );
        }
    }

    // Step 3: Check bundled location (production)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let plugin_path = exe_dir.join("streamlink").join("plugins").join("twitch.py");
            println!("[Streaming] Checking exe-relative path: {:?}", plugin_path);
            if plugin_path.exists() {
                println!(
                    "[Streaming] ✅ Found ttvlol plugin at exe dir: {:?}",
                    plugin_path
                );
                return true;
            }
        }
    }

    // Development mode: check CWD and parent
    if let Ok(cwd) = std::env::current_dir() {
        println!("[Streaming] CWD is: {:?}", cwd);

        // Check CWD (project root)
        let cwd_plugin = cwd.join("streamlink").join("plugins").join("twitch.py");
        if cwd_plugin.exists() {
            println!(
                "[Streaming] ✅ Found ttvlol plugin at CWD: {:?}",
                cwd_plugin
            );
            return true;
        }

        // Check parent of CWD (for when CWD is src-tauri during dev)
        if let Some(parent) = cwd.parent() {
            let parent_plugin = parent.join("streamlink").join("plugins").join("twitch.py");
            println!("[Streaming] Checking parent path: {:?}", parent_plugin);
            if parent_plugin.exists() {
                println!(
                    "[Streaming] ✅ Found ttvlol plugin at parent: {:?}",
                    parent_plugin
                );
                return true;
            }
        }
    }

    println!("[Streaming] ❌ ttvlol plugin NOT found in any location");
    false
}

#[tauri::command]
pub async fn start_stream(
    url: String,
    quality: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    println!("[Streaming] start_stream called for URL: {}", url);

    // Get settings values and determine which args to use
    let (streamlink_args, streamlink_settings, custom_path) = {
        let settings = state.settings.lock().unwrap();
        let custom = settings.streamlink.custom_streamlink_path.clone();

        // Check if ttvlol plugin actually exists (not just enabled in settings)
        let ttvlol_installed = is_ttvlol_plugin_installed(custom.as_deref());
        println!("[Streaming] ttvlol plugin installed: {}", ttvlol_installed);

        println!(
            "[Streaming] Settings: ttvlol_enabled={}, streamlink_args='{}', custom_path={:?}",
            settings.ttvlol_plugin.enabled, settings.streamlink_args, custom
        );

        // Only use ttvlol args if BOTH enabled in settings AND the plugin file exists
        let args = if settings.ttvlol_plugin.enabled && ttvlol_installed {
            // Use the ttvlol plugin args
            println!(
                "[Streaming] ✅ Using ttvlol plugin args: {}",
                settings.streamlink_args
            );
            settings.streamlink_args.clone()
        } else {
            // Don't use any special args if plugin is disabled or not installed
            if settings.ttvlol_plugin.enabled && !ttvlol_installed {
                println!(
                    "[Streaming] ⚠️ WARNING: ttvlol enabled but plugin not installed, skipping ttvlol args"
                );
            } else if !settings.ttvlol_plugin.enabled {
                println!("[Streaming] ℹ️ ttvlol plugin is disabled in settings");
            }
            String::new()
        };
        (args, settings.streamlink.clone(), custom)
    };

    println!("[Streaming] Final args to be used: '{}'", streamlink_args);

    // Use the custom path if set, otherwise fallback to bundled/development paths
    let streamlink_path = StreamlinkManager::get_effective_path(custom_path.as_deref());

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
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    // Get the custom path from settings if set
    let custom_path = {
        let settings = state.settings.lock().unwrap();
        settings.streamlink.custom_streamlink_path.clone()
    };

    // Use custom path if set, otherwise fallback to bundled/development paths
    let streamlink_path = StreamlinkManager::get_effective_path(custom_path.as_deref());

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
/// Checks custom path from settings first, then bundled/dev paths
#[tauri::command]
pub fn is_streamlink_available(state: State<'_, AppState>) -> bool {
    // Get the custom path from settings if set
    let custom_path = {
        let settings = state.settings.lock().unwrap();
        settings.streamlink.custom_streamlink_path.clone()
    };

    // Use get_effective_path which checks custom -> bundled -> dev paths
    let effective_path = StreamlinkManager::get_effective_path(custom_path.as_deref());
    let path = std::path::Path::new(&effective_path);

    let available = path.exists();
    println!(
        "[Streaming] is_streamlink_available check: path={:?}, exists={}",
        effective_path, available
    );
    available
}
