use anyhow::Result;
use log::{debug, error};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;

const CLIENT_ID: &str = env!("TWITCH_APP_CLIENT_ID");

// 7TV API circuit breaker. The 7TV API (the endpoint that lists a channel's
// emotes) has been getting overloaded; when it starts failing we stop hammering
// it. Exhausting retries on a 7TV request opens the circuit for a cooldown so
// subsequent 7TV calls fail fast (no waiting on 10s timeouts) instead of grinding
// a bulk prefetch scan to a halt; a success closes it immediately. Shared by the
// live picker and the AFK prefetch.
static SEVENTV_CIRCUIT_OPEN_UNTIL: AtomicU64 = AtomicU64::new(0); // unix secs; 0 = closed
const SEVENTV_CIRCUIT_COOLDOWN_SECS: u64 = 60;

fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// True if the 7TV API circuit is currently open (recent repeated failures). The
/// prefetch reads this after scanning to know the emote counts are incomplete.
pub fn seventv_circuit_open() -> bool {
    unix_now_secs() < SEVENTV_CIRCUIT_OPEN_UNTIL.load(Ordering::Relaxed)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Emote {
    pub id: String,
    pub name: String,
    pub url: String,
    pub provider: EmoteProvider,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_zero_width: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_url: Option<String>,
    /// Type of emote: "globals", "subscriptions", "bitstier", "follower", "channelpoints", etc.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emote_type: Option<String>,
    /// Owner/broadcaster ID for subscription emotes
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    /// Owner/author display name for emote attribution
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_name: Option<String>,
    /// Emote width in pixels (for aspect ratio sorting - wide emotes > 32)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
#[allow(clippy::upper_case_acronyms)] // BTTV and FFZ are established acronyms (BetterTTV, FrankerFaceZ)
pub enum EmoteProvider {
    Twitch,
    BTTV,
    #[serde(rename = "7tv")]
    SevenTV,
    FFZ,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmoteSet {
    pub twitch: Vec<Emote>,
    pub bttv: Vec<Emote>,
    #[serde(rename = "7tv")]
    pub seven_tv: Vec<Emote>,
    pub ffz: Vec<Emote>,
}

impl EmoteSet {
    pub fn new() -> Self {
        Self {
            twitch: Vec::new(),
            bttv: Vec::new(),
            seven_tv: Vec::new(),
            ffz: Vec::new(),
        }
    }

    pub fn total_count(&self) -> usize {
        self.twitch.len() + self.bttv.len() + self.seven_tv.len() + self.ffz.len()
    }
}

#[derive(Debug, Clone)]
struct CachedEmoteSet {
    set: EmoteSet,
    timestamp: SystemTime,
}

pub struct EmoteService {
    // Memory cache: channel_id -> EmoteSet
    cache: Arc<RwLock<HashMap<String, CachedEmoteSet>>>,
    // HTTP client with connection pooling
    client: reqwest::Client,
    // Cache duration (5 minutes like the TS version)
    cache_duration: Duration,
    // Cached authorized user ID to prevent rate-limiting on /validate
    cached_user_id: Arc<RwLock<Option<String>>>,
}

impl EmoteService {
    pub fn new() -> Self {
        Self {
            cache: Arc::new(RwLock::new(HashMap::new())),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .gzip(true)
                .build()
                .unwrap_or_default(),
            cache_duration: Duration::from_secs(5 * 60), // 5 minutes
            cached_user_id: Arc::new(RwLock::new(None)),
        }
    }

    /// Fetch all emotes for a channel (or global) with concurrent requests
    pub async fn fetch_channel_emotes(
        &self,
        channel_name: Option<String>,
        channel_id: Option<String>,
        access_token: Option<String>,
    ) -> Result<EmoteSet> {
        let cache_key = channel_id.clone().unwrap_or_else(|| "global".to_string());

        // Check memory cache first
        {
            let cache = self.cache.read().await;
            if let Some(cached) = cache.get(&cache_key) {
                if let Ok(elapsed) = cached.timestamp.elapsed() {
                    if elapsed < self.cache_duration {
                        debug!("[EmoteService] Memory cache hit for {}", cache_key);
                        return Ok(cached.set.clone());
                    }
                }
            }
        }

        debug!(
            "[EmoteService] Fetching emotes concurrently for channel: {:?}, ID: {:?}",
            channel_name, channel_id
        );

        // Fetch all emote providers concurrently using tokio::join!
        // Include Twitch user emotes if we have an access token
        let (bttv_result, seven_tv_result, ffz_result, twitch_result) = tokio::join!(
            self.fetch_bttv_emotes(channel_name.clone(), channel_id.clone()),
            self.fetch_7tv_emotes(channel_name.clone(), channel_id.clone()),
            self.fetch_ffz_emotes(channel_name.clone()),
            self.fetch_user_twitch_emotes(access_token.as_deref(), channel_id.as_deref())
        );

        // Collect results (log errors but continue with available emotes)
        let bttv_emotes = match bttv_result {
            Ok(emotes) => emotes,
            Err(e) => {
                error!("[EmoteService] BTTV fetch error: {}", e);
                Vec::new()
            }
        };

        let seven_tv_emotes = match seven_tv_result {
            Ok(emotes) => emotes,
            Err(e) => {
                error!("[EmoteService] 7TV fetch error: {}", e);
                Vec::new()
            }
        };

        let ffz_emotes = match ffz_result {
            Ok(emotes) => emotes,
            Err(e) => {
                error!("[EmoteService] FFZ fetch error: {}", e);
                Vec::new()
            }
        };

        let has_twitch_error = twitch_result.is_err();
        let twitch_emotes = match twitch_result {
            Ok(emotes) => emotes,
            Err(e) => {
                error!("[EmoteService] Twitch user emotes fetch error: {}", e);
                // Fallback to hardcoded global emotes
                Self::get_global_twitch_emotes()
            }
        };

        // Build emote set
        let emote_set = EmoteSet {
            twitch: twitch_emotes,
            bttv: bttv_emotes,
            seven_tv: seven_tv_emotes,
            ffz: ffz_emotes,
        };

        debug!(
            "[EmoteService] Fetched emotes: Twitch={}, BTTV={}, 7TV={}, FFZ={}",
            emote_set.twitch.len(),
            emote_set.bttv.len(),
            emote_set.seven_tv.len(),
            emote_set.ffz.len()
        );

        // Update memory cache
        {
            let mut cache = self.cache.write().await;
            // Back-date the timestamp so a DEGRADED fetch expires fast (~10s)
            // instead of being pinned for the full 5 min: Twitch failing, OR 7TV
            // returning nothing. 7TV's trending+global sets are always present
            // when its API is healthy, so an empty result means 7TV was down — we
            // don't want to cache that "7TV = nothing" set for the whole session
            // (the bug that needed a manual /refresh). A short TTL lets it
            // re-fetch and self-heal once the provider recovers.
            let degraded = has_twitch_error || emote_set.seven_tv.is_empty();
            let timestamp = if degraded {
                SystemTime::now()
                    .checked_sub(Duration::from_secs(290))
                    .unwrap_or(SystemTime::now())
            } else {
                SystemTime::now()
            };

            cache.insert(
                cache_key,
                CachedEmoteSet {
                    set: emote_set.clone(),
                    timestamp,
                },
            );
        }

        Ok(emote_set)
    }

    /// Drop a channel's cached emote set so the next fetch re-pulls fresh from
    /// the providers. Used when the 7TV EventAPI reports an emote set change, so
    /// a freshly opened window (which reads through this cache) does not serve a
    /// stale set until the 5 minute TTL expires.
    pub async fn invalidate_channel(&self, channel_id: &str) {
        self.cache.write().await.remove(channel_id);
    }

    /// Get emote by name from cached emote set
    pub async fn get_emote_by_name(
        &self,
        channel_id: Option<String>,
        emote_name: &str,
    ) -> Option<Emote> {
        let cache_key = channel_id.unwrap_or_else(|| "global".to_string());

        let cache = self.cache.read().await;
        if let Some(cached) = cache.get(&cache_key) {
            // Search in priority order: 7TV > FFZ > BTTV > Twitch
            for emote in &cached.set.seven_tv {
                if emote.name == emote_name {
                    return Some(emote.clone());
                }
            }
            for emote in &cached.set.ffz {
                if emote.name == emote_name {
                    return Some(emote.clone());
                }
            }
            for emote in &cached.set.bttv {
                if emote.name == emote_name {
                    return Some(emote.clone());
                }
            }
            for emote in &cached.set.twitch {
                if emote.name == emote_name {
                    return Some(emote.clone());
                }
            }
        }

        None
    }

    /// Clear the memory cache
    pub async fn clear_cache(&self) {
        let mut cache = self.cache.write().await;
        cache.clear();
        debug!("[EmoteService] Memory cache cleared");
    }

    /// GET with retry + a 7TV circuit breaker. Retries transient failures
    /// (network errors, 5xx, 429) with exponential backoff. A non-retryable 4xx
    /// (e.g. 404 = channel not on 7TV) returns None immediately WITHOUT opening
    /// the circuit. For 7TV URLs: if the circuit is open it fails fast; exhausting
    /// retries opens it; a success closes it.
    async fn get_with_retry(&self, url: &str, attempts: u32) -> Option<reqwest::Response> {
        let is_seventv = url.contains("7tv.");
        if is_seventv && seventv_circuit_open() {
            return None;
        }
        // 7TV is the only provider prone to multi-second stalls, and it sits on the
        // chat-load critical path: parse_historical_messages awaits the channel emote
        // fetch, whose join waits for ALL providers. A down 7TV at the shared 10s
        // client timeout x 3 attempts pinned that await ~31s (measured: a 41s
        // parse_historical that left chat blank on join). Cap 7TV hard — a short
        // per-request timeout and a SINGLE attempt — so a slow/down 7TV fails in ~4s
        // and immediately trips the circuit breaker, which then fast-skips 7TV on
        // every subsequent fetch for the cooldown (so only the first join after a 7TV
        // outage pays anything). Healthy 7TV answers in ~1s, well under the 4s budget;
        // the per-request retry resilience it gives up is covered by the circuit's
        // cooldown re-probe. Other providers keep their full timeout + retry budget.
        let attempts = if is_seventv { 1 } else { attempts.max(1) };
        let mut backoff_ms = 300u64;
        for attempt in 0..attempts {
            let mut req = self.client.get(url);
            if is_seventv {
                req = req.timeout(Duration::from_secs(4));
            }
            match req.send().await {
                Ok(resp) if resp.status().is_success() => {
                    if is_seventv {
                        SEVENTV_CIRCUIT_OPEN_UNTIL.store(0, Ordering::Relaxed);
                    }
                    return Some(resp);
                }
                Ok(resp) => {
                    let s = resp.status();
                    // 4xx other than 429 are final and not a provider outage.
                    if !(s.is_server_error() || s == reqwest::StatusCode::TOO_MANY_REQUESTS) {
                        return None;
                    }
                }
                Err(_) => {} // network / timeout — retry
            }
            if attempt + 1 < attempts {
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(2000);
            }
        }
        if is_seventv {
            SEVENTV_CIRCUIT_OPEN_UNTIL.store(
                unix_now_secs() + SEVENTV_CIRCUIT_COOLDOWN_SECS,
                Ordering::Relaxed,
            );
        }
        None
    }

    /// Cheap liveness probe for the 7TV API. Used by the prefetch before scanning
    /// so it can warn that the count is incomplete when 7TV is down, instead of
    /// reporting a confident total that silently omits most 7TV emotes. Going
    /// through get_with_retry means a failure also trips the circuit breaker, so
    /// the scan that follows fails fast on 7TV rather than grinding.
    pub async fn seventv_api_healthy(&self) -> bool {
        self.get_with_retry("https://7tv.io/v3/emote-sets/global", 2)
            .await
            .is_some()
    }

    /// Fetch user-specific Twitch emotes using the Helix API
    /// Returns all emotes the user has access to: globals, subscriptions, drops, bits, etc.
    async fn fetch_user_twitch_emotes(
        &self,
        access_token: Option<&str>,
        broadcaster_id: Option<&str>,
    ) -> Result<Vec<Emote>> {
        let token = match access_token {
            Some(t) if !t.is_empty() => t,
            _ => {
                debug!("[EmoteService] No access token provided, using global emotes fallback");
                return Ok(Self::get_global_twitch_emotes());
            }
        };

        // Get user ID from cache, or fetch it via /validate
        let user_id = {
            let mut cache_write = self.cached_user_id.write().await;
            if let Some(id) = cache_write.clone() {
                id
            } else {
                // Fetch the user ID from the token validation endpoint
                let validate_response = self
                    .client
                    .get("https://id.twitch.tv/oauth2/validate")
                    .header("Authorization", format!("OAuth {}", token))
                    .send()
                    .await?;

                if !validate_response.status().is_success() {
                    return Err(anyhow::anyhow!("Token validation failed"));
                }

                let validate_data: serde_json::Value = validate_response.json().await?;
                let fetched_id = validate_data["user_id"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("No user_id in token validation response"))?
                    .to_string();

                *cache_write = Some(fetched_id.clone());
                fetched_id
            }
        };

        debug!(
            "[EmoteService] Fetching Twitch emotes for user_id: {}",
            user_id
        );

        // Build the API URL with pagination support
        let mut all_emotes: Vec<Emote> = Vec::new();
        let mut cursor: Option<String> = None;

        loop {
            let mut url = format!(
                "https://api.twitch.tv/helix/chat/emotes/user?user_id={}",
                user_id
            );

            // Include broadcaster_id for follower emotes if provided
            if let Some(bid) = broadcaster_id {
                url.push_str(&format!("&broadcaster_id={}", bid));
            }

            // Add pagination cursor if we have one
            if let Some(ref c) = cursor {
                url.push_str(&format!("&after={}", c));
            }

            let response = self
                .client
                .get(&url)
                .header("Authorization", format!("Bearer {}", token))
                .header("Client-Id", CLIENT_ID)
                .send()
                .await?;

            if !response.status().is_success() {
                let status = response.status();
                let error_text = response.text().await.unwrap_or_default();
                error!(
                    "[EmoteService] Twitch emotes API error {}: {}",
                    status, error_text
                );

                // Return fallback on error
                if all_emotes.is_empty() {
                    return Ok(Self::get_global_twitch_emotes());
                } else {
                    break;
                }
            }

            let data: serde_json::Value = response.json().await?;

            // Parse emotes from response
            if let Some(emotes_array) = data["data"].as_array() {
                for emote_data in emotes_array {
                    if let (Some(id), Some(name)) =
                        (emote_data["id"].as_str(), emote_data["name"].as_str())
                    {
                        // Capture emote type and owner for categorization
                        let emote_type = emote_data["emote_type"].as_str().map(|s| s.to_string());
                        let owner_id = emote_data["owner_id"].as_str().map(|s| s.to_string());

                        all_emotes.push(Emote {
                            id: id.to_string(),
                            name: name.to_string(),
                            url: format!(
                                "https://static-cdn.jtvnw.net/emoticons/v2/{}/default/dark/3.0",
                                id
                            ),
                            provider: EmoteProvider::Twitch,
                            is_zero_width: None,
                            local_url: None,
                            emote_type,
                            owner_id,
                            width: None,
                            owner_name: None,
                        });
                    }
                }
            }

            // Check for pagination cursor
            cursor = data["pagination"]["cursor"].as_str().map(|s| s.to_string());

            if cursor.is_none() {
                break;
            }
        }

        debug!(
            "[EmoteService] Fetched {} Twitch user emotes",
            all_emotes.len()
        );

        // If we got no emotes (e.g., new account), return hardcoded globals
        if all_emotes.is_empty() {
            return Ok(Self::get_global_twitch_emotes());
        }

        Ok(all_emotes)
    }

    // Private helper methods for fetching from each provider

    async fn fetch_bttv_emotes(
        &self,
        _channel_name: Option<String>,
        channel_id: Option<String>,
    ) -> Result<Vec<Emote>> {
        let mut emotes = Vec::new();

        // Fetch global BTTV emotes
        match self
            .client
            .get("https://api.betterttv.net/3/cached/emotes/global")
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                if let Ok(json) = response.json::<serde_json::Value>().await {
                    if let Some(array) = json.as_array() {
                        for item in array {
                            if let (Some(id), Some(code)) = (
                                item.get("id").and_then(|v| v.as_str()),
                                item.get("code").and_then(|v| v.as_str()),
                            ) {
                                let is_modifier = item
                                    .get("modifier")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);
                                emotes.push(Emote {
                                    id: id.to_string(),
                                    name: code.to_string(),
                                    url: format!("https://cdn.betterttv.net/emote/{}/1x", id),
                                    provider: EmoteProvider::BTTV,
                                    is_zero_width: Some(is_modifier),
                                    local_url: None,
                                    emote_type: None,
                                    owner_id: None,
                                    width: None,
                                    owner_name: None,
                                });
                            }
                        }
                    }
                }
            }
            Ok(_) => error!("[EmoteService] BTTV global: non-success status"),
            Err(e) => error!("[EmoteService] BTTV global request failed: {}", e),
        }

        // Fetch channel-specific BTTV emotes
        if let Some(channel_id) = channel_id {
            match self
                .client
                .get(format!(
                    "https://api.betterttv.net/3/cached/users/twitch/{}",
                    channel_id
                ))
                .send()
                .await
            {
                Ok(response) if response.status().is_success() => {
                    if let Ok(json) = response.json::<serde_json::Value>().await {
                        // Channel emotes
                        if let Some(channel_emotes) =
                            json.get("channelEmotes").and_then(|v| v.as_array())
                        {
                            for item in channel_emotes {
                                if let (Some(id), Some(code)) = (
                                    item.get("id").and_then(|v| v.as_str()),
                                    item.get("code").and_then(|v| v.as_str()),
                                ) {
                                    let is_modifier = item
                                        .get("modifier")
                                        .and_then(|v| v.as_bool())
                                        .unwrap_or(false);
                                    emotes.push(Emote {
                                        id: id.to_string(),
                                        name: code.to_string(),
                                        url: format!("https://cdn.betterttv.net/emote/{}/1x", id),
                                        provider: EmoteProvider::BTTV,
                                        is_zero_width: Some(is_modifier),
                                        local_url: None,
                                        emote_type: None,
                                        owner_id: None,
                                        width: None,
                                        owner_name: None,
                                    });
                                }
                            }
                        }
                        // Shared emotes
                        if let Some(shared_emotes) =
                            json.get("sharedEmotes").and_then(|v| v.as_array())
                        {
                            for item in shared_emotes {
                                if let (Some(id), Some(code)) = (
                                    item.get("id").and_then(|v| v.as_str()),
                                    item.get("code").and_then(|v| v.as_str()),
                                ) {
                                    let is_modifier = item
                                        .get("modifier")
                                        .and_then(|v| v.as_bool())
                                        .unwrap_or(false);
                                    emotes.push(Emote {
                                        id: id.to_string(),
                                        name: code.to_string(),
                                        url: format!("https://cdn.betterttv.net/emote/{}/1x", id),
                                        provider: EmoteProvider::BTTV,
                                        is_zero_width: Some(is_modifier),
                                        local_url: None,
                                        emote_type: None,
                                        owner_id: None,
                                        width: None,
                                        owner_name: None,
                                    });
                                }
                            }
                        }
                    }
                }
                Ok(_) => {} // Channel not found or error - not critical
                Err(e) => error!("[EmoteService] BTTV channel request failed: {}", e),
            }
        }

        Ok(emotes)
    }

    async fn fetch_7tv_emotes(
        &self,
        _channel_name: Option<String>,
        channel_id: Option<String>,
    ) -> Result<Vec<Emote>> {
        let mut emotes = Vec::new();

        // Fetch trending 7TV emotes using GraphQL (v4 API)
        // Note: v4 API uses `defaultName` instead of `name`, and `flags` is now an object
        let gql_query = r#"
        query EmoteSearch(
            $query: String,
            $tags: [String!],
            $sortBy: SortBy!,
            $filters: Filters,
            $page: Int,
            $perPage: Int!
        ) {
            emotes {
                search(
                    query: $query
                    tags: { tags: $tags, match: ANY }
                    sort: { sortBy: $sortBy, order: DESCENDING }
                    filters: $filters
                    page: $page
                    perPage: $perPage
                ) {
                    items {
                        id
                        defaultName
                        flags {
                            zeroWidth
                        }
                        host {
                            files {
                                width
                            }
                        }
                    }
                }
            }
        }
        "#;

        let variables = serde_json::json!({
            // Removed "animated": true filter to include all emotes (both static and animated)
            "page": 1,
            "perPage": 300,
            "query": null,
            "sortBy": "TRENDING_MONTHLY",
            "tags": []
        });

        let body = serde_json::json!({
            "operationName": "EmoteSearch",
            "query": gql_query,
            "variables": variables
        });

        match self
            .client
            .post("https://api.7tv.app/v4/gql")
            .header("Content-Type", "application/json")
            .header(
                "Accept",
                "application/graphql-response+json, application/graphql+json, application/json",
            )
            .json(&body)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                if let Ok(json) = response.json::<serde_json::Value>().await {
                    if let Some(items) = json
                        .pointer("/data/emotes/search/items")
                        .and_then(|v| v.as_array())
                    {
                        for item in items {
                            if let (Some(id), Some(name)) = (
                                item.get("id").and_then(|v| v.as_str()),
                                item.get("defaultName").and_then(|v| v.as_str()),
                            ) {
                                let is_zero_width = item
                                    .pointer("/flags/zeroWidth")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);
                                let width = item
                                    .pointer("/host/files/0/width")
                                    .and_then(|v| v.as_u64())
                                    .map(|v| v as u32);
                                emotes.push(Emote {
                                    id: id.to_string(),
                                    name: name.to_string(),
                                    url: format!("https://cdn.7tv.app/emote/{}/1x.avif", id),
                                    provider: EmoteProvider::SevenTV,
                                    is_zero_width: Some(is_zero_width),
                                    local_url: None,
                                    emote_type: None,
                                    owner_id: None,
                                    width,
                                    owner_name: None,
                                });
                            }
                        }
                    }
                }
            }
            Ok(_) => error!("[EmoteService] 7TV GraphQL: non-success status"),
            Err(e) => error!("[EmoteService] 7TV GraphQL request failed: {}", e),
        }

        // Fetch global 7TV emotes (v3 API)
        match self
            .get_with_retry("https://7tv.io/v3/emote-sets/global", 3)
            .await
        {
            Some(response) => {
                if let Ok(json) = response.json::<serde_json::Value>().await {
                    if let Some(global_emotes) = json.get("emotes").and_then(|v| v.as_array()) {
                        for item in global_emotes {
                            let emote_data = item.get("data").unwrap_or(item);
                            if let (Some(id), Some(name)) = (
                                emote_data
                                    .get("id")
                                    .or_else(|| item.get("id"))
                                    .and_then(|v| v.as_str()),
                                item.get("name").and_then(|v| v.as_str()),
                            ) {
                                let flags = emote_data
                                    .get("flags")
                                    .or_else(|| item.get("flags"))
                                    .and_then(|v| v.as_i64())
                                    .unwrap_or(0);
                                let width = emote_data
                                    .pointer("/host/files/0/width")
                                    .and_then(|v| v.as_u64())
                                    .map(|v| v as u32);
                                emotes.push(Emote {
                                    id: id.to_string(),
                                    name: name.to_string(),
                                    url: format!("https://cdn.7tv.app/emote/{}/1x.avif", id),
                                    provider: EmoteProvider::SevenTV,
                                    is_zero_width: Some((flags & 256) == 256),
                                    local_url: None,
                                    emote_type: None,
                                    owner_id: None,
                                    width,
                                    owner_name: None,
                                });
                            }
                        }
                    }
                }
            }
            None => error!("[EmoteService] 7TV global unavailable (after retries)"),
        }

        // Fetch channel-specific 7TV emotes
        if let Some(channel_id) = channel_id {
            match self
                .get_with_retry(&format!("https://7tv.io/v3/users/twitch/{}", channel_id), 3)
                .await
            {
                Some(response) => {
                    if let Ok(json) = response.json::<serde_json::Value>().await {
                        if let Some(emote_set_emotes) =
                            json.pointer("/emote_set/emotes").and_then(|v| v.as_array())
                        {
                            for active_emote in emote_set_emotes {
                                let emote_data = active_emote.get("data").unwrap_or(active_emote);
                                let emote_id = emote_data
                                    .get("id")
                                    .or_else(|| active_emote.get("id"))
                                    .and_then(|v| v.as_str());
                                let name = active_emote.get("name").and_then(|v| v.as_str());

                                if let (Some(id), Some(name)) = (emote_id, name) {
                                    let flags = emote_data
                                        .get("flags")
                                        .or_else(|| active_emote.get("flags"))
                                        .and_then(|v| v.as_i64())
                                        .unwrap_or(0);
                                    let width = emote_data
                                        .pointer("/host/files/0/width")
                                        .and_then(|v| v.as_u64())
                                        .map(|v| v as u32);
                                    // Extract owner display name from emote data
                                    let owner_name = emote_data
                                        .pointer("/owner/display_name")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string());
                                    emotes.push(Emote {
                                        id: id.to_string(),
                                        name: name.to_string(),
                                        url: format!("https://cdn.7tv.app/emote/{}/1x.avif", id),
                                        provider: EmoteProvider::SevenTV,
                                        is_zero_width: Some((flags & 256) == 256),
                                        local_url: None,
                                        emote_type: None,
                                        owner_id: None,
                                        width,
                                        owner_name,
                                    });
                                }
                            }
                        }
                    }
                }
                None => {} // 404 (not on 7TV) or unavailable after retries — not critical
            }
        }

        // Deduplicate by ID
        let mut seen = std::collections::HashSet::new();
        emotes.retain(|emote| seen.insert(emote.id.clone()));

        Ok(emotes)
    }

    /// Pick the best CDN URL for an FFZ emoticon.
    ///
    /// Animated FFZ emotes expose a separate `animated` object (WebP) alongside
    /// the static `urls` (PNG). Prefer the animated 1x variant when present so
    /// animated emotes actually move, falling back to the static 1x URL, then a
    /// constructed default.
    fn ffz_emote_url(item: &serde_json::Value, id: i64) -> String {
        item.pointer("/animated/1")
            .and_then(|v| v.as_str())
            .or_else(|| item.pointer("/urls/1").and_then(|v| v.as_str()))
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("https://cdn.frankerfacez.com/emote/{}/1", id))
    }

    async fn fetch_ffz_emotes(&self, channel_name: Option<String>) -> Result<Vec<Emote>> {
        let mut emotes = Vec::new();

        // Fetch global FFZ emotes
        match self
            .client
            .get("https://api.frankerfacez.com/v1/set/global")
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                if let Ok(json) = response.json::<serde_json::Value>().await {
                    if let Some(sets) = json.get("sets").and_then(|v| v.as_object()) {
                        for (_set_id, set_data) in sets {
                            if let Some(emoticons) =
                                set_data.get("emoticons").and_then(|v| v.as_array())
                            {
                                for item in emoticons {
                                    if let (Some(id), Some(name)) = (
                                        item.get("id").and_then(|v| v.as_i64()),
                                        item.get("name").and_then(|v| v.as_str()),
                                    ) {
                                        let url = Self::ffz_emote_url(item, id);

                                        emotes.push(Emote {
                                            id: id.to_string(),
                                            name: name.to_string(),
                                            url,
                                            provider: EmoteProvider::FFZ,
                                            is_zero_width: None,
                                            local_url: None,
                                            emote_type: None,
                                            owner_id: None,
                                            width: None,
                                            owner_name: None,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Ok(_) => error!("[EmoteService] FFZ global: non-success status"),
            Err(e) => error!("[EmoteService] FFZ global request failed: {}", e),
        }

        // Fetch channel-specific FFZ emotes
        if let Some(channel_name) = channel_name {
            match self
                .client
                .get(format!(
                    "https://api.frankerfacez.com/v1/room/{}",
                    channel_name
                ))
                .send()
                .await
            {
                Ok(response) if response.status().is_success() => {
                    if let Ok(json) = response.json::<serde_json::Value>().await {
                        if let Some(sets) = json.get("sets").and_then(|v| v.as_object()) {
                            for (_set_id, set_data) in sets {
                                if let Some(emoticons) =
                                    set_data.get("emoticons").and_then(|v| v.as_array())
                                {
                                    for item in emoticons {
                                        if let (Some(id), Some(name)) = (
                                            item.get("id").and_then(|v| v.as_i64()),
                                            item.get("name").and_then(|v| v.as_str()),
                                        ) {
                                            let url = Self::ffz_emote_url(item, id);

                                            emotes.push(Emote {
                                                id: id.to_string(),
                                                name: name.to_string(),
                                                url,
                                                provider: EmoteProvider::FFZ,
                                                is_zero_width: None,
                                                local_url: None,
                                                emote_type: None,
                                                owner_id: None,
                                                width: None,
                                                owner_name: None,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(_) => {} // Channel not found - not critical
                Err(e) => error!("[EmoteService] FFZ channel request failed: {}", e),
            }
        }

        Ok(emotes)
    }

    fn get_global_twitch_emotes() -> Vec<Emote> {
        vec![
            Emote {
                id: "25".to_string(),
                name: "Kappa".to_string(),
                url: "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0".to_string(),
                provider: EmoteProvider::Twitch,
                is_zero_width: None,
                local_url: None,
                emote_type: None,
                owner_id: None,
                width: None,
                owner_name: None,
            },
            Emote {
                id: "354".to_string(),
                name: "4Head".to_string(),
                url: "https://static-cdn.jtvnw.net/emoticons/v2/354/default/dark/3.0".to_string(),
                provider: EmoteProvider::Twitch,
                is_zero_width: None,
                local_url: None,
                emote_type: None,
                owner_id: None,
                width: None,
                owner_name: None,
            },
            Emote {
                id: "425618".to_string(),
                name: "LUL".to_string(),
                url: "https://static-cdn.jtvnw.net/emoticons/v2/425618/default/dark/3.0"
                    .to_string(),
                provider: EmoteProvider::Twitch,
                is_zero_width: None,
                local_url: None,
                emote_type: None,
                owner_id: None,
                width: None,
                owner_name: None,
            },
            Emote {
                id: "305954156".to_string(),
                name: "Pog".to_string(),
                url: "https://static-cdn.jtvnw.net/emoticons/v2/305954156/default/dark/3.0"
                    .to_string(),
                provider: EmoteProvider::Twitch,
                is_zero_width: None,
                local_url: None,
                emote_type: None,
                owner_id: None,
                width: None,
                owner_name: None,
            },
            Emote {
                id: "88".to_string(),
                name: "PogChamp".to_string(),
                url: "https://static-cdn.jtvnw.net/emoticons/v2/88/default/dark/3.0".to_string(),
                provider: EmoteProvider::Twitch,
                is_zero_width: None,
                local_url: None,
                emote_type: None,
                owner_id: None,
                width: None,
                owner_name: None,
            },
            Emote {
                id: "81273".to_string(),
                name: "BibleThump".to_string(),
                url: "https://static-cdn.jtvnw.net/emoticons/v2/81273/default/dark/3.0".to_string(),
                provider: EmoteProvider::Twitch,
                is_zero_width: None,
                local_url: None,
                emote_type: None,
                owner_id: None,
                width: None,
                owner_name: None,
            },
            Emote {
                id: "81248".to_string(),
                name: "Kreygasm".to_string(),
                url: "https://static-cdn.jtvnw.net/emoticons/v2/81248/default/dark/3.0".to_string(),
                provider: EmoteProvider::Twitch,
                is_zero_width: None,
                local_url: None,
                emote_type: None,
                owner_id: None,
                width: None,
                owner_name: None,
            },
            Emote {
                id: "81249".to_string(),
                name: "ResidentSleeper".to_string(),
                url: "https://static-cdn.jtvnw.net/emoticons/v2/81249/default/dark/3.0".to_string(),
                provider: EmoteProvider::Twitch,
                is_zero_width: None,
                local_url: None,
                emote_type: None,
                owner_id: None,
                width: None,
                owner_name: None,
            },
            Emote {
                id: "81274".to_string(),
                name: "FailFish".to_string(),
                url: "https://static-cdn.jtvnw.net/emoticons/v2/81274/default/dark/3.0".to_string(),
                provider: EmoteProvider::Twitch,
                is_zero_width: None,
                local_url: None,
                emote_type: None,
                owner_id: None,
                width: None,
                owner_name: None,
            },
            Emote {
                id: "81997".to_string(),
                name: "NotLikeThis".to_string(),
                url: "https://static-cdn.jtvnw.net/emoticons/v2/81997/default/dark/3.0".to_string(),
                provider: EmoteProvider::Twitch,
                is_zero_width: None,
                local_url: None,
                emote_type: None,
                owner_id: None,
                width: None,
                owner_name: None,
            },
            Emote {
                id: "166266".to_string(),
                name: "CoolCat".to_string(),
                url: "https://static-cdn.jtvnw.net/emoticons/v2/166266/default/dark/3.0"
                    .to_string(),
                provider: EmoteProvider::Twitch,
                is_zero_width: None,
                local_url: None,
                emote_type: None,
                owner_id: None,
                width: None,
                owner_name: None,
            },
            Emote {
                id: "191762".to_string(),
                name: "CoolStoryBob".to_string(),
                url: "https://static-cdn.jtvnw.net/emoticons/v2/191762/default/dark/3.0"
                    .to_string(),
                provider: EmoteProvider::Twitch,
                is_zero_width: None,
                local_url: None,
                emote_type: None,
                owner_id: None,
                width: None,
                owner_name: None,
            },
            Emote {
                id: "196892".to_string(),
                name: "SeemsGood".to_string(),
                url: "https://static-cdn.jtvnw.net/emoticons/v2/196892/default/dark/3.0"
                    .to_string(),
                provider: EmoteProvider::Twitch,
                is_zero_width: None,
                local_url: None,
                emote_type: None,
                owner_id: None,
                width: None,
                owner_name: None,
            },
            Emote {
                id: "245".to_string(),
                name: "KappaHD".to_string(),
                url: "https://static-cdn.jtvnw.net/emoticons/v2/245/default/dark/3.0".to_string(),
                provider: EmoteProvider::Twitch,
                is_zero_width: None,
                local_url: None,
                emote_type: None,
                owner_id: None,
                width: None,
                owner_name: None,
            },
            Emote {
                id: "1902".to_string(),
                name: "Keepo".to_string(),
                url: "https://static-cdn.jtvnw.net/emoticons/v2/1902/default/dark/3.0".to_string(),
                provider: EmoteProvider::Twitch,
                is_zero_width: None,
                local_url: None,
                emote_type: None,
                owner_id: None,
                width: None,
                owner_name: None,
            },
        ]
    }
}

impl Default for EmoteService {
    fn default() -> Self {
        Self::new()
    }
}
