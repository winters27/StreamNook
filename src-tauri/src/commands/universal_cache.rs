use crate::services::universal_cache_service::{
    assign_badge_metadata_positions, cache_file, cache_item, cleanup_expired_entries,
    clear_universal_cache, export_manifest_for_github, get_cached_file_path, get_cached_files_list,
    get_cached_item, get_universal_cache_stats, sync_universal_cache, CacheType,
    UniversalCacheEntry, UniversalCacheStats,
};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::command;

#[command]
pub async fn get_universal_cached_item(
    cache_type: String,
    id: String,
) -> Result<Option<UniversalCacheEntry>, String> {
    let cache_type_enum = match cache_type.as_str() {
        "badge" => CacheType::Badge,
        "emote" => CacheType::Emote,
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
            "third-party-badge" => CacheType::ThirdPartyBadge,
            "cosmetic" => CacheType::Cosmetic,
            _ => continue,
        };
        types.push(cache_type_enum);
    }

    sync_universal_cache(types).await.map_err(|e| e.to_string())
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

#[command]
pub async fn assign_badge_positions() -> Result<usize, String> {
    assign_badge_metadata_positions()
        .await
        .map_err(|e| e.to_string())
}

#[command]
pub async fn export_manifest(output_path: String) -> Result<(), String> {
    let path = PathBuf::from(output_path);
    export_manifest_for_github(path).map_err(|e| e.to_string())
}

#[command]
pub async fn download_and_cache_file(
    cache_type: String,
    id: String,
    url: String,
    expiry_days: u32,
) -> Result<String, String> {
    let cache_type_enum = match cache_type.as_str() {
        "badge" => CacheType::Badge,
        "emote" => CacheType::Emote,
        "third-party-badge" => CacheType::ThirdPartyBadge,
        "cosmetic" => CacheType::Cosmetic,
        _ => return Err(format!("Invalid cache type: {}", cache_type)),
    };

    cache_file(cache_type_enum, id, url, expiry_days)
        .await
        .map_err(|e| e.to_string())
}

#[command]
pub async fn get_cached_file(cache_type: String, id: String) -> Result<Option<String>, String> {
    let cache_type_enum = match cache_type.as_str() {
        "badge" => CacheType::Badge,
        "emote" => CacheType::Emote,
        "third-party-badge" => CacheType::ThirdPartyBadge,
        "cosmetic" => CacheType::Cosmetic,
        _ => return Err(format!("Invalid cache type: {}", cache_type)),
    };

    get_cached_file_path(cache_type_enum, &id)
        .await
        .map_err(|e| e.to_string())
}

#[command]
pub async fn get_cached_files(cache_type: String) -> Result<HashMap<String, String>, String> {
    let cache_type_enum = match cache_type.as_str() {
        "badge" => CacheType::Badge,
        "emote" => CacheType::Emote,
        "third-party-badge" => CacheType::ThirdPartyBadge,
        "cosmetic" => CacheType::Cosmetic,
        _ => return Err(format!("Invalid cache type: {}", cache_type)),
    };

    get_cached_files_list(cache_type_enum)
        .await
        .map_err(|e| e.to_string())
}
