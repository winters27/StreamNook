use anyhow::Result;
use reqwest::header::{AUTHORIZATION, ACCEPT, HeaderMap, HeaderValue};
use reqwest::Client;
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::RwLock;
use std::collections::HashMap;
use chrono::{DateTime, Utc};
use crate::models::drops::*;
use crate::services::drops_auth_service::DropsAuthService;
use tokio::time::Duration;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

// Use Twitch ANDROID APP client ID for GQL operations (required for drops API access)
// This is what TwitchDropsMiner uses - it works with NO SCOPES
const CLIENT_ID: &str = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";
const CLIENT_URL: &str = "https://www.twitch.tv";

// Your app's client ID (for reference - used for other Helix API calls)
const APP_CLIENT_ID: &str = "1qgws7yzcp21g5ledlzffw3lmqdvie";

#[derive(Debug, Deserialize)]
struct GraphQLResponse<T> {
    data: Option<T>,
    errors: Option<Vec<GraphQLError>>,
}

#[derive(Debug, Deserialize)]
struct GraphQLError {
    message: String,
}

#[derive(Debug, Deserialize)]
struct DropCampaignsData {
    #[serde(rename = "currentUser")]
    current_user: Option<CurrentUserDrops>,
}

#[derive(Debug, Deserialize)]
struct CurrentUserDrops {
    #[serde(rename = "dropCampaigns")]
    drop_campaigns: Vec<GraphQLDropCampaign>,
}

#[derive(Debug, Deserialize)]
struct GraphQLDropCampaign {
    id: String,
    name: String,
    game: GameInfo,
    description: String,
    #[serde(rename = "imageURL")]
    image_url: String,
    #[serde(rename = "startAt")]
    start_at: String,
    #[serde(rename = "endAt")]
    end_at: String,
    #[serde(rename = "timeBasedDrops")]
    time_based_drops: Vec<GraphQLTimeBasedDrop>,
}

#[derive(Debug, Deserialize)]
struct GameInfo {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct GraphQLTimeBasedDrop {
    id: String,
    name: String,
    #[serde(rename = "requiredMinutesWatched")]
    required_minutes_watched: i32,
    #[serde(rename = "benefitEdges")]
    benefit_edges: Vec<BenefitEdge>,
    #[serde(rename = "self")]
    self_progress: Option<DropSelfProgress>,
}

#[derive(Debug, Deserialize)]
struct BenefitEdge {
    benefit: Benefit,
}

#[derive(Debug, Deserialize)]
struct Benefit {
    id: String,
    name: String,
    #[serde(rename = "imageAssetURL")]
    image_asset_url: String,
}

#[derive(Debug, Deserialize)]
struct DropSelfProgress {
    #[serde(rename = "currentMinutesWatched")]
    current_minutes_watched: i32,
    #[serde(rename = "isClaimed")]
    is_claimed: bool,
}

#[derive(Debug, Deserialize)]
struct ChannelPointsData {
    community: CommunityPoints,
}

#[derive(Debug, Deserialize)]
struct CommunityPoints {
    channel: ChannelPoints,
}

#[derive(Debug, Deserialize)]
struct ChannelPoints {
    #[serde(rename = "self")]
    self_points: SelfPoints,
}

#[derive(Debug, Deserialize)]
struct SelfPoints {
    #[serde(rename = "communityPoints")]
    community_points: CommunityPointsBalance,
    #[serde(rename = "availableClaim")]
    available_claim: Option<AvailableClaim>,
}

#[derive(Debug, Deserialize)]
struct CommunityPointsBalance {
    balance: i32,
}

#[derive(Debug, Deserialize)]
struct AvailableClaim {
    id: String,
    #[serde(rename = "pointsEarned")]
    points_earned: i32,
}

pub struct DropsService {
    client: Client,
    settings: Arc<RwLock<DropsSettings>>,
    drop_progress: Arc<RwLock<HashMap<String, DropProgress>>>,
    claimed_drops: Arc<RwLock<Vec<ClaimedDrop>>>,
    channel_points_history: Arc<RwLock<Vec<ChannelPointsClaim>>>,
    channel_points_balances: Arc<RwLock<HashMap<String, ChannelPointsBalance>>>,
    monitoring_active: Arc<RwLock<bool>>,
    current_channel: Arc<RwLock<Option<(String, String)>>>, // (channel_id, channel_name)
    cached_active_campaigns_count: Arc<RwLock<i32>>, // Cache campaign count to avoid repeated API calls
    cached_campaigns: Arc<RwLock<Option<(Vec<DropCampaign>, DateTime<Utc>)>>>, // Cache campaigns with timestamp
    device_id: String,
    session_id: String,
}

impl DropsService {
    pub fn new() -> Self {
        // Generate persistent device ID and session ID (like TwitchDropsMiner does)
        let device_id = Uuid::new_v4().to_string().replace("-", "");
        let session_id = Uuid::new_v4().to_string().replace("-", "");
        
        Self {
            client: Client::new(),
            settings: Arc::new(RwLock::new(DropsSettings::default())),
            drop_progress: Arc::new(RwLock::new(HashMap::new())),
            claimed_drops: Arc::new(RwLock::new(Vec::new())),
            channel_points_history: Arc::new(RwLock::new(Vec::new())),
            channel_points_balances: Arc::new(RwLock::new(HashMap::new())),
            monitoring_active: Arc::new(RwLock::new(false)),
            current_channel: Arc::new(RwLock::new(None)),
            cached_active_campaigns_count: Arc::new(RwLock::new(0)),
            cached_campaigns: Arc::new(RwLock::new(None)),
            device_id,
            session_id,
        }
    }
    
