use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as StdMutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex as TokioMutex;

use crate::services::cache_service::get_cache_dir;

// Global mutex to prevent concurrent manifest writes (for sync operations)
static MANIFEST_LOCK: Lazy<StdMutex<()>> = Lazy::new(|| StdMutex::new(()));

// Async mutex for async operations
static ASYNC_MANIFEST_LOCK: Lazy<TokioMutex<()>> = Lazy::new(|| TokioMutex::new(()));

// Flag to prevent concurrent downloads
static DOWNLOAD_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Universal cache entry for badges, emotes, and other assets
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UniversalCacheEntry {
    pub id: String,
    pub cache_type: CacheType,
    pub data: serde_json::Value,
    pub metadata: CacheMetadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CacheType {
    Badge,
    Emote,
    #[serde(rename = "thirdpartybadge")]
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
const UNIVERSAL_CACHE_URL: &str =
    "https://raw.githubusercontent.com/winters27/StreamNook/refs/heads/main/universal-cache/main";

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

    let json = match fs::read_to_string(&manifest_path) {
        Ok(json) => json,
        Err(e) => {
            println!("[UniversalCache] Failed to read manifest file: {}", e);
            // Create new manifest
            return Ok(UniversalCacheManifest {
                version: CACHE_VERSION,
                last_sync: None,
                entries: HashMap::new(),
            });
        }
    };

    match serde_json::from_str::<UniversalCacheManifest>(&json) {
        Ok(manifest) => Ok(manifest),
        Err(e) => {
            println!(
                "[UniversalCache] Failed to parse manifest ({}), creating new one",
                e
            );
            // Backup the corrupted manifest
            let backup_path = manifest_path.with_extension("json.backup");
            let _ = fs::rename(&manifest_path, &backup_path);
            println!(
                "[UniversalCache] Backed up corrupted manifest to {:?}",
                backup_path
            );

            // Create new manifest
            Ok(UniversalCacheManifest {
                version: CACHE_VERSION,
                last_sync: None,
                entries: HashMap::new(),
            })
        }
    }
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
            println!(
                "[UniversalCache] Successfully fetched {} from universal cache",
                id
            );
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
            println!(
                "[UniversalCache] Failed to fetch from universal cache: {}",
                e
            );
            Ok(None)
        }
    }
}

/// Download and merge the universal manifest from GitHub
/// Returns true if download was performed, false if skipped (already in progress)
async fn download_universal_manifest() -> Result<bool> {
    // Check if download is already in progress using compare_exchange
    // This atomically checks if false and sets to true
    if DOWNLOAD_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        // Another download is already in progress, skip
        return Ok(false);
    }

    // Ensure we reset the flag when done (even on error)
    let _guard = scopeguard::guard((), |_| {
        DOWNLOAD_IN_PROGRESS.store(false, Ordering::SeqCst);
    });

    println!("[UniversalCache] Downloading universal manifest from GitHub...");

    let url = format!("{}/manifest.json", UNIVERSAL_CACHE_URL);

    let client = reqwest::Client::builder()
        .user_agent("StreamNook/1.0")
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    match client.get(&url).send().await {
        Ok(response) if response.status().is_success() => {
            let remote_manifest: UniversalCacheManifest = response.json().await?;
            println!(
                "[UniversalCache] Downloaded manifest with {} entries",
                remote_manifest.entries.len()
            );

            // Acquire async lock for all manifest operations
            let _async_lock = ASYNC_MANIFEST_LOCK.lock().await;

            let mut local_manifest = load_manifest()?;

            // Only add entries that don't exist locally or are from "badgebase" source
            for (key, entry) in remote_manifest.entries {
                if entry.metadata.source == "badgebase" {
                    local_manifest.entries.insert(key, entry);
                }
            }

            // Update last_sync time
            local_manifest.last_sync = Some(get_current_timestamp());

            save_manifest(&local_manifest)?;
            println!("[UniversalCache] Merged universal manifest into local cache");

            // Assign positions if not already set
            let needs_positions = local_manifest
                .entries
                .iter()
                .filter(|(_, entry)| entry.metadata.source == "badgebase")
                .any(|(_, entry)| entry.position.is_none());

            if needs_positions {
                println!("[UniversalCache] Assigning positions to badge metadata...");
                // Note: assign_badge_metadata_positions will acquire its own lock
                drop(_async_lock);
                let _ = assign_badge_metadata_positions_internal().await;
            }

            Ok(true)
        }
        Ok(response) => {
            println!(
                "[UniversalCache] GitHub returned status: {}",
                response.status()
            );
            Ok(true)
        }
        Err(e) => {
            println!(
                "[UniversalCache] Failed to download universal manifest: {}",
                e
            );
            Ok(true) // Don't fail if GitHub is unavailable
        }
    }
}

