use crate::services::badge_service::{BadgeService, UserBadgesResponse};
use crate::services::twitch_service::TwitchService;
use std::sync::Arc;
use tokio::sync::RwLock;

// Global badge service instance
lazy_static::lazy_static! {
    static ref BADGE_SERVICE: Arc<RwLock<Option<BadgeService>>> = Arc::new(RwLock::new(None));
}

/// Initialize the badge service (called on app start)
pub async fn initialize_badge_service() {
    let client_id = "1qgws7yzcp21g5ledlzffw3lmqdvie".to_string();
    let service = BadgeService::new(client_id);

    // Pre-fetch global badges if token is available
    if let Ok(token) = TwitchService::get_token().await {
        let _ = service.fetch_global_badges(&token).await;
    }

    // Pre-fetch third-party badge databases
    let _ = service.fetch_third_party_badges().await;

    *BADGE_SERVICE.write().await = Some(service);
    println!("[BadgeService] Service initialized and pre-warmed");
}

pub async fn get_service() -> Result<Arc<RwLock<Option<BadgeService>>>, String> {
    Ok(BADGE_SERVICE.clone())
}

/// Get user badges for a specific channel (for normal chat - display badges only)
#[tauri::command]
pub async fn get_user_badges_unified(
    user_id: String,
    username: String,
    channel_id: String,
    channel_name: String,
) -> Result<UserBadgesResponse, String> {
    let service_lock = get_service().await?;

    // Auto-initialize if not ready yet
    {
        let service_guard = service_lock.read().await;
        if service_guard.is_none() {
            drop(service_guard);
            initialize_badge_service().await;
        }
    }

    let service_guard = service_lock.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(|| "Badge service failed to initialize".to_string())?;

    let token = TwitchService::get_token()
        .await
        .map_err(|e| format!("Failed to get token: {}", e))?;

    service
        .get_user_badges(&user_id, &username, &channel_id, &channel_name, &token)
        .await
}

/// Get user badges with full earned badge collection (for profile overlay)
#[tauri::command]
pub async fn get_user_badges_with_earned_unified(
    user_id: String,
    username: String,
    channel_id: String,
    channel_name: String,
) -> Result<UserBadgesResponse, String> {
    let service_lock = get_service().await?;

    // Auto-initialize if not ready yet
    {
        let service_guard = service_lock.read().await;
        if service_guard.is_none() {
            drop(service_guard);
            initialize_badge_service().await;
        }
    }

    let service_guard = service_lock.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(|| "Badge service failed to initialize".to_string())?;

    let token = TwitchService::get_token()
        .await
        .map_err(|e| format!("Failed to get token: {}", e))?;

    service
        .get_user_badges_with_earned(&user_id, &username, &channel_id, &channel_name, &token)
        .await
}

/// Parse a badge string from IRC tags (e.g., "subscriber/12,premium/1")
#[tauri::command]
pub async fn parse_badge_string(badge_string: String) -> Result<Vec<String>, String> {
    let service_lock = get_service().await?;
    let service_guard = service_lock.read().await;

    let service = service_guard
        .as_ref()
        .ok_or_else(|| "Badge service not initialized".to_string())?;

    Ok(service.parse_badge_string(&badge_string))
}

/// Pre-fetch global badges (can be called manually or on app start)
#[tauri::command]
pub async fn prefetch_global_badges_unified() -> Result<(), String> {
    let service_lock = get_service().await?;
    let service_guard = service_lock.read().await;

    let service = service_guard
        .as_ref()
        .ok_or_else(|| "Badge service not initialized".to_string())?;

    let token = TwitchService::get_token()
        .await
        .map_err(|e| format!("Failed to get token: {}", e))?;

    service.fetch_global_badges(&token).await
}

/// Pre-fetch channel badges for a specific channel
#[tauri::command]
pub async fn prefetch_channel_badges_unified(channel_id: String) -> Result<(), String> {
    let service_lock = get_service().await?;
    let service_guard = service_lock.read().await;

    let service = service_guard
        .as_ref()
        .ok_or_else(|| "Badge service not initialized".to_string())?;

    let token = TwitchService::get_token()
        .await
        .map_err(|e| format!("Failed to get token: {}", e))?;

    service.fetch_channel_badges(&channel_id, &token).await
}

/// Pre-fetch third-party badge databases (FFZ, Chatterino, Homies)
#[tauri::command]
pub async fn prefetch_third_party_badges() -> Result<(), String> {
    let service_lock = get_service().await?;
    let service_guard = service_lock.read().await;

    let service = service_guard
        .as_ref()
        .ok_or_else(|| "Badge service not initialized".to_string())?;

    service.fetch_third_party_badges().await
}

/// Clear all badge caches
#[tauri::command]
pub async fn clear_badge_cache_unified() -> Result<(), String> {
    let service_lock = get_service().await?;
    let service_guard = service_lock.read().await;

    let service = service_guard
        .as_ref()
        .ok_or_else(|| "Badge service not initialized".to_string())?;

    service.clear_cache().await;
    Ok(())
}

/// Clear badge cache for a specific channel
#[tauri::command]
pub async fn clear_channel_badge_cache_unified(channel_id: String) -> Result<(), String> {
    let service_lock = get_service().await?;
    let service_guard = service_lock.read().await;

    let service = service_guard
        .as_ref()
        .ok_or_else(|| "Badge service not initialized".to_string())?;

    service.clear_channel_cache(&channel_id).await;
    Ok(())
}

/// Store a user's badge string from IRC for later profile lookups
#[tauri::command]
pub async fn store_user_badge_string(user_id: String, badge_string: String) -> Result<(), String> {
    let service_lock = get_service().await?;

    // Auto-initialize if not ready yet
    {
        let service_guard = service_lock.read().await;
        if service_guard.is_none() {
            drop(service_guard);
            initialize_badge_service().await;
        }
    }

    let service_guard = service_lock.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(|| "Badge service not initialized".to_string())?;

    service
        .store_user_badge_string(&user_id, &badge_string)
        .await;
    Ok(())
}

/// Get a user's cached badge string
#[tauri::command]
pub async fn get_user_badge_string(user_id: String) -> Result<Option<String>, String> {
    let service_lock = get_service().await?;
    let service_guard = service_lock.read().await;

    let service = service_guard
        .as_ref()
        .ok_or_else(|| "Badge service not initialized".to_string())?;

    Ok(service.get_user_badge_string(&user_id).await)
}

/// Resolve a badge string to full badge info using Helix metadata
#[tauri::command]
pub async fn resolve_badge_string(
    badge_string: String,
    channel_id: String,
) -> Result<Vec<crate::services::badge_service::UserBadge>, String> {
    let service_lock = get_service().await?;

    // Auto-initialize if not ready yet
    {
        let service_guard = service_lock.read().await;
        if service_guard.is_none() {
            drop(service_guard);
            initialize_badge_service().await;
        }
    }

    let service_guard = service_lock.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(|| "Badge service not initialized".to_string())?;

    Ok(service
        .resolve_badge_string(&badge_string, &channel_id)
        .await)
}
