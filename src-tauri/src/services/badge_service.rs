use lru::LruCache;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;

// ============================================================================
// GQL STRUCTS (for fetching user's displayBadges when no IRC data available)
// ============================================================================

#[derive(Debug, Serialize)]
struct GQLRequest {
    #[serde(rename = "operationName")]
    operation_name: String,
    variables: GQLVariables,
    extensions: GQLExtensions,
}

#[derive(Debug, Serialize, Clone)]
struct GQLVariables {
    #[serde(rename = "channelID")]
    channel_id: String,
    #[serde(rename = "channelLogin")]
    channel_login: String,
    #[serde(rename = "hasChannelID")]
    has_channel_id: bool,
    #[serde(rename = "targetUserID")]
    target_user_id: Option<String>,
    #[serde(rename = "targetLogin")]
    target_login: String,
    #[serde(rename = "giftRecipientLogin")]
    gift_recipient_login: String,
    #[serde(rename = "isViewerBadgeCollectionEnabled")]
    is_viewer_badge_collection_enabled: bool,
    #[serde(rename = "withStandardGifting")]
    with_standard_gifting: bool,
    #[serde(rename = "badgeSourceChannelID")]
    badge_source_channel_id: String,
    #[serde(rename = "badgeSourceChannelLogin")]
    badge_source_channel_login: String,
}

#[derive(Debug, Serialize, Clone)]
struct GQLExtensions {
    #[serde(rename = "persistedQuery")]
    persisted_query: PersistedQuery,
}

#[derive(Debug, Serialize, Clone)]
struct PersistedQuery {
    version: i32,
    #[serde(rename = "sha256Hash")]
    sha256_hash: String,
}

#[derive(Debug, Deserialize)]
struct GQLResponse {
    data: Option<GQLData>,
}

#[derive(Debug, Deserialize)]
struct GQLData {
    #[serde(rename = "targetUser", default)]
    target_user: Option<TargetUser>,
    #[serde(rename = "channelViewer", default)]
    channel_viewer: Option<ChannelViewer>,
}

#[derive(Debug, Deserialize)]
struct TargetUser {
    #[serde(rename = "displayBadges", default)]
    display_badges: Vec<GQLBadge>,
}

#[derive(Debug, Deserialize)]
struct ChannelViewer {
    #[serde(rename = "earnedBadges", default)]
    earned_badges: Vec<EarnedBadge>,
}

#[derive(Debug, Deserialize)]
struct EarnedBadge {
    #[serde(rename = "setID")]
    set_id: String,
    version: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(rename = "image1x", default)]
    image_1x: Option<String>,
    #[serde(rename = "image2x", default)]
    image_2x: Option<String>,
    #[serde(rename = "image4x", default)]
    image_4x: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GQLBadge {
    #[serde(rename = "setID")]
    set_id: String,
    version: String,
}

// ============================================================================
// GQL STRUCTS (for fetching user's global badge collection)
// ============================================================================

#[derive(Debug, Serialize)]
struct BadgeCollectionGQLRequest {
    #[serde(rename = "operationName")]
    operation_name: String,
    variables: BadgeCollectionVariables,
    extensions: GQLExtensions,
}

#[derive(Debug, Serialize, Clone)]
struct BadgeCollectionVariables {
    login: String,
}

#[derive(Debug, Deserialize)]
struct BadgeCollectionGQLResponse {
    data: Option<BadgeCollectionGQLData>,
}

#[derive(Debug, Deserialize)]
struct BadgeCollectionGQLData {
    user: Option<BadgeCollectionUser>,
}

#[derive(Debug, Deserialize)]
struct BadgeCollectionUser {
    #[serde(rename = "globalBadgeCollection", default)]
    global_badge_collection: Vec<BadgeCollectionItem>,
}

#[derive(Debug, Deserialize)]
struct BadgeCollectionItem {
    badge: BadgeCollectionBadge,
}

#[derive(Debug, Deserialize)]
struct BadgeCollectionBadge {
    #[serde(rename = "setID")]
    set_id: String,
    version: String,
    #[serde(default)]
    title: Option<String>,
}