/// Get an item from cache (checks local first, downloads manifest if needed)
/// NOTE: This function is optimized for fast reads - it doesn't acquire locks for cache hits
pub async fn get_cached_item(
    cache_type: CacheType,
    id: &str,
) -> Result<Option<UniversalCacheEntry>> {
    // Load manifest WITHOUT lock for fast cache reads
    // This is safe because:
    // 1. load_manifest handles corrupted files gracefully
    // 2. We only read, never write here
    // 3. Worst case: we get slightly stale data or miss a just-added entry
    let manifest = load_manifest()?;

    // Check if we have it locally
    if let Some(entry) = manifest.entries.get(id) {
        // Verify it's the right type and not expired
        if entry.cache_type == cache_type && !is_cache_expired(&entry.metadata) {
            return Ok(Some(entry.clone()));
        } else if is_cache_expired(&entry.metadata) {
            println!("[UniversalCache] Local cache entry for {} is expired", id);
        }
    }

    // Not in local cache - check if we've downloaded the universal manifest recently
    let should_download = manifest.last_sync.is_none() || {
        let current_time = get_current_timestamp();
        let last_sync = manifest.last_sync.unwrap_or(0);
        current_time - last_sync > 7 * 24 * 60 * 60 // More than 7 days old
    };

    if should_download {
        // download_universal_manifest will handle concurrency protection and updating last_sync
        let downloaded = download_universal_manifest().await?;

        if downloaded {
            // Reload manifest after download (no lock needed for reads)
            let manifest = load_manifest()?;

            // Try to find the item again
            if let Some(entry) = manifest.entries.get(id) {
                if entry.cache_type == cache_type && !is_cache_expired(&entry.metadata) {
                    println!("[UniversalCache] Found {} in downloaded manifest", id);
                    return Ok(Some(entry.clone()));
                }
            }
        }
    }

    Ok(None)
}

/// Save an item to local cache (with lock to prevent concurrent writes)
pub async fn save_cached_item(entry: UniversalCacheEntry) -> Result<()> {
    // Acquire lock to prevent concurrent writes
    let _lock = MANIFEST_LOCK.lock().unwrap();

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
        position: None,
    };

    save_cached_item(entry).await
}

/// Parse date string in format "DD Month YYYY" to timestamp for sorting
fn parse_date_to_timestamp(date_str: &str) -> i64 {
    use chrono::{Datelike, NaiveDate, Timelike};

    // Try to parse "DD Month YYYY" format
    let months = [
        ("January", 1),
        ("February", 2),
        ("March", 3),
        ("April", 4),
        ("May", 5),
        ("June", 6),
        ("July", 7),
        ("August", 8),
        ("September", 9),
        ("October", 10),
        ("November", 11),
        ("December", 12),
    ];

    // Split the date string
    let parts: Vec<&str> = date_str.split_whitespace().collect();
    if parts.len() != 3 {
        return 0; // Invalid format
    }

    // Parse day
    let day = match parts[0].parse::<u32>() {
        Ok(d) if (1..=31).contains(&d) => d,
        _ => return 0,
    };

    // Parse month
    let month = months
        .iter()
        .find(|(name, _)| *name == parts[1])
        .map(|(_, num)| *num)
        .unwrap_or(0);

    if month == 0 {
        return 0;
    }

    // Parse year
    let year = match parts[2].parse::<i32>() {
        Ok(y) if (1900..=3000).contains(&y) => y,
        _ => return 0,
    };

    // Create a date and convert to timestamp
    match NaiveDate::from_ymd_opt(year, month, day) {
        Some(date) => {
            // Convert to timestamp (seconds since epoch)
            date.and_hms_opt(0, 0, 0)
                .map(|dt| dt.and_utc().timestamp())
                .unwrap_or(0)
        }
        None => 0,
    }
}

/// Internal function to assign positions (called from download_universal_manifest with lock already held)
async fn assign_badge_metadata_positions_internal() -> Result<usize> {
    let _lock = ASYNC_MANIFEST_LOCK.lock().await;
    assign_badge_metadata_positions_impl()
}

