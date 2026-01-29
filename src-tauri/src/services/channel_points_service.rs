use crate::models::drops::{ChannelPointsBalance, ChannelPointsClaim, ChannelPointsClaimType};
use anyhow::Result;
use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, Utc};
use log::{debug, error};
use regex::Regex;
use reqwest::Client;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

// Client IDs - Web for checking, Android for claiming (to match token)
const WEB_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const ANDROID_CLIENT_ID: &str = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp"; // Same as drops token
const CLIENT_URL: &str = "https://www.twitch.tv";
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

pub struct ChannelPointsService {
    client: Client,
    balances: Arc<RwLock<HashMap<String, ChannelPointsBalance>>>,
    claim_history: Arc<RwLock<Vec<ChannelPointsClaim>>>,
    watching_streams: Arc<RwLock<HashMap<String, WatchingStream>>>,
    device_id: String,
    session_id: String,
}

#[derive(Debug, Clone)]
pub struct WatchingStream {
    pub channel_id: String,
    pub channel_login: String,
    pub broadcast_id: String,
    pub spade_url: Option<String>,
    #[allow(dead_code)]
    pub started_at: DateTime<Utc>,
    pub last_payload_sent: DateTime<Utc>,
    pub minutes_watched: i32,
    pub points_earned: i32,
}

impl ChannelPointsService {
    pub fn new() -> Self {
        // Generate persistent device ID and session ID (like Twitch-Channel-Points-Miner-v2)
        let device_id = Uuid::new_v4().to_string().replace("-", "");
        let session_id = Uuid::new_v4().to_string().replace("-", "");

        Self {
            client: Client::new(),
            balances: Arc::new(RwLock::new(HashMap::new())),
            claim_history: Arc::new(RwLock::new(Vec::new())),
            watching_streams: Arc::new(RwLock::new(HashMap::new())),
            device_id,
            session_id,
        }
    }

    /// Extract custom points name and icon URL from channel's communityPointsSettings
    fn extract_points_settings(
        channel: &serde_json::Map<String, serde_json::Value>,
    ) -> (Option<String>, Option<String>) {
        let points_name = channel
            .get("communityPointsSettings")
            .and_then(|s| s.get("name"))
            .and_then(|n| n.as_str())
            .map(|s| s.to_string());

        let points_icon_url = channel
            .get("communityPointsSettings")
            .and_then(|s| s.get("image"))
            .and_then(|i| i.get("url"))
            .and_then(|u| u.as_str())
            .map(|s| s.to_string());

        (points_name, points_icon_url)
    }

