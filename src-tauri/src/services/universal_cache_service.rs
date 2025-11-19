use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::services::cache_service::get_cache_dir;

/// Universal cache entry for badges, emotes, and other assets
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UniversalCacheEntry {
    pub id: String,
    pub cache_type: CacheType,
    pub data: serde_json::Value,
    pub metadata: CacheMetadata,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CacheType {
    Badge,
    Emote,
    BadgebaseInfo,
    ThirdPartyBadge,
    Cosmetic,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CacheMetadata {
    pub timestamp: u64,
    pub expiry_days: u32,
    pub source: String, // e.g., "twitch", "bttv", "7tv", "ffz", "badgebase", "universal"
    pub version: u32,   // Cache format version for future compatibility
}

/// Universal cache manifest - tracks all cached items
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct UniversalCacheManifest {
    pub version: u32,
    pub last_sync: Option<u64>,
    pub entries: HashMap<String, UniversalCacheEntry>,
}

const CACHE_VERSION: u32 = 1;
const UNIVERSAL_CACHE_URL: &str = "https://raw.githubusercontent.com/streamnook/universal-cache/main";

/// Get the universal cache directory
pub fn get_universal_cache_dir() -> Result<PathBuf> {
    let cache_dir = get_cache_dir()?.join("universal");

    if !cache_dir.exists() {
        fs::create_dir_all(&cache_dir).context("Failed to create universal cache directory")?;
    }

    Ok(cache_dir)
}

/// Get current timestamp in seconds
fn get_current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// Check if cache entry is expired
/// Note: expiry_days of 0 means never expire (permanent cache)
fn is_cache_expired(metadata: &CacheMetadata) -> bool {
    // If expiry_days is 0, never expire
    if metadata.expiry_days == 0 {
        return false;
    }
    
    let current_time = get_current_timestamp();
    let expiry_seconds = metadata.expiry_days as u64 * 24 * 60 * 60;
    current_time > metadata.timestamp + expiry_seconds
}

/// Load the universal cache manifest
pub fn load_manifest() -> Result<UniversalCacheManifest> {
    let manifest_path = get_universal_cache_dir()?.join("manifest.json");

    if !manifest_path.exists() {
        return Ok(UniversalCacheManifest {
            version: CACHE_VERSION,
            last_sync: None,
            entries: HashMap::new(),
        });
    }

    let json = fs::read_to_string(&manifest_path).context("Failed to read manifest file")?;
    let manifest: UniversalCacheManifest =
        serde_json::from_str(&json).context("Failed to parse manifest")?;

    Ok(manifest)
}

/// Save the universal cache manifest
pub fn save_manifest(manifest: &UniversalCacheManifest) -> Result<()> {
    let manifest_path = get_universal_cache_dir()?.join("manifest.json");
    let json = serde_json::to_string_pretty(manifest)?;
    fs::write(&manifest_path, json).context("Failed to write manifest file")?;
    Ok(())
}

/// Fetch universal cache data from hosted repository
pub async fn fetch_universal_cache_data(
    cache_type: &CacheType,
    id: &str,
) -> Result<Option<UniversalCacheEntry>> {
    let type_str = match cache_type {
        CacheType::Badge => "badges",
        CacheType::Emote => "emotes",
        CacheType::BadgebaseInfo => "badgebase",
        CacheType::ThirdPartyBadge => "third-party-badges",
        CacheType::Cosmetic => "cosmetics",
    };

    // Try to fetch from universal cache repository
    let url = format!("{}/{}/{}.json", UNIVERSAL_CACHE_URL, type_str, id);

    println!("[UniversalCache] Attempting to fetch from: {}", url);

    let client = reqwest::Client::builder()
        .user_agent("StreamNook/1.0")
        .timeout(std::time::Duration::from_secs(5))
        .build()?;

    match client.get(&url).send().await {
        Ok(response) if response.status().is_success() => {
            let entry: UniversalCacheEntry = response.json().await?;
            println!("[UniversalCache] Successfully fetched {} from universal cache", id);
            Ok(Some(entry))
        }
        Ok(response) => {
            println!(
                "[UniversalCache] Universal cache returned status: {}",
                response.status()
            );
            Ok(None)
        }
        Err(e) => {
            println!("[UniversalCache] Failed to fetch from universal cache: {}", e);
            Ok(None)
        }
    }
}

/// Get an item from cache (checks local first, then universal)
pub async fn get_cached_item(
    cache_type: CacheType,
    id: &str,
) -> Result<Option<UniversalCacheEntry>> {
    // Load manifest
    let manifest = load_manifest()?;

    // Check if we have it locally
    if let Some(entry) = manifest.entries.get(id) {
        // Verify it's the right type and not expired
        if entry.cache_type == cache_type && !is_cache_expired(&entry.metadata) {
            println!("[UniversalCache] Found {} in local cache", id);
            return Ok(Some(entry.clone()));
        } else if is_cache_expired(&entry.metadata) {
            println!("[UniversalCache] Local cache entry for {} is expired", id);
        }
    }

    // Not in local cache or expired, try universal cache
    println!("[UniversalCache] Checking universal cache for {}", id);
    if let Some(entry) = fetch_universal_cache_data(&cache_type, id).await? {
        // Save to local cache
        save_cached_item(entry.clone()).await?;
        return Ok(Some(entry));
    }

    Ok(None)
}

/// Save an item to local cache
pub async fn save_cached_item(entry: UniversalCacheEntry) -> Result<()> {
    let mut manifest = load_manifest()?;

    // Add or update entry
    manifest.entries.insert(entry.id.clone(), entry);

    // Save manifest
    save_manifest(&manifest)?;

    Ok(())
}

/// Save a new item to cache with metadata
pub async fn cache_item(
    cache_type: CacheType,
    id: String,
    data: serde_json::Value,
    source: String,
    expiry_days: u32,
) -> Result<()> {
    let entry = UniversalCacheEntry {
        id: id.clone(),
        cache_type,
        data,
        metadata: CacheMetadata {
            timestamp: get_current_timestamp(),
            expiry_days,
            source,
            version: CACHE_VERSION,
        },
    };

    save_cached_item(entry).await
}

/// Sync with universal cache - download commonly used items
pub async fn sync_universal_cache(item_types: Vec<CacheType>) -> Result<usize> {
    println!("[UniversalCache] Starting sync with universal cache");

    let mut synced_count = 0;

    // For each type, fetch the index file which lists available items
    for cache_type in item_types {
        let type_str = match cache_type {
            CacheType::Badge => "badges",
            CacheType::Emote => "emotes",
            CacheType::BadgebaseInfo => "badgebase",
            CacheType::ThirdPartyBadge => "third-party-badges",
            CacheType::Cosmetic => "cosmetics",
        };

        let index_url = format!("{}/{}/index.json", UNIVERSAL_CACHE_URL, type_str);

        println!("[UniversalCache] Fetching index from: {}", index_url);

        let client = reqwest::Client::builder()
            .user_agent("StreamNook/1.0")
            .timeout(std::time::Duration::from_secs(10))
            .build()?;

        match client.get(&index_url).send().await {
            Ok(response) if response.status().is_success() => {
                let index: Vec<String> = response.json().await?;
                println!(
                    "[UniversalCache] Found {} items in {} index",
                    index.len(),
                    type_str
                );

                // Fetch each item (limit to prevent overwhelming)
                let limit = 100.min(index.len());
                for id in index.iter().take(limit) {
                    if let Ok(Some(entry)) = fetch_universal_cache_data(&cache_type, id).await {
                        save_cached_item(entry).await?;
                        synced_count += 1;
                    }
                }
            }
            Ok(response) => {
                println!(
                    "[UniversalCache] Index fetch returned status: {}",
                    response.status()
                );
            }
            Err(e) => {
                println!("[UniversalCache] Failed to fetch index: {}", e);
            }
        }
    }

    // Update last sync time
    let mut manifest = load_manifest()?;
    manifest.last_sync = Some(get_current_timestamp());
    save_manifest(&manifest)?;

    println!("[UniversalCache] Sync complete. Synced {} items", synced_count);

    Ok(synced_count)
}

/// Clear expired entries from cache
pub fn cleanup_expired_entries() -> Result<usize> {
    let mut manifest = load_manifest()?;
    let initial_count = manifest.entries.len();

    manifest
        .entries
        .retain(|_, entry| !is_cache_expired(&entry.metadata));

    let removed_count = initial_count - manifest.entries.len();

    if removed_count > 0 {
        save_manifest(&manifest)?;
        println!(
            "[UniversalCache] Cleaned up {} expired entries",
            removed_count
        );
    }

    Ok(removed_count)
}

/// Get cache statistics
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UniversalCacheStats {
    pub total_entries: usize,
    pub entries_by_type: HashMap<String, usize>,
    pub last_sync: Option<u64>,
    pub cache_dir: String,
}

pub fn get_universal_cache_stats() -> Result<UniversalCacheStats> {
    let manifest = load_manifest()?;
    let cache_dir = get_universal_cache_dir()?;

    let mut entries_by_type: HashMap<String, usize> = HashMap::new();

    for entry in manifest.entries.values() {
        let type_str = match entry.cache_type {
            CacheType::Badge => "badges",
            CacheType::Emote => "emotes",
            CacheType::BadgebaseInfo => "badgebase",
            CacheType::ThirdPartyBadge => "third-party-badges",
            CacheType::Cosmetic => "cosmetics",
        };

        *entries_by_type.entry(type_str.to_string()).or_insert(0) += 1;
    }

    Ok(UniversalCacheStats {
        total_entries: manifest.entries.len(),
        entries_by_type,
        last_sync: manifest.last_sync,
        cache_dir: cache_dir.to_string_lossy().to_string(),
    })
}

/// Clear all universal cache data
pub fn clear_universal_cache() -> Result<()> {
    let cache_dir = get_universal_cache_dir()?;

    if cache_dir.exists() {
        fs::remove_dir_all(&cache_dir).context("Failed to remove universal cache directory")?;
        fs::create_dir_all(&cache_dir).context("Failed to recreate universal cache directory")?;
    }

    Ok(())
}
