//! Drops and Points Farmer — a StreamNook plugin.
//!
//! A separate program that StreamNook starts and talks to over JSON-RPC. It
//! runs background channel-points farming (and, in a later version, drops
//! mining) entirely in its own process, with its own networking, using a
//! Twitch credential the host hands over only after the user consents. The
//! core StreamNook binary contains none of this behavior.

mod protocol;
mod twitch;

use protocol::{read_loop, Host, Inbound};
use serde_json::{json, Value};
use std::collections::HashMap;
use twitch::{Channel, Cred};

/// Watch rotation, mirroring the former native farmer.
const MAX_CONCURRENT_DEFAULT: usize = 2;
const ROTATION_TICKS: u64 = 15; // re-pick the watch set every 15 minutes
const CLAIM_EVERY_TICKS: u64 = 5; // sweep bonus chests every 5 minutes

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
        }
    }

    /// The host-rendered settings panel.
    fn panel_schema() -> Value {
        json!({
            "title": "Drops and Points Farmer",
            "sections": [{
                "label": "Channel points",
                "description": "Farms channel points on your followed live channels in the background. The channel you are actively watching already earns on its own.",
                "fields": [
                    { "key": "active", "type": "toggle", "label": "Farming active", "description": "Pause without uninstalling.", "default": true },
                    { "key": "max_concurrent", "type": "number", "label": "Channels at once", "description": "Twitch credits points on up to two channels at a time.", "min": 1, "max": 2, "default": 2 },
                    { "key": "priority_channels", "type": "string_list", "label": "Priority channels", "description": "Logins to farm first, one per line. Others fill the remaining slots." }
                ]
            }]
        })
    }

    fn apply_panel_values(&mut self, values: &Value) {
        if let Some(active) = values.get("active").and_then(|v| v.as_bool()) {
            self.settings.active = active;
        }
        if let Some(n) = values.get("max_concurrent").and_then(|v| v.as_u64()) {
            self.settings.max_concurrent = (n as usize).clamp(1, 2);
        }
        if let Some(list) = values.get("priority_channels").and_then(|v| v.as_array()) {
            self.settings.priority_logins = list
                .iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_lowercase())
                .filter(|s| !s.is_empty())
                .collect();
        }
    }

    async fn on_initialized(&mut self) {
        let _ = self
            .host
            .request("register_panel", json!({ "schema": Self::panel_schema() }))
            .await;
        if let Ok(result) = self.host.request("get_panel_values", json!({})).await {
            if let Some(values) = result.get("values") {
                self.apply_panel_values(values);
            }
        }
        self.host.log("info", "drops-farmer initialized").await;
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

    /// Picks up to max_concurrent channels: priority logins first (when live),
    /// then least-recently-watched of the rest.
    fn pick_channels(&self) -> Vec<Channel> {
        let mut picked: Vec<Channel> = Vec::new();
        for login in &self.settings.priority_logins {
            if picked.len() >= self.settings.max_concurrent {
                break;
            }
            if let Some(ch) = self.live.iter().find(|c| &c.login == login) {
                picked.push(ch.clone());
            }
        }
        let mut rest: Vec<&Channel> = self
            .live
            .iter()
            .filter(|c| !picked.iter().any(|p| p.channel_id == c.channel_id))
            .collect();
        rest.sort_by_key(|c| self.last_watched.get(&c.channel_id).copied().unwrap_or(0));
        for ch in rest {
            if picked.len() >= self.settings.max_concurrent {
                break;
            }
            picked.push(ch.clone());
        }
        picked
    }

    async fn on_tick(&mut self) {
        if !self.settings.active || self.live.is_empty() {
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

        if self.current_set.is_empty() || self.tick_count % ROTATION_TICKS == 1 {
            self.current_set = self.pick_channels();
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
            Inbound::Initialized => farmer.on_initialized().await,
            Inbound::FollowedLive(params) => farmer.on_followed_live(&params),
            Inbound::WatchTick => farmer.on_tick().await,
            Inbound::PanelChange(params) => {
                if let Some(values) = params.get("values") {
                    farmer.apply_panel_values(values);
                }
            }
        }
    }
}
