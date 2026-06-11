//! Drops and Points Farmer — a StreamNook plugin.
//!
//! A separate program that StreamNook starts and talks to over JSON-RPC. It
//! runs background channel-points farming (and, in a later version, drops
//! mining) entirely in its own process, with its own networking, using a
//! Twitch credential the host hands over only after the user consents. The
//! core StreamNook binary contains none of this behavior.

mod mining;
mod protocol;
mod twitch;

use mining::{MiningTarget, PriorityMode, RecoveryMode};
use protocol::{read_loop, Host, Inbound};
use serde_json::{json, Value};
use std::collections::HashMap;
use twitch::{Channel, Cred};

/// Watch rotation, mirroring the former native farmer.
const MAX_CONCURRENT_DEFAULT: usize = 2;
const ROTATION_TICKS: u64 = 15; // re-pick the watch set every 15 minutes
const CLAIM_EVERY_TICKS: u64 = 5; // sweep bonus chests every 5 minutes

/// Parses a panel string_list value into trimmed, lowercased, non-empty entries.
fn string_list(arr: &[Value]) -> Vec<String> {
    arr.iter()
        .filter_map(|v| v.as_str())
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

struct Settings {
    active: bool,
    max_concurrent: usize,
    priority_logins: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            active: true,
            max_concurrent: MAX_CONCURRENT_DEFAULT,
            priority_logins: Vec::new(),
        }
    }
}

struct Farmer {
    host: Host,
    client: reqwest::Client,
    device_id: String,
    session_id: String,
    settings: Settings,
    live: Vec<Channel>,
    last_watched: HashMap<String, u64>,
    current_set: Vec<Channel>,
    tick_count: u64,
    cred: Option<Cred>,
    user_id: Option<String>,
    credential_denied: bool,
    miner: mining::Miner,
    /// Directory the host gave us to persist state in.
    data_dir: String,
    /// The plugin's own config (the rich DropsSettings shape). This plugin
    /// owns and persists its automation config; the app's settings screen
    /// reads it via drops.get-config and writes it via drops.configure.
    config: Value,
}

impl Farmer {
    fn new(host: Host) -> Self {
        Self {
            host,
            client: reqwest::Client::new(),
            device_id: uuid::Uuid::new_v4().simple().to_string(),
            session_id: uuid::Uuid::new_v4().simple().to_string(),
            settings: Settings::default(),
            live: Vec::new(),
            last_watched: HashMap::new(),
            current_set: Vec::new(),
            tick_count: 0,
            cred: None,
            user_id: None,
            credential_denied: false,
            miner: mining::Miner::new(),
            data_dir: String::new(),
            config: json!({}),
        }
    }

    fn config_path(&self) -> std::path::PathBuf {
        std::path::Path::new(&self.data_dir).join("config.json")
    }

