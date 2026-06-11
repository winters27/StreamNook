//! Ad-Free Playback — a StreamNook plugin.
//!
//! A separate program that StreamNook starts and talks to over JSON-RPC. When
//! the app starts a live stream the viewer is not already entitled to watch
//! ad-free (Twitch Turbo or a channel subscription), the host invokes this
//! plugin's `playback.resolve` hook; the plugin fetches the channel's master
//! playlist through a community playlist proxy in its own process, with its
//! own networking, and hands the result back for the app's relay to serve.
//! When the host reports an ad window on a stream this plugin resolved, it
//! re-resolves through a different region and swaps the relay's upstream via
//! `set_upstream`. The core StreamNook binary contains none of this behavior.

mod master;
mod protocol;
mod proxies;

use protocol::{read_loop, Host, Inbound};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Minimum spacing between region pivots for one session, so a stretch where
/// every region serves ads cannot thrash the player with reloads.
const PIVOT_COOLDOWN: Duration = Duration::from_secs(30);

struct Settings {
    enabled: bool,
    /// Preferred region label (NA/EU/AS/SA/RU), or None for automatic.
    region: Option<String>,
    /// User-supplied proxy base URLs, tried before the bundled pool.
    custom_proxies: Vec<String>,
    /// Merge the above-1080p tiers from the viewer's signed-in master into
    /// the proxy master (anonymous masters top out at 1080p).
    splice_high_tiers: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: true,
            region: None,
            custom_proxies: Vec::new(),
            splice_high_tiers: true,
        }
    }
}

/// One live relay session this plugin resolved, addressable for pivots.
struct Session {
    channel: String,
    quality: String,
    current_base: String,
    tried: Vec<String>,
    last_pivot: Option<Instant>,
}

struct Engine {
    host: Host,
    client: reqwest::Client,
    settings: Settings,
    sessions: HashMap<String, Session>,
}