/// Implementation of position assignment (assumes lock is held or not needed)
fn assign_badge_metadata_positions_impl() -> Result<usize> {
    let mut manifest = load_manifest()?;

    // Collect all badge entries from badge metadata source
    let mut metadata_entries: Vec<(String, UniversalCacheEntry)> = manifest
        .entries
        .iter()
        .filter(|(_, entry)| {
            entry.cache_type == CacheType::Badge && entry.metadata.source == "badgebase"
        })
        .map(|(id, entry)| (id.clone(), entry.clone()))
        .collect();

    // Sort by date (newest first), then by usage (highest first)
    metadata_entries.sort_by(|a, b| {
        let a_data = &a.1.data;
        let b_data = &b.1.data;

        // Extract date_added
        let a_date = a_data
            .get("date_added")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let b_date = b_data
            .get("date_added")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        // Parse usage stats
        let parse_usage = |stats: &str| -> u32 {
            stats
                .split_whitespace()
                .next()
                .and_then(|s| s.replace(",", "").parse::<u32>().ok())
                .unwrap_or(0)
        };

        let a_usage = a_data
            .get("usage_stats")
            .and_then(|v| v.as_str())
            .map(parse_usage)
            .unwrap_or(0);
        let b_usage = b_data
            .get("usage_stats")
            .and_then(|v| v.as_str())
            .map(parse_usage)
            .unwrap_or(0);

        // Sort by date (newest first), then usage (highest first)
        b_date.cmp(a_date).then(b_usage.cmp(&a_usage))
    });

    // Assign positions
    for (position, (id, mut entry)) in metadata_entries.into_iter().enumerate() {
        entry.position = Some(position as u32);
        manifest.entries.insert(id, entry);
    }

    let count = manifest
        .entries
        .iter()
        .filter(|(_, entry)| {
            entry.cache_type == CacheType::Badge
                && entry.metadata.source == "badgebase"
                && entry.position.is_some()
        })
        .count();

    save_manifest(&manifest)?;
    println!(
        "[UniversalCache] Assigned positions to {} badge metadata entries",
        count
    );

    Ok(count)
}

/// Assign positions to badge metadata entries based on date and usage (public API)
pub async fn assign_badge_metadata_positions() -> Result<usize> {
    let _lock = ASYNC_MANIFEST_LOCK.lock().await;
    assign_badge_metadata_positions_impl()
}

