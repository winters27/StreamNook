use crate::services::badge_service::{BadgeService, ThirdPartyGalleryBadge, UserBadgesResponse};
use crate::services::twitch_service::TwitchService;
use log::debug;
use std::sync::Arc;
use tokio::sync::RwLock;

// Global badge service instance
lazy_static::lazy_static! {
    static ref BADGE_SERVICE: Arc<RwLock<Option<BadgeService>>> = Arc::new(RwLock::new(None));
}

/// Initialize the badge service (called on app start)
pub async fn initialize_badge_service() {
    let client_id = env!("TWITCH_APP_CLIENT_ID").to_string();
    let service = BadgeService::new(client_id);

    // No per-client Helix prefetch of global badges on startup. get_user_badges
    // self-heals when the cache is empty (it lazily fetches on the first badge
    // resolution), so idle clients never call Helix for badges.

    // Pre-fetch third-party badge databases (FFZ/Chatterino/etc — not Helix)
    let _ = service.fetch_third_party_badges().await;

    *BADGE_SERVICE.write().await = Some(service);
    debug!("[BadgeService] Service initialized and pre-warmed");
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

/// Resolve ONLY a user's real chat-client (third-party) badges — their actual
/// BTTV / FFZ / Chatterino / Homies / Chatsen / Chatty / DankChat badges — from
/// the prefetched provider databases. Cache-only (no Twitch token, no channel,
/// no network), so chat can call it once per chatter without the per-user round
/// trip the full unified path needs. display_badges / earned_badges come back
/// empty.
#[tauri::command]
pub async fn get_third_party_badges_for_user_unified(
    user_id: String,
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

    Ok(service.get_third_party_badges_only(&user_id).await)
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

/// Get the current user's global badge collection (all earned global badges)
/// Returns a list of badge IDs in "set_id/version" format (e.g., "bungie_ally_badge/1")
/// Used for cross-referencing badge drop ownership
#[tauri::command]
pub async fn get_global_badge_collection(username: String) -> Result<Vec<String>, String> {
    use crate::services::drops_auth_service::DropsAuthService;

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

    // Get OAuth token from DropsAuthService (same as drops.rs uses for internal GQL)
    let token = DropsAuthService::get_token()
        .await
        .map_err(|e| format!("Failed to get drops auth token: {}", e))?;

    service
        .fetch_global_badge_collection_from_gql(&username, &token)
        .await
}

/// Get the full distinct badge set for every third-party chat client (FFZ,
/// BetterTTV, Chatterino, Homies, Chatsen, Chatty, DankChat) for the browse gallery.
/// Pass the current user's Twitch ID to flag which badges they own.
#[tauri::command]
pub async fn get_all_third_party_badges(
    viewer_user_id: Option<String>,
) -> Result<Vec<ThirdPartyGalleryBadge>, String> {
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

    // Make sure the databases are warm (no-op if cache is fresh).
    let _ = service.fetch_third_party_badges().await;

    Ok(service
        .get_all_third_party_badges(viewer_user_id.as_deref())
        .await)
}

/// Resolve a single user's BetterTTV Pro loyalty badge (the per-user badge a Pro
/// subscriber enables). This is separate from the contributor badge feed above:
/// BTTV only exposes Pro badges over its live-update WebSocket, so this does an
/// on-demand `broadcast_me` lookup (cached, negative answers included). Returns
/// `None` when the user has no Pro badge or the socket didn't answer in time.
/// Called by the profile card in parallel with the main profile fetch so it
/// never blocks the card from rendering.
#[tauri::command]
pub async fn get_bttv_pro_badge(
    user_id: String,
) -> Result<Option<crate::services::bttv_pro_service::BttvProBadge>, String> {
    Ok(crate::services::bttv_pro_service::resolve_bttv_pro_badge(&user_id).await)
}

/// Every distinct BetterTTV Pro loyalty badge image URL StreamNook has resolved
/// so far, across all users (persisted). The BetterTTV gallery tab renders one
/// tile per URL so discovered loyalty tiers are visible to everyone, not just
/// the account that owns them.
#[tauri::command]
pub async fn get_discovered_bttv_pro_badges() -> Result<Vec<String>, String> {
    Ok(crate::services::bttv_pro_service::get_discovered_bttv_pro_badges())
}

/// Emit a badge notification received from the real-time feed (the badge
/// WebSocket, or its latest.json poll fallback) through the exact same
/// `badge-notification` event the UI already renders. This lets a pushed drop
/// surface identically to a locally-detected one, with no UI change. Dedupe is
/// handled client-side by the socket service before this is invoked.
#[tauri::command]
pub fn push_badge_notification(
    app_handle: tauri::AppHandle,
    badge: crate::services::badge_polling_service::BadgeNotification,
) -> Result<(), String> {
    use crate::services::badge_polling_service::BadgeNotificationStatus;
    use tauri::Emitter;

    let is_available = matches!(badge.status, BadgeNotificationStatus::Available);
    app_handle
        .emit("badge-notification", vec![badge.clone()])
        .map_err(|e| e.to_string())?;
    if is_available {
        let _ = app_handle.emit("badge-available", vec![badge]);
    }
    Ok(())
}
