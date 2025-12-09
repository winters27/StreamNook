use crate::models::settings::AppState;
use crate::models::stream::TwitchStream;
use crate::models::user::{ChannelInfo, UserInfo};
use crate::services::twitch_service::{DeviceCodeInfo, TokenHealthStatus, TwitchService};
use crate::services::whisper_history_service::{
    WhisperHistoryService, WhisperMessage, WhisperThread,
};
use crate::services::whisper_service::WhisperService;
use anyhow::Result;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Mutex as TokioMutex;

// Device Code Flow - the main login command
#[tauri::command]
pub async fn twitch_login(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(String, String), String> {
    let verification_uri = TwitchService::login(&state, app)
        .await
        .map_err(|e| e.to_string())?;

    // Also get the device info to return the user code
    let device_info = TwitchService::start_device_login(&state)
        .await
        .map_err(|e| e.to_string())?;

    // Return both the verification URI and the user code
    Ok((verification_uri, device_info.user_code))
}

// Device code commands (kept for backward compatibility)
#[tauri::command]
pub async fn twitch_start_device_login(
    state: State<'_, AppState>,
) -> Result<DeviceCodeInfo, String> {
    TwitchService::start_device_login(&state)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn twitch_complete_device_login(
    device_code: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    TwitchService::complete_device_login(&device_code, &state)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn twitch_logout(state: State<'_, AppState>) -> Result<(), String> {
    TwitchService::logout(&state)
        .await
        .map_err(|e| e.to_string())
}

/// Clear WebView2 browsing data (cookies, cache, etc.) to force re-login
/// This is used during migrations or when a full logout is required
#[tauri::command]
pub async fn clear_webview_data(app: AppHandle) -> Result<(), String> {
    use std::fs;
    use tauri::Manager;

    println!("[CLEAR_WEBVIEW] Starting WebView2 data cleanup...");

    // Try multiple possible locations for WebView2 data
    let mut paths_to_clear = Vec::new();

    // 1. Tauri's app_data_dir (typically AppData/Local/com.streamnook.dev/)
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        paths_to_clear.push(app_data_dir.join("EBWebView"));
    }

    // 2. Config directory (AppData/Roaming/StreamNook/)
    if let Some(config_dir) = dirs::config_dir() {
        paths_to_clear.push(config_dir.join("StreamNook").join("EBWebView"));
    }

    // 3. Local data directory (AppData/Local/)
    if let Some(local_dir) = dirs::data_local_dir() {
        paths_to_clear.push(local_dir.join("StreamNook").join("EBWebView"));
        paths_to_clear.push(local_dir.join("com.streamnook.dev").join("EBWebView"));
    }

    // 4. Roaming data directory
    if let Some(data_dir) = dirs::data_dir() {
        paths_to_clear.push(data_dir.join("StreamNook").join("EBWebView"));
    }

    let mut cleared_any = false;
    for webview_data_path in paths_to_clear {
        if webview_data_path.exists() {
            println!(
                "[CLEAR_WEBVIEW] Found WebView2 data at: {:?}",
                webview_data_path
            );

            // Remove the entire WebView2 data directory
            if let Err(e) = fs::remove_dir_all(&webview_data_path) {
                eprintln!(
                    "[CLEAR_WEBVIEW] Warning: Could not fully remove {:?}: {}",
                    webview_data_path, e
                );
            } else {
                println!(
                    "[CLEAR_WEBVIEW] Successfully cleared: {:?}",
                    webview_data_path
                );
                cleared_any = true;
            }
        }
    }

    if !cleared_any {
        println!("[CLEAR_WEBVIEW] No WebView2 data directories found to clear");
    }

    Ok(())
}

/// Check if stored credentials exist (for showing appropriate toasts)
#[tauri::command]
pub async fn has_stored_credentials() -> Result<bool, String> {
    Ok(TwitchService::has_stored_credentials().await)
}

#[tauri::command]
pub async fn get_followed_streams(state: State<'_, AppState>) -> Result<Vec<TwitchStream>, String> {
    TwitchService::get_followed_streams(&state)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_channel_info(
    channel_name: String,
    state: State<'_, AppState>,
) -> Result<ChannelInfo, String> {
    TwitchService::get_channel_info(&channel_name, &state)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_user_info(_state: State<'_, AppState>) -> Result<UserInfo, String> {
    TwitchService::get_user_info()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_recommended_streams(
    state: State<'_, AppState>,
) -> Result<Vec<TwitchStream>, String> {
    TwitchService::get_recommended_streams(&state)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_recommended_streams_paginated(
    state: State<'_, AppState>,
    cursor: Option<String>,
    limit: u32,
) -> Result<(Vec<TwitchStream>, Option<String>), String> {
    TwitchService::get_recommended_streams_paginated(&state, cursor, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_browser_url(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| format!("Failed to open browser: {}", e))
}

#[tauri::command]
pub async fn focus_window(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;

    if let Some(window) = app.get_webview_window("main") {
        window
            .set_focus()
            .map_err(|e| format!("Failed to focus window: {}", e))?;

        // Also unminimize if minimized
        if window.is_minimized().unwrap_or(false) {
            window
                .unminimize()
                .map_err(|e| format!("Failed to unminimize window: {}", e))?;
        }

        Ok(())
    } else {
        Err("Main window not found".to_string())
    }
}

#[tauri::command]
pub async fn get_top_games(
    state: State<'_, AppState>,
    limit: u32,
) -> Result<Vec<serde_json::Value>, String> {
    TwitchService::get_top_games(&state, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_top_games_paginated(
    state: State<'_, AppState>,
    cursor: Option<String>,
    limit: u32,
) -> Result<(Vec<serde_json::Value>, Option<String>), String> {
    TwitchService::get_top_games_paginated(&state, cursor, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_streams_by_game(
    state: State<'_, AppState>,
    game_id: String,
    cursor: Option<String>,
    limit: u32,
) -> Result<(Vec<TwitchStream>, Option<String>), String> {
    TwitchService::get_streams_by_game(&state, &game_id, cursor, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search_channels(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<TwitchStream>, String> {
    TwitchService::search_channels(&state, &query)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_user_by_id(user_id: String) -> Result<UserInfo, String> {
    TwitchService::get_user_by_id(&user_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_user_by_login(login: String) -> Result<UserInfo, String> {
    TwitchService::get_user_by_login(&login)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn follow_channel(target_user_id: String) -> Result<(), String> {
    TwitchService::follow_channel(&target_user_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unfollow_channel(target_user_id: String) -> Result<(), String> {
    TwitchService::unfollow_channel(&target_user_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_following_status(target_user_id: String) -> Result<bool, String> {
    TwitchService::check_following_status(&target_user_id)
        .await
        .map_err(|e| e.to_string())
}

/// Verify the current token's health and return detailed status
/// This should be called on app startup to proactively check/refresh the token
#[tauri::command]
pub async fn verify_token_health() -> Result<TokenHealthStatus, String> {
    TwitchService::verify_token_health()
        .await
        .map_err(|e| e.to_string())
}

/// Force refresh the token even if it hasn't expired yet
#[tauri::command]
pub async fn force_refresh_token() -> Result<String, String> {
    TwitchService::force_refresh_token()
        .await
        .map_err(|e| e.to_string())
}

/// Check if a specific stream is currently online by user login
/// Returns the stream data if online, None if offline
#[tauri::command]
pub async fn check_stream_online(user_login: String) -> Result<Option<TwitchStream>, String> {
    TwitchService::check_stream_online(&user_login)
        .await
        .map_err(|e| e.to_string())
}

/// Get streams by game name (convenience method that resolves game name to ID)
/// Returns streams sorted by viewer count (highest first)
#[tauri::command]
pub async fn get_streams_by_game_name(
    state: State<'_, AppState>,
    game_name: String,
    exclude_user_login: Option<String>,
    limit: u32,
) -> Result<Vec<TwitchStream>, String> {
    TwitchService::get_streams_by_game_name(
        &state,
        &game_name,
        exclude_user_login.as_deref(),
        limit,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Send a whisper message to another user
/// Requires user:manage:whispers scope
#[tauri::command]
pub async fn send_whisper(to_user_id: String, message: String) -> Result<(), String> {
    TwitchService::send_whisper(&to_user_id, &message)
        .await
        .map_err(|e| e.to_string())
}

/// Start listening for whisper messages via EventSub WebSocket
/// This should be called after the user is authenticated
#[tauri::command]
pub async fn start_whisper_listener(
    app: AppHandle,
    whisper_service: State<'_, Arc<TokioMutex<WhisperService>>>,
) -> Result<(), String> {
    // Get the current user's ID and token
    let user_info = TwitchService::get_user_info()
        .await
        .map_err(|e| format!("Failed to get user info: {}", e))?;

    let token = TwitchService::get_token()
        .await
        .map_err(|e| format!("Failed to get token: {}", e))?;

    // Start the whisper listener
    let service = whisper_service.lock().await;
    service
        .start_listening(user_info.id, token, app)
        .await
        .map_err(|e| format!("Failed to start whisper listener: {}", e))?;

    Ok(())
}

/// Get whisper message history for a specific user
/// Uses undocumented Twitch GraphQL API
#[tauri::command]
pub async fn get_whisper_history(
    other_user_id: String,
    cursor: Option<String>,
) -> Result<(Vec<WhisperMessage>, Option<String>), String> {
    let token = TwitchService::get_token()
        .await
        .map_err(|e| format!("Failed to get token: {}", e))?;

    let user_info = TwitchService::get_user_info()
        .await
        .map_err(|e| format!("Failed to get user info: {}", e))?;

    WhisperHistoryService::get_whisper_messages(
        &token,
        &user_info.id,
        &other_user_id,
        cursor.as_deref(),
    )
    .await
}

/// Search for a user to whisper using official Helix API
#[tauri::command]
pub async fn search_whisper_user(
    username: String,
) -> Result<Option<(String, String, String, Option<String>)>, String> {
    // Use the official Helix API to find user by login
    match TwitchService::get_user_by_login(&username).await {
        Ok(user) => Ok(Some((
            user.id,
            user.login,
            user.display_name,
            user.profile_image_url,
        ))),
        Err(_) => {
            // User not found
            Ok(None)
        }
    }
}

/// Import all whisper history for a list of known user IDs
/// Used to fetch all messages from existing conversations
#[tauri::command]
pub async fn import_all_whisper_history(
    user_ids: Vec<String>,
) -> Result<std::collections::HashMap<String, Vec<WhisperMessage>>, String> {
    let token = TwitchService::get_token()
        .await
        .map_err(|e| format!("Failed to get token: {}", e))?;

    let user_info = TwitchService::get_user_info()
        .await
        .map_err(|e| format!("Failed to get user info: {}", e))?;

    let result =
        WhisperHistoryService::import_full_history(&token, &user_info.id, user_ids).await?;

    Ok(result.messages_by_user)
}

/// Search for categories by name (uses Twitch search API for fuzzy matching)
/// Returns a list of matching categories with id, name, and box_art_url
#[tauri::command]
pub async fn search_categories(
    query: String,
    limit: u32,
) -> Result<Vec<serde_json::Value>, String> {
    TwitchService::search_categories(&query, limit)
        .await
        .map_err(|e| e.to_string())
}
