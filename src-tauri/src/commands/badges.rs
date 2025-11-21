use serde::{Deserialize, Serialize};
use crate::services::twitch_service::TwitchService;
use crate::services::universal_cache_service::{get_cached_item, cache_item, CacheType};
use std::time::{SystemTime, UNIX_EPOCH};

// --- HELIX API STRUCTS ---

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HelixBadgeVersion {
    pub id: String,
    pub image_url_1x: String,
    pub image_url_2x: String,
    pub image_url_4x: String,
    pub title: String,
    pub description: String,
    pub click_action: Option<String>,
    pub click_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HelixBadgeSet {
    pub set_id: String,
    pub versions: Vec<HelixBadgeVersion>,
}

/// This is the top-level response from the Helix API
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HelixBadgesResponse {
    pub data: Vec<HelixBadgeSet>,
}

/// Cached badges with metadata
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CachedBadgesData {
    pub badges: HelixBadgesResponse,
    pub cached_at: u64,
}

// --- TAURI COMMANDS ---

/// Get current timestamp in seconds
fn get_current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// Fetch global Twitch badges from API (no cache)
async fn fetch_badges_from_api(
    client_id: String,
    token: String,
) -> Result<HelixBadgesResponse, String> {
    let url = "https://api.twitch.tv/helix/chat/badges/global";
    
    println!("[Badges] Fetching global badges from Twitch API...");
    
    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .header("Client-Id", client_id)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch global badges: HTTP {} - {}",
            response.status(),
            response.text().await.unwrap_or_default()
        ));
    }

    let badges = response
        .json::<HelixBadgesResponse>()
        .await
        .map_err(|e| format!("Failed to parse global badges: {}", e))?;

    println!("[Badges] Successfully fetched {} badge sets from API", badges.data.len());
    
    Ok(badges)
}

/// Fetch global Twitch badges with caching support
#[tauri::command]
pub async fn fetch_global_badges(
    client_id: String,
    token: String,
) -> Result<HelixBadgesResponse, String> {
    // Try to get from cache first
    let cache_key = "global_badges";
    
    match get_cached_item(CacheType::Badge, cache_key).await {
        Ok(Some(cached)) => {
            match serde_json::from_value::<CachedBadgesData>(cached.data) {
                Ok(cached_data) => {
                    // Check if cache is less than 7 days old
                    let cache_age_days = (get_current_timestamp() - cached_data.cached_at) / (24 * 60 * 60);
                    
                    if cache_age_days < 7 {
                        println!("[Badges] Using cached badges (age: {} days)", cache_age_days);
                        return Ok(cached_data.badges);
                    } else {
                        println!("[Badges] Cache is {} days old, refreshing...", cache_age_days);
                    }
                }
                Err(e) => {
                    println!("[Badges] Failed to parse cached badges: {}", e);
                }
            }
        }
        Ok(None) => {
            println!("[Badges] No cached badges found");
        }
        Err(e) => {
            println!("[Badges] Error checking cache: {}", e);
        }
    }
    
    // Fetch from API
    let badges = fetch_badges_from_api(client_id, token).await?;
    
    // Cache the result for 7 days
    let cached_data = CachedBadgesData {
        badges: badges.clone(),
        cached_at: get_current_timestamp(),
    };
    
    if let Ok(json_value) = serde_json::to_value(&cached_data) {
        let _ = cache_item(
            CacheType::Badge,
            cache_key.to_string(),
            json_value,
            "twitch".to_string(),
            7, // Cache for 7 days
        ).await;
        println!("[Badges] Cached global badges for 7 days");
    }
    
    Ok(badges)
}

/// Get cached global badges without fetching from API
#[tauri::command]
pub async fn get_cached_global_badges() -> Result<Option<HelixBadgesResponse>, String> {
    let cache_key = "global_badges";
    
    match get_cached_item(CacheType::Badge, cache_key).await {
        Ok(Some(cached)) => {
            match serde_json::from_value::<CachedBadgesData>(cached.data) {
                Ok(cached_data) => {
                    println!("[Badges] Retrieved {} badge sets from cache", cached_data.badges.data.len());
                    Ok(Some(cached_data.badges))
                }
                Err(e) => {
                    println!("[Badges] Failed to parse cached badges: {}", e);
                    Ok(None)
                }
            }
        }
        Ok(None) => {
            println!("[Badges] No cached badges found");
            Ok(None)
        }
        Err(e) => {
            println!("[Badges] Error checking cache: {}", e);
            Err(format!("Cache error: {}", e))
        }
    }
}

