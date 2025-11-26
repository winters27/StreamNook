use crate::models::settings::AppState;
use crate::services::discord_service::DiscordService;
use anyhow::Result;
use tauri::State;

#[tauri::command]
pub async fn connect_discord(app_state: State<'_, AppState>) -> Result<(), String> {
    DiscordService::connect(&app_state)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn disconnect_discord() -> Result<(), String> {
    DiscordService::disconnect()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_idle_discord_presence(app_state: State<'_, AppState>) -> Result<(), String> {
    DiscordService::set_idle_presence(&app_state)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_discord_presence(
    details: String,
    activity_state: String,
    large_image: String,
    small_image: String,
    start_time: u64,
    game_name: String,
    stream_url: String,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    DiscordService::update_presence(
        &details,
        &activity_state,
        &large_image,
        &small_image,
        start_time,
        &game_name,
        &stream_url,
        &app_state,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_discord_presence(state: State<'_, AppState>) -> Result<(), String> {
    DiscordService::clear_presence(&state)
        .await
        .map_err(|e| e.to_string())
}
