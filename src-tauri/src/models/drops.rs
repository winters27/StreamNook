use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DropCampaign {
    pub id: String,
    pub name: String,
    pub game_id: String,
    pub game_name: String,
    pub description: String,
    pub image_url: String,
    pub start_at: DateTime<Utc>,
    pub end_at: DateTime<Utc>,
    pub time_based_drops: Vec<TimeBasedDrop>,
    #[serde(default)]
    pub is_account_connected: bool,
    #[serde(default)]
    pub allowed_channels: Vec<AllowedChannel>,
    #[serde(default)]
    pub is_acl_based: bool,
    #[serde(default)]
    pub details_url: Option<String>,  // "About this drop" link
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllowedChannel {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeBasedDrop {
    pub id: String,
    pub name: String,
    pub required_minutes_watched: i32,
    pub benefit_edges: Vec<DropBenefit>,
    #[serde(rename = "self")]
    pub progress: Option<DropProgress>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DropBenefit {
    pub id: String,
    pub name: String,
    pub image_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DropProgress {
    pub campaign_id: String,
    pub drop_id: String,
    pub current_minutes_watched: i32,
    pub required_minutes_watched: i32,
    pub is_claimed: bool,
    pub last_updated: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimedDrop {
    pub id: String,
    pub campaign_id: String,
    pub drop_id: String,
    pub drop_name: String,
    pub game_name: String,
    pub benefit_name: String,
    pub benefit_image_url: String,
    pub claimed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelPointsBalance {
    pub channel_id: String,
    pub channel_name: String,
    pub balance: i32,
    pub last_updated: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelPointsClaim {
    pub id: String,
    pub channel_id: String,
    pub channel_name: String,
    pub points_earned: i32,
    pub claimed_at: DateTime<Utc>,
    pub claim_type: ChannelPointsClaimType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ChannelPointsClaimType {
    Watch,      // Regular watch time bonus
    Raid,       // Participated in raid
    Prediction, // Prediction reward
    Bonus,      // Bonus chest claim
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DropsStatistics {
    pub total_drops_claimed: i32,
    pub total_channel_points_earned: i32,
    pub active_campaigns: i32,
    pub drops_in_progress: i32,
    pub recent_claims: Vec<ClaimedDrop>,
    pub channel_points_history: Vec<ChannelPointsClaim>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DropsSettings {
    pub auto_claim_drops: bool,
    pub auto_claim_channel_points: bool,
    pub notify_on_drop_available: bool,
    pub notify_on_drop_claimed: bool,
    pub notify_on_points_claimed: bool,
    pub check_interval_seconds: u64,
    // Mining-specific settings
    pub auto_mining_enabled: bool,
    pub priority_games: Vec<String>,
    pub excluded_games: HashSet<String>,
    pub priority_mode: PriorityMode,
    pub watch_interval_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PriorityMode {
    PriorityOnly,    // Only mine priority games
    EndingSoonest,   // Prioritize campaigns ending soon
    LowAvailFirst,   // Prioritize low availability campaigns
}

impl Default for DropsSettings {
    fn default() -> Self {
        Self {
            auto_claim_drops: true,
            auto_claim_channel_points: true,
            notify_on_drop_available: true,
            notify_on_drop_claimed: true,
            notify_on_points_claimed: false,
            check_interval_seconds: 60,
            // Mining defaults
            auto_mining_enabled: false,
            priority_games: Vec::new(),
            excluded_games: HashSet::new(),
            priority_mode: PriorityMode::PriorityOnly,
            watch_interval_seconds: 20,
        }
    }
}

// Channel information for mining
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MiningChannel {
    pub id: String,
    #[serde(rename = "display_name")]
    pub name: String,
    pub game_id: String,
    pub game_name: String,
    #[serde(rename = "viewer_count")]
    pub viewers: i32,
    pub drops_enabled: bool,
    #[serde(rename = "is_live")]
    pub is_online: bool,
    pub is_acl_based: bool,
}

// Mining status information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MiningStatus {
    pub is_mining: bool,
    pub current_channel: Option<MiningChannel>,
    pub current_campaign: Option<String>,
    pub current_drop: Option<CurrentDropInfo>,
    pub eligible_channels: Vec<MiningChannel>,
    pub last_update: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurrentDropInfo {
    pub drop_id: String,
    pub drop_name: String,
    pub campaign_name: String,
    pub game_name: String,
    pub current_minutes: i32,
    pub required_minutes: i32,
    pub progress_percentage: f32,
    pub estimated_completion: Option<DateTime<Utc>>,
}

impl Default for MiningStatus {
    fn default() -> Self {
        Self {
            is_mining: false,
            current_channel: None,
            current_campaign: None,
            current_drop: None,
            eligible_channels: Vec::new(),
            last_update: Utc::now(),
        }
    }
}

// GQL Models for fetching inventory
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GqlInventoryResponse {
    pub data: GqlData,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GqlData {
    pub current_user: CurrentUser,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CurrentUser {
    pub inventory: Inventory,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub drop_campaigns_in_progress: Option<Vec<DropCampaignInProgress>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DropCampaignInProgress {
    pub id: String,
    pub name: String,
    pub status: String,
    pub game: Game,
    #[serde(rename = "self")]
    pub account_info: AccountInfo,
    pub time_based_drops: Vec<GqlTimeBasedDrop>,
    pub start_at: DateTime<Utc>,
    pub end_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub is_account_connected: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    pub id: String,
    pub name: String,
    pub box_art_url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GqlTimeBasedDrop {
    pub id: String,
    pub name: String,
    pub required_minutes_watched: i32,
    #[serde(rename = "self")]
    pub drop_instance: Option<DropInstance>,
    pub benefit_edges: Vec<BenefitEdge>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DropInstance {
    pub id: String,
    pub current_minutes_watched: i32,
    pub is_claimed: bool,
    pub drop_instance_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BenefitEdge {
    pub benefit: Benefit,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Benefit {
    pub id: String,
    pub name: String,
    pub image_asset_url: String,
}

// Inventory-specific models
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InventoryItem {
    pub campaign: DropCampaign,
    pub status: CampaignStatus,
    pub progress_percentage: f32,
    pub total_drops: i32,
    pub claimed_drops: i32,
    pub drops_in_progress: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum CampaignStatus {
    Active,
    Upcoming,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InventoryResponse {
    pub items: Vec<InventoryItem>,
    pub total_campaigns: i32,
    pub active_campaigns: i32,
    pub upcoming_campaigns: i32,
    pub expired_campaigns: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GameEventDrop {
    pub id: String,
    pub last_awarded_at: DateTime<Utc>,
}