    /// Create headers for GQL requests (mimicking TwitchDropsMiner's auth_state.headers())
    fn create_gql_headers(&self, token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("Client-ID", HeaderValue::from_static(CLIENT_ID));
        headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
        headers.insert("Accept-Language", HeaderValue::from_static("en-US"));
        headers.insert("Accept-Encoding", HeaderValue::from_static("gzip"));
        headers.insert(AUTHORIZATION, HeaderValue::from_str(&format!("OAuth {}", token)).unwrap());
        headers.insert("Origin", HeaderValue::from_static(CLIENT_URL));
        headers.insert("Referer", HeaderValue::from_static(CLIENT_URL));
        headers.insert("X-Device-Id", HeaderValue::from_str(&self.device_id).unwrap());
        headers.insert("Client-Session-Id", HeaderValue::from_str(&self.session_id).unwrap());
        headers
    }

    pub async fn get_settings(&self) -> DropsSettings {
        self.settings.read().await.clone()
    }

    pub async fn update_settings(&self, new_settings: DropsSettings) {
        let mut settings = self.settings.write().await;
        *settings = new_settings;
    }

    /// Fetch inventory (in-progress campaigns) using the Inventory GQL operation
    /// This matches TwitchDropsMiner's fetch_inventory() function
    pub async fn fetch_inventory(&self) -> Result<InventoryResponse> {
        println!("🔍 [fetch_inventory] Fetching inventory (in-progress campaigns)...");
        
        let token = match DropsAuthService::get_token().await {
            Ok(t) => {
                println!("✅ [fetch_inventory] Got token");
                t
            }
            Err(e) => {
                println!("❌ [fetch_inventory] Failed to get token: {}", e);
                return Err(e);
            }
        };
        
        // Use the exact same GQL operation as TwitchDropsMiner
        let response = self.client
            .post("https://gql.twitch.tv/gql")
            .headers(self.create_gql_headers(&token))
            .json(&serde_json::json!({
                "operationName": "Inventory",
                "variables": {
                    "fetchRewardCampaigns": false
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "d86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b"
                    }
                }
            }))
            .send()
            .await?;

        println!("📡 [fetch_inventory] Response status: {}", response.status());
        
        let response_text = response.text().await?;
        let response_json: serde_json::Value = match serde_json::from_str(&response_text) {
            Ok(json) => json,
            Err(e) => {
                println!("❌ Failed to parse JSON: {}", e);
                return Err(anyhow::anyhow!("Failed to parse response as JSON: {}", e));
            }
        };
        
        // Check for errors
        if let Some(errors) = response_json.get("errors") {
            println!("❌ GraphQL errors found: {:?}", errors);
            return Err(anyhow::anyhow!("GraphQL errors: {:?}", errors));
        }

        if response_json["data"].is_null() || response_json["data"]["currentUser"].is_null() {
            return Err(anyhow::anyhow!("Unable to fetch inventory data"));
        }

        // Parse in-progress campaigns
        let inventory = &response_json["data"]["currentUser"]["inventory"];
        let campaigns_array = inventory["dropCampaignsInProgress"]
            .as_array()
            .map(|v| v.to_vec())
            .unwrap_or_else(Vec::new);
        
        // Parse gameEventDrops for claimed benefits tracking
        let empty_game_events = Vec::new();
        let game_event_drops = inventory["gameEventDrops"]
            .as_array()
            .unwrap_or(&empty_game_events);
        
        let mut claimed_benefits: std::collections::HashMap<String, DateTime<Utc>> = std::collections::HashMap::new();
        for event in game_event_drops {
            if let (Some(id), Some(last_awarded)) = (
                event["id"].as_str(),
                event["lastAwardedAt"].as_str()
            ) {
                if let Ok(dt) = DateTime::parse_from_rfc3339(last_awarded) {
                    claimed_benefits.insert(id.to_string(), dt.with_timezone(&Utc));
                }
            }
        }

        println!("📊 Found {} in-progress campaigns", campaigns_array.len());

        let mut items = Vec::new();
        let mut active_count = 0;
        let mut upcoming_count = 0;
        let mut expired_count = 0;
        let now = Utc::now();

        for campaign_json in &campaigns_array {
            // Parse game info
            let game = &campaign_json["game"];
            if game.is_null() {
                continue;
            }
            
            let game_id = game["id"].as_str().unwrap_or("").to_string();
            let game_name = game["displayName"].as_str()
                .or_else(|| game["name"].as_str())
                .unwrap_or("")
                .to_string();
            let image_url = game["boxArtURL"].as_str().unwrap_or("").to_string();

            if game_name.is_empty() {
                continue;
            }

            // Parse dates
            let start_at = campaign_json["startAt"].as_str()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|| Utc::now());
                
            let end_at = campaign_json["endAt"].as_str()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|| Utc::now() + chrono::Duration::days(365));

            // Determine status
            let status = if start_at > now {
                upcoming_count += 1;
                CampaignStatus::Upcoming
            } else if end_at < now {
                expired_count += 1;
                CampaignStatus::Expired
            } else {
                active_count += 1;
                CampaignStatus::Active
            };

            // Parse allowed channels
            let mut allowed_channels = Vec::new();
            let mut is_acl_based = false;
            
            if let Some(allow) = campaign_json["allow"].as_object() {
                if allow.get("isEnabled").and_then(|v| v.as_bool()).unwrap_or(false) {
                    if let Some(channels) = allow["channels"].as_array() {
                        is_acl_based = !channels.is_empty();
                        for channel in channels {
                            if let (Some(id), Some(name)) = (
                                channel["id"].as_str(),
                                channel["name"].as_str()
                            ) {
                                allowed_channels.push(AllowedChannel {
                                    id: id.to_string(),
                                    name: name.to_string(),
                                });
                            }
                        }
                    }
                }
            }

            // Parse time-based drops
            let mut time_based_drops: Vec<TimeBasedDrop> = Vec::new();
            let mut total_drops = 0;
            let mut claimed_drops = 0;
            let mut drops_in_progress = 0;
            let mut total_progress: f32 = 0.0;