/// Pre-fetch and cache global badges in the background
#[tauri::command]
pub async fn prefetch_global_badges() -> Result<(), String> {
    println!("[Badges] Starting background badge pre-fetch...");
    
    let client_id = "1qgws7yzcp21g5ledlzffw3lmqdvie".to_string();
    
    match TwitchService::get_token().await {
        Ok(token) => {
            match fetch_global_badges(client_id, token).await {
                Ok(badges) => {
                    println!("[Badges] Pre-fetch complete: {} badge sets cached", badges.data.len());
                    Ok(())
                }
                Err(e) => {
                    println!("[Badges] Pre-fetch failed: {}", e);
                    Err(e)
                }
            }
        }
        Err(e) => {
            println!("[Badges] Failed to get token for pre-fetch: {}", e);
            Err(format!("Failed to get token: {}", e))
        }
    }
}

/// Get Twitch credentials for badge fetching
#[tauri::command]
pub async fn get_twitch_credentials() -> Result<(String, String), String> {
    let client_id = "1qgws7yzcp21g5ledlzffw3lmqdvie".to_string();
    let token = TwitchService::get_token()
        .await
        .map_err(|e| format!("Failed to get token: {}", e))?;
    
    Ok((client_id, token))
}

/// Fetch channel-specific Twitch badges using the Helix API
#[tauri::command]
pub async fn fetch_channel_badges(
    channel_id: String,
    client_id: String,
    token: String,
) -> Result<HelixBadgesResponse, String> {
    let url = format!(
        "https://api.twitch.tv/helix/chat/badges?broadcaster_id={}",
        channel_id
    );

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Client-Id", client_id)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch channel badges: HTTP {} - {}",
            response.status(),
            response.text().await.unwrap_or_default()
        ));
    }

    let badges = response
        .json::<HelixBadgesResponse>()
        .await
        .map_err(|e| format!("Failed to parse channel badges: {}", e))?;

    Ok(badges)
}

/// Get user's badges for a specific channel
/// Returns a badge string in the format "badge1/version1,badge2/version2"
/// Note: This uses the /users endpoint to get broadcaster_type and constructs badges from that
#[tauri::command]
pub async fn get_user_badges(
    user_id: String,
    channel_id: Option<String>,
) -> Result<String, String> {
    let client_id = "1qgws7yzcp21g5ledlzffw3lmqdvie".to_string();
    let token = TwitchService::get_token()
        .await
        .map_err(|e| format!("Failed to get token: {}", e))?;
    
    let client = reqwest::Client::new();
    
    // Get user information to check broadcaster_type
    let user_url = format!("https://api.twitch.tv/helix/users?id={}", user_id);
    let user_response = client
        .get(&user_url)
        .header("Client-Id", &client_id)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    if !user_response.status().is_success() {
        return Err(format!(
            "Failed to fetch user info: HTTP {} - {}",
            user_response.status(),
            user_response.text().await.unwrap_or_default()
        ));
    }

    #[derive(Debug, Deserialize)]
    struct UserData {
        broadcaster_type: String,
    }
    
    #[derive(Debug, Deserialize)]
    struct UsersResponse {
        data: Vec<UserData>,
    }
    
    let users_response = user_response
        .json::<UsersResponse>()
        .await
        .map_err(|e| format!("Failed to parse user info: {}", e))?;
    
    let mut badges = Vec::new();
    
    // Add broadcaster badges based on broadcaster_type
    if let Some(user_data) = users_response.data.first() {
        match user_data.broadcaster_type.as_str() {
            "partner" => badges.push("partner/1".to_string()),
            "affiliate" => badges.push("affiliate/1".to_string()),
            _ => {}
        }
    }
    
    // If channel_id is provided, check for subscriber status
    if let Some(broadcaster_id) = channel_id {
        // Check if user is subscribed to the channel
        let sub_url = format!(
            "https://api.twitch.tv/helix/subscriptions/user?broadcaster_id={}&user_id={}",
            broadcaster_id, user_id
        );
        
        let sub_response = client
            .get(&sub_url)
            .header("Client-Id", &client_id)
            .header("Authorization", format!("Bearer {}", &token))
            .send()
            .await;
        
        if let Ok(response) = sub_response {
            if response.status().is_success() {
                #[derive(Debug, Deserialize)]
                struct SubData {
                    tier: String,
                }
                
                #[derive(Debug, Deserialize)]
                struct SubResponse {
                    data: Vec<SubData>,
                }
                
                if let Ok(sub_data) = response.json::<SubResponse>().await {
                    if let Some(sub) = sub_data.data.first() {
                        // Map tier to subscriber badge version
                        let badge_version = match sub.tier.as_str() {
                            "1000" => "0",  // Tier 1
                            "2000" => "2000", // Tier 2
                            "3000" => "3000", // Tier 3
                            _ => "0",
                        };
                        badges.push(format!("subscriber/{}", badge_version));
                    }
                }
            }
        }
    }
    
    Ok(badges.join(","))
}
