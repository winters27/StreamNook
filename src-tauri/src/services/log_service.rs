use anyhow::Result;
use chrono::{DateTime, Utc};
use lazy_static::lazy_static;
use log::{debug, error};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::Mutex;

const MAX_LOGS: usize = 500;
const MAX_ACTIVITY_HISTORY: usize = 15;
const WEBHOOK_COOLDOWN_MS: u64 = 30000; // 30 seconds
const BATCH_DELAY_MS: u64 = 5000; // 5 seconds to batch errors

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl std::fmt::Display for LogLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LogLevel::Debug => write!(f, "debug"),
            LogLevel::Info => write!(f, "info"),
            LogLevel::Warn => write!(f, "warn"),
            LogLevel::Error => write!(f, "error"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: LogLevel,
    pub category: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivityEntry {
    pub timestamp: String,
    pub action: String,
}

struct LogState {
    logs: VecDeque<LogEntry>,
    activity_history: VecDeque<ActivityEntry>,
    error_buffer: Vec<LogEntry>,
    last_webhook_send: u64,
    webhook_scheduled: bool,
}

lazy_static! {
    static ref LOG_STATE: Arc<Mutex<LogState>> = Arc::new(Mutex::new(LogState {
        logs: VecDeque::with_capacity(MAX_LOGS),
        activity_history: VecDeque::with_capacity(MAX_ACTIVITY_HISTORY),
        error_buffer: Vec::new(),
        last_webhook_send: 0,
        webhook_scheduled: false,
    }));
}

pub struct LogService;

impl LogService {
    /// Add a log entry to the ring buffer
    pub async fn log_message(
        level: LogLevel,
        category: String,
        message: String,
        data: Option<serde_json::Value>,
    ) -> Result<()> {
        let entry = LogEntry {
            timestamp: Utc::now().to_rfc3339(),
            level: level.clone(),
            category,
            message,
            data,
        };

        let mut state = LOG_STATE.lock().await;

        // Add to ring buffer
        if state.logs.len() >= MAX_LOGS {
            state.logs.pop_front();
        }
        state.logs.push_back(entry.clone());

        // Queue errors for Discord webhook
        if matches!(level, LogLevel::Error) && !Self::should_ignore_error(&entry) {
            state.error_buffer.push(entry);

            // Schedule webhook send if not already scheduled
            if !state.webhook_scheduled {
                state.webhook_scheduled = true;
                drop(state); // Release lock before spawning task
                Self::schedule_webhook_send();
            }
        }

        Ok(())
    }

    /// Track user activity for error context
    pub async fn track_activity(action: String) -> Result<()> {
        let mut state = LOG_STATE.lock().await;

        let entry = ActivityEntry {
            timestamp: Utc::now().to_rfc3339(),
            action: action.chars().take(100).collect(), // Limit action length
        };

        if state.activity_history.len() >= MAX_ACTIVITY_HISTORY {
            state.activity_history.pop_front();
        }
        state.activity_history.push_back(entry);

        Ok(())
    }

    /// Get recent logs
    pub async fn get_recent_logs(limit: Option<usize>) -> Result<Vec<LogEntry>> {
        let state = LOG_STATE.lock().await;
        let limit = limit.unwrap_or(100);

        Ok(state
            .logs
            .iter()
            .rev()
            .take(limit)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect())
    }

    /// Get logs by level
    pub async fn get_logs_by_level(level: LogLevel) -> Result<Vec<LogEntry>> {
        let state = LOG_STATE.lock().await;

        let min_level = match level {
            LogLevel::Debug => 0,
            LogLevel::Info => 1,
            LogLevel::Warn => 2,
            LogLevel::Error => 3,
        };

        Ok(state
            .logs
            .iter()
            .filter(|log| {
                let log_level = match log.level {
                    LogLevel::Debug => 0,
                    LogLevel::Info => 1,
                    LogLevel::Warn => 2,
                    LogLevel::Error => 3,
                };
                log_level >= min_level
            })
            .cloned()
            .collect())
    }

    /// Get recent activity
    pub async fn get_recent_activity() -> Result<Vec<ActivityEntry>> {
        let state = LOG_STATE.lock().await;
        Ok(state.activity_history.iter().cloned().collect())
    }

    /// Clear all logs
    pub async fn clear_logs() -> Result<()> {
        let mut state = LOG_STATE.lock().await;
        state.logs.clear();
        Ok(())
    }

    /// Check if error should be ignored (benign/noise errors)
    fn should_ignore_error(entry: &LogEntry) -> bool {
        let ignored_patterns = [
            // App lifecycle / React errors
            "Couldn't find callback id",
            "This might happen when the app is reloaded",
            "ResizeObserver loop",
            "Non-Error promise rejection",
            "Failed to load resource.*favicon",
            "ERR_FILE_NOT_FOUND.*blob:",
            "Error caught and handled by boundary",
            "The above error occurred in the <TitleBar> component",
            "The above error occurred in the <DynamicIsland> component",
            // External resource / CDN errors
            "Tracking Prevention blocked",
            "cdn.jsdelivr.net",
            "emoji-datasource",
            // Service-specific noise
            "BadgePolling.*invoke",
            "Badge NOT FOUND",
            // HLS streaming non-fatal errors (expected during live streaming)
            "bufferStalledError",
            "bufferNudgeOnStall",
            "fragParsingError",
            "fragLoadError",
            "levelLoadError",
            "[HLS] Buffer stalled",
            "[HLS] Non-fatal error",
            "[HLS] Error.*fatal.*false",
            "manifestLoadError.*fatal.*false",
        ];

        let full_message = format!(
            "{} {} {}",
            entry.category,
            entry.message,
            entry.data.as_ref().map_or(String::new(), |d| d.to_string())
        );

        ignored_patterns
            .iter()
            .any(|pattern| full_message.contains(pattern))
    }

    /// Schedule sending buffered errors to Discord
    fn schedule_webhook_send() {
        tokio::spawn(async {
            // Wait for batch delay
            tokio::time::sleep(tokio::time::Duration::from_millis(BATCH_DELAY_MS)).await;

            loop {
                let mut state = LOG_STATE.lock().await;
                state.webhook_scheduled = false;

                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64;

                // Check cooldown
                if now - state.last_webhook_send < WEBHOOK_COOLDOWN_MS {
                    // Wait for cooldown to expire
                    let remaining = WEBHOOK_COOLDOWN_MS - (now - state.last_webhook_send);
                    drop(state); // Release lock
                    tokio::time::sleep(tokio::time::Duration::from_millis(remaining)).await;
                    continue; // Check again
                }

                if !state.error_buffer.is_empty() {
                    let errors_to_send = state.error_buffer.clone();
                    state.error_buffer.clear();
                    state.last_webhook_send = now;

                    // Get recent logs and activity for context
                    // Fetch more logs since we filter to WARN/ERROR only for breadcrumbs
                    let recent_logs: Vec<LogEntry> = state
                        .logs
                        .iter()
                        .rev()
                        .take(50)
                        .cloned()
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();

                    let recent_activity: Vec<ActivityEntry> =
                        state.activity_history.iter().cloned().collect();

                    drop(state); // Release lock before network call

                    // Send to Discord in background task
                    tokio::spawn(async move {
                        if let Err(e) = LogService::send_to_discord_webhook(
                            errors_to_send,
                            recent_logs,
                            recent_activity,
                        )
                        .await
                        {
                            error!("[LogService] Failed to send to Discord webhook: {}", e);
                        }
                    });
                }

                break; // Exit loop after processing
            }
        });
    }

    /// Send errors to Discord webhook via background task
    async fn send_to_discord_webhook(
        errors: Vec<LogEntry>,
        recent_logs: Vec<LogEntry>,
        recent_activity: Vec<ActivityEntry>,
    ) -> Result<()> {
        // Get webhook URL from environment variable or settings
        // For now, using the hardcoded URL from the original TS version
        let webhook_url = "https://ptb.discord.com/api/webhooks/1444242659739697204/GpZDi70IWHCIObS-LOtFr89uU-J8tbnQLG7DRhHACR1Wn-26YchRTPCdWKUYf47zHyv7";

        // Build error details
        let error_details = errors
            .iter()
            .map(|e| {
                format!(
                    "[{}] {}{}",
                    e.category,
                    e.message,
                    e.data
                        .as_ref()
                        .map_or(String::new(), |d| format!(" | {}", d))
                )
            })
            .collect::<Vec<_>>()
            .join("\n");

        let code_block_errors = format!(
            "```\n{}\n```",
            &error_details[..error_details.len().min(1500)]
        );

        // Build breadcrumbs - only include WARN and ERROR level logs for signal clarity
        let breadcrumbs = recent_logs
            .iter()
            .filter(|l| matches!(l.level, LogLevel::Warn | LogLevel::Error))
            .map(|l| {
                let time = l.timestamp.split('T').nth(1).unwrap_or("");
                let time_short = time.split('.').next().unwrap_or("");
                format!(
                    "[{}] [{}] {}",
                    time_short,
                    l.level.to_string().to_uppercase(),
                    &l.message[..l.message.len().min(80)]
                )
            })
            .collect::<Vec<_>>()
            .join("\n");

        // Build activity log
        let activity_log = recent_activity
            .iter()
            .map(|a| {
                let dt = DateTime::parse_from_rfc3339(&a.timestamp).ok();
                let time = dt
                    .map(|d| d.format("%H:%M:%S").to_string())
                    .unwrap_or_else(|| "??:??:??".to_string());
                format!("{} → {}", time, a.action)
            })
            .collect::<Vec<_>>()
            .join("\n");

        // Build embed fields
        let mut fields = vec![
            serde_json::json!({
                "name": "App Version",
                "value": format!("`{}`", env!("CARGO_PKG_VERSION")),
                "inline": true
            }),
            serde_json::json!({
                "name": "Platform",
                "value": format!("`{}`", std::env::consts::OS),
                "inline": true
            }),
            serde_json::json!({
                "name": "Error Count",
                "value": format!("`{}`", errors.len()),
                "inline": true
            }),
        ];

        if !breadcrumbs.is_empty() {
            fields.push(serde_json::json!({
                "name": "🍞 Breadcrumbs (Last 15 Logs)",
                "value": format!("```\n{}\n```", breadcrumbs),
                "inline": false
            }));
        }

        if !activity_log.is_empty() {
            fields.push(serde_json::json!({
                "name": "👥 User Actions",
                "value": format!("```\n{}\n```", activity_log),
                "inline": false
            }));
        }

        fields.push(serde_json::json!({
            "name": "Errors",
            "value": code_block_errors,
            "inline": false
        }));

        let embed = serde_json::json!({
            "title": "🚨 StreamNook Error Report",
            "color": 0xFF0000, // Red
            "fields": fields,
            "timestamp": Utc::now().to_rfc3339(),
            "footer": {
                "text": "StreamNook • Auto Error Report"
            }
        });

        let payload = serde_json::json!({
            "embeds": [embed]
        });

        // Send webhook request
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()?;

        let response = client
            .post(webhook_url)
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await?;

        if !response.status().is_success() {
            anyhow::bail!("Discord webhook returned status: {}", response.status());
        }

        debug!("[LogService] Error report sent to Discord");
        Ok(())
    }
}