    /// Get channel points context (balance and claim availability) - FIXED VERSION
    pub async fn get_channel_points_context(
        &self,
        channel_login: &str,
        token: &str,
    ) -> Result<ChannelPointsContext> {
        // Ensure channel login is lowercase (Twitch API requirement)
        let channel_login_lower = channel_login.to_lowercase();

        // Use full query text since persisted query requires web token
        let query = r#"
            query ChannelPointsContext($channelLogin: String!) {
                user(login: $channelLogin) {
                    id
                    login
                    displayName
                    channel {
                        id
                        communityPointsSettings {
                            name
                            image {
                                url
                            }
                        }
                        self {
                            communityPoints {
                                balance
                                availableClaim {
                                    id
                                }
                            }
                        }
                    }
                }
            }
        "#;

        let response = self
            .client
            .post("https://gql.twitch.tv/gql")
            .header("Client-Id", WEB_CLIENT_ID)
            .header("Authorization", format!("OAuth {}", token)) // Use OAuth format
            .header("User-Agent", USER_AGENT)
            .header("Accept", "*/*")
            .header("Accept-Language", "en-US")
            .header("Accept-Encoding", "gzip")
            .header("Origin", CLIENT_URL)
            .header("Referer", CLIENT_URL)
            .header("X-Device-Id", &self.device_id)
            .header("Client-Session-Id", &self.session_id)
            .json(&json!({
                "operationName": "ChannelPointsContext",
                "query": query,
                "variables": {
                    "channelLogin": channel_login_lower
                }
            }))
            .send()
            .await?;

        // Check status code first
        let status = response.status();
        if !status.is_success() {
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(anyhow::anyhow!(
                "API request failed with status {}: {}",
                status,
                error_text
            ));
        }

        // Get response text for better error handling
        let response_text = response.text().await?;

        // Try to parse as JSON (NOT as array)
        let result: serde_json::Value = match serde_json::from_str(&response_text) {
            Ok(json) => json,
            Err(e) => {
                error!("Failed to decode response for {}: {}", channel_login, e);
                error!(
                    "Response text: {}",
                    &response_text[..response_text.len().min(500)]
                );
                return Err(anyhow::anyhow!("Failed to decode JSON response: {}", e));
            }
        };

        // Check for errors first
        if let Some(errors) = result["errors"].as_array() {
            if !errors.is_empty() {
                let error_msg = errors[0]["message"].as_str().unwrap_or("Unknown error");
                return Err(anyhow::anyhow!("GraphQL error: {}", error_msg));
            }
        }

        // Parse the response structure - updated for user query
        if let Some(user) = result["data"]["user"].as_object() {
            let user_id = user["id"].as_str().unwrap_or("").to_string();

            // Check if user has a channel (not all users are streamers)
            if user["channel"].is_null() {
                // User exists but has no channel - this is normal for non-streamers
                debug!("ℹ️ User {} has no channel (not a streamer)", channel_login);
                return Ok(ChannelPointsContext {
                    channel_id: user_id.clone(),
                    channel_login: channel_login.to_string(),
                    balance: 0,
                    available_claim: None,
                    points_name: None,
                    points_icon_url: None,
                });
            }

            if let Some(channel) = user["channel"].as_object() {
                let channel_id = channel["id"].as_str().unwrap_or("").to_string();

                // Check if self data exists
                if channel["self"].is_null() {
                    // Channel exists but no self data (not logged in for this channel?)
                    debug!(
                        "⚠️ No self data for channel {} - may not be logged in",
                        channel_login
                    );
                    // Extract custom points settings even without self data
                    let (points_name, points_icon_url) = Self::extract_points_settings(channel);
                    return Ok(ChannelPointsContext {
                        channel_id,
                        channel_login: channel_login.to_string(),
                        balance: 0,
                        available_claim: None,
                        points_name,
                        points_icon_url,
                    });
                }

                if let Some(self_data) = channel["self"].as_object() {
                    // Check if community points data exists
                    if self_data["communityPoints"].is_null() {
                        // Channel doesn't have community points enabled
                        debug!(
                            "ℹ️ Channel {} doesn't have community points enabled",
                            channel_login
                        );
                        let (points_name, points_icon_url) = Self::extract_points_settings(channel);
                        return Ok(ChannelPointsContext {
                            channel_id,
                            channel_login: channel_login.to_string(),
                            balance: 0,
                            available_claim: None,
                            points_name,
                            points_icon_url,
                        });
                    }

                    if let Some(points_data) = self_data["communityPoints"].as_object() {
                        let balance = points_data["balance"].as_i64().unwrap_or(0) as i32;

                        let claim_info = if let Some(available_claim) =
                            points_data["availableClaim"].as_object()
                        {
                            Some(ClaimInfo {
                                claim_id: available_claim["id"].as_str().unwrap_or("").to_string(),
                                points: 50, // Standard bonus is 50 points (field not available in query)
                            })
                        } else {
                            None
                        };

                        // Extract custom points settings
                        let (points_name, points_icon_url) = Self::extract_points_settings(channel);

                        // Update our balance tracking
                        let mut balances = self.balances.write().await;
                        balances.insert(
                            channel_id.clone(),
                            ChannelPointsBalance {
                                channel_id: channel_id.clone(),
                                channel_name: channel_login.to_string(),
                                balance,
                                last_updated: Utc::now(),
                                points_name: points_name.clone(),
                                points_icon_url: points_icon_url.clone(),
                            },
                        );

                        return Ok(ChannelPointsContext {
                            channel_id,
                            channel_login: channel_login.to_string(),
                            balance,
                            available_claim: claim_info,
                            points_name,
                            points_icon_url,
                        });
                    }
                }
            }
        } else if result["data"]["user"].is_null() {
            // User doesn't exist
            debug!(
                "⚠️ User {} not found (tried: {})",
                channel_login, channel_login_lower
            );
            return Err(anyhow::anyhow!("User {} not found", channel_login));
        }

        // If we get here, something unexpected happened - log the response for debugging
        error!("❌ Unexpected response structure for {}", channel_login);
        error!(
            "Response: {}",
            serde_json::to_string_pretty(&result).unwrap_or_default()
        );
        Err(anyhow::anyhow!(
            "Failed to get channel points context - unexpected response structure"
        ))
    }

