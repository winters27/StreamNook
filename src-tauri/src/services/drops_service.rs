use crate::models::drops::*;
use crate::services::drops_auth_service::DropsAuthService;
use anyhow::Result;
use chrono::{DateTime, Utc};
use log::{debug, error};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION};
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;
use tokio::time::Duration;
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

// Response structure for ChannelPointsContext persisted query
#[derive(Debug, Deserialize)]
struct ChannelPointsContextData {
    channel: Option<ChannelPointsChannel>,
}

#[derive(Debug, Deserialize)]
struct ChannelPointsChannel {
    id: String,
    #[serde(rename = "self")]
    self_data: Option<ChannelPointsSelf>,
}

#[derive(Debug, Deserialize)]
struct ChannelPointsSelf {
    #[serde(rename = "communityPoints")]
    community_points: Option<CommunityPointsInfo>,
}

#[derive(Debug, Deserialize)]
struct CommunityPointsInfo {
    balance: i32,
    #[serde(rename = "availableClaim")]
    available_claim: Option<AvailableClaimInfo>,
    #[serde(rename = "activeMultipliers")]
    active_multipliers: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
struct AvailableClaimInfo {
    id: String,
    #[serde(rename = "pointsEarnedBaseline")]
    points_earned_baseline: Option<i32>,
    #[serde(rename = "pointsEarnedTotal")]
    points_earned_total: Option<i32>,
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
    attempted_claims: Arc<RwLock<std::collections::HashSet<String>>>, // Track drops we've already attempted to claim
    device_id: String,
    session_id: String,
}

impl DropsService {
    pub fn new() -> Self {
        Self::new_with_settings(DropsSettings::default())
    }

    /// Create a new DropsService with the given initial settings
    /// Use this to restore persisted settings on app startup
    pub fn new_with_settings(initial_settings: DropsSettings) -> Self {
        // Generate persistent device ID and session ID (like TwitchDropsMiner does)
        let device_id = Uuid::new_v4().to_string().replace("-", "");
        let session_id = Uuid::new_v4().to_string().replace("-", "");

        Self {
            client: Client::new(),
            settings: Arc::new(RwLock::new(initial_settings)),
            drop_progress: Arc::new(RwLock::new(HashMap::new())),
            claimed_drops: Arc::new(RwLock::new(Vec::new())),
            channel_points_history: Arc::new(RwLock::new(Vec::new())),
            channel_points_balances: Arc::new(RwLock::new(HashMap::new())),
            monitoring_active: Arc::new(RwLock::new(false)),
            current_channel: Arc::new(RwLock::new(None)),
            cached_active_campaigns_count: Arc::new(RwLock::new(0)),
            cached_campaigns: Arc::new(RwLock::new(None)),
            attempted_claims: Arc::new(RwLock::new(std::collections::HashSet::new())),
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
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("OAuth {}", token)).unwrap(),
        );
        headers.insert("Origin", HeaderValue::from_static(CLIENT_URL));
        headers.insert("Referer", HeaderValue::from_static(CLIENT_URL));
        headers.insert(
            "X-Device-Id",
            HeaderValue::from_str(&self.device_id).unwrap(),
        );
        headers.insert(
            "Client-Session-Id",
            HeaderValue::from_str(&self.session_id).unwrap(),
        );
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
        debug!("🔍 [fetch_inventory] Fetching inventory (in-progress campaigns)...");

