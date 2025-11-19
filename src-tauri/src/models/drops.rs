use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeBasedDrop {
    pub id: String,
    pub name: String,
    pub required_minutes_watched: i32,
    pub benefit_edges: Vec<DropBenefit>,
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
}

impl Default for DropsSettings {
    fn default() -> Self {
        Self {
            auto_claim_drops: true,
            auto_claim_channel_points: true,
            notify_on_drop_available: true,
            notify_on_drop_claimed: true,
            notify_on_points_claimed: false, // Less noisy by default
            check_interval_seconds: 60, // Check every minute
        }
    }
}