            if let Some(drops) = campaign_json["timeBasedDrops"].as_array() {
                total_drops = drops.len() as i32;
                
                for drop_json in drops {
                    let drop_id = drop_json["id"].as_str().unwrap_or("").to_string();
                    let drop_name = drop_json["name"].as_str().unwrap_or("").to_string();
                    let required_minutes = drop_json["requiredMinutesWatched"].as_i64().unwrap_or(0) as i32;
                    
                    // Parse benefits
                    let mut benefit_edges = Vec::new();
                    if let Some(edges) = drop_json["benefitEdges"].as_array() {
                        for edge in edges {
                            if let Some(benefit) = edge.get("benefit") {
                                benefit_edges.push(DropBenefit {
                                    id: benefit["id"].as_str().unwrap_or("").to_string(),
                                    name: benefit["name"].as_str().unwrap_or("").to_string(),
                                    image_url: benefit["imageAssetURL"].as_str().unwrap_or("").to_string(),
                                });
                            }
                        }
                    }

                    // Parse progress
                    let mut progress = None;
                    let mut is_claimed = false;
                    let mut current_minutes = 0;

                    if let Some(self_data) = drop_json.get("self") {
                        current_minutes = self_data["currentMinutesWatched"].as_i64().unwrap_or(0) as i32;
                        is_claimed = self_data["isClaimed"].as_bool().unwrap_or(false);
                        
                        let drop_instance_id = self_data["dropInstanceID"].as_str().map(|s| s.to_string());

                        progress = Some(DropProgress {
                            campaign_id: campaign_json["id"].as_str().unwrap_or("").to_string(),
                            drop_id: drop_id.clone(),
                            current_minutes_watched: current_minutes,
                            required_minutes_watched: required_minutes,
                            is_claimed,
                            last_updated: Utc::now(),
                        });
                    } else {
                        // Check claimed_benefits to determine if claimed
                        for benefit in &benefit_edges {
                            if let Some(awarded_at) = claimed_benefits.get(&benefit.id) {
                                if start_at <= *awarded_at && *awarded_at < end_at {
                                    is_claimed = true;
                                    break;
                                }
                            }
                        }
                    }

                    if is_claimed {
                        claimed_drops += 1;
                        total_progress += 1.0;
                    } else if current_minutes > 0 {
                        drops_in_progress += 1;
                        if required_minutes > 0 {
                            total_progress += (current_minutes as f32 / required_minutes as f32).min(1.0);
                        }
                    }

                    time_based_drops.push(TimeBasedDrop {
                        id: drop_id,
                        name: drop_name,
                        required_minutes_watched: required_minutes,
                        benefit_edges,
                        progress,
                    });
                }
            }

            let progress_percentage = if total_drops > 0 {
                (total_progress / total_drops as f32) * 100.0
            } else {
                0.0
            };

            let is_account_connected = campaign_json["self"]["isAccountConnected"]
                .as_bool()
                .unwrap_or(true);

            let campaign = DropCampaign {
                id: campaign_json["id"].as_str().unwrap_or("").to_string(),
                name: campaign_json["name"].as_str().unwrap_or("").to_string(),
                game_id,
                game_name,
                description: campaign_json["description"].as_str().unwrap_or("").to_string(),
                image_url,
                start_at,
                end_at,
                time_based_drops,
                is_account_connected,
                allowed_channels,
                is_acl_based,
            };