        let token = match DropsAuthService::get_token().await {
            Ok(t) => {
                debug!("✅ [fetch_inventory] Got token");
                t
            }
            Err(e) => {
                debug!("❌ [fetch_inventory] Failed to get token: {}", e);
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

        debug!(
            "📡 [fetch_inventory] Response status: {}",
            response.status()
        );

        let response_text = response.text().await?;
        let response_json: serde_json::Value = match serde_json::from_str(&response_text) {
            Ok(json) => json,
            Err(e) => {
                debug!("❌ Failed to parse JSON: {}", e);
                return Err(anyhow::anyhow!("Failed to parse response as JSON: {}", e));
            }
        };

        // Check for errors
        if let Some(errors) = response_json.get("errors") {
            debug!("❌ GraphQL errors found: {:?}", errors);
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

        let mut claimed_benefits: std::collections::HashMap<String, DateTime<Utc>> =
            std::collections::HashMap::new();
        for event in game_event_drops {
            if let (Some(id), Some(last_awarded)) =
                (event["id"].as_str(), event["lastAwardedAt"].as_str())
            {
                if let Ok(dt) = DateTime::parse_from_rfc3339(last_awarded) {
                    claimed_benefits.insert(id.to_string(), dt.with_timezone(&Utc));
                }
            }
        }

        debug!("📊 Found {} in-progress campaigns", campaigns_array.len());

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
            let game_name = game["displayName"]
                .as_str()
                .or_else(|| game["name"].as_str())
                .unwrap_or("")
                .to_string();
            let image_url = game["boxArtURL"].as_str().unwrap_or("").to_string();

            if game_name.is_empty() {
                continue;
            }

            // Parse dates
            let start_at = campaign_json["startAt"]
                .as_str()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|| Utc::now());

            let end_at = campaign_json["endAt"]
                .as_str()
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
                if allow
                    .get("isEnabled")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    if let Some(channels) = allow["channels"].as_array() {
                        is_acl_based = !channels.is_empty();
                        for channel in channels {
                            if let (Some(id), Some(name)) =
                                (channel["id"].as_str(), channel["name"].as_str())
                            {
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
                    let required_minutes =
                        drop_json["requiredMinutesWatched"].as_i64().unwrap_or(0) as i32;

                    // Parse benefits
                    let mut benefit_edges = Vec::new();
                    if let Some(edges) = drop_json["benefitEdges"].as_array() {
                        for edge in edges {
                            if let Some(benefit) = edge.get("benefit") {
                                benefit_edges.push(DropBenefit {
                                    id: benefit["id"].as_str().unwrap_or("").to_string(),
                                    name: benefit["name"].as_str().unwrap_or("").to_string(),
                                    image_url: benefit["imageAssetURL"]
                                        .as_str()
                                        .unwrap_or("")
                                        .to_string(),
                                    distribution_type: benefit["distributionType"]
                                        .as_str()
                                        .map(|s| s.to_string()),
                                });
                            }
                        }
                    }

                    // Parse progress
                    let mut progress = None;
                    let mut is_claimed = false;
                    let mut current_minutes = 0;

                    if let Some(self_data) = drop_json.get("self") {
                        current_minutes =
                            self_data["currentMinutesWatched"].as_i64().unwrap_or(0) as i32;
                        is_claimed = self_data["isClaimed"].as_bool().unwrap_or(false);

                        // Parse the dropInstanceID - this is the key for claiming drops!
                        let drop_instance_id =
                            self_data["dropInstanceID"].as_str().map(|s| s.to_string());

                        if drop_instance_id.is_some() {
                            debug!(
                                "📋 Found dropInstanceID for {}: {:?}",
                                drop_id, drop_instance_id
                            );
                        }

                        progress = Some(DropProgress {
                            campaign_id: campaign_json["id"].as_str().unwrap_or("").to_string(),
                            drop_id: drop_id.clone(),
                            current_minutes_watched: current_minutes,
                            required_minutes_watched: required_minutes,
                            is_claimed,
                            last_updated: Utc::now(),
                            drop_instance_id, // Store the dropInstanceID for claiming!
                        });
                    } else {
                        // Check claimed_benefits to determine if claimed
                        // If a benefit was EVER claimed (exists in claimed_benefits),
                        // mark the drop as claimed - this handles badge drops and re-run campaigns
                        for benefit in &benefit_edges {
                            if claimed_benefits.contains_key(&benefit.id) {
                                is_claimed = true;
                                break;
                            }
                        }
                    }

                    if is_claimed {
                        claimed_drops += 1;
                        total_progress += 1.0;
                    } else if current_minutes > 0 {
                        drops_in_progress += 1;
                        if required_minutes > 0 {
                            total_progress +=
                                (current_minutes as f32 / required_minutes as f32).min(1.0);
                        }
                    }

                    time_based_drops.push(TimeBasedDrop {
                        id: drop_id,
                        name: drop_name,
                        required_minutes_watched: required_minutes,
                        benefit_edges,
                        progress,
                        // Drops with 0 required minutes are event-based/badge drops that cannot be auto-mined
                        is_mineable: required_minutes > 0,
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
                description: campaign_json["description"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
                image_url,
                start_at,
                end_at,
                time_based_drops,
                is_account_connected,
                allowed_channels,
                is_acl_based,
                details_url: None,
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

        debug!(
            "📊 Inventory summary: {} total, {} active, {} upcoming, {} expired",
            total_campaigns, active_count, upcoming_count, expired_count
        );

        // Parse completed drops from gameEventDrops array
        let mut completed_drops = Vec::new();
        for event in game_event_drops {
            if let (Some(id), Some(name), Some(image_url), Some(last_awarded)) = (
                event["id"].as_str(),
                event["name"].as_str(),
                event["imageURL"].as_str(),
                event["lastAwardedAt"].as_str(),
            ) {
                if let Ok(dt) = DateTime::parse_from_rfc3339(last_awarded) {
                    completed_drops.push(CompletedDrop {
                        id: id.to_string(),
                        name: name.to_string(),
                        image_url: image_url.to_string(),
                        game_name: event["game"]["name"].as_str().map(|s| s.to_string()),
                        is_connected: event["isConnected"].as_bool().unwrap_or(false),
                        required_account_link: event["requiredAccountLink"]
                            .as_str()
                            .map(|s| s.to_string()),
                        last_awarded_at: dt.with_timezone(&Utc),
                        total_count: event["totalCount"].as_i64().unwrap_or(1) as i32,
                    });
                }
            }
        }

        // Sort completed drops by most recent first
        completed_drops.sort_by(|a, b| b.last_awarded_at.cmp(&a.last_awarded_at));

        debug!(
            "🎁 Found {} completed drops in user's permanent inventory",
            completed_drops.len()
        );

        Ok(InventoryResponse {
            items,
            total_campaigns,
            active_campaigns: active_count,
            upcoming_campaigns: upcoming_count,
            expired_campaigns: expired_count,
            completed_drops,
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
                    debug!(
                        "📦 Using cached campaigns ({} seconds old)",
                        age.num_seconds()
                    );
                    return Ok(campaigns.clone());
                } else {
                    debug!(
                        "⏰ Campaign cache expired ({} seconds old)",
                        age.num_seconds()
                    );
                }
            }
        }

        // Cache miss or expired - fetch from API
        debug!("🔄 Fetching fresh campaigns from API");
        let campaigns = self.fetch_all_active_campaigns_from_api().await?;

        // IMPORTANT:
        // Keep the internal drop_progress map in sync with what the UI receives.
        // The UI calls `get_drop_progress` separately from `get_active_drop_campaigns`,
        // so if we don't update the progress map here, the frontend will see 0 minutes
        // watched for every campaign until a mining websocket event happens.
        self.update_campaigns_and_progress(&campaigns).await;

        Ok(campaigns)
    }

    /// Internal method to fetch campaigns from API (no caching)
    /// This should only be called by get_all_active_campaigns_cached or during mining operations
    pub(crate) async fn fetch_all_active_campaigns_from_api(&self) -> Result<Vec<DropCampaign>> {
        debug!("🔍 [fetch_all_active_campaigns_from_api] Starting (no filters)...");

        let token = match DropsAuthService::get_token().await {
            Ok(t) => {
                debug!(
                    "✅ [get_all_active_campaigns] Got token (first 10 chars): {}",
                    &t[..10.min(t.len())]
                );
                t
            }
            Err(e) => {
                debug!("❌ [get_all_active_campaigns] Failed to get token: {}", e);
                return Err(e);
            }
        };

        debug!("🔍 Fetching drops campaigns using Android app client ID...");

        // Use a full GraphQL query that includes timeBasedDrops with requiredMinutesWatched
        // The ViewerDropsDashboard persisted query doesn't include these fields
        let query = r#"
        query DropCampaigns {
            currentUser {
                id
                dropCampaigns {
                    id
                    name
                    owner { id name }
                    game {
                        id
                        displayName
                        boxArtURL
                    }
                    status
                    startAt
                    endAt
                    description
                    detailsURL
                    accountLinkURL
                    self {
                        isAccountConnected
                    }
                    allow {
                        isEnabled
                        channels {
                            id
                            name
                        }
                    }
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
                            dropInstanceID
                        }
                    }
                }
            }
        }
        "#;

        let response = self
            .client
            .post("https://gql.twitch.tv/gql")
            .headers(self.create_gql_headers(&token))
            .json(&serde_json::json!({
                "query": query,
                "variables": {}
            }))
            .send()
            .await?;

        debug!("📡 Response status: {}", response.status());

        // Get the raw response text first
        let response_text = response.text().await?;

        // Try to parse it as JSON
        let response_json: serde_json::Value = match serde_json::from_str(&response_text) {
            Ok(json) => json,
            Err(e) => {
                debug!("❌ Failed to parse JSON: {}", e);
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
            debug!("❌ GraphQL errors found: {:?}", errors);
            return Err(anyhow::anyhow!("GraphQL errors: {:?}", errors));
        }

        // Check if data and currentUser exist
        if response_json["data"].is_null() {
            debug!("⚠️ Response data is null");
            return Err(anyhow::anyhow!(
                "Unable to fetch drops data. This is likely due to client ID mismatch."
            ));
        }

        if response_json["data"]["currentUser"].is_null() {
            debug!("⚠️ currentUser is null - token/client ID mismatch");
            return Err(anyhow::anyhow!(
                "Authentication mismatch: Token was issued for app client ID but drops API requires web client ID"
            ));
        }

        let mut result = Vec::new();

        // Parse campaigns from DropCampaignDetails response
        // This query returns ALL campaigns with full details including timeBasedDrops
        let campaigns_array = response_json["data"]["currentUser"]["dropCampaigns"]
            .as_array()
            .unwrap_or(&Vec::new())
            .to_vec();

        debug!(
            "📊 Raw campaigns response: {} campaigns found",
            campaigns_array.len()
        );

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
                let game_name = game["displayName"]
                    .as_str()
                    .or_else(|| game["name"].as_str())
                    .unwrap_or("")
                    .to_string();

                let image_url = game["boxArtURL"].as_str().unwrap_or("").to_string();

                if game_name.is_empty() {
                    continue;
                }

                // Parse allowed channels (ACL)
                // If allow.channels exists and is not empty, this is an ACL-restricted campaign
                // The isEnabled field may or may not be present - we check channels directly
                let mut allowed_channels = Vec::new();
                let mut is_acl_based = false;

                if let Some(allow) = campaign_json["allow"].as_object() {
                    // Check if channels array exists and is not empty
                    if let Some(channels) = allow.get("channels").and_then(|v| v.as_array()) {
                        if !channels.is_empty() {
                            // If isEnabled exists and is explicitly false, skip ACL
                            // Otherwise (isEnabled is true or not present), use the channels
                            let is_enabled = allow
                                .get("isEnabled")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(true); // Default to true if not present

                            if is_enabled {
                                is_acl_based = true;
                                for channel in channels {
                                    if let (Some(id), Some(name)) =
                                        (channel["id"].as_str(), channel["name"].as_str())
                                    {
                                        allowed_channels.push(AllowedChannel {
                                            id: id.to_string(),
                                            name: name.to_string(),
                                        });
                                    }
                                }
                                debug!(
                                    "  🔒 ACL campaign: {} allowed channels for {}",
                                    allowed_channels.len(),
                                    campaign_json["name"].as_str().unwrap_or("unknown")
                                );
                            }
                        }
                    }
                }

                // Parse time-based drops - manually parse to handle camelCase field names
                let mut time_based_drops: Vec<TimeBasedDrop> = Vec::new();
                if let Some(drops) = campaign_json["timeBasedDrops"].as_array() {
                    for drop_json in drops {
                        let drop_id = drop_json["id"].as_str().unwrap_or("").to_string();
                        let drop_name = drop_json["name"].as_str().unwrap_or("").to_string();
                        let required_minutes =
                            drop_json["requiredMinutesWatched"].as_i64().unwrap_or(0) as i32;

                        // Parse benefit edges manually (nested structure)
                        let mut benefit_edges = Vec::new();
                        if let Some(edges) = drop_json["benefitEdges"].as_array() {
                            for edge in edges {
                                if let Some(benefit) = edge.get("benefit") {
                                    benefit_edges.push(DropBenefit {
                                        id: benefit["id"].as_str().unwrap_or("").to_string(),
                                        name: benefit["name"].as_str().unwrap_or("").to_string(),
                                        image_url: benefit["imageAssetURL"]
                                            .as_str()
                                            .unwrap_or("")
                                            .to_string(),
                                        distribution_type: benefit["distributionType"]
                                            .as_str()
                                            .map(|s| s.to_string()),
                                    });
                                }
                            }
                        }

                        // Parse progress from "self" field if present
                        let progress = if let Some(self_data) = drop_json.get("self") {
                            if !self_data.is_null() {
                                let drop_instance_id =
                                    self_data["dropInstanceID"].as_str().map(|s| s.to_string());
                                Some(DropProgress {
                                    campaign_id: campaign_json["id"]
                                        .as_str()
                                        .unwrap_or("")
                                        .to_string(),
                                    drop_id: drop_id.clone(),
                                    current_minutes_watched: self_data["currentMinutesWatched"]
                                        .as_i64()
                                        .unwrap_or(0)
                                        as i32,
                                    required_minutes_watched: required_minutes,
                                    is_claimed: self_data["isClaimed"].as_bool().unwrap_or(false),
                                    last_updated: Utc::now(),
                                    drop_instance_id,
                                })
                            } else {
                                None
                            }
                        } else {
                            None
                        };

                        // Determine if drop is mineable (has watch time requirement)
                        // Drops with 0 required minutes are event-based/badge drops that cannot be auto-mined
                        let is_mineable = required_minutes > 0;

                        debug!("📋 [fetch_all_active_campaigns] Drop '{}': required_minutes={}, is_mineable={}", 
                            drop_name, required_minutes, is_mineable);

                        time_based_drops.push(TimeBasedDrop {
                            id: drop_id,
                            name: drop_name,
                            required_minutes_watched: required_minutes,
                            benefit_edges,
                            progress,
                            is_mineable,
                        });
                    }
                }

                // Parse dates
                let start_at = campaign_json["startAt"]
                    .as_str()
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|| Utc::now());

                let end_at = campaign_json["endAt"]
                    .as_str()
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|| Utc::now() + chrono::Duration::days(365));

                // Check if campaign is active (not upcoming or expired)
                let now = Utc::now();
                if start_at > now || end_at < now {
                    continue;
                }

                // Look for detailsURL or any URL field that might be the "about this drop" link
                let details_url = campaign_json["detailsURL"]
                    .as_str()
                    .or_else(|| campaign_json["aboutDropsURL"].as_str())
                    .or_else(|| campaign_json["aboutURL"].as_str())
                    .or_else(|| campaign_json["url"].as_str())
                    .map(|s| s.to_string());

                result.push(DropCampaign {
                    id: campaign_json["id"].as_str().unwrap_or("").to_string(),
                    name: campaign_json["name"].as_str().unwrap_or("").to_string(),
                    game_id,
                    game_name,
                    description: campaign_json["description"]
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
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

        debug!("📊 Returning {} total campaigns (unfiltered)", result.len());
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

        debug!("📊 Applying filters to {} campaigns", all_campaigns.len());

        for campaign in all_campaigns {
            // Skip excluded games
            if settings.excluded_games.contains(&campaign.game_name) {
                debug!("  ⛔ Filtered out: {} (excluded)", campaign.game_name);
                continue;
            }

            // Apply priority mode filter
            if settings.priority_mode == PriorityMode::PriorityOnly
                && !settings.priority_games.is_empty()
                && !settings.priority_games.contains(&campaign.game_name)
            {
                debug!(
                    "  ⛔ Filtered out: {} (not in priority list)",
                    campaign.game_name
                );
                continue;
            }

            debug!("  ✅ Included: {} ({})", campaign.name, campaign.game_name);
            filtered_result.push(campaign);
        }

        debug!("📊 Returning {} filtered campaigns", filtered_result.len());
        Ok(filtered_result)
    }

    pub async fn claim_drop(
        &self,
        drop_id: &str,
        provided_drop_instance_id: Option<&str>,
    ) -> Result<()> {
        let token = DropsAuthService::get_token().await?;

        // First check if a drop_instance_id was provided directly from the frontend
        // This is the most reliable method - the frontend extracts it from inventory data
        let drop_instance_id = if let Some(provided_id) = provided_drop_instance_id {
            debug!(
                "🎁 Using provided dropInstanceID from frontend: {}",
                provided_id
            );
            provided_id.to_string()
        } else {
            // Second, check if we have a stored drop_instance_id from the API response
            let (stored_instance_id, campaign_id) = {
                let progress_map = self.drop_progress.read().await;
                if let Some(progress) = progress_map.get(drop_id) {
                    (
                        progress.drop_instance_id.clone(),
                        progress.campaign_id.clone(),
                    )
                } else {
                    (None, String::new())
                }
            };

            if let Some(instance_id) = stored_instance_id {
                // Use the stored dropInstanceID from the API
                debug!("🎁 Using stored dropInstanceID from API: {}", instance_id);
                instance_id
            } else {
                // Fallback: Generate dropInstanceID in format: user_id#campaign_id#drop_id
                // This is how TwitchDropsMiner constructs the claim ID when not available
                let user_id = self.get_user_id_from_token(&token).await?;

                if campaign_id.is_empty() {
                    // Last resort: just use drop_id
                    debug!("⚠️ No campaign_id available, using drop_id as fallback");
                    drop_id.to_string()
                } else {
                    let generated_id = format!("{}#{}#{}", user_id, campaign_id, drop_id);
                    debug!("🎁 Generated dropInstanceID: {}", generated_id);
                    generated_id
                }
            }
        };

        debug!(
            "🎁 Claiming drop: {} with dropInstanceID: {}",
            drop_id, drop_instance_id
        );

        // Use persisted query format like TwitchDropsMiner does
        let response = self
            .client
            .post("https://gql.twitch.tv/gql")
            .headers(self.create_gql_headers(&token))
            .json(&serde_json::json!({
                "operationName": "DropsPage_ClaimDropRewards",
                "variables": {
                    "input": {
                        "dropInstanceID": drop_instance_id
                    }
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930"
                    }
                }
            }))
            .send()
            .await?;

        let status = response.status();
        let response_text = response.text().await?;

        debug!("📡 Claim response status: {}", status);
        debug!("📡 Claim response: {}", response_text);

        if !status.is_success() {
            return Err(anyhow::anyhow!("Failed to claim drop: {}", response_text));
        }

        // Parse response to check for errors
        let response_json: serde_json::Value = serde_json::from_str(&response_text)?;

        if let Some(errors) = response_json.get("errors") {
            debug!("❌ GraphQL errors: {:?}", errors);
            return Err(anyhow::anyhow!("GraphQL errors: {:?}", errors));
        }

        // Check claimDropRewards response status
        if let Some(data) = response_json.get("data") {
            if let Some(claim_result) = data.get("claimDropRewards") {
                let result_status = claim_result
                    .get("status")
                    .and_then(|s| s.as_str())
                    .unwrap_or("UNKNOWN");

                debug!("🎁 Claim result status: {}", result_status);

                match result_status {
                    "ELIGIBLE_FOR_ALL" | "DROP_INSTANCE_ALREADY_CLAIMED" => {
                        debug!("✅ Drop claimed successfully!");
                    }
                    _ => {
                        debug!("⚠️ Unexpected claim status: {}", result_status);
                    }
                }
            }
        }

        // Update progress to mark as claimed
        let mut progress_map = self.drop_progress.write().await;
        if let Some(progress) = progress_map.get_mut(drop_id) {
            progress.is_claimed = true;
            progress.last_updated = Utc::now();
        }

        Ok(())
    }

    /// Get user ID from token by validating it with Twitch
    async fn get_user_id_from_token(&self, token: &str) -> Result<String> {
        let response = self
            .client
            .get("https://id.twitch.tv/oauth2/validate")
            .header(AUTHORIZATION, format!("OAuth {}", token))
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!("Failed to validate token"));
        }

        let validation: serde_json::Value = response.json().await?;
        let user_id = validation["user_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("No user_id in token validation response"))?;

        Ok(user_id.to_string())
    }

    pub async fn check_channel_points(
        &self,
        channel_id: &str,
        channel_name: &str,
    ) -> Result<Option<ChannelPointsClaim>> {
        let token = DropsAuthService::get_token().await?;

        // Use persisted query like TwitchDropsMiner
        let response = self
            .client
            .post("https://gql.twitch.tv/gql")
            .headers(self.create_gql_headers(&token))
            .json(&serde_json::json!({
                "operationName": "ChannelPointsContext",
                "variables": {
                    "channelLogin": channel_name.to_lowercase()
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "9988086babc615a918a1e9a722ff41d98847acac822645209ac7379eecb27152"
                    }
                }
            }))
            .send()
            .await?;

        let response_json: serde_json::Value = response.json().await?;

        // Check for errors
        if let Some(errors) = response_json.get("errors") {
            return Err(anyhow::anyhow!("GraphQL errors: {:?}", errors));
        }

        // Parse the response - structure is: data.channel.self.communityPoints
        if let Some(data) = response_json.get("data") {
            if let Some(channel) = data.get("channel") {
                let channel_id_from_response = channel
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or(channel_id);

                if let Some(self_data) = channel.get("self") {
                    if let Some(community_points) = self_data.get("communityPoints") {
                        let balance_val = community_points
                            .get("balance")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0) as i32;

                        // Update balance
                        let balance = ChannelPointsBalance {
                            channel_id: channel_id_from_response.to_string(),
                            channel_name: channel_name.to_string(),
                            balance: balance_val,
                            last_updated: Utc::now(),
                            points_name: None, // Not fetched via persisted query
                            points_icon_url: None,
                        };

                        let mut balances = self.channel_points_balances.write().await;
                        balances.insert(channel_id_from_response.to_string(), balance);

                        // Check if there's a claim available
                        if let Some(available_claim) = community_points.get("availableClaim") {
                            if !available_claim.is_null() {
                                let claim_id = available_claim
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let points_earned = available_claim
                                    .get("pointsEarnedTotal")
                                    .or_else(|| available_claim.get("pointsEarnedBaseline"))
                                    .and_then(|v| v.as_i64())
                                    .unwrap_or(50)
                                    as i32;

                                return Ok(Some(ChannelPointsClaim {
                                    id: claim_id,
                                    channel_id: channel_id_from_response.to_string(),
                                    channel_name: channel_name.to_string(),
                                    points_earned,
                                    claimed_at: Utc::now(),
                                    claim_type: ChannelPointsClaimType::Watch,
                                }));
                            }
                        }
                    }
                }
            }
        }

        Ok(None)
    }

    pub async fn claim_channel_points(
        &self,
        channel_id: &str,
        _channel_name: &str,
        claim_id: &str,
    ) -> Result<i32> {
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

        let response = self
            .client
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
            return Err(anyhow::anyhow!(
                "Failed to claim channel points: {}",
                error_text
            ));
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

        let total_channel_points_earned: i32 =
            channel_points_history.iter().map(|c| c.points_earned).sum();

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
            channel_points_history: channel_points_history
                .iter()
                .rev()
                .take(20)
                .cloned()
                .collect(),
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

    pub async fn get_channel_points_balance(
        &self,
        channel_id: &str,
    ) -> Option<ChannelPointsBalance> {
        let balances = self.channel_points_balances.read().await;
        balances.get(channel_id).cloned()
    }

    pub async fn get_all_channel_points_balances(&self) -> Vec<ChannelPointsBalance> {
        let balances = self.channel_points_balances.read().await;
        balances.values().cloned().collect()
    }

    pub async fn start_monitoring(
        &self,
        channel_id: String,
        channel_name: String,
        app_handle: AppHandle,
    ) {
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
        let attempted_claims = self.attempted_claims.clone();
        let client = self.client.clone();

        // Spawn background monitoring task
        tokio::spawn(async move {
            debug!(
                "🎮 Started drops and channel points monitoring for {}",
                channel_name
            );

            loop {
                // Check if monitoring should continue
                let should_continue = *monitoring_active.read().await;
                if !should_continue {
                    debug!("🛑 Stopping drops monitoring");
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
                    )
                    .await
                    {
                        if let Some(claim) = claim_available {
                            // Notify about available claim
                            if current_settings.notify_on_drop_available {
                                let _ = app_handle.emit("channel-points-available", &claim);
                            }

                            // Auto-claim if enabled
                            if current_settings.auto_claim_channel_points {
                                match Self::claim_channel_points_internal(
                                    &client, &ch_id, &ch_name, &claim.id,
                                )
                                .await
                                {
                                    Ok(new_balance) => {
                                        debug!(
                                            "✅ Auto-claimed {} channel points! New balance: {}",
                                            claim.points_earned, new_balance
                                        );

                                        // Add to history
                                        let mut history = channel_points_history.write().await;
                                        history.push(claim.clone());

                                        // Notify about successful claim
                                        if current_settings.notify_on_points_claimed {
                                            let _ =
                                                app_handle.emit("channel-points-claimed", &claim);
                                        }
                                    }
                                    Err(e) => {
                                        error!("❌ Failed to auto-claim channel points: {}", e);
                                    }
                                }
                            }
                        }
                    }

                    // Check for claimable drops (progress is updated via WebSocket, no need to fetch campaigns)
                    // Filter out drops we've already attempted to claim to prevent spam
                    let claimable_drops: Vec<DropProgress> = {
                        let progress_map = drop_progress.read().await;
                        let attempted = attempted_claims.read().await;
                        progress_map
                            .values()
                            .filter(|p| {
                                !p.is_claimed
                                    && p.current_minutes_watched >= p.required_minutes_watched
                                    && p.required_minutes_watched > 0 // Only mineable drops
                                    && !attempted.contains(&p.drop_id) // Skip already-attempted
                            })
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
                            // Mark as attempted BEFORE trying to claim (prevents retry on failure)
                            {
                                let mut attempted = attempted_claims.write().await;
                                attempted.insert(progress.drop_id.clone());
                                debug!(
                                    "📝 [Auto] Marking drop {} as attempted (won't retry)",
                                    progress.drop_id
                                );
                            }

                            match Self::claim_drop_internal(
                                &client,
                                &progress.drop_id,
                                &drop_progress,
                            )
                            .await
                            {
                                Ok(_) => {
                                    debug!("✅ Auto-claimed drop: {}", progress.drop_id);

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
                                    error!("❌ Failed to auto-claim drop (won't retry): {}", e);
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
    pub async fn update_drop_progress_from_websocket(
        &self,
        drop_id: String,
        current_minutes: i32,
        required_minutes: i32,
    ) {
        let mut progress_map = self.drop_progress.write().await;

        if let Some(progress) = progress_map.get_mut(&drop_id) {
            // Update existing progress
            progress.current_minutes_watched = current_minutes;
            progress.required_minutes_watched = required_minutes;
            progress.last_updated = Utc::now();

            debug!(
                "✅ Updated drop progress from WebSocket: {}/{} minutes for drop {}",
                current_minutes, required_minutes, drop_id
            );
        } else {
            // Create new progress entry if it doesn't exist
            let progress = DropProgress {
                campaign_id: String::new(), // Will be filled in later
                drop_id: drop_id.clone(),
                current_minutes_watched: current_minutes,
                required_minutes_watched: required_minutes,
                is_claimed: false,
                last_updated: Utc::now(),
                drop_instance_id: None, // Will be populated when we fetch from API
            };
            progress_map.insert(drop_id.clone(), progress);

            debug!(
                "✅ Created new drop progress from WebSocket: {}/{} minutes for drop {}",
                current_minutes, required_minutes, drop_id
            );
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
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("OAuth {}", token)).unwrap(),
        );
        headers.insert("Origin", HeaderValue::from_static(CLIENT_URL));
        headers.insert("Referer", HeaderValue::from_static(CLIENT_URL));

        // Use persisted query like TwitchDropsMiner
        let response = client
            .post("https://gql.twitch.tv/gql")
            .headers(headers)
            .json(&serde_json::json!({
                "operationName": "ChannelPointsContext",
                "variables": {
                    "channelLogin": channel_name.to_lowercase()
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "9988086babc615a918a1e9a722ff41d98847acac822645209ac7379eecb27152"
                    }
                }
            }))
            .send()
            .await?;

        let response_json: serde_json::Value = response.json().await?;

        // Check for errors
        if let Some(errors) = response_json.get("errors") {
            return Err(anyhow::anyhow!("GraphQL errors: {:?}", errors));
        }

        // Parse the response - structure is: data.channel.self.communityPoints
        if let Some(data) = response_json.get("data") {
            if let Some(channel) = data.get("channel") {
                let channel_id_from_response = channel
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or(channel_id);

                if let Some(self_data) = channel.get("self") {
                    if let Some(community_points) = self_data.get("communityPoints") {
                        let balance_val = community_points
                            .get("balance")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0) as i32;

                        // Update balance
                        let balance = ChannelPointsBalance {
                            channel_id: channel_id_from_response.to_string(),
                            channel_name: channel_name.to_string(),
                            balance: balance_val,
                            last_updated: Utc::now(),
                            points_name: None, // Not fetched via persisted query
                            points_icon_url: None,
                        };

                        let mut balances_lock = balances.write().await;
                        balances_lock.insert(channel_id_from_response.to_string(), balance);

                        // Check if there's a claim available
                        if let Some(available_claim) = community_points.get("availableClaim") {
                            if !available_claim.is_null() {
                                let claim_id = available_claim
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let points_earned = available_claim
                                    .get("pointsEarnedTotal")
                                    .or_else(|| available_claim.get("pointsEarnedBaseline"))
                                    .and_then(|v| v.as_i64())
                                    .unwrap_or(50)
                                    as i32;

                                return Ok(Some(ChannelPointsClaim {
                                    id: claim_id,
                                    channel_id: channel_id_from_response.to_string(),
                                    channel_name: channel_name.to_string(),
                                    points_earned,
                                    claimed_at: Utc::now(),
                                    claim_type: ChannelPointsClaimType::Watch,
                                }));
                            }
                        }
                    }
                }
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
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("OAuth {}", token)).unwrap(),
        );
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
            return Err(anyhow::anyhow!(
                "Failed to claim channel points: {}",
                error_text
            ));
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
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("OAuth {}", token)).unwrap(),
        );
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
                            drop_instance_id: None, // Internal query doesn't return dropInstanceID
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
                                distribution_type: None, // GQL struct doesn't have this field
                            })
                            .collect(),
                        progress: None,
                        is_mineable: drop.required_minutes_watched > 0,
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
                    .unwrap_or_else(|_| {
                        DateTime::parse_from_rfc3339("2000-01-01T00:00:00Z").unwrap()
                    })
                    .with_timezone(&Utc),
                end_at: DateTime::parse_from_rfc3339(&campaign.end_at)
                    .unwrap_or_else(|_| {
                        DateTime::parse_from_rfc3339("2099-12-31T23:59:59Z").unwrap()
                    })
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

        // First, check if we have a stored drop_instance_id from the API response
        let (stored_instance_id, campaign_id) = {
            let progress_map = drop_progress.read().await;
            if let Some(progress) = progress_map.get(drop_id) {
                (
                    progress.drop_instance_id.clone(),
                    progress.campaign_id.clone(),
                )
            } else {
                (None, String::new())
            }
        };

        // Determine the dropInstanceID to use
        let drop_instance_id = if let Some(instance_id) = stored_instance_id {
            // Use the stored dropInstanceID from the API (this is the correct one!)
            debug!(
                "🎁 [Auto] Using stored dropInstanceID from API: {}",
                instance_id
            );
            instance_id
        } else {
            // Fallback: Generate dropInstanceID in format: user_id#campaign_id#drop_id
            // Get user_id from token validation
            let validation_response = client
                .get("https://id.twitch.tv/oauth2/validate")
                .header(AUTHORIZATION, format!("OAuth {}", token))
                .send()
                .await?;

            if !validation_response.status().is_success() {
                return Err(anyhow::anyhow!("Failed to validate token for auto-claim"));
            }

            let validation: serde_json::Value = validation_response.json().await?;
            let user_id = validation["user_id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("No user_id in token validation"))?;

            if campaign_id.is_empty() {
                drop_id.to_string()
            } else {
                let generated_id = format!("{}#{}#{}", user_id, campaign_id, drop_id);
                debug!("🎁 [Auto] Generated dropInstanceID: {}", generated_id);
                generated_id
            }
        };

        debug!(
            "🎁 [Auto] Claiming drop: {} with dropInstanceID: {}",
            drop_id, drop_instance_id
        );

        // Create headers
        let mut headers = HeaderMap::new();
        headers.insert("Client-ID", HeaderValue::from_static(CLIENT_ID));
        headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
        headers.insert("Accept-Language", HeaderValue::from_static("en-US"));
        headers.insert("Accept-Encoding", HeaderValue::from_static("gzip"));
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("OAuth {}", token)).unwrap(),
        );
        headers.insert("Origin", HeaderValue::from_static(CLIENT_URL));
        headers.insert("Referer", HeaderValue::from_static(CLIENT_URL));

        // Use persisted query format
        let response = client
            .post("https://gql.twitch.tv/gql")
            .headers(headers)
            .json(&serde_json::json!({
                "operationName": "DropsPage_ClaimDropRewards",
                "variables": {
                    "input": {
                        "dropInstanceID": drop_instance_id
                    }
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930"
                    }
                }
            }))
            .send()
            .await?;

        let status = response.status();
        let response_text = response.text().await?;

        debug!("📡 [Auto] Claim response status: {}", status);
        debug!("📡 [Auto] Claim response: {}", response_text);

        if !status.is_success() {
            return Err(anyhow::anyhow!("Failed to claim drop: {}", response_text));
        }

        // Parse response to check for errors
        let response_json: serde_json::Value = serde_json::from_str(&response_text)?;

        if let Some(errors) = response_json.get("errors") {
            debug!("❌ [Auto] GraphQL errors: {:?}", errors);
            return Err(anyhow::anyhow!("GraphQL errors: {:?}", errors));
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