impl Engine {
    fn new(host: Host) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .user_agent(proxies::USER_AGENT)
            .build()
            .unwrap_or_default();
        Self {
            host,
            client,
            settings: Settings::default(),
            sessions: HashMap::new(),
        }
    }

    /// The settings panel the host renders from generic field types. The host
    /// has no knowledge of these keys or of this plugin; it just draws the
    /// fields and stores their values, which come back to us as panel values.
    fn panel_schema() -> Value {
        json!({
            "title": "Ad-Free Playback",
            "sections": [
                {
                    "label": "Resolution",
                    "description": "Streams you are already entitled to watch ad-free (Twitch Turbo or a channel subscription) play directly and are never routed here. Everything else resolves through a community playlist proxy.",
                    "fields": [
                        { "key": "enabled", "type": "toggle", "label": "Resolve streams through proxies", "description": "Off hands every stream back to the app's direct resolution.", "default": true },
                        { "key": "region", "type": "select", "label": "Preferred region", "description": "Automatic races every region and takes the fastest answer.", "default": "auto", "options": [
                            { "value": "auto", "label": "Automatic" },
                            { "value": "NA", "label": "North America" },
                            { "value": "EU", "label": "Europe" },
                            { "value": "AS", "label": "Asia" },
                            { "value": "SA", "label": "South America" },
                            { "value": "RU", "label": "Russia" }
                        ] },
                        { "key": "splice_high_tiers", "type": "toggle", "label": "Keep 1440p+ from your login", "description": "Proxy masters top out at 1080p; your signed-in master's higher tiers are merged back in.", "default": true }
                    ]
                },
                {
                    "label": "Proxies",
                    "fields": [
                        { "key": "custom_proxies", "type": "string_list", "label": "Custom proxy URLs", "description": "Tried before the bundled pool. Base URLs only.", "placeholder": "https://proxy.example.com" }
                    ]
                }
            ]
        })
    }

    /// Maps the host-stored panel values into the engine's settings. Keys are
    /// defined by this plugin's own schema above, not by the host.
    fn apply_panel_values(&mut self, v: &Value) {
        if let Some(b) = v.get("enabled").and_then(|x| x.as_bool()) {
            self.settings.enabled = b;
        }
        if let Some(r) = v.get("region").and_then(|x| x.as_str()) {
            self.settings.region = match r {
                "auto" | "" => None,
                other => Some(other.to_string()),
            };
        }
        if let Some(b) = v.get("splice_high_tiers").and_then(|x| x.as_bool()) {
            self.settings.splice_high_tiers = b;
        }
        if let Some(arr) = v.get("custom_proxies").and_then(|x| x.as_array()) {
            self.settings.custom_proxies = arr
                .iter()
                .filter_map(|x| x.as_str())
                .map(|s| s.trim().trim_end_matches('/').to_string())
                .filter(|s| s.starts_with("http://") || s.starts_with("https://"))
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
        self.host.log("info", "ad-bypass initialized").await;
    }

    /// Candidate proxy-base groups in race order: custom proxies first, then
    /// the preferred region's bundled proxies, then the rest of the pool.
    /// `exclude` removes bases already tried in the current pivot chain.
    fn candidate_groups(&self, exclude: &[String]) -> Vec<Vec<String>> {
        let excluded = |b: &str| exclude.iter().any(|e| e == b);
        let mut groups: Vec<Vec<String>> = Vec::new();
        let custom: Vec<String> = self
            .settings
            .custom_proxies
            .iter()
            .filter(|b| !excluded(b))
            .cloned()
            .collect();
        if !custom.is_empty() {
            groups.push(custom);
        }
        match &self.settings.region {
            Some(region) => {
                let (preferred, rest): (Vec<String>, Vec<String>) = proxies::BUNDLED
                    .iter()
                    .filter(|(url, _)| !excluded(url))
                    .partition_map(region);
                if !preferred.is_empty() {
                    groups.push(preferred);
                }
                if !rest.is_empty() {
                    groups.push(rest);
                }
            }
            None => {
                let all: Vec<String> = proxies::BUNDLED
                    .iter()
                    .filter(|(url, _)| !excluded(url))
                    .map(|(url, _)| (*url).to_string())
                    .collect();
                if !all.is_empty() {
                    groups.push(all);
                }
            }
        }
        groups
    }

    /// Race the candidate groups in order; the first valid master wins.
    async fn resolve_master(
        &self,
        channel: &str,
        exclude: &[String],
    ) -> Option<(String, String)> {
        for group in self.candidate_groups(exclude) {
            match proxies::race(&self.client, channel, &group).await {
                Ok(win) => return Some(win),
                Err(e) => {
                    self.host
                        .log("debug", format!("{channel}: race miss: {e}"))
                        .await;
                }
            }
        }
        None
    }

    /// Handles the `playback.resolve` action: resolve `channel` through the
    /// proxies and answer with the master (high tiers spliced in when the
    /// host passed the signed-in master along), or decline so the host falls
    /// back to its own direct resolution.
    async fn handle_action(&mut self, id: Value, action: &str, args: &Value) {
        if action != "playback.resolve" {
            let _ = self
                .host
                .respond_error(id, -32601, &format!("unknown action: {action}"))
                .await;
            return;
        }
        let stream_id = args
            .get("stream_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let channel = args
            .get("channel")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_lowercase();
        let quality = args
            .get("quality")
            .and_then(|v| v.as_str())
            .unwrap_or("best")
            .to_string();
        // A new resolve for this stream id means the relay session moved on to
        // a new stream. The old session must die NOW, on every outcome: if it
        // survived a decline below, a later ad window on the new stream would
        // pivot the relay onto the OLD channel's playlist.
        if !stream_id.is_empty() {
            self.sessions.remove(&stream_id);
        }
        if !self.settings.enabled || channel.is_empty() || stream_id.is_empty() {
            let _ = self.host.respond(id, json!({ "declined": true })).await;
            return;
        }

        let Some((base, mut body)) = self.resolve_master(&channel, &[]).await else {
            self.host
                .log(
                    "warning",
                    format!("{channel}: every proxy failed; declining so the app plays direct"),
                )
                .await;
            let _ = self.host.respond(id, json!({ "declined": true })).await;
            return;
        };

        if self.settings.splice_high_tiers {
            if let Some(auth_master) = args.get("auth_master").and_then(|v| v.as_str()) {
                body = master::splice(&body, auth_master);
            }
        }

        let region = proxies::region_for_base(&base);
        self.host
            .log(
                "info",
                format!(
                    "{channel}: resolved via {base}{}",
                    region
                        .as_deref()
                        .map(|r| format!(" ({r})"))
                        .unwrap_or_default()
                ),
            )
            .await;
        self.sessions.insert(
            stream_id,
            Session {
                channel,
                quality,
                current_base: base.clone(),
                tried: vec![base.clone()],
                last_pivot: None,
            },
        );
        let _ = self
            .host
            .respond(id, json!({ "master": body, "base": base, "region": region }))
            .await;
    }

    /// An ad window opened on a relay session. If it is one this plugin
    /// resolved, the current region is leaking ads: re-resolve through a
    /// region not yet tried and hand the relay the new upstream.
    async fn on_ad_window(&mut self, params: &Value) {
        let active = params.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
        let stream_id = params
            .get("stream_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        if !active || !self.sessions.contains_key(&stream_id) {
            return;
        }
        {
            let session = self.sessions.get(&stream_id).unwrap();
            if session
                .last_pivot
                .is_some_and(|t| t.elapsed() < PIVOT_COOLDOWN)
            {
                return;
            }
        }

        let (channel, quality, exclude) = {
            let session = self.sessions.get_mut(&stream_id).unwrap();
            session.last_pivot = Some(Instant::now());
            // When every base has been tried, keep only the leaking one
            // excluded so the next round can retry the rest of the pool.
            let pool_size = proxies::BUNDLED.len() + self.settings.custom_proxies.len();
            if session.tried.len() >= pool_size {
                session.tried = vec![session.current_base.clone()];
            }
            (
                session.channel.clone(),
                session.quality.clone(),
                session.tried.clone(),
            )
        };

        self.host
            .log(
                "info",
                format!("{channel}: ad window reported; re-resolving through another region"),
            )
            .await;
        let Some((base, body)) = self.resolve_master(&channel, &exclude).await else {
            self.host
                .log("warning", format!("{channel}: no clean region available to pivot to"))
                .await;
            return;
        };
        let variants = master::parse_master(&body);
        let Some(url) = master::select_variant(&variants, &quality) else {
            self.host
                .log("warning", format!("{channel}: pivot master had no usable variants"))
                .await;
            return;
        };
        match self
            .host
            .request(
                "set_upstream",
                json!({ "stream_id": stream_id, "playlist_url": url }),
            )
            .await
        {
            Ok(_) => {
                let region = proxies::region_for_base(&base);
                self.host
                    .log(
                        "info",
                        format!(
                            "{channel}: upstream swapped to {base}{}",
                            region
                                .as_deref()
                                .map(|r| format!(" ({r})"))
                                .unwrap_or_default()
                        ),
                    )
                    .await;
                if let Some(session) = self.sessions.get_mut(&stream_id) {
                    session.current_base = base.clone();
                    if !session.tried.contains(&base) {
                        session.tried.push(base);
                    }
                }
            }
            Err(e) => {
                // unknown_stream means the session ended while we resolved.
                self.host
                    .log("info", format!("{channel}: set_upstream failed: {e}"))
                    .await;
                self.sessions.remove(&stream_id);
            }
        }
    }
}

/// Partition the bundled pool by a region label, keeping URL strings.
trait PartitionByRegion {
    fn partition_map(self, region: &str) -> (Vec<String>, Vec<String>);
}

impl<'a, I> PartitionByRegion for I
where
    I: Iterator<Item = &'a (&'static str, &'static str)>,
{
    fn partition_map(self, region: &str) -> (Vec<String>, Vec<String>) {
        let mut preferred = Vec::new();
        let mut rest = Vec::new();
        for (url, r) in self {
            if r.eq_ignore_ascii_case(region) {
                preferred.push((*url).to_string());
            } else {
                rest.push((*url).to_string());
            }
        }
        (preferred, rest)
    }
}

#[tokio::main]
async fn main() {
    let host = Host::new(tokio::io::stdout());
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Inbound>(64);

    tokio::spawn(read_loop(tokio::io::stdin(), host.clone(), tx));

    let mut engine = Engine::new(host);
    while let Some(event) = rx.recv().await {
        match event {
            Inbound::Initialized => engine.on_initialized().await,
            Inbound::AdWindow(params) => engine.on_ad_window(&params).await,
            Inbound::PanelChange(params) => {
                if let Some(values) = params.get("values") {
                    engine.apply_panel_values(values);
                }
            }
            Inbound::Action { id, action, args } => {
                engine.handle_action(id, &action, &args).await
            }
        }
    }
}
