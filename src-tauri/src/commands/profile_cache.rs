// Tauri commands for ProfileCache service
use crate::services::profile_cache_service::{UserProfile, PROFILE_CACHE};
use tauri::command;

/// Get complete user profile with all cosmetics and badges
#[command]
pub async fn get_user_profile(
    user_id: String,
    username: String,
    channel_id: Option<String>,
    channel_name: Option<String>,
) -> Result<UserProfile, String> {
    PROFILE_CACHE
        .get_user_profile(user_id, username, channel_id, channel_name)
        .await
        .map_err(|e| {
            println!("[ProfileCache Command] Failed to get profile: {}", e);
            format!("Failed to get user profile: {}", e)
        })
}

/// Refresh user profile in background (non-blocking)
#[command]
pub async fn refresh_user_profile(
    user_id: String,
    username: String,
    channel_id: Option<String>,
    channel_name: Option<String>,
) -> Result<(), String> {
    PROFILE_CACHE
        .refresh_user_profile(user_id, username, channel_id, channel_name)
        .await
        .map_err(|e| {
            println!("[ProfileCache Command] Failed to refresh profile: {}", e);
            format!("Failed to refresh user profile: {}", e)
        })
}

/// Clear all profile caches
#[command]
pub async fn clear_profile_cache() -> Result<(), String> {
    PROFILE_CACHE.clear_all_caches().await;
    Ok(())
}

/// Preload badge databases on startup
#[command]
pub async fn preload_badge_databases() -> Result<(), String> {
    PROFILE_CACHE.preload_badge_databases().await.map_err(|e| {
        println!(
            "[ProfileCache Command] Failed to preload badge databases: {}",
            e
        );
        format!("Failed to preload badge databases: {}", e)
    })
}
