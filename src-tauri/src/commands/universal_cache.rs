use crate::services::universal_cache_service::{
    cache_item, cleanup_expired_entries, clear_universal_cache, get_cached_item,
    get_universal_cache_stats, sync_universal_cache, CacheType, UniversalCacheEntry,
    UniversalCacheStats,
};
use tauri::command;

#[command]
pub async fn get_universal_cached_item(
    cache_type: String,
    id: String,
) -> Result<Option<UniversalCacheEntry>, String> {
    let cache_type_enum = match cache_type.as_str() {
        "badge" => CacheType::Badge,
        "emote" => CacheType::Emote,
        "badgebase" => CacheType::BadgebaseInfo,
        "third-party-badge" => CacheType::ThirdPartyBadge,
        "cosmetic" => CacheType::Cosmetic,
        _ => return Err(format!("Invalid cache type: {}", cache_type)),
    };

    get_cached_item(cache_type_enum, &id)
        .await
        .map_err(|e| e.to_string())
}

#[command]
pub async fn save_universal_cached_item(
    cache_type: String,
    id: String,
    data: serde_json::Value,
    source: String,
    expiry_days: u32,
) -> Result<(), String> {
    let cache_type_enum = match cache_type.as_str() {
        "badge" => CacheType::Badge,
        "emote" => CacheType::Emote,
        "badgebase" => CacheType::BadgebaseInfo,
        "third-party-badge" => CacheType::ThirdPartyBadge,
        "cosmetic" => CacheType::Cosmetic,
        _ => return Err(format!("Invalid cache type: {}", cache_type)),
    };

    cache_item(cache_type_enum, id, data, source, expiry_days)
        .await
        .map_err(|e| e.to_string())
}

#[command]
pub async fn sync_universal_cache_data(cache_types: Vec<String>) -> Result<usize, String> {
    let mut types = Vec::new();

    for cache_type in cache_types {
        let cache_type_enum = match cache_type.as_str() {
            "badge" => CacheType::Badge,
            "emote" => CacheType::Emote,
            "badgebase" => CacheType::BadgebaseInfo,
            "third-party-badge" => CacheType::ThirdPartyBadge,
            "cosmetic" => CacheType::Cosmetic,
            _ => continue,
        };
        types.push(cache_type_enum);
    }

    sync_universal_cache(types)
        .await
        .map_err(|e| e.to_string())
}

#[command]
pub async fn cleanup_universal_cache() -> Result<usize, String> {
    cleanup_expired_entries().map_err(|e| e.to_string())
}

#[command]
pub async fn clear_all_universal_cache() -> Result<(), String> {
    clear_universal_cache().map_err(|e| e.to_string())
}

#[command]
pub async fn get_universal_cache_statistics() -> Result<UniversalCacheStats, String> {
    get_universal_cache_stats().map_err(|e| e.to_string())
}