    /// Claim available channel points bonus - FIXED VERSION
    pub async fn claim_channel_points(
        &self,
        channel_id: &str,
        channel_login: &str,
        claim_id: &str,
        token: &str,
    ) -> Result<i32> {
        debug!(
            "🎁 Claiming channel points for channel: {} (claim_id: {})",
            channel_login, claim_id
        );

        // Use Android client ID for claiming (matches the token's client ID)
        let response = self.client
            .post("https://gql.twitch.tv/gql")
            .header("Client-Id", ANDROID_CLIENT_ID)  // Use Android client ID to match token
            .header("Authorization", format!("OAuth {}", token))  // Use OAuth format consistently
            .header("User-Agent", USER_AGENT)
            .header("Accept", "*/*")
            .header("Accept-Language", "en-US")
            .header("Accept-Encoding", "gzip")
            .header("Origin", CLIENT_URL)
            .header("Referer", CLIENT_URL)
            .header("X-Device-Id", &self.device_id)
            .header("Client-Session-Id", &self.session_id)
            .json(&json!({
                "operationName": "ClaimCommunityPoints",
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0"
                    }
                },
                "variables": {
                    "input": {
                        "claimID": claim_id,
                        "channelID": channel_id
                    }
                }
            }))
            .send()
            .await?;

        // Check status code first
        let status = response.status();
        if !status.is_success() {
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(anyhow::anyhow!(
                "API request failed with status {}: {}",
                status,
                error_text
            ));
        }

        // Get response text for better error handling
        let response_text = response.text().await?;

        // Try to parse as JSON (NOT as array)
        let result: serde_json::Value = match serde_json::from_str(&response_text) {
            Ok(json) => json,
            Err(e) => {
                error!(
                    "Failed to decode claim response for {}: {}",
                    channel_login, e
                );
                error!(
                    "Response text: {}",
                    &response_text[..response_text.len().min(500)]
                );
                return Err(anyhow::anyhow!("Failed to decode JSON response: {}", e));
            }
        };

        // Check for errors
        if let Some(errors) = result["errors"].as_array() {
            if !errors.is_empty() {
                let error_msg = errors[0]["message"].as_str().unwrap_or("Unknown error");
                return Err(anyhow::anyhow!("Failed to claim points: {}", error_msg));
            }
        }

        // Parse the claim response
        if let Some(claim_data) = result["data"]["claimCommunityPoints"].as_object() {
            // Check for claim errors
            if let Some(error) = claim_data["error"].as_object() {
                let error_code = error["code"].as_str().unwrap_or("UNKNOWN");
                return Err(anyhow::anyhow!(
                    "Failed to claim points - error code: {}",
                    error_code
                ));
            }

            // Get points earned (might be in different fields)
            let points_earned = claim_data["currentPoints"]
                .as_i64()
                .or_else(|| claim_data["pointsEarned"].as_i64())
                .or_else(|| claim_data["pointGain"].as_i64())
                .unwrap_or(50) as i32;

            debug!(
                "✅ Successfully claimed channel points for {} (earned: ~50 points)",
                channel_login
            );

            // Record the claim in history
            let mut history = self.claim_history.write().await;
            history.push(ChannelPointsClaim {
                id: claim_id.to_string(),
                channel_id: channel_id.to_string(),
                channel_name: channel_login.to_string(),
                points_earned: 50, // Standard claim amount
                claimed_at: Utc::now(),
                claim_type: ChannelPointsClaimType::Bonus,
            });

            // Keep only last 100 claims
            if history.len() > 100 {
                let len = history.len();
                history.drain(0..len - 100);
            }

            return Ok(points_earned);
        }

        Err(anyhow::anyhow!(
            "Failed to claim channel points - invalid response structure"
        ))
    }

    /// Check and auto-claim channel points if available
    pub async fn check_and_claim_points(
        &self,
        channel_login: &str,
        token: &str,
        auto_claim: bool,
    ) -> Result<Option<i32>> {
        let context = self
            .get_channel_points_context(channel_login, token)
            .await?;

        debug!(
            "💰 Channel points for {}: {} (claim available: {})",
            channel_login,
            context.balance,
            context.available_claim.is_some()
        );

        if let Some(claim_info) = context.available_claim {
            if auto_claim {
                debug!(
                    "🎯 Auto-claiming {} points for {}",
                    claim_info.points, channel_login
                );
                match self
                    .claim_channel_points(
                        &context.channel_id,
                        channel_login,
                        &claim_info.claim_id,
                        token,
                    )
                    .await
                {
                    Ok(points) => return Ok(Some(points)),
                    Err(e) => {
                        error!("❌ Failed to auto-claim points: {}", e);
                        return Err(e);
                    }
                }
            } else {
                debug!("ℹ️ Points available but auto-claim is disabled");
                return Ok(Some(claim_info.points));
            }
        }

        Ok(None)
    }

    /// Start watching a stream to earn channel points
    pub async fn start_watching_stream(
        &self,
        channel_id: &str,
        channel_login: &str,
        token: &str,
    ) -> Result<()> {
        // Get broadcast ID
        let broadcast_id = self
            .get_broadcast_id(channel_id, token)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Channel {} is not live", channel_login))?;

        // Get spade URL
        let spade_url = self.get_spade_url(channel_login).await.ok();

        let watching_stream = WatchingStream {
            channel_id: channel_id.to_string(),
            channel_login: channel_login.to_string(),
            broadcast_id,
            spade_url,
            started_at: Utc::now(),
            last_payload_sent: Utc::now(),
            minutes_watched: 0,
            points_earned: 0,
        };

        let mut watching = self.watching_streams.write().await;
        watching.insert(channel_id.to_string(), watching_stream);

        debug!("👀 Started watching {} for channel points", channel_login);
        Ok(())
    }

    /// Stop watching a stream
    pub async fn stop_watching_stream(&self, channel_id: &str) -> Result<()> {
        let mut watching = self.watching_streams.write().await;
        if let Some(stream) = watching.remove(channel_id) {
            debug!(
                "👋 Stopped watching {} after {} minutes",
                stream.channel_login, stream.minutes_watched
            );
        }
        Ok(())
    }

    /// Send minute-watched payload for all currently watching streams
    /// Rotates through streams to maximize point farming across multiple channels
    pub async fn send_minute_watched_for_streams(&self, token: &str) -> Result<()> {
        let user_id = self.get_user_id(token).await?;
        let mut watching = self.watching_streams.write().await;

        // Get all watching streams as a vector for rotation
        let mut all_streams: Vec<_> = watching.values_mut().collect();

        if all_streams.is_empty() {
            return Ok(());
        }

        // Capture the total count before borrowing
        let total_streams = all_streams.len();

        // Sort by last payload sent time (oldest first for fair rotation)
        all_streams.sort_by_key(|s| s.last_payload_sent);

        // Twitch allows earning points on 2 streams concurrently
        // But we rotate through all streams to maximize total points
        const MAX_CONCURRENT_STREAMS: usize = 2;
        let streams_to_send = all_streams.iter_mut().take(MAX_CONCURRENT_STREAMS);

        for stream in streams_to_send {
            // Only send if we have spade URL
            if let Some(ref spade_url) = stream.spade_url {
                match self
                    .send_watch_payload(
                        spade_url,
                        &stream.channel_id,
                        &stream.channel_login,
                        &stream.broadcast_id,
                        &user_id,
                    )
                    .await
                {
                    Ok(true) => {
                        stream.last_payload_sent = Utc::now();
                        stream.minutes_watched += 1;
                        // Estimate points earned (roughly 10 points per 5 minutes)
                        if stream.minutes_watched % 5 == 0 {
                            stream.points_earned += 10;
                        }
                        debug!(
                            "✅ Sent minute-watched for {} ({} minutes, {} total watching)",
                            stream.channel_login, stream.minutes_watched, total_streams
                        );
                    }
                    Ok(false) => {
                        debug!(
                            "⚠️ Failed to send minute-watched for {}",
                            stream.channel_login
                        );
                    }
                    Err(e) => {
                        error!(
                            "❌ Error sending minute-watched for {}: {}",
                            stream.channel_login, e
                        );
                    }
                }
            }
        }

        // Log rotation status
        if total_streams > MAX_CONCURRENT_STREAMS {
            debug!(
                "🔄 Rotating through {} channels ({} earning concurrently)",
                total_streams, MAX_CONCURRENT_STREAMS
            );
        }

        Ok(())
    }

    /// Get broadcast ID for a channel
    async fn get_broadcast_id(&self, channel_id: &str, token: &str) -> Result<Option<String>> {
        let query = r#"
        query GetStreamInfo($channelID: ID!) {
            user(id: $channelID) {
                stream {
                    id
                }
            }
        }
        "#;

        let response = self
            .client
            .post("https://gql.twitch.tv/gql")
            .header("Client-Id", ANDROID_CLIENT_ID)
            .header("Authorization", format!("Bearer {}", token))
            .json(&serde_json::json!({
                "query": query,
                "variables": {
                    "channelID": channel_id
                }
            }))
            .send()
            .await?;

        let result: serde_json::Value = response.json().await?;

        if let Some(user) = result["data"]["user"].as_object() {
            if let Some(stream) = user["stream"].as_object() {
                if let Some(id) = stream["id"].as_str() {
                    return Ok(Some(id.to_string()));
                }
            }
        }

        Ok(None)
    }

    /// Extract spade URL from channel page
    async fn get_spade_url(&self, channel_name: &str) -> Result<String> {
        let channel_url = format!("https://www.twitch.tv/{}", channel_name);

        // Fetch the channel page HTML
        let response = self
            .client
            .get(&channel_url)
            .header("User-Agent", USER_AGENT)
            .send()
            .await?;

        let html = response.text().await?;

        // Try to find spade URL directly in the HTML
        let spade_pattern =
            Regex::new(r#""spade_?url":\s*"(https://video-edge-[.\w\-/]+\.ts(?:\?[^"]*)?)"#)?;

        if let Some(captures) = spade_pattern.captures(&html) {
            if let Some(url) = captures.get(1) {
                return Ok(url.as_str().to_string());
            }
        }

        // If not found directly, look for settings JS file
        let settings_pattern =
            Regex::new(r#"src="(https://[\w.]+/config/settings\.[0-9a-f]{32}\.js)"#)?;

        if let Some(captures) = settings_pattern.captures(&html) {
            if let Some(settings_url) = captures.get(1) {
                // Fetch the settings JS file
                let settings_response = self.client.get(settings_url.as_str()).send().await?;

                let settings_js = settings_response.text().await?;

                // Look for spade URL in settings
                if let Some(captures) = spade_pattern.captures(&settings_js) {
                    if let Some(url) = captures.get(1) {
                        return Ok(url.as_str().to_string());
                    }
                }
            }
        }

        Err(anyhow::anyhow!(
            "Could not find spade URL for channel {}",
            channel_name
        ))
    }

    /// Send watch payload to earn channel points
    async fn send_watch_payload(
        &self,
        spade_url: &str,
        channel_id: &str,
        channel_login: &str,
        broadcast_id: &str,
        user_id: &str,
    ) -> Result<bool> {
        // Create the minute-watched payload
        let payload_data = json!([{
            "event": "minute-watched",
            "properties": {
                "broadcast_id": broadcast_id,
                "channel_id": channel_id,
                "channel": channel_login,
                "hidden": false,
                "live": true,
                "location": "channel",
                "logged_in": true,
                "muted": false,
                "player": "site",
                "user_id": user_id
            }
        }]);

        // Minify and base64 encode the payload
        let payload_str = serde_json::to_string(&payload_data)?;
        let encoded = general_purpose::STANDARD.encode(payload_str.as_bytes());

        // Send the watch payload
        let response = self
            .client
            .post(spade_url)
            .form(&[("data", encoded)])
            .send()
            .await?;

        let status = response.status();
        Ok(status.as_u16() == 204)
    }

    /// Get user ID from token
    pub async fn get_user_id(&self, token: &str) -> Result<String> {
        let response = self
            .client
            .get("https://id.twitch.tv/oauth2/validate")
            .header("Authorization", format!("OAuth {}", token))
            .send()
            .await?;

        if response.status().is_success() {
            let data: serde_json::Value = response.json().await?;
            if let Some(user_id) = data["user_id"].as_str() {
                return Ok(user_id.to_string());
            }
        }

        Err(anyhow::anyhow!("Failed to get user ID from token"))
    }

    /// Get currently watching streams
    pub async fn get_watching_streams(&self) -> Vec<WatchingStream> {
        self.watching_streams
            .read()
            .await
            .values()
            .cloned()
            .collect()
    }

    /// Get all tracked channel points balances
    pub async fn get_all_balances(&self) -> Vec<ChannelPointsBalance> {
        self.balances.read().await.values().cloned().collect()
    }

    /// Get channel points claim history
    #[allow(dead_code)]
    pub async fn get_claim_history(&self) -> Vec<ChannelPointsClaim> {
        self.claim_history.read().await.clone()
    }

    /// Get total points earned from history
    #[allow(dead_code)]
    pub async fn get_total_points_earned(&self) -> i32 {
        self.claim_history
            .read()
            .await
            .iter()
            .map(|c| c.points_earned)
            .sum()
    }
}

#[derive(Debug, Clone)]
pub struct ChannelPointsContext {
    pub channel_id: String,
    pub channel_login: String,
    pub balance: i32,
    pub available_claim: Option<ClaimInfo>,
    /// Custom channel points name (e.g., "Kisses" for Hamlinz)
    pub points_name: Option<String>,
    /// Custom channel points icon URL
    pub points_icon_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ClaimInfo {
    pub claim_id: String,
    pub points: i32,
}