// ============================================================================
// MODELS
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BadgeInfo {
    pub id: String,
    pub set_id: String,
    pub version: String,
    pub title: String,
    pub description: String,
    pub image_1x: String,
    pub image_2x: String,
    pub image_4x: String,
    pub click_action: Option<String>,
    pub click_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserBadge {
    pub badge_info: BadgeInfo,
    pub provider: BadgeProvider,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
#[allow(clippy::upper_case_acronyms)] // FFZ is an established acronym (FrankerFaceZ)
pub enum BadgeProvider {
    Twitch,
    FFZ,
    Chatterino,
    Homies,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserBadgesResponse {
    pub display_badges: Vec<UserBadge>,
    pub earned_badges: Vec<UserBadge>,
    pub third_party_badges: Vec<UserBadge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedBadgeLink {
    pub link_type: String, // "category" or "drops"
    pub name: String,
    pub original_text: String,
}

// ============================================================================
// THIRD PARTY BADGE STRUCTS
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
struct FFZBadgesResponse {
    badges: Vec<FFZBadge>,
    users: HashMap<String, Vec<u32>>,
}

#[derive(Debug, Clone, Deserialize)]
struct FFZBadge {
    id: u32,
    title: Option<String>,
    name: Option<String>,
    urls: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ChatterinoBadgesResponse {
    badges: Vec<ChatterinoBadge>,
}

#[derive(Debug, Clone, Deserialize)]
struct ChatterinoBadge {
    tooltip: String,
    image1: String,
    image2: Option<String>,
    image3: Option<String>,
    users: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct HomiesBadgesResponse {
    badges: Vec<HomiesBadge>,
}

#[derive(Debug, Clone, Deserialize)]
struct HomiesBadge {
    tooltip: String,
    image1: String,
    image2: Option<String>,
    image3: Option<String>,
    users: Vec<String>,
}

// ============================================================================
// TWITCH HELIX STRUCTS
// ============================================================================

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HelixBadgesResponse {
    pub data: Vec<HelixBadgeSet>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HelixBadgeSet {
    pub set_id: String,
    pub versions: Vec<HelixBadgeVersion>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
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

// ============================================================================
// CACHE STRUCTURES
// ============================================================================

struct ThirdPartyCache {
    ffz: Option<FFZBadgesResponse>,
    chatterino: Option<ChatterinoBadgesResponse>,
    homies: Option<HomiesBadgesResponse>,
    last_updated: SystemTime,
}

struct BadgeCache {
    global_badges: Option<HelixBadgesResponse>,
    channel_badges: LruCache<String, HelixBadgesResponse>,
    third_party: ThirdPartyCache,
    // Store user's last known badge string from IRC for profile lookups
    user_badge_strings: LruCache<String, String>,
}

impl BadgeCache {
    fn new() -> Self {
        Self {
            global_badges: None,
            channel_badges: LruCache::new(NonZeroUsize::new(50).unwrap()),
            third_party: ThirdPartyCache {
                ffz: None,
                chatterino: None,
                homies: None,
                last_updated: UNIX_EPOCH,
            },
            // Cache last badge string for up to 1000 users
            user_badge_strings: LruCache::new(NonZeroUsize::new(1000).unwrap()),
        }
    }
}

// ============================================================================
// BADGE SERVICE
// ============================================================================

pub struct BadgeService {
    cache: Arc<RwLock<BadgeCache>>,
    client_id: String,
    http_client: reqwest::Client,
}

impl BadgeService {
    pub fn new(client_id: String) -> Self {
        Self {
            cache: Arc::new(RwLock::new(BadgeCache::new())),
            client_id,
            http_client: reqwest::Client::builder()
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap(),
        }
    }

    // ========================================================================
    // GLOBAL BADGES (Helix API)
    // ========================================================================

    pub async fn fetch_global_badges(&self, token: &str) -> Result<(), String> {
        let url = "https://api.twitch.tv/helix/chat/badges/global";
        let response = self
            .http_client
            .get(url)
            .header("Client-Id", &self.client_id)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await
            .map_err(|e| format!("Failed to fetch global badges: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("Helix API returned status: {}", response.status()));
        }

        let badges: HelixBadgesResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse badges: {}", e))?;

        let mut cache = self.cache.write().await;
        cache.global_badges = Some(badges.clone());

        Ok(())
    }

    pub async fn get_global_badges(&self) -> Option<HelixBadgesResponse> {
        let cache = self.cache.read().await;
        cache.global_badges.clone()
    }

    // ========================================================================
    // CHANNEL BADGES (Helix API)
    // ========================================================================

    pub async fn fetch_channel_badges(&self, channel_id: &str, token: &str) -> Result<(), String> {
        let url = format!(
            "https://api.twitch.tv/helix/chat/badges?broadcaster_id={}",
            channel_id
        );

        let response = self
            .http_client
            .get(&url)
            .header("Client-Id", &self.client_id)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await
            .map_err(|e| format!("Failed to fetch channel badges: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("Helix API returned status: {}", response.status()));
        }

        let badges: HelixBadgesResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse badges: {}", e))?;

        let mut cache = self.cache.write().await;
        cache
            .channel_badges
            .put(channel_id.to_string(), badges.clone());

        Ok(())
    }

    pub async fn get_channel_badges(&self, channel_id: &str) -> Option<HelixBadgesResponse> {
        let mut cache = self.cache.write().await;
        cache.channel_badges.get(channel_id).cloned()
    }

    // ========================================================================
    // THIRD PARTY BADGES
    // ========================================================================

    pub async fn fetch_third_party_badges(&self) -> Result<(), String> {
        let cache_duration = Duration::from_secs(10 * 60); // 10 minutes

        let mut cache = self.cache.write().await;

        // Check if cache is still valid
        if let Ok(elapsed) = cache.third_party.last_updated.elapsed() {
            if elapsed < cache_duration {
                return Ok(());
            }
        }

        drop(cache); // Release lock during network calls

        // Fetch FFZ badges
        let ffz_result = self
            .http_client
            .get("https://api.frankerfacez.com/v1/badges/ids")
            .send()
            .await;

        let ffz_badges = if let Ok(response) = ffz_result {
            if response.status().is_success() {
                response.json::<FFZBadgesResponse>().await.ok()
            } else {
                None
            }
        } else {
            None
        };

        // Fetch Chatterino badges
        let chatterino_result = self
            .http_client
            .get("https://api.chatterino.com/badges")
            .send()
            .await;

        let chatterino_badges = if let Ok(response) = chatterino_result {
            if response.status().is_success() {
                response.json::<ChatterinoBadgesResponse>().await.ok()
            } else {
                None
            }
        } else {
            None
        };

        // Fetch Homies badges (try both endpoints)
        let homies1_result = self
            .http_client
            .get("https://itzalex.github.io/badges")
            .send()
            .await;

        let homies2_result = self
            .http_client
            .get("https://itzalex.github.io/badges2")
            .send()
            .await;

        let homies_badges = Self::merge_homies_responses(homies1_result, homies2_result).await;

        // Update cache
        let mut cache = self.cache.write().await;
        cache.third_party.ffz = ffz_badges;
        cache.third_party.chatterino = chatterino_badges;
        cache.third_party.homies = homies_badges;
        cache.third_party.last_updated = SystemTime::now();

        Ok(())
    }

    async fn merge_homies_responses(
        result1: Result<reqwest::Response, reqwest::Error>,
        result2: Result<reqwest::Response, reqwest::Error>,
    ) -> Option<HomiesBadgesResponse> {
        let mut all_badges: Vec<HomiesBadge> = Vec::new();

        if let Ok(response) = result1 {
            if response.status().is_success() {
                if let Ok(data) = response.json::<HomiesBadgesResponse>().await {
                    all_badges.extend(data.badges);
                }
            }
        }

        if let Ok(response) = result2 {
            if response.status().is_success() {
                if let Ok(data) = response.json::<HomiesBadgesResponse>().await {
                    for badge in data.badges {
                        if !all_badges.iter().any(|b| b.tooltip == badge.tooltip) {
                            all_badges.push(badge);
                        } else if let Some(existing) =
                            all_badges.iter_mut().find(|b| b.tooltip == badge.tooltip)
                        {
                            existing.users.extend(badge.users);
                        }
                    }
                }
            }
        }

        if all_badges.is_empty() {
            None
        } else {
            Some(HomiesBadgesResponse { badges: all_badges })
        }
    }

    // ========================================================================
    // USER BADGE STRING CACHE (for profile lookups)
    // ========================================================================

    /// Store a user's badge string from IRC for later profile lookups
    pub async fn store_user_badge_string(&self, user_id: &str, badge_string: &str) {
        let mut cache = self.cache.write().await;
        cache
            .user_badge_strings
            .put(user_id.to_string(), badge_string.to_string());
    }

    /// Get a user's cached badge string
    pub async fn get_user_badge_string(&self, user_id: &str) -> Option<String> {
        let mut cache = self.cache.write().await;
        cache.user_badge_strings.get(user_id).cloned()
    }

    // ========================================================================
    // GQL FALLBACK (for fetching user's displayBadges when no IRC data)
    // ========================================================================

    /// Fetch display badges AND earned badges from Twitch GQL ViewerCard query (anonymous mode)
    /// This is used as a fallback when we don't have IRC badge data for a user
    /// Returns (display_badges, earned_badges)
    async fn fetch_badges_from_gql(
        &self,
        user_id: &str,
        username: &str,
        channel_id: &str,
        channel_name: &str,
    ) -> Result<(Vec<String>, Vec<String>), String> {
        let request = GQLRequest {
            operation_name: "ViewerCard".to_string(),
            variables: GQLVariables {
                channel_id: channel_id.to_string(),
                channel_login: channel_name.to_string(),
                has_channel_id: true,
                target_user_id: Some(user_id.to_string()),
                target_login: username.to_string(),
                gift_recipient_login: username.to_string(),
                is_viewer_badge_collection_enabled: true,
                with_standard_gifting: true,
                badge_source_channel_id: channel_id.to_string(),
                badge_source_channel_login: channel_name.to_string(),
            },
            extensions: GQLExtensions {
                persisted_query: PersistedQuery {
                    version: 1,
                    sha256_hash: "80c53fe04c79a6414484104ea573c28d6a8436e031a235fc6908de63f51c74fd"
                        .to_string(),
                },
            },
        };

        // Use anonymous mode with public Twitch client ID
        let response = self
            .http_client
            .post("https://gql.twitch.tv/gql")
            .header("Accept-Language", "en-US")
            .header("Client-ID", "kimne78kx3ncx6brgo4mv6wki5h1ko")
            .json(&vec![request])
            .send()
            .await
            .map_err(|e| format!("Failed to send GQL request: {}", e))?;

        if !response.status().is_success() {
            return Err(format!(
                "GQL request failed with status: {}",
                response.status()
            ));
        }

        let response_text = response
            .text()
            .await
            .map_err(|e| format!("Failed to read GQL response: {}", e))?;

        // Parse response - it's an array with one item
        let gql_responses: Vec<GQLResponse> =
            serde_json::from_str(&response_text).map_err(|e| {
                format!(
                    "Failed to parse GQL response: {} - Raw: {}",
                    e,
                    &response_text[..200.min(response_text.len())]
                )
            })?;

        let gql_data = gql_responses
            .into_iter()
            .next()
            .and_then(|r| r.data)
            .ok_or_else(|| "No data in GQL response".to_string())?;

        // Extract display badges from targetUser.displayBadges
        let display_badges: Vec<String> = gql_data
            .target_user
            .as_ref()
            .map(|u| {
                u.display_badges
                    .iter()
                    .map(|b| format!("{}/{}", b.set_id, b.version))
                    .collect()
            })
            .unwrap_or_default();

        // Extract earned badges from channelViewer.earnedBadges
        let earned_badges: Vec<String> = gql_data
            .channel_viewer
            .as_ref()
            .map(|cv| {
                cv.earned_badges
                    .iter()
                    .map(|b| format!("{}/{}", b.set_id, b.version))
                    .collect()
            })
            .unwrap_or_default();

        Ok((display_badges, earned_badges))
    }

    /// Fetch ALL global badges a user has earned from Twitch GQL
    /// This uses the globalBadgeCollection query to get the full list of earned badges
    pub async fn fetch_global_badge_collection_from_gql(
        &self,
        username: &str,
        token: &str,
    ) -> Result<Vec<String>, String> {
        // Use full query text instead of persisted query hash (matches working pattern in drops.rs)
        let query = r#"
        query GetGlobalBadgeCollection($login: String!) {
            user(login: $login) {
                globalBadgeCollection {
                    badge {
                        setID
                        version
                        title
                    }
                }
            }
        }
        "#;

        let request_body = serde_json::json!({
            "operationName": "GetGlobalBadgeCollection",
            "query": query,
            "variables": {
                "login": username.to_lowercase()
            }
        });

        // Use authenticated mode with OAuth token for accessing badge collection
        let response = self
            .http_client
            .post("https://gql.twitch.tv/gql")
            .header("Accept-Language", "en-US")
            .header("Client-Id", "kimne78kx3ncx6brgo4mv6wki5h1ko")
            .header("Authorization", format!("OAuth {}", token))
            .json(&request_body)
            .send()
            .await
            .map_err(|e| format!("Failed to send GQL request: {}", e))?;

        if !response.status().is_success() {
            return Err(format!(
                "GQL request failed with status: {}",
                response.status()
            ));
        }

        let response_text = response
            .text()
            .await
            .map_err(|e| format!("Failed to read GQL response: {}", e))?;

        log::debug!(
            "[BadgeService] Badge collection GQL raw response (first 500 chars): {}",
            &response_text[..500.min(response_text.len())]
        );

        // Parse response - single object (not array) when using inline query
        let gql_response: BadgeCollectionGQLResponse = serde_json::from_str(&response_text)
            .map_err(|e| {
                format!(
                    "Failed to parse GQL badge collection response: {} - Raw: {}",
                    e,
                    &response_text[..500.min(response_text.len())]
                )
            })?;

        let gql_data = gql_response.data.ok_or_else(|| {
            format!(
                "No data in GQL badge collection response. Raw: {}",
                &response_text[..500.min(response_text.len())]
            )
        })?;

        let earned_badges: Vec<String> = gql_data
            .user
            .as_ref()
            .map(|u| {
                u.global_badge_collection
                    .iter()
                    .map(|item| format!("{}/{}", item.badge.set_id, item.badge.version))
                    .collect()
            })
            .unwrap_or_default();

        log::debug!(
            "[BadgeService] Fetched {} global earned badges for user",
            earned_badges.len()
        );

        Ok(earned_badges)
    }

    /// Fetch ALL earned badges from both channel-specific and global sources
    /// This merges channelViewer.earnedBadges with globalBadgeCollection for complete coverage
    /// NOTE: This is only used for profile overlays, not for normal chat!
    async fn fetch_all_earned_badges(
        &self,
        channel_earned_ids: Vec<String>,
        username: &str,
        channel_id: &str,
        token: &str,
    ) -> Vec<UserBadge> {
        let mut all_badge_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

        // 1. Use already-fetched channel-specific earned badges
        for badge_id in channel_earned_ids {
            all_badge_ids.insert(badge_id);
        }

        // 2. Fetch global badge collection (ALL earned global badges)
        match self
            .fetch_global_badge_collection_from_gql(username, token)
            .await
        {
            Ok(global_badge_ids) => {
                for badge_id in global_badge_ids {
                    all_badge_ids.insert(badge_id);
                }
            }
            Err(_) => {
                // Silently fail - this is just supplemental data
            }
        }

        // 3. Resolve all unique badge IDs to full badge info
        let badge_ids: Vec<String> = all_badge_ids.into_iter().collect();
        if badge_ids.is_empty() {
            return Vec::new();
        }

        // Resolve using both channel and global badges
        self.resolve_badge_ids(&badge_ids, channel_id).await
    }

    // ========================================================================
    // USER BADGES LOOKUP (Helix + GQL fallback)
    // ========================================================================

    /// Get all badges for a user (for normal chat - display badges only)
    /// Priority: IRC cached badges -> GQL ViewerCard badges -> empty
    pub async fn get_user_badges(
        &self,
        user_id: &str,
        username: &str,
        channel_id: &str,
        channel_name: &str,
        token: &str,
    ) -> Result<UserBadgesResponse, String> {
        // Ensure badge metadata is fetched
        if self.get_global_badges().await.is_none() {
            self.fetch_global_badges(token).await?;
        }

        if self.get_channel_badges(channel_id).await.is_none() {
            self.fetch_channel_badges(channel_id, token).await?;
        }

        // Try to get user's badge string from IRC cache first
        let badge_string = self.get_user_badge_string(user_id).await;

        // Resolve badges - use IRC cache if available, otherwise try GQL
        let display_badges = if let Some(badge_str) = badge_string {
            self.resolve_badge_string(&badge_str, channel_id).await
        } else {
            // No IRC data - try GQL fallback
            match self
                .fetch_badges_from_gql(user_id, username, channel_id, channel_name)
                .await
            {
                Ok((display_ids, _)) => {
                    if !display_ids.is_empty() {
                        // Store display in cache for future use
                        let badge_str = display_ids.join(",");
                        self.store_user_badge_string(user_id, &badge_str).await;
                        self.resolve_badge_ids(&display_ids, channel_id).await
                    } else {
                        Vec::new()
                    }
                }
                Err(_) => Vec::new(),
            }
        };

        // Fetch third-party badges (cached, fast)
        self.fetch_third_party_badges().await?;
        let third_party_badges = self.get_third_party_badges_for_user(user_id).await;

        // For normal chat, earned badges = display badges (no extra queries needed)
        Ok(UserBadgesResponse {
            display_badges: display_badges.clone(),
            earned_badges: display_badges,
            third_party_badges,
        })
    }

    /// Get all badges for a user INCLUDING full earned badge collection (for profile overlay)
    /// This makes additional queries to fetch ALL earned badges
    pub async fn get_user_badges_with_earned(
        &self,
        user_id: &str,
        username: &str,
        channel_id: &str,
        channel_name: &str,
        token: &str,
    ) -> Result<UserBadgesResponse, String> {
        // Ensure badge metadata is fetched
        if self.get_global_badges().await.is_none() {
            self.fetch_global_badges(token).await?;
        }

        if self.get_channel_badges(channel_id).await.is_none() {
            self.fetch_channel_badges(channel_id, token).await?;
        }

        // Fetch display badges and channel-earned badges from GQL
        let (display_ids, channel_earned_ids) = match self
            .fetch_badges_from_gql(user_id, username, channel_id, channel_name)
            .await
        {
            Ok(result) => result,
            Err(_) => {
                // Fall back to IRC cache if available
                if let Some(badge_str) = self.get_user_badge_string(user_id).await {
                    let display = self.resolve_badge_string(&badge_str, channel_id).await;
                    return Ok(UserBadgesResponse {
                        display_badges: display.clone(),
                        earned_badges: display.clone(),
                        third_party_badges: self.get_third_party_badges_for_user(user_id).await,
                    });
                }
                return Ok(UserBadgesResponse {
                    display_badges: Vec::new(),
                    earned_badges: Vec::new(),
                    third_party_badges: Vec::new(),
                });
            }
        };

        // Resolve display badges
        let display_badges = if !display_ids.is_empty() {
            self.resolve_badge_ids(&display_ids, channel_id).await
        } else {
            Vec::new()
        };

        // Fetch all earned badges (merges channel + global)
        let earned_badges = self
            .fetch_all_earned_badges(channel_earned_ids, username, channel_id, token)
            .await;

        // Fetch third-party badges
        self.fetch_third_party_badges().await?;
        let third_party_badges = self.get_third_party_badges_for_user(user_id).await;

        Ok(UserBadgesResponse {
            display_badges,
            earned_badges,
            third_party_badges,
        })
    }

    /// Resolve a badge string (e.g., "subscriber/12,premium/1") to full badge info
    pub async fn resolve_badge_string(
        &self,
        badge_string: &str,
        channel_id: &str,
    ) -> Vec<UserBadge> {
        let badge_ids = self.parse_badge_string(badge_string);
        self.resolve_badge_ids(&badge_ids, channel_id).await
    }

    async fn resolve_badge_ids(&self, badge_ids: &[String], channel_id: &str) -> Vec<UserBadge> {
        let cache = self.cache.read().await;
        let mut resolved = Vec::new();

        for badge_id in badge_ids {
            let parts: Vec<&str> = badge_id.split('/').collect();
            if parts.len() != 2 {
                continue;
            }

            let set_id = parts[0];
            let version = parts[1];

            // Try channel badges first (subscriber, bits, etc.)
            if let Some(channel_badges) = cache.channel_badges.peek(channel_id) {
                if let Some(badge_info) =
                    Self::find_badge_in_response(channel_badges, set_id, version)
                {
                    resolved.push(UserBadge {
                        badge_info,
                        provider: BadgeProvider::Twitch,
                    });
                    continue;
                }
            }

            // Fall back to global badges
            if let Some(global_badges) = &cache.global_badges {
                if let Some(badge_info) =
                    Self::find_badge_in_response(global_badges, set_id, version)
                {
                    resolved.push(UserBadge {
                        badge_info,
                        provider: BadgeProvider::Twitch,
                    });
                }
            }
        }

        resolved
    }

    /// Resolve badge IDs using only global badges (for earned badge collection)
    /// The global badge collection only contains global badges, not channel-specific ones
    async fn resolve_badge_ids_global_only(&self, badge_ids: &[String]) -> Vec<UserBadge> {
        let cache = self.cache.read().await;
        let mut resolved = Vec::new();

        for badge_id in badge_ids {
            let parts: Vec<&str> = badge_id.split('/').collect();
            if parts.len() != 2 {
                continue;
            }

            let set_id = parts[0];
            let version = parts[1];

            // Only look up global badges for earned badges
            if let Some(global_badges) = &cache.global_badges {
                if let Some(badge_info) =
                    Self::find_badge_in_response(global_badges, set_id, version)
                {
                    resolved.push(UserBadge {
                        badge_info,
                        provider: BadgeProvider::Twitch,
                    });
                }
            }
        }

        resolved
    }

    fn find_badge_in_response(
        response: &HelixBadgesResponse,
        set_id: &str,
        version: &str,
    ) -> Option<BadgeInfo> {
        for badge_set in &response.data {
            if badge_set.set_id == set_id {
                for badge_version in &badge_set.versions {
                    if badge_version.id == version {
                        return Some(BadgeInfo {
                            id: format!("{}/{}", set_id, version),
                            set_id: set_id.to_string(),
                            version: version.to_string(),
                            title: badge_version.title.clone(),
                            description: badge_version.description.clone(),
                            image_1x: badge_version.image_url_1x.clone(),
                            image_2x: badge_version.image_url_2x.clone(),
                            image_4x: badge_version.image_url_4x.clone(),
                            click_action: badge_version.click_action.clone(),
                            click_url: badge_version.click_url.clone(),
                        });
                    }
                }
            }
        }
        None
    }

    async fn get_third_party_badges_for_user(&self, user_id: &str) -> Vec<UserBadge> {
        let cache = self.cache.read().await;
        let mut badges = Vec::new();

        // FFZ badges
        if let Some(ffz) = &cache.third_party.ffz {
            if let Some(badge_ids) = ffz.users.get(user_id) {
                for &badge_id in badge_ids {
                    if let Some(badge) = ffz.badges.iter().find(|b| b.id == badge_id) {
                        let image_url = badge
                            .urls
                            .get("4")
                            .or_else(|| badge.urls.get("2"))
                            .or_else(|| badge.urls.get("1"))
                            .cloned()
                            .unwrap_or_default();

                        badges.push(UserBadge {
                            badge_info: BadgeInfo {
                                id: format!("ffz-{}", badge_id),
                                set_id: "ffz".to_string(),
                                version: badge_id.to_string(),
                                title: badge
                                    .title
                                    .clone()
                                    .or_else(|| badge.name.clone())
                                    .unwrap_or_else(|| format!("FFZ Badge {}", badge_id)),
                                description: String::new(),
                                image_1x: badge.urls.get("1").cloned().unwrap_or_default(),
                                image_2x: badge.urls.get("2").cloned().unwrap_or_default(),
                                image_4x: image_url,
                                click_action: None,
                                click_url: Some("https://www.frankerfacez.com/badges".to_string()),
                            },
                            provider: BadgeProvider::FFZ,
                        });
                    }
                }
            }
        }

        // Chatterino badges
        if let Some(chatterino) = &cache.third_party.chatterino {
            for badge in &chatterino.badges {
                if badge.users.contains(&user_id.to_string()) {
                    badges.push(UserBadge {
                        badge_info: BadgeInfo {
                            id: format!("chatterino-{}", badge.tooltip),
                            set_id: "chatterino".to_string(),
                            version: "1".to_string(),
                            title: badge.tooltip.clone(),
                            description: String::new(),
                            image_1x: badge.image1.clone(),
                            image_2x: badge.image2.clone().unwrap_or_else(|| badge.image1.clone()),
                            image_4x: badge
                                .image3
                                .clone()
                                .or_else(|| badge.image2.clone())
                                .unwrap_or_else(|| badge.image1.clone()),
                            click_action: None,
                            click_url: Some("https://chatterino.com/".to_string()),
                        },
                        provider: BadgeProvider::Chatterino,
                    });
                }
            }
        }

        // Homies badges
        if let Some(homies) = &cache.third_party.homies {
            for badge in &homies.badges {
                if badge.users.contains(&user_id.to_string()) {
                    badges.push(UserBadge {
                        badge_info: BadgeInfo {
                            id: format!("homies-{}", badge.tooltip),
                            set_id: "homies".to_string(),
                            version: "1".to_string(),
                            title: badge.tooltip.clone(),
                            description: String::new(),
                            image_1x: badge.image1.clone(),
                            image_2x: badge.image2.clone().unwrap_or_else(|| badge.image1.clone()),
                            image_4x: badge
                                .image3
                                .clone()
                                .or_else(|| badge.image2.clone())
                                .unwrap_or_else(|| badge.image1.clone()),
                            click_action: None,
                            click_url: Some("https://chatterinohomies.com/".to_string()),
                        },
                        provider: BadgeProvider::Homies,
                    });
                }
            }
        }

        badges
    }

    // ========================================================================
    // BADGE PARSING
    // ========================================================================

    pub fn parse_badge_string(&self, badge_string: &str) -> Vec<String> {
        if badge_string.is_empty() {
            return Vec::new();
        }

        badge_string
            .split(',')
            .filter_map(|badge| {
                let parts: Vec<&str> = badge.split('/').collect();
                if parts.len() == 2 {
                    Some(format!("{}/{}", parts[0], parts[1]))
                } else {
                    None
                }
            })
            .collect()
    }

    // ========================================================================
    // CACHE MANAGEMENT
    // ========================================================================

    pub async fn clear_cache(&self) {
        let mut cache = self.cache.write().await;
        cache.global_badges = None;
        cache.channel_badges.clear();
        cache.third_party.ffz = None;
        cache.third_party.chatterino = None;
        cache.third_party.homies = None;
        cache.third_party.last_updated = UNIX_EPOCH;
        cache.user_badge_strings.clear();
    }

    pub async fn clear_channel_cache(&self, channel_id: &str) {
        let mut cache = self.cache.write().await;
        cache.channel_badges.pop(channel_id);
    }
}
