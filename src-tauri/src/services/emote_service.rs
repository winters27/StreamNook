use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::sync::RwLock;

const CLIENT_ID: &str = "1qgws7yzcp21g5ledlzffw3lmqdvie";

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
                        println!("[EmoteService] Memory cache hit for {}", cache_key);
                        return Ok(cached.set.clone());
                    }
                }
            }
        }

        println!(
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
                eprintln!("[EmoteService] BTTV fetch error: {}", e);
                Vec::new()
            }
        };

        let seven_tv_emotes = match seven_tv_result {
            Ok(emotes) => emotes,
            Err(e) => {
                eprintln!("[EmoteService] 7TV fetch error: {}", e);
                Vec::new()
            }
        };

        let ffz_emotes = match ffz_result {
            Ok(emotes) => emotes,
            Err(e) => {
                eprintln!("[EmoteService] FFZ fetch error: {}", e);
                Vec::new()
            }
        };

        let twitch_emotes = match twitch_result {
            Ok(emotes) => emotes,
            Err(e) => {
                eprintln!("[EmoteService] Twitch user emotes fetch error: {}", e);
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

        println!(
            "[EmoteService] Fetched emotes: Twitch={}, BTTV={}, 7TV={}, FFZ={}",
            emote_set.twitch.len(),
            emote_set.bttv.len(),
            emote_set.seven_tv.len(),
            emote_set.ffz.len()
        );

        // Update memory cache
        {
            let mut cache = self.cache.write().await;
            cache.insert(
                cache_key,
                CachedEmoteSet {
                    set: emote_set.clone(),
                    timestamp: SystemTime::now(),
                },
            );
        }

        Ok(emote_set)
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
        println!("[EmoteService] Memory cache cleared");
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
                println!("[EmoteService] No access token provided, using global emotes fallback");
                return Ok(Self::get_global_twitch_emotes());
            }
        };

        // First, get the user ID from the token validation endpoint
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
        let user_id = validate_data["user_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("No user_id in token validation response"))?;

        println!(
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
                eprintln!(
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

        println!(
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
                                let image_type = item.get("imageType").and_then(|v| v.as_str());
                                emotes.push(Emote {
                                    id: id.to_string(),
                                    name: code.to_string(),
                                    url: format!("https://cdn.betterttv.net/emote/{}/1x", id),
                                    provider: EmoteProvider::BTTV,
                                    is_zero_width: Some(image_type == Some("gif")),
                                    local_url: None,
                                    emote_type: None,
                                    owner_id: None,
                                });
                            }
                        }
                    }
                }
            }
            Ok(_) => eprintln!("[EmoteService] BTTV global: non-success status"),
            Err(e) => eprintln!("[EmoteService] BTTV global request failed: {}", e),
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
                                    let image_type = item.get("imageType").and_then(|v| v.as_str());
                                    emotes.push(Emote {
                                        id: id.to_string(),
                                        name: code.to_string(),
                                        url: format!("https://cdn.betterttv.net/emote/{}/1x", id),
                                        provider: EmoteProvider::BTTV,
                                        is_zero_width: Some(image_type == Some("gif")),
                                        local_url: None,
                                        emote_type: None,
                                        owner_id: None,
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
                                    let image_type = item.get("imageType").and_then(|v| v.as_str());
                                    emotes.push(Emote {
                                        id: id.to_string(),
                                        name: code.to_string(),
                                        url: format!("https://cdn.betterttv.net/emote/{}/1x", id),
                                        provider: EmoteProvider::BTTV,
                                        is_zero_width: Some(image_type == Some("gif")),
                                        local_url: None,
                                        emote_type: None,
                                        owner_id: None,
                                    });
                                }
                            }
                        }
                    }
                }
                Ok(_) => {} // Channel not found or error - not critical
                Err(e) => eprintln!("[EmoteService] BTTV channel request failed: {}", e),
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

        // Fetch trending 7TV emotes using GraphQL
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
                        name
                        flags
                    }
                }
            }
        }
        "#;

        let variables = serde_json::json!({
            "filters": { "animated": true },
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
                                item.get("name").and_then(|v| v.as_str()),
                            ) {
                                let flags = item.get("flags").and_then(|v| v.as_i64()).unwrap_or(0);
                                emotes.push(Emote {
                                    id: id.to_string(),
                                    name: name.to_string(),
                                    url: format!("https://cdn.7tv.app/emote/{}/4x.webp", id),
                                    provider: EmoteProvider::SevenTV,
                                    is_zero_width: Some(flags == 256),
                                    local_url: None,
                                    emote_type: None,
                                    owner_id: None,
                                });
                            }
                        }
                    }
                }
            }
            Ok(_) => eprintln!("[EmoteService] 7TV GraphQL: non-success status"),
            Err(e) => eprintln!("[EmoteService] 7TV GraphQL request failed: {}", e),
        }

        // Fetch global 7TV emotes (v3 API)
        match self
            .client
            .get("https://7tv.io/v3/emote-sets/global")
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                if let Ok(json) = response.json::<serde_json::Value>().await {
                    if let Some(global_emotes) = json.get("emotes").and_then(|v| v.as_array()) {
                        for item in global_emotes {
                            if let (Some(id), Some(name)) = (
                                item.get("id").and_then(|v| v.as_str()),
                                item.get("name").and_then(|v| v.as_str()),
                            ) {
                                let flags = item.get("flags").and_then(|v| v.as_i64()).unwrap_or(0);
                                emotes.push(Emote {
                                    id: id.to_string(),
                                    name: name.to_string(),
                                    url: format!("https://cdn.7tv.app/emote/{}/4x.webp", id),
                                    provider: EmoteProvider::SevenTV,
                                    is_zero_width: Some(flags == 256),
                                    local_url: None,
                                    emote_type: None,
                                    owner_id: None,
                                });
                            }
                        }
                    }
                }
            }
            Ok(_) => eprintln!("[EmoteService] 7TV global: non-success status"),
            Err(e) => eprintln!("[EmoteService] 7TV global request failed: {}", e),
        }

        // Fetch channel-specific 7TV emotes
        if let Some(channel_id) = channel_id {
            match self
                .client
                .get(format!("https://7tv.io/v3/users/twitch/{}", channel_id))
                .send()
                .await
            {
                Ok(response) if response.status().is_success() => {
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
                                    let flags = active_emote
                                        .get("flags")
                                        .and_then(|v| v.as_i64())
                                        .unwrap_or(0);
                                    emotes.push(Emote {
                                        id: id.to_string(),
                                        name: name.to_string(),
                                        url: format!("https://cdn.7tv.app/emote/{}/4x.webp", id),
                                        provider: EmoteProvider::SevenTV,
                                        is_zero_width: Some((flags & 256) == 256),
                                        local_url: None,
                                        emote_type: None,
                                        owner_id: None,
                                    });
                                }
                            }
                        }
                    }
                }
                Ok(_) => {} // Channel not found - not critical
                Err(e) => eprintln!("[EmoteService] 7TV channel request failed: {}", e),
            }
        }

        // Deduplicate by ID
        let mut seen = std::collections::HashSet::new();
        emotes.retain(|emote| seen.insert(emote.id.clone()));

        Ok(emotes)
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
                                        let default_url =
                                            format!("https://cdn.frankerfacez.com/emote/{}/1", id);
                                        let url = item
                                            .pointer("/urls/1")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or(&default_url);

                                        emotes.push(Emote {
                                            id: id.to_string(),
                                            name: name.to_string(),
                                            url: url.to_string(),
                                            provider: EmoteProvider::FFZ,
                                            is_zero_width: None,
                                            local_url: None,
                                            emote_type: None,
                                            owner_id: None,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Ok(_) => eprintln!("[EmoteService] FFZ global: non-success status"),
            Err(e) => eprintln!("[EmoteService] FFZ global request failed: {}", e),
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
                                            let default_url = format!(
                                                "https://cdn.frankerfacez.com/emote/{}/1",
                                                id
                                            );
                                            let url = item
                                                .pointer("/urls/1")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or(&default_url);

                                            emotes.push(Emote {
                                                id: id.to_string(),
                                                name: name.to_string(),
                                                url: url.to_string(),
                                                provider: EmoteProvider::FFZ,
                                                is_zero_width: None,
                                                local_url: None,
                                                emote_type: None,
                                                owner_id: None,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(_) => {} // Channel not found - not critical
                Err(e) => eprintln!("[EmoteService] FFZ channel request failed: {}", e),
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
            },
        ]
    }
}

impl Default for EmoteService {
    fn default() -> Self {
        Self::new()
    }
}