/// Export manifest to a specific path for GitHub upload
pub fn export_manifest_for_github(output_path: PathBuf) -> Result<()> {
    let manifest = load_manifest()?;
    let json = serde_json::to_string_pretty(&manifest)?;
    fs::write(&output_path, json)?;
    println!("[UniversalCache] Exported manifest to {:?}", output_path);
    Ok(())
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

    println!(
        "[UniversalCache] Sync complete. Synced {} items",
        synced_count
    );

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

/// Cache a file from a URL
pub async fn cache_file(
    cache_type: CacheType,
    id: String,
    url: String,
    expiry_days: u32,
) -> Result<String> {
    println!(
        "[UniversalCache] Caching file: {} (type: {:?})",
        id, cache_type
    );
    let cache_dir = get_universal_cache_dir()?;
    let type_str = match cache_type {
        CacheType::Badge => "badges",
        CacheType::Emote => "emotes",
        CacheType::ThirdPartyBadge => "third-party-badges",
        CacheType::Cosmetic => "cosmetics",
    };

    let type_dir = cache_dir.join(type_str);
    if !type_dir.exists() {
        fs::create_dir_all(&type_dir).context("Failed to create cache type directory")?;
    }

    // Determine extension from URL
    let url_path = PathBuf::from(&url);
    let extension = url_path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("bin");

    // Use a prefix for the file ID in the manifest to avoid collision with metadata
    // But for the filename, we can just use the ID
    let file_name = format!("{}.{}", id, extension);
    let file_path = type_dir.join(&file_name);

    // Download file
    let client = reqwest::Client::builder()
        .user_agent("StreamNook/1.0")
        .build()?;

    let response = client.get(&url).send().await?;

    if !response.status().is_success() {
        return Err(anyhow::anyhow!(
            "Failed to download file: {}",
            response.status()
        ));
    }

    let bytes = response.bytes().await?;

    let mut file = fs::File::create(&file_path)?;
    std::io::copy(&mut Cursor::new(bytes), &mut file)?;

    let path_str = file_path.to_string_lossy().to_string();

    // Update manifest
    // We use "file:" prefix for the ID in the manifest
    let manifest_id = format!("file:{}", id);

    let entry = UniversalCacheEntry {
        id: manifest_id,
        cache_type,
        data: serde_json::json!({
            "local_path": path_str,
            "url": url,
            "file_name": file_name
        }),
        metadata: CacheMetadata {
            timestamp: get_current_timestamp(),
            expiry_days,
            source: "universal_file".to_string(),
            version: CACHE_VERSION,
        },
        position: None,
    };

    save_cached_item(entry).await?;

    println!("[UniversalCache] Successfully cached file: {}", path_str);
    Ok(path_str)
}

/// Get cached file path if exists and valid
pub async fn get_cached_file_path(cache_type: CacheType, id: &str) -> Result<Option<String>> {
    let manifest_id = format!("file:{}", id);

    // Use existing get_cached_item which handles expiry
    let entry = get_cached_item(cache_type.clone(), &manifest_id).await?;

    if let Some(entry) = entry {
        if let Some(path) = entry.data.get("local_path").and_then(|p| p.as_str()) {
            let path_buf = PathBuf::from(path);
            if path_buf.exists() {
                return Ok(Some(path.to_string()));
            }
        }
    }

    Ok(None)
}

/// Get ALL cached items of a specific type - efficient batch lookup (single disk read)
pub fn get_all_cached_items_by_type(
    cache_type: CacheType,
) -> Result<HashMap<String, UniversalCacheEntry>> {
    let manifest = load_manifest()?;
    let mut items = HashMap::new();

    for (key, entry) in manifest.entries {
        if entry.cache_type == cache_type && !is_cache_expired(&entry.metadata) {
            items.insert(key, entry);
        }
    }

    Ok(items)
}

/// Get multiple cached items by their IDs - efficient batch lookup (single disk read)
pub fn get_cached_items_batch(
    cache_type: CacheType,
    ids: &[String],
) -> Result<HashMap<String, UniversalCacheEntry>> {
    let manifest = load_manifest()?;
    let mut items = HashMap::new();

    for id in ids {
        if let Some(entry) = manifest.entries.get(id) {
            if entry.cache_type == cache_type && !is_cache_expired(&entry.metadata) {
                items.insert(id.clone(), entry.clone());
            }
        }
    }

    Ok(items)
}

/// Get all cached files for a specific type
pub async fn get_cached_files_list(cache_type: CacheType) -> Result<HashMap<String, String>> {
    // println!(
    //     "[UniversalCache] Getting cached files list for {:?}",
    //     cache_type
    // );
    let manifest = load_manifest()?;
    let mut files = HashMap::new();

    for (key, entry) in manifest.entries {
        // Check if it's a file entry (id starts with "file:") and matches type
        if entry.cache_type == cache_type && key.starts_with("file:") {
            if let Some(path) = entry.data.get("local_path").and_then(|p| p.as_str()) {
                // Strip "file:" prefix from key to get original ID
                let id = key.trim_start_matches("file:").to_string();
                files.insert(id, path.to_string());
            }
        }
    }

    // println!(
    //     "[UniversalCache] Found {} cached files for {:?}",
    //     files.len(),
    //     cache_type
    // );
    Ok(files)
}

/// Auto-sync universal cache if stale (>24 hours since last sync)
/// Returns true if sync was triggered, false if cache was fresh
pub async fn auto_sync_if_stale() -> Result<bool> {
    const STALE_THRESHOLD_SECONDS: u64 = 24 * 60 * 60; // 24 hours

    let manifest = load_manifest()?;

    let should_sync = match manifest.last_sync {
        None => {
            println!("[UniversalCache] No last_sync timestamp found, triggering auto-sync");
            true
        }
        Some(last_sync) => {
            let current_time = get_current_timestamp();
            let age_seconds = current_time.saturating_sub(last_sync);
            let is_stale = age_seconds > STALE_THRESHOLD_SECONDS;

            if is_stale {
                let age_hours = age_seconds / 3600;
                println!(
                    "[UniversalCache] Cache is stale ({}h old), triggering auto-sync",
                    age_hours
                );
            }

            is_stale
        }
    };

    if should_sync {
        // Fire-and-forget: spawn download in background so we don't block startup
        tokio::spawn(async {
            match download_universal_manifest().await {
                Ok(true) => println!("[UniversalCache] Auto-sync completed successfully"),
                Ok(false) => println!("[UniversalCache] Auto-sync skipped (already in progress)"),
                Err(e) => println!("[UniversalCache] Auto-sync failed: {}", e),
            }
        });
        Ok(true)
    } else {
        Ok(false)
    }
}
