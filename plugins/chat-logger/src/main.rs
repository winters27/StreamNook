//! Chat Logger, a StreamNook plugin.
//!
//! Receives chat messages from the host over the plugin protocol and appends
//! them to plain text log files: one folder per channel, one file per day.
//! Runs as its own process, makes no network connections, and writes only
//! under the folder the user picked (or its own data folder by default).

mod protocol;

use chrono::Local;
use protocol::{read_loop, Host, Inbound, PANEL_VALUES_REQ_ID};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

struct Settings {
    /// Base folder for log files. Empty means the default under data_dir.
    log_dir: String,
    /// Lowercase channel logins to log. Empty means every channel.
    channels: Vec<String>,
    /// Also log event notices (subscriptions, raids, announcements).
    include_events: bool,
    /// Start each line with the time it was sent.
    timestamps: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            log_dir: String::new(),
            channels: Vec::new(),
            include_events: true,
            timestamps: true,
        }
    }
}

/// An open per-channel file, kept until the local date rolls over or the
/// base folder changes.
struct OpenLog {
    date: String,
    file: File,
}

struct Logger {
    host: Host,
    data_dir: Option<PathBuf>,
    settings: Settings,
    open: HashMap<String, OpenLog>,
}

/// Channel logins are already filesystem-safe ([a-z0-9_]), but sanitize
/// defensively since the name becomes a folder.
fn safe_dir_name(channel: &str) -> String {
    channel
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

impl Logger {
    fn new(host: Host) -> Self {
        Self {
            host,
            data_dir: None,
            settings: Settings::default(),
            open: HashMap::new(),
        }
    }

    /// Where log files go: the picked folder, else `logs` under data_dir.
    fn base_dir(&self) -> Option<PathBuf> {
        if !self.settings.log_dir.is_empty() {
            return Some(PathBuf::from(&self.settings.log_dir));
        }
        self.data_dir.as_ref().map(|d| d.join("logs"))
    }

    fn on_init(&mut self, params: &Value) {
        if let Some(dir) = params.get("data_dir").and_then(|d| d.as_str()) {
            if !dir.is_empty() {
                self.data_dir = Some(PathBuf::from(dir));
            }
        }
    }

    fn panel_schema(&self) -> Value {
        let default_dir = self
            .base_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        json!({
            "title": "Chat Logger",
            "sections": [
                {
                    "label": "Location",
                    "fields": [
                        { "key": "log_dir", "type": "folder", "label": "Log folder",
                          "description": "One folder per channel, one file per day.",
                          "placeholder": default_dir, "default": "" }
                    ]
                },
                {
                    "label": "Channels",
                    "fields": [
                        { "key": "channels", "type": "channel_list", "label": "Only log these channels",
                          "description": "Leave empty to log every channel you open." }
                    ]
                },
                {
                    "label": "Content",
                    "fields": [
                        { "key": "timestamps", "type": "toggle", "label": "Timestamps",
                          "description": "Start each line with the time it was sent.", "default": true },
                        { "key": "include_events", "type": "toggle", "label": "Subscriptions, raids, and announcements",
                          "description": "Also log event notices, not just regular messages.", "default": true }
                    ]
                }
            ]
        })
    }

    async fn on_initialized(&mut self) {
        let _ = self
            .host
            .request(2, "register_panel", json!({ "schema": self.panel_schema() }))
            .await;
        let _ = self
            .host
            .request(PANEL_VALUES_REQ_ID, "get_panel_values", json!({}))
            .await;
        self.host.log("info", "chat logger initialized").await;
    }

    fn apply_panel_values(&mut self, v: &Value) {
        let old_base = self.base_dir();
        if let Some(dir) = v.get("log_dir").and_then(|x| x.as_str()) {
            self.settings.log_dir = dir.trim().to_string();
        }
        if let Some(arr) = v.get("channels").and_then(|x| x.as_array()) {
            self.settings.channels = arr
                .iter()
                .filter_map(|c| c.get("channel_login").and_then(|l| l.as_str()))
                .map(|l| l.to_lowercase())
                .collect();
        }
        if let Some(b) = v.get("timestamps").and_then(|x| x.as_bool()) {
            self.settings.timestamps = b;
        }
        if let Some(b) = v.get("include_events").and_then(|x| x.as_bool()) {
            self.settings.include_events = b;
        }
        // A base change invalidates every open handle; files reopen lazily
        // under the new folder on the next message.
        if self.base_dir() != old_base {
            self.open.clear();
        }
    }

    async fn on_chat_message(&mut self, params: &Value) {
        let channel = params
            .get("channel")
            .and_then(|c| c.as_str())
            .unwrap_or_default()
            .to_lowercase();
        if channel.is_empty() {
            return;
        }
        if !self.settings.channels.is_empty() && !self.settings.channels.contains(&channel) {
            return;
        }
        let Some(msg) = params.get("message") else {
            return;
        };

        let system_message = msg
            .get("system_message")
            .and_then(|s| s.as_str())
            .unwrap_or_default();
        let is_event = msg.get("msg_type").is_some_and(|t| !t.is_null());
        if is_event && !self.settings.include_events {
            return;
        }

        let display = msg
            .get("display_name")
            .and_then(|d| d.as_str())
            .filter(|d| !d.is_empty())
            .or_else(|| msg.get("login").and_then(|l| l.as_str()))
            .unwrap_or("?");
        let text = msg.get("text").and_then(|t| t.as_str()).unwrap_or_default();
        let is_action = msg
            .get("is_action")
            .and_then(|a| a.as_bool())
            .unwrap_or(false);

        let prefix = if self.settings.timestamps {
            let local = msg
                .get("ts")
                .and_then(|t| t.as_str())
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                .map(|t| t.with_timezone(&Local))
                .unwrap_or_else(Local::now);
            format!("[{}] ", local.format("%H:%M:%S"))
        } else {
            String::new()
        };

        let mut lines: Vec<String> = Vec::with_capacity(2);
        if !system_message.is_empty() {
            lines.push(format!("{prefix}{system_message}"));
        }
        if !text.is_empty() {
            if is_action {
                lines.push(format!("{prefix}* {display} {text}"));
            } else {
                lines.push(format!("{prefix}{display}: {text}"));
            }
        }
        if lines.is_empty() {
            return;
        }

        if let Err(e) = self.append(&channel, &lines) {
            // Drop the handle so the next message retries a fresh open.
            self.open.remove(&channel);
            self.host
                .log("warning", format!("write failed for {channel}: {e}"))
                .await;
        }
    }

    /// Appends lines to the channel's file for today, opening (and dating)
    /// it on first use, after a day rollover, or after a write failure.
    fn append(&mut self, channel: &str, lines: &[String]) -> anyhow::Result<()> {
        let date = Local::now().format("%Y-%m-%d").to_string();
        let stale = self
            .open
            .get(channel)
            .map_or(true, |entry| entry.date != date);
        if stale {
            let base = self
                .base_dir()
                .ok_or_else(|| anyhow::anyhow!("no usable log folder"))?;
            let dir = base.join(safe_dir_name(channel));
            fs::create_dir_all(&dir)?;
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join(format!("{date}.log")))?;
            writeln!(
                file,
                "# Logging started {}",
                Local::now().format("%Y-%m-%d %H:%M:%S")
            )?;
            self.open
                .insert(channel.to_string(), OpenLog { date, file });
        }
        let entry = self.open.get_mut(channel).expect("opened above");
        for line in lines {
            writeln!(entry.file, "{line}")?;
        }
        entry.file.flush()?;
        Ok(())
    }
}

#[tokio::main]
async fn main() {
    let host = Host::new(tokio::io::stdout());
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Inbound>(256);

    tokio::spawn(read_loop(tokio::io::stdin(), host.clone(), tx));

    let mut logger = Logger::new(host);
    while let Some(event) = rx.recv().await {
        match event {
            Inbound::Init(params) => logger.on_init(&params),
            Inbound::Initialized => logger.on_initialized().await,
            Inbound::ChatMessage(params) => logger.on_chat_message(&params).await,
            Inbound::PanelChange(params) | Inbound::PanelValues(params) => {
                let values = params.get("values").unwrap_or(&params);
                logger.apply_panel_values(values);
            }
        }
    }
}
