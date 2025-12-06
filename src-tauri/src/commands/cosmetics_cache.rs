use crate::services::universal_cache_service::{cache_item, get_cached_item, CacheType};
use anyhow::Result;
use tauri::command;

#[command]
pub async fn cache_user_cosmetics(
    user_id: String,
    cosmetics_data: serde_json::Value,
) -> Result<(), String> {
    cache_item(
        CacheType::Cosmetic,
        format!("7tv_{}", user_id),
        cosmetics_data,
        "7tv".to_string(),
        7, // Cache for 7 days
    )
    .await
    .map_err(|e| e.to_string())
}

#[command]
pub async fn get_cached_user_cosmetics(
    user_id: String,
) -> Result<Option<serde_json::Value>, String> {
    match get_cached_item(CacheType::Cosmetic, &format!("7tv_{}", user_id)).await {
        Ok(Some(entry)) => Ok(Some(entry.data)),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[command]
pub async fn cache_third_party_badges(
    user_id: String,
    badges_data: serde_json::Value,
) -> Result<(), String> {
    cache_item(
        CacheType::ThirdPartyBadge,
        format!("tpb_{}", user_id),
        badges_data,
        "third-party".to_string(),
        7, // Cache for 7 days
    )
    .await
    .map_err(|e| e.to_string())
}

#[command]
pub async fn get_cached_third_party_badges(
    user_id: String,
) -> Result<Option<serde_json::Value>, String> {
    match get_cached_item(CacheType::ThirdPartyBadge, &format!("tpb_{}", user_id)).await {
        Ok(Some(entry)) => Ok(Some(entry.data)),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[command]
pub async fn prefetch_user_cosmetics(_user_id: String) -> Result<(), String> {
    // This command will be called from the frontend to pre-fetch cosmetics
    // The actual fetching will be done by the frontend services, and then cached
    // This is just a marker/trigger command
    Ok(())
}
