use crate::services::magne_service::MagneService;
use anyhow::Result;

#[tauri::command]
pub async fn connect_magne() -> Result<(), String> {
    MagneService::connect().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn disconnect_magne() -> Result<(), String> {
    MagneService::disconnect().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_idle_magne_presence() -> Result<(), String> {
    MagneService::set_idle_presence()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_magne_presence(
    details: String,
    activity_state: String,
    large_image: String,
    small_image: String,
    start_time: u64,
    game_name: String,
    stream_url: String,
) -> Result<(), String> {
    MagneService::update_presence(
        &details,
        &activity_state,
        &large_image,
        &small_image,
        start_time,
        &game_name,
        &stream_url,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_magne_presence() -> Result<(), String> {
    MagneService::clear_presence()
        .await
        .map_err(|e| e.to_string())
}