            items.push(InventoryItem {
                campaign,
                status,
                progress_percentage,
                total_drops,
                claimed_drops,
                drops_in_progress,
            });
        }

        let total_campaigns = items.len() as i32;

        println!("📊 Inventory summary: {} total, {} active, {} upcoming, {} expired",
            total_campaigns, active_count, upcoming_count, expired_count);

        Ok(InventoryResponse {
            items,
            total_campaigns,
            active_campaigns: active_count,
            upcoming_campaigns: upcoming_count,
            expired_campaigns: expired_count,
        })
    }

    /// Get all active campaigns with smart caching (for UI display)
    /// Uses cached campaigns if available and not stale (5 minute TTL)
    /// Only fetches from API if cache is empty or expired
    pub async fn get_all_active_campaigns_cached(&self) -> Result<Vec<DropCampaign>> {
        const CACHE_TTL_SECONDS: i64 = 300; // 5 minutes
        
        // Check if we have valid cached data
        {
            let cache = self.cached_campaigns.read().await;
            if let Some((campaigns, cached_at)) = cache.as_ref() {
                let age = Utc::now().signed_duration_since(*cached_at);
                if age.num_seconds() < CACHE_TTL_SECONDS {
                    println!("📦 Using cached campaigns ({} seconds old)", age.num_seconds());
                    return Ok(campaigns.clone());
                } else {
                    println!("⏰ Campaign cache expired ({} seconds old)", age.num_seconds());
                }
            }
        }
        
        // Cache miss or expired - fetch from API
        println!("🔄 Fetching fresh campaigns from API");
        let campaigns = self.fetch_all_active_campaigns_from_api().await?;
        
        // Update cache
        {
            let mut cache = self.cached_campaigns.write().await;
            *cache = Some((campaigns.clone(), Utc::now()));
        }
        
        Ok(campaigns)
    }
    
    /// Internal method to fetch campaigns from API (no caching)
    /// This should only be called by get_all_active_campaigns_cached or during mining operations
    pub(crate) async fn fetch_all_active_campaigns_from_api(&self) -> Result<Vec<DropCampaign>> {
        println!("🔍 [fetch_all_active_campaigns_from_api] Starting (no filters)...");
        
        let token = match DropsAuthService::get_token().await {
            Ok(t) => {
                println!("✅ [get_all_active_campaigns] Got token (first 10 chars): {}", &t[..10.min(t.len())]);
                t
            }
            Err(e) => {
                println!("❌ [get_all_active_campaigns] Failed to get token: {}", e);
                return Err(e);
            }
        };
        
        println!("🔍 Fetching drops campaigns using Android app client ID...");
        
        // Use GQL exactly like TwitchDropsMiner does
        let response = self.client
            .post("https://gql.twitch.tv/gql")
            .headers(self.create_gql_headers(&token))
            .json(&serde_json::json!({
                "operationName": "ViewerDropsDashboard",
                "variables": {
                    "fetchRewardCampaigns": false
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "5a4da2ab3d5b47c9f9ce864e727b2cb346af1e3ea8b897fe8f704a97ff017619"
                    }
                }
            }))
            .send()
            .await?;

        println!("📡 Response status: {}", response.status());
        
        // Get the raw response text first
        let response_text = response.text().await?;
        
        // Try to parse it as JSON
        let response_json: serde_json::Value = match serde_json::from_str(&response_text) {
            Ok(json) => json,
            Err(e) => {
                println!("❌ Failed to parse JSON: {}", e);
                return Err(anyhow::anyhow!("Failed to parse response as JSON: {}", e));
            }
        };
        
        // Check for authorization errors
        if let Some(error_msg) = response_json.get("error").and_then(|e| e.as_str()) {
            if error_msg == "Unauthorized" {
                return Err(anyhow::anyhow!(
                    "Drops API requires authentication with Twitch web client."
                ));
            }
        }
        
        if let Some(errors) = response_json.get("errors") {
            println!("❌ GraphQL errors found: {:?}", errors);
            return Err(anyhow::anyhow!("GraphQL errors: {:?}", errors));
        }

        // Check if data and currentUser exist
        if response_json["data"].is_null() {
            println!("⚠️ Response data is null");
            return Err(anyhow::anyhow!(
                "Unable to fetch drops data. This is likely due to client ID mismatch."
            ));
        }
        
        if response_json["data"]["currentUser"].is_null() {
            println!("⚠️ currentUser is null - token/client ID mismatch");
            return Err(anyhow::anyhow!(
                "Authentication mismatch: Token was issued for app client ID but drops API requires web client ID"
            ));
        }

        let mut result = Vec::new();
        
        // The response structure is different for the persisted query
        let campaigns_array = response_json["data"]["currentUser"]["dropCampaigns"]
            .as_array()
            .unwrap_or(&Vec::new())
            .to_vec();
        
        println!("📊 Raw campaigns response: {} campaigns found", campaigns_array.len());
        
        if !campaigns_array.is_empty() {
            for campaign_json in &campaigns_array {
                // Check campaign status - accept ACTIVE and UPCOMING campaigns
                let status = campaign_json["status"].as_str().unwrap_or("");
                
                // Skip only EXPIRED campaigns
                if status == "EXPIRED" {
                    continue;
                }

                // Parse game info - handle null game gracefully
                let game = &campaign_json["game"];
                if game.is_null() {
                    continue;
                }
                
                let game_id = game["id"].as_str().unwrap_or("").to_string();
                let game_name = game["displayName"].as_str()
                    .or_else(|| game["name"].as_str())
                    .unwrap_or("")
                    .to_string();
                
                let image_url = game["boxArtURL"].as_str().unwrap_or("").to_string();

                if game_name.is_empty() {
                    continue;
                }

                // Parse allowed channels (ACL)
                let mut allowed_channels = Vec::new();
                let mut is_acl_based = false;
                
                if let Some(allow) = campaign_json["allow"].as_object() {
                    if allow.get("isEnabled").and_then(|v| v.as_bool()).unwrap_or(false) {
                        if let Some(channels) = allow["channels"].as_array() {
                            is_acl_based = !channels.is_empty();
                            for channel in channels {
                                if let (Some(id), Some(name)) = (
                                    channel["id"].as_str(),
                                    channel["name"].as_str()
                                ) {
                                    allowed_channels.push(AllowedChannel {
                                        id: id.to_string(),
                                        name: name.to_string(),
                                    });
                                }
                            }
                        }
                    }
                }

                // Parse time-based drops
                let mut time_based_drops: Vec<TimeBasedDrop> = Vec::new();
                if let Some(drops) = campaign_json["timeBasedDrops"].as_array() {
                    for drop_json in drops {
                        if let Ok(mut drop) = serde_json::from_value::<TimeBasedDrop>(drop_json.clone()) {
                            if let Some(progress_json) = drop_json.get("self") {
                                if let Ok(progress) = serde_json::from_value::<DropProgress>(progress_json.clone()) {
                                    drop.progress = Some(progress);
                                }
                            }
                            time_based_drops.push(drop);
                        }
                    }
                }

                // Parse dates
                let start_at = campaign_json["startAt"].as_str()
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|| Utc::now());
                    
                let end_at = campaign_json["endAt"].as_str()
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|| Utc::now() + chrono::Duration::days(365));

                // Check if campaign is active (not upcoming or expired)
                let now = Utc::now();
                if start_at > now || end_at < now {
                    continue;
                }

                // Look for detailsURL or any URL field that might be the "about this drop" link
                let details_url = campaign_json["detailsURL"].as_str()
                    .or_else(|| campaign_json["aboutDropsURL"].as_str())
                    .or_else(|| campaign_json["aboutURL"].as_str())
                    .or_else(|| campaign_json["url"].as_str())
                    .map(|s| s.to_string());

                result.push(DropCampaign {
                    id: campaign_json["id"].as_str().unwrap_or("").to_string(),
                    name: campaign_json["name"].as_str().unwrap_or("").to_string(),
                    game_id,
                    game_name,
                    description: campaign_json["description"].as_str().unwrap_or("").to_string(),
                    image_url,
                    start_at,
                    end_at,
                    time_based_drops,
                    is_account_connected: true,
                    allowed_channels,
                    is_acl_based,
                    details_url,
                });
            }
        }

        println!("📊 Returning {} total campaigns (unfiltered)", result.len());
        Ok(result)
    }

    /// Updates the service's internal state with fresh campaign data and calculates progress.
    pub async fn update_campaigns_and_progress(&self, campaigns: &[DropCampaign]) {
        let mut progress_map = self.drop_progress.write().await;
        progress_map.clear(); // Clear old progress before updating

        for campaign in campaigns {
            for drop in &campaign.time_based_drops {
                if let Some(mut progress) = drop.progress.clone() {
                    progress.campaign_id = campaign.id.clone();
                    progress.drop_id = drop.id.clone();
                    progress_map.insert(drop.id.clone(), progress);
                }
            }
        }
        
        // Update cached campaign count
        let mut cached_count = self.cached_active_campaigns_count.write().await;
        *cached_count = campaigns.len() as i32;
        
        // Update campaigns cache when mining fetches them
        let mut cache = self.cached_campaigns.write().await;
        *cache = Some((campaigns.to_vec(), Utc::now()));
    }
    
    /// Get active campaigns with settings filters applied (for mining)
    pub async fn get_active_campaigns(&self) -> Result<Vec<DropCampaign>> {
        // First get all campaigns from the API
        let all_campaigns = self.fetch_all_active_campaigns_from_api().await?;

        // Update internal progress map (this is a simplified version of the original logic)
        self.update_campaigns_and_progress(&all_campaigns).await;
        
        // Apply settings filters
        let settings = self.settings.read().await;
        let mut filtered_result = Vec::new();
        
        println!("📊 Applying filters to {} campaigns", all_campaigns.len());
        
        for campaign in all_campaigns {
            // Skip excluded games
            if settings.excluded_games.contains(&campaign.game_name) {
                println!("  ⛔ Filtered out: {} (excluded)", campaign.game_name);
                continue;
            }
            
            // Apply priority mode filter
            if settings.priority_mode == PriorityMode::PriorityOnly 
                && !settings.priority_games.is_empty()
                && !settings.priority_games.contains(&campaign.game_name) {
                println!("  ⛔ Filtered out: {} (not in priority list)", campaign.game_name);
                continue;
            }
            
            println!("  ✅ Included: {} ({})", campaign.name, campaign.game_name);
            filtered_result.push(campaign);
        }
        
        println!("📊 Returning {} filtered campaigns", filtered_result.len());
        Ok(filtered_result)
    }


    pub async fn claim_drop(&self, drop_id: &str) -> Result<()> {
        let token = DropsAuthService::get_token().await?;

        let mutation = r#"
        mutation ClaimDrop($input: ClaimDropRewardsInput!) {
            claimDropRewards(input: $input) {
                status
            }
        }
        "#;

        let response = self.client
            .post("https://gql.twitch.tv/gql")
            .headers(self.create_gql_headers(&token))
            .json(&serde_json::json!({
                "query": mutation,
                "variables": {
                    "input": {
                        "dropInstanceID": drop_id
                    }
                }
            }))
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!("Failed to claim drop: {}", error_text));
        }

        // Update progress to mark as claimed
        let mut progress_map = self.drop_progress.write().await;
        if let Some(progress) = progress_map.get_mut(drop_id) {
            progress.is_claimed = true;
            progress.last_updated = Utc::now();
        }

        Ok(())
    }

    pub async fn check_channel_points(&self, channel_id: &str, channel_name: &str) -> Result<Option<ChannelPointsClaim>> {
        let token = DropsAuthService::get_token().await?;

        let query = r#"
        query ChannelPointsContext($channelLogin: String!) {
            community(id: $channelLogin) {
                channel {
                    self {
                        communityPoints {
                            balance
                        }
                        availableClaim {
                            id
                            pointsEarned
                        }
                    }
                }
            }
        }
        "#;

        let response = self.client
            .post("https://gql.twitch.tv/gql")
            .headers(self.create_gql_headers(&token))
            .json(&serde_json::json!({
                "query": query,
                "variables": {
                    "channelLogin": channel_name
                }
            }))
            .send()
            .await?;

        let gql_response: GraphQLResponse<ChannelPointsData> = response.json().await?;

        if let Some(errors) = gql_response.errors {
            return Err(anyhow::anyhow!("GraphQL errors: {:?}", errors));
        }

        if let Some(data) = gql_response.data {
            let self_points = &data.community.channel.self_points;
            
            // Update balance
            let balance = ChannelPointsBalance {
                channel_id: channel_id.to_string(),
                channel_name: channel_name.to_string(),
                balance: self_points.community_points.balance,
                last_updated: Utc::now(),
            };
            
            let mut balances = self.channel_points_balances.write().await;
            balances.insert(channel_id.to_string(), balance);

            // Check if there's a claim available
            if let Some(claim) = &self_points.available_claim {
                return Ok(Some(ChannelPointsClaim {
                    id: claim.id.clone(),
                    channel_id: channel_id.to_string(),
                    channel_name: channel_name.to_string(),
                    points_earned: claim.points_earned,
                    claimed_at: Utc::now(),
                    claim_type: ChannelPointsClaimType::Watch,
                }));
            }
        }

        Ok(None)
    }

    pub async fn claim_channel_points(&self, channel_id: &str, _channel_name: &str, claim_id: &str) -> Result<i32> {
        let token = DropsAuthService::get_token().await?;

        let mutation = r#"
        mutation ClaimCommunityPoints($input: ClaimCommunityPointsInput!) {
            claimCommunityPoints(input: $input) {
                currentPoints
                error {
                    code
                }
            }
        }
        "#;

        let response = self.client
            .post("https://gql.twitch.tv/gql")
            .headers(self.create_gql_headers(&token))
            .json(&serde_json::json!({
                "query": mutation,
                "variables": {
                    "input": {
                        "channelID": channel_id,
                        "claimID": claim_id
                    }
                }
            }))
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!("Failed to claim channel points: {}", error_text));
        }

        // Parse response to get points earned
        let result: serde_json::Value = response.json().await?;
        let current_points = result["data"]["claimCommunityPoints"]["currentPoints"]
            .as_i64()
            .unwrap_or(0) as i32;

        Ok(current_points)
    }

    pub async fn get_drop_progress(&self) -> Vec<DropProgress> {
        self.drop_progress.read().await.values().cloned().collect()
    }

    pub async fn get_claimed_drops(&self) -> Vec<ClaimedDrop> {
        self.claimed_drops.read().await.clone()
    }

    pub async fn get_channel_points_history(&self) -> Vec<ChannelPointsClaim> {
        self.channel_points_history.read().await.clone()
    }

    pub async fn get_statistics(&self) -> DropsStatistics {
        let claimed_drops = self.claimed_drops.read().await;
        let channel_points_history = self.channel_points_history.read().await;
        let drop_progress = self.drop_progress.read().await;

        let total_channel_points_earned: i32 = channel_points_history
            .iter()
            .map(|c| c.points_earned)
            .sum();

        let drops_in_progress = drop_progress
            .values()
            .filter(|p| !p.is_claimed && p.current_minutes_watched > 0)
            .count() as i32;

        // Use cached campaign count instead of fetching
        let active_campaigns = *self.cached_active_campaigns_count.read().await;

        DropsStatistics {
            total_drops_claimed: claimed_drops.len() as i32,
            total_channel_points_earned,
            active_campaigns,
            drops_in_progress,
            recent_claims: claimed_drops.iter().rev().take(10).cloned().collect(),
            channel_points_history: channel_points_history.iter().rev().take(20).cloned().collect(),
        }
    }

    pub async fn add_claimed_drop(&self, claimed_drop: ClaimedDrop) {
        let mut claimed_drops = self.claimed_drops.write().await;
        claimed_drops.push(claimed_drop);
    }

    pub async fn add_channel_points_claim(&self, claim: ChannelPointsClaim) {
        let mut history = self.channel_points_history.write().await;
        history.push(claim);
    }

    pub async fn get_channel_points_balance(&self, channel_id: &str) -> Option<ChannelPointsBalance> {
        let balances = self.channel_points_balances.read().await;
        balances.get(channel_id).cloned()
    }

    pub async fn get_all_channel_points_balances(&self) -> Vec<ChannelPointsBalance> {
        let balances = self.channel_points_balances.read().await;
        balances.values().cloned().collect()
    }

    pub async fn start_monitoring(&self, channel_id: String, channel_name: String, app_handle: AppHandle) {
        // Set current channel
        {
            let mut current = self.current_channel.write().await;
            *current = Some((channel_id.clone(), channel_name.clone()));
        }

        // Check if already monitoring
        {
            let mut monitoring = self.monitoring_active.write().await;
            if *monitoring {
                return; // Already monitoring
            }
            *monitoring = true;
        }

        // Clone Arc references for the background task
        let settings = self.settings.clone();
        let drop_progress = self.drop_progress.clone();
        let claimed_drops = self.claimed_drops.clone();
        let channel_points_history = self.channel_points_history.clone();
        let channel_points_balances = self.channel_points_balances.clone();
        let monitoring_active = self.monitoring_active.clone();
        let current_channel = self.current_channel.clone();
        let client = self.client.clone();

        // Spawn background monitoring task
        tokio::spawn(async move {
            println!("🎮 Started drops and channel points monitoring for {}", channel_name);
            
            loop {
                // Check if monitoring should continue
                let should_continue = *monitoring_active.read().await;
                if !should_continue {
                    println!("🛑 Stopping drops monitoring");
                    break;
                }

                // Get current settings
                let current_settings = settings.read().await.clone();
                let check_interval = Duration::from_secs(current_settings.check_interval_seconds);

                // Get current channel info
                let channel_info = current_channel.read().await.clone();
                if let Some((ch_id, ch_name)) = channel_info {
                    // Check channel points
                    if let Ok(claim_available) = Self::check_channel_points_internal(
                        &client,
                        &ch_id,
                        &ch_name,
                        &channel_points_balances,
                    ).await {
                        if let Some(claim) = claim_available {
                            // Notify about available claim
                            if current_settings.notify_on_drop_available {
                                let _ = app_handle.emit("channel-points-available", &claim);
                            }

                            // Auto-claim if enabled
                            if current_settings.auto_claim_channel_points {
                                match Self::claim_channel_points_internal(
                                    &client,
                                    &ch_id,
                                    &ch_name,
                                    &claim.id,
                                ).await {
                                    Ok(new_balance) => {
                                        println!("✅ Auto-claimed {} channel points! New balance: {}", 
                                            claim.points_earned, new_balance);
                                        
                                        // Add to history
                                        let mut history = channel_points_history.write().await;
                                        history.push(claim.clone());

                                        // Notify about successful claim
                                        if current_settings.notify_on_points_claimed {
                                            let _ = app_handle.emit("channel-points-claimed", &claim);
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!("❌ Failed to auto-claim channel points: {}", e);
                                    }
                                }
                            }
                        }
                    }

                    // Check for claimable drops (progress is updated via WebSocket, no need to fetch campaigns)
                    let claimable_drops: Vec<DropProgress> = {
                        let progress_map = drop_progress.read().await;
                        progress_map.values()
                            .filter(|p| !p.is_claimed && p.current_minutes_watched >= p.required_minutes_watched)
                            .cloned()
                            .collect()
                    };
                    
                    for progress in claimable_drops {
                        // Drop is ready to claim
                        if current_settings.notify_on_drop_available {
                            let _ = app_handle.emit("drop-ready", &progress);
                        }

                        // Auto-claim if enabled
                        if current_settings.auto_claim_drops {
                            match Self::claim_drop_internal(
                                &client,
                                &progress.drop_id,
                                &drop_progress,
                            ).await {
                                Ok(_) => {
                                    println!("✅ Auto-claimed drop: {}", progress.drop_id);
                                    
                                    // Create claimed drop record
                                    let claimed = ClaimedDrop {
                                        id: uuid::Uuid::new_v4().to_string(),
                                        campaign_id: progress.campaign_id.clone(),
                                        drop_id: progress.drop_id.clone(),
                                        drop_name: "Drop".to_string(), // Would need to fetch from campaign
                                        game_name: "Game".to_string(),
                                        benefit_name: "Reward".to_string(),
                                        benefit_image_url: String::new(),
                                        claimed_at: Utc::now(),
                                    };

                                    let mut claimed_drops_lock = claimed_drops.write().await;
                                    claimed_drops_lock.push(claimed.clone());

                                    if current_settings.notify_on_drop_claimed {
                                        let _ = app_handle.emit("drop-claimed", &claimed);
                                    }
                                }
                                Err(e) => {
                                    eprintln!("❌ Failed to auto-claim drop: {}", e);
                                }
                            }
                        }
                    }
                }

                // Wait for next check interval
                tokio::time::sleep(check_interval).await;
            }
        });
    }

    pub async fn stop_monitoring(&self) {
        let mut monitoring = self.monitoring_active.write().await;
        *monitoring = false;
        
        let mut current = self.current_channel.write().await;
        *current = None;
    }

    pub async fn update_current_channel(&self, channel_id: String, channel_name: String) {
        let mut current = self.current_channel.write().await;
        *current = Some((channel_id, channel_name));
    }
    
    /// Update drop progress from WebSocket events
    pub async fn update_drop_progress_from_websocket(&self, drop_id: String, current_minutes: i32, required_minutes: i32) {
        let mut progress_map = self.drop_progress.write().await;
        
        if let Some(progress) = progress_map.get_mut(&drop_id) {
            // Update existing progress
            progress.current_minutes_watched = current_minutes;
            progress.required_minutes_watched = required_minutes;
            progress.last_updated = Utc::now();
            
            println!("✅ Updated drop progress from WebSocket: {}/{} minutes for drop {}", 
                current_minutes, required_minutes, drop_id);
        } else {
            // Create new progress entry if it doesn't exist
            let progress = DropProgress {
                campaign_id: String::new(), // Will be filled in later
                drop_id: drop_id.clone(),
                current_minutes_watched: current_minutes,
                required_minutes_watched: required_minutes,
                is_claimed: false,
                last_updated: Utc::now(),
            };
            progress_map.insert(drop_id.clone(), progress);
            
            println!("✅ Created new drop progress from WebSocket: {}/{} minutes for drop {}", 
                current_minutes, required_minutes, drop_id);
        }
    }

    // Internal helper methods that don't require &self
    async fn check_channel_points_internal(
        client: &Client,
        channel_id: &str,
        channel_name: &str,
        balances: &Arc<RwLock<HashMap<String, ChannelPointsBalance>>>,
    ) -> Result<Option<ChannelPointsClaim>> {
        let token = DropsAuthService::get_token().await?;

        // Create headers similar to the main methods
        let mut headers = HeaderMap::new();
        headers.insert("Client-ID", HeaderValue::from_static(CLIENT_ID));
        headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
        headers.insert("Accept-Language", HeaderValue::from_static("en-US"));
        headers.insert("Accept-Encoding", HeaderValue::from_static("gzip"));
        headers.insert(AUTHORIZATION, HeaderValue::from_str(&format!("OAuth {}", token)).unwrap());
        headers.insert("Origin", HeaderValue::from_static(CLIENT_URL));
        headers.insert("Referer", HeaderValue::from_static(CLIENT_URL));

        let query = r#"
        query ChannelPointsContext($channelLogin: String!) {
            community(id: $channelLogin) {
                channel {
                    self {
                        communityPoints {
                            balance
                        }
                        availableClaim {
                            id
                            pointsEarned
                        }
                    }
                }
            }
        }
        "#;

        let response = client
            .post("https://gql.twitch.tv/gql")
            .headers(headers)
            .json(&serde_json::json!({
                "query": query,
                "variables": {
                    "channelLogin": channel_name
                }
            }))
            .send()
            .await?;

        let gql_response: GraphQLResponse<ChannelPointsData> = response.json().await?;

        if let Some(errors) = gql_response.errors {
            return Err(anyhow::anyhow!("GraphQL errors: {:?}", errors));
        }

        if let Some(data) = gql_response.data {
            let self_points = &data.community.channel.self_points;
            
            // Update balance
            let balance = ChannelPointsBalance {
                channel_id: channel_id.to_string(),
                channel_name: channel_name.to_string(),
                balance: self_points.community_points.balance,
                last_updated: Utc::now(),
            };
            
            let mut balances_lock = balances.write().await;
            balances_lock.insert(channel_id.to_string(), balance);

            // Check if there's a claim available
            if let Some(claim) = &self_points.available_claim {
                return Ok(Some(ChannelPointsClaim {
                    id: claim.id.clone(),
                    channel_id: channel_id.to_string(),
                    channel_name: channel_name.to_string(),
                    points_earned: claim.points_earned,
                    claimed_at: Utc::now(),
                    claim_type: ChannelPointsClaimType::Watch,
                }));
            }
        }

        Ok(None)
    }

    async fn claim_channel_points_internal(
        client: &Client,
        channel_id: &str,
        _channel_name: &str,
        claim_id: &str,
    ) -> Result<i32> {
        let token = DropsAuthService::get_token().await?;

        // Create headers similar to the main methods
        let mut headers = HeaderMap::new();
        headers.insert("Client-ID", HeaderValue::from_static(CLIENT_ID));
        headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
        headers.insert("Accept-Language", HeaderValue::from_static("en-US"));
        headers.insert("Accept-Encoding", HeaderValue::from_static("gzip"));
        headers.insert(AUTHORIZATION, HeaderValue::from_str(&format!("OAuth {}", token)).unwrap());
        headers.insert("Origin", HeaderValue::from_static(CLIENT_URL));
        headers.insert("Referer", HeaderValue::from_static(CLIENT_URL));

        let mutation = r#"
        mutation ClaimCommunityPoints($input: ClaimCommunityPointsInput!) {
            claimCommunityPoints(input: $input) {
                currentPoints
                error {
                    code
                }
            }
        }
        "#;

        let response = client
            .post("https://gql.twitch.tv/gql")
            .headers(headers)
            .json(&serde_json::json!({
                "query": mutation,
                "variables": {
                    "input": {
                        "channelID": channel_id,
                        "claimID": claim_id
                    }
                }
            }))
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!("Failed to claim channel points: {}", error_text));
        }

        let result: serde_json::Value = response.json().await?;
        let current_points = result["data"]["claimCommunityPoints"]["currentPoints"]
            .as_i64()
            .unwrap_or(0) as i32;

        Ok(current_points)
    }

    async fn get_active_campaigns_internal(
        client: &Client,
        drop_progress: &Arc<RwLock<HashMap<String, DropProgress>>>,
    ) -> Result<Vec<DropCampaign>> {
        let token = DropsAuthService::get_token().await?;
        
        // Create headers similar to the main methods
        let mut headers = HeaderMap::new();
        headers.insert("Client-ID", HeaderValue::from_static(CLIENT_ID));
        headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
        headers.insert("Accept-Language", HeaderValue::from_static("en-US"));
        headers.insert("Accept-Encoding", HeaderValue::from_static("gzip"));
        headers.insert(AUTHORIZATION, HeaderValue::from_str(&format!("OAuth {}", token)).unwrap());
        headers.insert("Origin", HeaderValue::from_static(CLIENT_URL));
        headers.insert("Referer", HeaderValue::from_static(CLIENT_URL));
        
        let query = r#"
        query DropCampaigns {
            currentUser {
                dropCampaigns {
                    id
                    name
                    game {
                        id
                        name
                    }
                    description
                    imageURL
                    startAt
                    endAt
                    timeBasedDrops {
                        id
                        name
                        requiredMinutesWatched
                        benefitEdges {
                            benefit {
                                id
                                name
                                imageAssetURL
                            }
                        }
                        self {
                            currentMinutesWatched
                            isClaimed
                        }
                    }
                }
            }
        }
        "#;

        let response = client
            .post("https://gql.twitch.tv/gql")
            .headers(headers)
            .json(&serde_json::json!({
                "query": query,
                "variables": {}
            }))
            .send()
            .await?;

        let gql_response: GraphQLResponse<DropCampaignsData> = response.json().await?;

        if let Some(errors) = gql_response.errors {
            return Err(anyhow::anyhow!("GraphQL errors: {:?}", errors));
        }

        let campaigns = gql_response
            .data
            .and_then(|d| d.current_user)
            .map(|u| u.drop_campaigns)
            .unwrap_or_default();

        let mut result = Vec::new();
        let mut progress_map = drop_progress.write().await;

        for campaign in campaigns {
            let time_based_drops: Vec<TimeBasedDrop> = campaign
                .time_based_drops
                .iter()
                .map(|drop| {
                    // Update progress tracking
                    if let Some(self_progress) = &drop.self_progress {
                        let progress = DropProgress {
                            campaign_id: campaign.id.clone(),
                            drop_id: drop.id.clone(),
                            current_minutes_watched: self_progress.current_minutes_watched,
                            required_minutes_watched: drop.required_minutes_watched,
                            is_claimed: self_progress.is_claimed,
                            last_updated: Utc::now(),
                        };
                        progress_map.insert(drop.id.clone(), progress);
                    }

                    TimeBasedDrop {
                        id: drop.id.clone(),
                        name: drop.name.clone(),
                        required_minutes_watched: drop.required_minutes_watched,
                        benefit_edges: drop
                            .benefit_edges
                            .iter()
                            .map(|edge| DropBenefit {
                                id: edge.benefit.id.clone(),
                                name: edge.benefit.name.clone(),
                                image_url: edge.benefit.image_asset_url.clone(),
                            })
                            .collect(),
                        progress: None,
                    }
                })
                .collect();

            result.push(DropCampaign {
                id: campaign.id,
                name: campaign.name,
                game_id: campaign.game.id,
                game_name: campaign.game.name,
                description: campaign.description,
                image_url: campaign.image_url,
                start_at: DateTime::parse_from_rfc3339(&campaign.start_at)
                    .unwrap_or_else(|_| DateTime::parse_from_rfc3339("2000-01-01T00:00:00Z").unwrap())
                    .with_timezone(&Utc),
                end_at: DateTime::parse_from_rfc3339(&campaign.end_at)
                    .unwrap_or_else(|_| DateTime::parse_from_rfc3339("2099-12-31T23:59:59Z").unwrap())
                    .with_timezone(&Utc),
                time_based_drops,
                is_account_connected: true, // Internal campaigns are always connected
                allowed_channels: Vec::new(),
                is_acl_based: false,
                details_url: None, // Will be populated from the main fetch method
            });
        }

        Ok(result)
    }

    async fn claim_drop_internal(
        client: &Client,
        drop_id: &str,
        drop_progress: &Arc<RwLock<HashMap<String, DropProgress>>>,
    ) -> Result<()> {
        let token = DropsAuthService::get_token().await?;

        // Create headers similar to the main methods
        let mut headers = HeaderMap::new();
        headers.insert("Client-ID", HeaderValue::from_static(CLIENT_ID));
        headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
        headers.insert("Accept-Language", HeaderValue::from_static("en-US"));
        headers.insert("Accept-Encoding", HeaderValue::from_static("gzip"));
        headers.insert(AUTHORIZATION, HeaderValue::from_str(&format!("OAuth {}", token)).unwrap());
        headers.insert("Origin", HeaderValue::from_static(CLIENT_URL));
        headers.insert("Referer", HeaderValue::from_static(CLIENT_URL));

        let mutation = r#"
        mutation ClaimDrop($input: ClaimDropRewardsInput!) {
            claimDropRewards(input: $input) {
                status
            }
        }
        "#;

        let response = client
            .post("https://gql.twitch.tv/gql")
            .headers(headers)
            .json(&serde_json::json!({
                "query": mutation,
                "variables": {
                    "input": {
                        "dropInstanceID": drop_id
                    }
                }
            }))
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!("Failed to claim drop: {}", error_text));
        }

        // Update progress to mark as claimed
        let mut progress_map = drop_progress.write().await;
        if let Some(progress) = progress_map.get_mut(drop_id) {
            progress.is_claimed = true;
            progress.last_updated = Utc::now();
        }

        Ok(())
    }
}
