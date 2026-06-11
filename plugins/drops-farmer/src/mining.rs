//! Drops mining for the farming sidecar: fetch active campaigns, pick one by
//! the user's priority and mode settings, find an eligible live channel,
//! report minute-watched to advance the drop, recover from stalls and
//! offline channels, and claim each drop when it completes. This is the
//! former native miner's behavior, reimplemented here so the core app no
//! longer contains it.

use anyhow::{anyhow, Result};
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::protocol::Host;
use crate::twitch::{self, Cred};

const CLAIM_QUERY_HASH: &str =
    "a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930";

/// One time-based drop within a campaign.
#[derive(Clone, Debug)]
pub struct Drop {
    pub required_minutes: i32,
    pub current_minutes: i32,
    pub is_claimed: bool,
    pub drop_instance_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Campaign {
    pub id: String,
    pub game_id: String,
    pub game_name: String,
    pub end_at: String,
    /// Allow-listed channels (id, login); empty means any DROPS_ENABLED stream.
    pub acl_channels: Vec<(String, String)>,
    pub drops: Vec<Drop>,
}

impl Campaign {
    /// The first drop still being worked toward (unclaimed, not yet complete).
    pub fn active_drop(&self) -> Option<&Drop> {
        self.drops
            .iter()
            .find(|d| !d.is_claimed && d.current_minutes < d.required_minutes)
    }
    /// A completed-but-unclaimed drop ready to claim.
    pub fn claimable_drop(&self) -> Option<&Drop> {
        self.drops.iter().find(|d| {
            !d.is_claimed
                && d.current_minutes >= d.required_minutes
                && d.drop_instance_id.is_some()
        })
    }
}

#[derive(Clone, Debug)]
pub struct MiningChannel {
    pub id: String,
    pub login: String,
    pub viewers: i32,
}

fn gql(client: &Client, cred: &Cred, device_id: &str, session_id: &str) -> reqwest::RequestBuilder {
    client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", &cred.client_id)
        .header("Authorization", format!("OAuth {}", cred.token))
        .header("Accept-Language", "en-US")
        .header("Origin", "https://www.twitch.tv")
        .header("Referer", "https://www.twitch.tv")
        .header("X-Device-Id", device_id)
        .header("Client-Session-Id", session_id)
}

/// Fetches the user's active drop campaigns with per-drop progress. Requires
/// the account to have connected the campaign (the API returns progress only
/// then), which is the same constraint the native miner had.
pub async fn fetch_campaigns(
    client: &Client,
    cred: &Cred,
    device_id: &str,
    session_id: &str,
) -> Result<Vec<Campaign>> {
    let query = r#"
    query DropCampaigns {
        currentUser {
            dropCampaigns {
                id status endAt
                game { id displayName }
                allow { isEnabled channels { id name } }
                timeBasedDrops {
                    id requiredMinutesWatched
                    self { currentMinutesWatched isClaimed dropInstanceID }
                }
            }
        }
    }"#;
    let body: Value = gql(client, cred, device_id, session_id)
        .json(&json!({ "query": query, "variables": {} }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await?
        .json()
        .await?;

    let mut campaigns = Vec::new();
    let Some(list) = body["data"]["currentUser"]["dropCampaigns"].as_array() else {
        return Ok(campaigns);
    };
    for c in list {
        if c["status"].as_str() != Some("ACTIVE") {
            continue;
        }
        let acl_enabled = c["allow"]["isEnabled"].as_bool().unwrap_or(false);
        let acl_channels = if acl_enabled {
            c["allow"]["channels"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|ch| {
                            Some((ch["id"].as_str()?.to_string(), ch["name"].as_str()?.to_string()))
                        })
                        .collect()
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let drops = c["timeBasedDrops"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .map(|d| Drop {
                        required_minutes: d["requiredMinutesWatched"].as_i64().unwrap_or(0) as i32,
                        current_minutes: d["self"]["currentMinutesWatched"].as_i64().unwrap_or(0)
                            as i32,
                        is_claimed: d["self"]["isClaimed"].as_bool().unwrap_or(false),
                        drop_instance_id: d["self"]["dropInstanceID"].as_str().map(String::from),
                    })
                    .collect()
            })
            .unwrap_or_default();
        campaigns.push(Campaign {
            id: c["id"].as_str().unwrap_or_default().to_string(),
            game_id: c["game"]["id"].as_str().unwrap_or_default().to_string(),
            game_name: c["game"]["displayName"].as_str().unwrap_or_default().to_string(),
            end_at: c["endAt"].as_str().unwrap_or_default().to_string(),
            acl_channels,
            drops,
        });
    }
    Ok(campaigns)
}

/// Live channels streaming a game with drops enabled, most-viewers first.
pub async fn fetch_game_streams(
    client: &Client,
    cred: &Cred,
    game_id: &str,
) -> Result<Vec<MiningChannel>> {
    let query = r#"
    query GameStreams($gameID: ID!, $first: Int!) {
        game(id: $gameID) {
            streams(first: $first, options: { systemFilters: [DROPS_ENABLED] }) {
                edges { node { broadcaster { id login } viewersCount } }
            }
        }
    }"#;
    let body: Value = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", &cred.client_id)
        .header("Authorization", format!("Bearer {}", cred.token))
        .json(&json!({ "query": query, "variables": { "gameID": game_id, "first": 20 } }))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?
        .json()
        .await?;
    let mut channels = Vec::new();
    if let Some(edges) = body["data"]["game"]["streams"]["edges"].as_array() {
        for edge in edges {
            let node = &edge["node"];
            if let (Some(id), Some(login)) = (
                node["broadcaster"]["id"].as_str(),
                node["broadcaster"]["login"].as_str(),
            ) {
                channels.push(MiningChannel {
                    id: id.to_string(),
                    login: login.to_string(),
                    viewers: node["viewersCount"].as_i64().unwrap_or(0) as i32,
                });
            }
        }
    }
    // Prefer the most-watched stream: more stable, less likely to end mid-drop.
    channels.sort_by(|a, b| b.viewers.cmp(&a.viewers));
    Ok(channels)
}

/// Confirms a specific channel (an allow-listed one) is live, and returns it.
pub async fn channel_if_live(
    client: &Client,
    cred: &Cred,
    channel_id: &str,
    login: &str,
) -> Result<Option<MiningChannel>> {
    let query = r#"
    query StreamLive($id: ID!) {
        user(id: $id) { stream { id viewersCount } }
    }"#;
    let body: Value = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", &cred.client_id)
        .header("Authorization", format!("Bearer {}", cred.token))
        .json(&json!({ "query": query, "variables": { "id": channel_id } }))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?
        .json()
        .await?;
    if body["data"]["user"]["stream"]["id"].as_str().is_some() {
        Ok(Some(MiningChannel {
            id: channel_id.to_string(),
            login: login.to_string(),
            viewers: body["data"]["user"]["stream"]["viewersCount"].as_i64().unwrap_or(0) as i32,
        }))
    } else {
        Ok(None)
    }
}

/// Claims a completed drop by its instance id.
pub async fn claim_drop(
    client: &Client,
    cred: &Cred,
    device_id: &str,
    session_id: &str,
    drop_instance_id: &str,
) -> Result<bool> {
    let body: Value = gql(client, cred, device_id, session_id)
        .json(&json!({
            "operationName": "DropsPage_ClaimDropRewards",
            "variables": { "input": { "dropInstanceID": drop_instance_id } },
            "extensions": { "persistedQuery": { "version": 1, "sha256Hash": CLAIM_QUERY_HASH } }
        }))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?
        .json()
        .await
        .map_err(|e| anyhow!("claim parse failed: {e}"))?;
    Ok(body.get("errors").is_none())
}

#[derive(Clone, Copy, PartialEq)]
pub enum PriorityMode {
    PriorityOnly,
    EndingSoonest,
    LowAvailFirst,
}

impl PriorityMode {
    pub fn parse(s: &str) -> Self {
        match s {
            "EndingSoonest" => PriorityMode::EndingSoonest,
            "LowAvailFirst" => PriorityMode::LowAvailFirst,
            _ => PriorityMode::PriorityOnly,
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
pub enum RecoveryMode {
    Automatic,
    Relaxed,
    ManualOnly,
}

impl RecoveryMode {
    pub fn parse(s: &str) -> Self {
        match s {
            "Relaxed" => RecoveryMode::Relaxed,
            "ManualOnly" => RecoveryMode::ManualOnly,
            _ => RecoveryMode::Automatic,
        }
    }
    /// Stall threshold multiplier: Relaxed is more patient before switching.
    fn patience(&self) -> u64 {
        match self {
            RecoveryMode::Automatic => 1,
            RecoveryMode::Relaxed => 2,
            RecoveryMode::ManualOnly => u64::MAX,
        }
    }
}

#[derive(Clone)]
pub struct MiningSettings {
    pub priority_games: Vec<String>, // lowercase game names
    pub excluded_games: Vec<String>, // lowercase game names
    pub priority_mode: PriorityMode,
    pub recovery_mode: RecoveryMode,
    pub detect_game_change: bool,
    pub stale_threshold_secs: u64,
    pub blacklist_secs: u64,
}

impl Default for MiningSettings {
    fn default() -> Self {
        Self {
            priority_games: Vec::new(),
            excluded_games: Vec::new(),
            priority_mode: PriorityMode::PriorityOnly,
            recovery_mode: RecoveryMode::Automatic,
            detect_game_change: true,
            stale_threshold_secs: 420,
            blacklist_secs: 600,
        }
    }
}

/// What the miner is currently told to do. Set by the panel toggle or, once
/// the cockpit drives it, by hooked actions from the host UI.
#[derive(Clone, PartialEq)]
pub enum MiningTarget {
    Stopped,
    /// Pick the best campaign by the user's priority and mode.
    Auto,
    /// Mine one specific campaign by id.
    Campaign(String),
}

/// Drives drops mining: one campaign and one channel at a time, advancing the
/// drop with minute-watched, recovering from stalls and offline or
/// category-changed channels, and claiming completed drops.
pub struct Miner {
    pub settings: MiningSettings,
    pub target: MiningTarget,
    campaigns: Vec<Campaign>,
    campaigns_tick: u64,
    current: Option<MiningChannel>,
    /// The campaign we are mining. Kept sticky so Auto mode doesn't re-pick a
    /// different (equally-ranked) campaign every tick and thrash.
    current_campaign_id: Option<String>,
    last_minutes: i32,
    last_progress_tick: u64,
    /// channel_id -> tick when its blacklist expires.
    blacklist: HashMap<String, u64>,
}

impl Miner {
    pub fn new() -> Self {
        Self {
            settings: MiningSettings::default(),
            target: MiningTarget::Stopped,
            campaigns: Vec::new(),
            campaigns_tick: 0,
            current: None,
            current_campaign_id: None,
            last_minutes: -1,
            last_progress_tick: 0,
            blacklist: HashMap::new(),
        }
    }

    pub fn is_active(&self) -> bool {
        self.target != MiningTarget::Stopped
    }

    pub fn set_target(&mut self, target: MiningTarget) {
        if target == MiningTarget::Stopped {
            self.current = None;
            self.current_campaign_id = None;
        }
        self.target = target;
    }

    /// A status snapshot for the host UI's drops.status slot.
    pub fn status(&self) -> Value {
        let campaign = self
            .current_campaign_id
            .as_ref()
            .filter(|_| self.current.is_some())
            .and_then(|id| self.campaigns.iter().find(|c| &c.id == id));
        json!({
            "active": self.is_active(),
            "is_mining": self.current.is_some(),
            "game_name": campaign.map(|c| c.game_name.clone()),
            "campaign_id": campaign.map(|c| c.id.clone()),
            "channel_login": self.current.as_ref().map(|c| c.login.clone()),
            "current_minutes": campaign.and_then(|c| c.active_drop()).map(|d| d.current_minutes),
            "required_minutes": campaign.and_then(|c| c.active_drop()).map(|d| d.required_minutes),
        })
    }

    fn game_excluded(&self, game_name: &str) -> bool {
        let g = game_name.to_lowercase();
        self.settings.excluded_games.iter().any(|e| e == &g)
    }

    fn priority_index(&self, game_name: &str) -> Option<usize> {
        let g = game_name.to_lowercase();
        self.settings.priority_games.iter().position(|p| p == &g)
    }

    /// Campaigns worth mining now, ordered by the user's settings.
    fn ranked_campaigns(&self) -> Vec<Campaign> {
        let mut list: Vec<Campaign> = self
            .campaigns
            .iter()
            .filter(|c| c.active_drop().is_some() && !self.game_excluded(&c.game_name))
            .filter(|c| {
                self.settings.priority_mode != PriorityMode::PriorityOnly
                    || self.settings.priority_games.is_empty()
                    || self.priority_index(&c.game_name).is_some()
            })
            .cloned()
            .collect();
        list.sort_by(|a, b| {
            // Priority-list order always wins when set.
            let pa = self.priority_index(&a.game_name);
            let pb = self.priority_index(&b.game_name);
            match (pa, pb) {
                (Some(x), Some(y)) => return x.cmp(&y),
                (Some(_), None) => return std::cmp::Ordering::Less,
                (None, Some(_)) => return std::cmp::Ordering::Greater,
                (None, None) => {}
            }
            match self.settings.priority_mode {
                PriorityMode::EndingSoonest => a.end_at.cmp(&b.end_at),
                PriorityMode::LowAvailFirst => {
                    a.acl_channels.len().cmp(&b.acl_channels.len())
                }
                PriorityMode::PriorityOnly => std::cmp::Ordering::Equal,
            }
        });
        list
    }

    /// Picks an eligible live channel for a campaign, skipping blacklisted
    /// ones. Prefers allow-listed channels; otherwise the most-watched
    /// drops-enabled stream of the game.
    async fn pick_channel(
        &self,
        client: &Client,
        cred: &Cred,
        campaign: &Campaign,
    ) -> Option<MiningChannel> {
        if !campaign.acl_channels.is_empty() {
            for (id, login) in &campaign.acl_channels {
                if self.blacklist.contains_key(id) {
                    continue;
                }
                if let Ok(Some(ch)) = channel_if_live(client, cred, id, login).await {
                    return Some(ch);
                }
            }
            return None;
        }
        let streams = fetch_game_streams(client, cred, &campaign.game_id).await.ok()?;
        streams.into_iter().find(|c| !self.blacklist.contains_key(&c.id))
    }

    fn blacklist_current(&mut self, tick: u64) {
        if let Some(ch) = self.current.take() {
            self.blacklist
                .insert(ch.id, tick + self.settings.blacklist_secs / 60);
        }
    }

    /// One mining step. Returns the channel id currently being mined (so the
    /// caller can treat it as one of the two concurrent watch slots).
    #[allow(clippy::too_many_arguments)]
    pub async fn tick(
        &mut self,
        client: &Client,
        cred: &Cred,
        user_id: &str,
        device_id: &str,
        session_id: &str,
        tick_count: u64,
        host: &Host,
    ) -> Option<String> {
        if !self.is_active() {
            self.current = None;
            return None;
        }
        self.blacklist.retain(|_, exp| *exp > tick_count);

        // Refresh campaigns periodically (and on first run) to learn progress.
        if self.campaigns.is_empty() || tick_count.saturating_sub(self.campaigns_tick) >= 3 {
            match fetch_campaigns(client, cred, device_id, session_id).await {
                Ok(c) => {
                    self.campaigns = c;
                    self.campaigns_tick = tick_count;
                }
                Err(e) => host.log("debug", format!("campaign fetch failed: {e}")).await,
            }
            // Claim anything finished.
            let claimable: Vec<String> = self
                .campaigns
                .iter()
                .filter_map(|c| c.claimable_drop().and_then(|d| d.drop_instance_id.clone()))
                .collect();
            for instance in claimable {
                if let Ok(true) =
                    claim_drop(client, cred, device_id, session_id, &instance).await
                {
                    host.notify_user("info", "Claimed a completed drop").await;
                }
            }
        }

        let campaign = match &self.target {
            MiningTarget::Stopped => None,
            MiningTarget::Auto => {
                // Stay on the current campaign while it is still minable, so we
                // don't switch between equally-ranked campaigns every tick.
                let ranked = self.ranked_campaigns();
                self.current_campaign_id
                    .as_ref()
                    .and_then(|id| ranked.iter().find(|c| &c.id == id).cloned())
                    .or_else(|| ranked.into_iter().next())
            }
            MiningTarget::Campaign(id) => self
                .campaigns
                .iter()
                .find(|c| &c.id == id && c.active_drop().is_some())
                .cloned(),
        };
        let Some(campaign) = campaign else {
            self.current = None;
            self.current_campaign_id = None;
            return None;
        };

        // Stall detection against the active drop's progress for this campaign.
        let active_minutes = self
            .campaigns
            .iter()
            .find(|c| c.id == campaign.id)
            .and_then(|c| c.active_drop())
            .map(|d| d.current_minutes)
            .unwrap_or(self.last_minutes);
        if self.current.is_some() && self.current_campaign_id.as_deref() == Some(campaign.id.as_str()) {
            if active_minutes > self.last_minutes {
                self.last_minutes = active_minutes;
                self.last_progress_tick = tick_count;
            } else {
                let stalled_secs = tick_count.saturating_sub(self.last_progress_tick) * 60;
                let limit = self
                    .settings
                    .stale_threshold_secs
                    .saturating_mul(self.settings.recovery_mode.patience());
                if stalled_secs >= limit {
                    host.log("debug", "drop progress stalled; switching channel").await;
                    self.blacklist_current(tick_count);
                }
            }
        }

        // Acquire a channel if we don't have one for the current campaign.
        if self.current.is_none()
            || self.current_campaign_id.as_deref() != Some(campaign.id.as_str())
        {
            match self.pick_channel(client, cred, &campaign).await {
                Some(ch) => {
                    host.log("info", format!("mining {} for {}", ch.login, campaign.game_name))
                        .await;
                    self.current = Some(ch);
                    self.current_campaign_id = Some(campaign.id.clone());
                    self.last_minutes = active_minutes;
                    self.last_progress_tick = tick_count;
                }
                None => {
                    // No live channel for this campaign right now; drop it so a
                    // different campaign can be tried next tick.
                    self.current = None;
                    self.current_campaign_id = None;
                    return None;
                }
            }
        }

        let channel = self.current.clone()?;

        // Resolve the live broadcast (also tells us if it went offline or
        // changed game), then report one minute-watched.
        match twitch::fetch_stream_info(client, &channel.id, cred).await {
            Ok(Some((broadcast_id, game_id, game_name))) => {
                if self.settings.detect_game_change
                    && !game_id.is_empty()
                    && game_id != campaign.game_id
                {
                    host.log("debug", format!("{} changed game; switching", channel.login)).await;
                    self.blacklist_current(tick_count);
                    return None;
                }
                let watch = twitch::Channel {
                    channel_id: channel.id.clone(),
                    login: channel.login.clone(),
                };
                let _ = twitch::send_minute_watched(
                    client,
                    &watch,
                    &broadcast_id,
                    &game_id,
                    &game_name,
                    user_id,
                    cred,
                )
                .await;
                Some(channel.id)
            }
            Ok(None) => {
                // Offline: drop it and pick another next tick.
                host.log("debug", format!("{} went offline; switching", channel.login)).await;
                self.blacklist_current(tick_count);
                None
            }
            Err(_) => Some(channel.id),
        }
    }
}
