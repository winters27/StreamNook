use crate::models::settings::AppState;
use crate::models::stream::TwitchStream;
use crate::models::user::{ChannelInfo, UserInfo};
use crate::services::twitch_service::{DeviceCodeInfo, TokenHealthStatus, TwitchService};
use anyhow::Result;
use tauri::{AppHandle, State};

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