    /// Loads persisted config on startup and applies it, resuming auto-mining
    /// if it was on. Called once the host hands over the data directory.
    fn load_config(&mut self) {
        if let Ok(text) = std::fs::read_to_string(self.config_path()) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                self.config = value.clone();
                self.apply_config(&value);
                if value.get("auto_mining_enabled").and_then(|v| v.as_bool()) == Some(true) {
                    self.miner.set_target(MiningTarget::Auto);
                }
            }
        }
    }

    fn save_config(&self) {
        if self.data_dir.is_empty() {
            return;
        }
        if let Ok(text) = serde_json::to_string_pretty(&self.config) {
            let _ = std::fs::write(self.config_path(), text);
        }
    }

    /// Applies the app's native Drops settings (the rich DropsSettings shape)
    /// pushed via drops.configure. This is the single source of config; the
    /// plugin keeps no settings UI of its own. The mining target (start/stop,
    /// or a specific campaign) is driven separately by the mine actions, not
    /// by config, so editing settings never disturbs what is being mined.
    fn apply_config(&mut self, s: &Value) {
        // Channel-points farming.
        if let Some(active) = s.get("auto_claim_channel_points").and_then(|v| v.as_bool()) {
            self.settings.active = active;
        }
        let reserve = s
            .get("reserve_token_for_current_stream")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        // The watched channel is covered by the core heartbeat, so a reserved
        // token leaves the background farmer one slot; otherwise it uses both.
        self.settings.max_concurrent = if reserve { 1 } else { 2 };
        if let Some(arr) = s.get("priority_farm_channels").and_then(|v| v.as_array()) {
            self.settings.priority_logins = arr
                .iter()
                .filter_map(|c| c.get("channel_login").and_then(|l| l.as_str()))
                .map(|l| l.to_lowercase())
                .collect();
        }

        // Drops mining.
        let m = &mut self.miner.settings;
        if let Some(list) = s.get("priority_games").and_then(|v| v.as_array()) {
            m.priority_games = string_list(list);
        }
        if let Some(list) = s.get("excluded_games").and_then(|v| v.as_array()) {
            m.excluded_games = string_list(list);
        }
        if let Some(mode) = s.get("priority_mode").and_then(|v| v.as_str()) {
            m.priority_mode = PriorityMode::parse(mode);
        }
        if let Some(rec) = s.get("recovery_settings") {
            if let Some(mode) = rec.get("recovery_mode").and_then(|v| v.as_str()) {
                m.recovery_mode = RecoveryMode::parse(mode);
            }
            if let Some(d) = rec.get("detect_game_category_change").and_then(|v| v.as_bool()) {
                m.detect_game_change = d;
            }
            if let Some(n) = rec.get("stale_progress_threshold_seconds").and_then(|v| v.as_u64()) {
                m.stale_threshold_secs = n;
            }
            if let Some(n) = rec.get("streamer_blacklist_duration_seconds").and_then(|v| v.as_u64()) {
                m.blacklist_secs = n;
            }
        }
    }

    async fn on_initialized(&mut self) {
        // No host-rendered panel: this plugin is configured from the app's
        // native Drops settings, pushed in via the drops.configure action.
        self.host.log("info", "drops-farmer initialized").await;
    }

    /// Handles a hooked action the host UI invoked (e.g. the Drops center's
    /// Mine button), then replies to the host and pushes a fresh status so the
    /// cockpit updates without waiting for the next tick.
    async fn handle_action(&mut self, id: Value, action: &str, args: &Value) {
        let result = match action {
            "drops.mine" => {
                match args.get("campaign_id").and_then(|v| v.as_str()) {
                    Some(cid) => self.miner.set_target(MiningTarget::Campaign(cid.to_string())),
                    None => self.miner.set_target(MiningTarget::Auto),
                }
                json!({ "ok": true })
            }
            "drops.mine-auto" | "drops.mine-all" => {
                self.miner.set_target(MiningTarget::Auto);
                json!({ "ok": true })
            }
            "drops.stop" => {
                self.miner.set_target(MiningTarget::Stopped);
                json!({ "ok": true })
            }
            "drops.configure" => {
                self.config = args.clone();
                self.apply_config(args);
                self.save_config();
                json!({ "ok": true })
            }
            "drops.get-config" => self.config.clone(),
            other => {
                let _ = self
                    .host
                    .respond_error(id, -32601, &format!("unknown action: {other}"))
                    .await;
                return;
            }
        };
        let _ = self.host.respond(id, result).await;
        self.host.set_status("drops.status", self.miner.status()).await;
    }

    fn on_followed_live(&mut self, params: &Value) {
        self.live = params
            .get("channels")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|c| {
                        Some(Channel {
                            channel_id: c.get("channel_id")?.as_str()?.to_string(),
                            login: c.get("login")?.as_str()?.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
    }

    /// Ensures we hold a credential, requesting one (and triggering the host's
    /// consent prompt) only the first time it is actually needed. A denial
    /// stops further requests for the session.
    async fn ensure_credential(&mut self) -> Option<Cred> {
        if let Some(cred) = &self.cred {
            return Some(cred.clone());
        }
        if self.credential_denied {
            return None;
        }
        match self
            .host
            .request("get_credential", json!({ "kind": "twitch.android" }))
            .await
        {
            Ok(result) => {
                let token = result.get("token").and_then(|t| t.as_str())?.to_string();
                let client_id = result
                    .get("client_id")
                    .and_then(|c| c.as_str())
                    .unwrap_or_default()
                    .to_string();
                if client_id.is_empty() {
                    self.host
                        .log("error", "credential handover returned no client id")
                        .await;
                    return None;
                }
                let cred = Cred { token, client_id };
                self.cred = Some(cred.clone());
                // One-time confirmation once consent is granted and farming
                // actually begins.
                self.host
                    .notify_user("info", "Channel points farming is now active")
                    .await;
                Some(cred)
            }
            Err(e) => {
                // consent_denied or unavailable: stop asking this session.
                self.credential_denied = true;
                self.host
                    .log("info", format!("credential not available: {e}"))
                    .await;
                None
            }
        }
    }

    /// Picks up to `max` channels for points farming: priority logins first
    /// (when live), then least-recently-watched of the rest, skipping the
    /// channel already being mined for drops.
    fn pick_channels(&self, max: usize, exclude: &Option<String>) -> Vec<Channel> {
        let excluded = |id: &str| exclude.as_deref() == Some(id);
        let mut picked: Vec<Channel> = Vec::new();
        for login in &self.settings.priority_logins {
            if picked.len() >= max {
                break;
            }
            if let Some(ch) = self.live.iter().find(|c| &c.login == login) {
                if !excluded(&ch.channel_id) {
                    picked.push(ch.clone());
                }
            }
        }
        let mut rest: Vec<&Channel> = self
            .live
            .iter()
            .filter(|c| !picked.iter().any(|p| p.channel_id == c.channel_id))
            .filter(|c| !excluded(&c.channel_id))
            .collect();
        rest.sort_by_key(|c| self.last_watched.get(&c.channel_id).copied().unwrap_or(0));
        for ch in rest {
            if picked.len() >= max {
                break;
            }
            picked.push(ch.clone());
        }
        picked
    }

    async fn on_tick(&mut self) {
        let cp_active = self.settings.active && !self.live.is_empty();
        if !cp_active && !self.miner.is_active() {
            return;
        }
        let Some(cred) = self.ensure_credential().await else {
            return;
        };
        if self.user_id.is_none() {
            match twitch::fetch_user_id(&self.client, &cred.token).await {
                Ok(id) => self.user_id = Some(id),
                Err(e) => {
                    self.host.log("error", format!("user id fetch failed: {e}")).await;
                    return;
                }
            }
        }
        let user_id = self.user_id.clone().unwrap();
        self.tick_count += 1;

        // Drops mining runs first; the mined channel takes one of the two
        // concurrent watch slots, so points farming gets the rest.
        let mined = self
            .miner
            .tick(
                &self.client,
                &cred,
                &user_id,
                &self.device_id,
                &self.session_id,
                self.tick_count,
                &self.host,
            )
            .await;
        if self.miner.is_active() {
            self.host.set_status("drops.status", self.miner.status()).await;
        }

        if !cp_active {
            return;
        }

        let reserved = if mined.is_some() { 1 } else { 0 };
        let available = self.settings.max_concurrent.saturating_sub(reserved);
        let invalid = self.current_set.len() > available
            || mined
                .as_ref()
                .is_some_and(|m| self.current_set.iter().any(|c| &c.channel_id == m));
        if available == 0 {
            self.current_set.clear();
        } else if self.current_set.is_empty()
            || self.tick_count % ROTATION_TICKS == 1
            || invalid
        {
            self.current_set = self.pick_channels(available, &mined);
        }

        let set = self.current_set.clone();
        let mut watched = 0;
        for ch in &set {
            match twitch::fetch_stream_info(&self.client, &ch.channel_id, &cred).await {
                Ok(Some((broadcast_id, game_id, game_name))) => {
                    match twitch::send_minute_watched(
                        &self.client,
                        ch,
                        &broadcast_id,
                        &game_id,
                        &game_name,
                        &user_id,
                        &cred,
                    )
                    .await
                    {
                        Ok(true) => {
                            self.last_watched.insert(ch.channel_id.clone(), self.tick_count);
                            watched += 1;
                        }
                        Ok(false) => {}
                        Err(e) => self.host.log("debug", format!("watch send failed for {}: {e}", ch.login)).await,
                    }
                }
                Ok(None) => {} // not live anymore; rotation will replace it
                Err(e) => self.host.log("debug", format!("stream info failed for {}: {e}", ch.login)).await,
            }
        }
        if watched > 0 {
            self.host.log("debug", format!("watched {watched} channel(s)")).await;
        }

        // Bonus chest sweep across all live channels every few minutes.
        if self.tick_count % CLAIM_EVERY_TICKS == 0 {
            let live = self.live.clone();
            let mut claimed = 0;
            for ch in &live {
                match twitch::fetch_claim(
                    &self.client,
                    &ch.login,
                    &self.device_id,
                    &self.session_id,
                    &cred.token,
                )
                .await
                {
                    Ok(Some((channel_id, claim_id))) => {
                        if let Ok(true) = twitch::claim_points(
                            &self.client,
                            &channel_id,
                            &claim_id,
                            &self.device_id,
                            &self.session_id,
                            &cred,
                        )
                        .await
                        {
                            claimed += 1;
                        }
                    }
                    Ok(None) => {}
                    Err(_) => {}
                }
            }
            if claimed > 0 {
                self.host.log("info", format!("claimed {claimed} bonus chest(s)")).await;
            }
        }
    }
}

#[tokio::main]
async fn main() {
    let host = Host::new(tokio::io::stdout());
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Inbound>(64);

    tokio::spawn(read_loop(tokio::io::stdin(), host.clone(), tx));

    let mut farmer = Farmer::new(host);
    while let Some(event) = rx.recv().await {
        match event {
            Inbound::Init { data_dir } => {
                farmer.data_dir = data_dir;
                farmer.load_config();
            }
            Inbound::Initialized => farmer.on_initialized().await,
            Inbound::FollowedLive(params) => farmer.on_followed_live(&params),
            Inbound::WatchTick => farmer.on_tick().await,
            Inbound::Action { id, action, args } => {
                farmer.handle_action(id, &action, &args).await;
            }
        }
    }
}
