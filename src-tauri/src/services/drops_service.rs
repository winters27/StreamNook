use anyhow::Result;
use reqwest::header::{AUTHORIZATION, ACCEPT};
use reqwest::Client;
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::RwLock;
use std::collections::HashMap;
use chrono::{DateTime, Utc};
use crate::models::drops::*;
use crate::services::twitch_service::TwitchService;
use tokio::time::Duration;
use tauri::{AppHandle, Emitter};

const CLIENT_ID: &str = "1qgws7yzcp21g5ledlzffw3lmqdvie";

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
}

impl DropsService {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            settings: Arc::new(RwLock::new(DropsSettings::default())),
            drop_progress: Arc::new(RwLock::new(HashMap::new())),
            claimed_drops: Arc::new(RwLock::new(Vec::new())),
            channel_points_history: Arc::new(RwLock::new(Vec::new())),
            channel_points_balances: Arc::new(RwLock::new(HashMap::new())),
            monitoring_active: Arc::new(RwLock::new(false)),
            current_channel: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn get_settings(&self) -> DropsSettings {
        self.settings.read().await.clone()
    }

    pub async fn update_settings(&self, new_settings: DropsSettings) {
        let mut settings = self.settings.write().await;
        *settings = new_settings;
    }

    pub async fn get_active_campaigns(&self) -> Result<Vec<DropCampaign>> {
        let token = TwitchService::get_token().await?;
        
        let response = self.client
            .post("https://gql.twitch.tv/gql")
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("OAuth {}", token))
            .header(ACCEPT, "application/json")
            .json(&serde_json::json!({
                "operationName": "ViewerDropsDashboard",
                "variables": {"fetchRewardCampaigns": true},
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "5a4da2ab3d5b47c9f9ce864e727b2cb346af1e3ea8b897fe8f704a97ff017619",
                    }
                }
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
        let mut progress_map = self.drop_progress.write().await;

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
                is_account_connected: true, // User campaigns are always connected
            });
        }

        Ok(result)
    }


    pub async fn claim_drop(&self, drop_id: &str) -> Result<()> {
        let token = TwitchService::get_token().await?;

        let mutation = r#"
        mutation ClaimDrop($input: ClaimDropRewardsInput!) {
            claimDropRewards(input: $input) {
                status
            }
        }
        "#;

        let response = self.client
            .post("https://gql.twitch.tv/gql")
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("OAuth {}", token))
            .header(ACCEPT, "application/json")
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
        let token = TwitchService::get_token().await?;

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
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("OAuth {}", token))
            .header(ACCEPT, "application/json")
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
        let token = TwitchService::get_token().await?;

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
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("OAuth {}", token))
            .header(ACCEPT, "application/json")
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

        DropsStatistics {
            total_drops_claimed: claimed_drops.len() as i32,
            total_channel_points_earned,
            active_campaigns: 0, // Will be updated when campaigns are fetched
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

                    // Check drops progress
                    if let Ok(_campaigns) = Self::get_active_campaigns_internal(
                        &client,
                        &drop_progress,
                    ).await {
                        // Check for claimable drops
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

    // Internal helper methods that don't require &self
    async fn check_channel_points_internal(
        client: &Client,
        channel_id: &str,
        channel_name: &str,
        balances: &Arc<RwLock<HashMap<String, ChannelPointsBalance>>>,
    ) -> Result<Option<ChannelPointsClaim>> {
        let token = TwitchService::get_token().await?;

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
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("OAuth {}", token))
            .header(ACCEPT, "application/json")
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
        let token = TwitchService::get_token().await?;

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
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("OAuth {}", token))
            .header(ACCEPT, "application/json")
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
        let token = TwitchService::get_token().await?;
        
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
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("OAuth {}", token))
            .header(ACCEPT, "application/json")
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
            });
        }

        Ok(result)
    }

    async fn claim_drop_internal(
        client: &Client,
        drop_id: &str,
        drop_progress: &Arc<RwLock<HashMap<String, DropProgress>>>,
    ) -> Result<()> {
        let token = TwitchService::get_token().await?;

        let mutation = r#"
        mutation ClaimDrop($input: ClaimDropRewardsInput!) {
            claimDropRewards(input: $input) {
                status
            }
        }
        "#;

        let response = client
            .post("https://gql.twitch.tv/gql")
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("OAuth {}", token))
            .header(ACCEPT, "application/json")
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
