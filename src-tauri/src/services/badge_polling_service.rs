use crate::commands::badges::get_cached_global_badges;
use crate::models::settings::AppState;
use crate::services::cache_service;
use crate::services::universal_cache_service::{get_cached_item, CacheType};

use chrono::{Datelike, Local, NaiveDate, TimeZone};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;
use tokio::time::{interval, Duration};

const POLL_INTERVAL_SECS: u64 = 5 * 60; // 5 minutes
const INITIAL_DELAY_SECS: u64 = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BadgeNotificationStatus {
    New,
    Available,
    ComingSoon,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BadgeNotification {
    pub badge_name: String,
    pub badge_set_id: String,
    pub badge_version: String,
    pub badge_image_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub badge_description: Option<String>,
    pub status: BadgeNotificationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_info: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BadgeMetadata {
    pub date_added: Option<String>,
    pub usage_stats: Option<String>,
    pub more_info: Option<String>,
    pub info_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct BadgePollingStateFile {
    known_badges: Vec<String>,
    notified_available_badges: Vec<String>,
    last_poll_timestamp_ms: u64,
}

#[derive(Debug, Clone, Default)]
struct BadgePollingState {
    known_badges: HashSet<String>,
    notified_available_badges: HashSet<String>,
    last_poll_timestamp_ms: u64,
}

impl BadgePollingState {
    fn from_file(file: BadgePollingStateFile) -> Self {
        Self {
            known_badges: file.known_badges.into_iter().collect(),
            notified_available_badges: file.notified_available_badges.into_iter().collect(),
            last_poll_timestamp_ms: file.last_poll_timestamp_ms,
        }
    }

    fn to_file(&self) -> BadgePollingStateFile {
        BadgePollingStateFile {
            known_badges: self.known_badges.iter().cloned().collect(),
            notified_available_badges: self.notified_available_badges.iter().cloned().collect(),
            last_poll_timestamp_ms: self.last_poll_timestamp_ms,
        }
    }
}

pub struct BadgePollingService {
    running: Arc<RwLock<bool>>,
    is_polling: Arc<RwLock<bool>>,
    state: Arc<RwLock<BadgePollingState>>,
}

impl BadgePollingService {
    pub fn new() -> Self {
        Self {
            running: Arc::new(RwLock::new(false)),
            is_polling: Arc::new(RwLock::new(false)),
            state: Arc::new(RwLock::new(BadgePollingState::default())),
        }
    }

    pub async fn start(&self, app_handle: AppHandle, app_state: AppState) {
        // Check if already running
        {
            let mut running = self.running.write().await;
            if *running {
                return;
            }
            *running = true;
        }

        // Load persisted state once at startup
        if let Ok(state) = load_state_from_disk() {
            *self.state.write().await = state;
        }

        let running = self.running.clone();
        let is_polling = self.is_polling.clone();
        let state = self.state.clone();

        tokio::spawn(async move {
            // Let the app settle before first poll
            tokio::time::sleep(Duration::from_secs(INITIAL_DELAY_SECS)).await;

            // First poll
            if let Err(e) = poll_once(&app_handle, &app_state, &running, &is_polling, &state).await
            {
                eprintln!("[BadgePolling] Initial poll failed: {e}");
            }

            let mut ticker = interval(Duration::from_secs(POLL_INTERVAL_SECS));
            // Consume the immediate tick
            ticker.tick().await;

            loop {
                ticker.tick().await;

                // Stop if requested
                if !*running.read().await {
                    break;
                }

                // Avoid work if notifications are disabled
                let badge_notifications_enabled = {
                    let settings = app_state.settings.lock().unwrap();
                    settings.live_notifications.enabled
                        && settings.live_notifications.show_badge_notifications
                };

                if !badge_notifications_enabled {
                    continue;
                }

                if let Err(e) =
                    poll_once(&app_handle, &app_state, &running, &is_polling, &state).await
                {
                    eprintln!("[BadgePolling] Poll failed: {e}");
                }
            }

            println!("[BadgePolling] Service stopped");
        });
    }

    pub async fn stop(&self) {
        let mut running = self.running.write().await;
        *running = false;
    }
}

async fn poll_once(
    app_handle: &AppHandle,
    _app_state: &AppState,
    running: &Arc<RwLock<bool>>,
    is_polling: &Arc<RwLock<bool>>,
    state: &Arc<RwLock<BadgePollingState>>,
) -> anyhow::Result<()> {
    // Quick abort
    if !*running.read().await {
        return Ok(());
    }

    // Prevent overlapping polls
    {
        let mut polling = is_polling.write().await;
        if *polling {
            return Ok(());
        }
        *polling = true;
    }

    let result = poll_once_impl(app_handle, state).await;

    // Always clear polling flag
    *is_polling.write().await = false;

    result
}

async fn poll_once_impl(
    app_handle: &AppHandle,
    state: &Arc<RwLock<BadgePollingState>>,
) -> anyhow::Result<()> {
    // Get cached badges (already fetched by main.rs background prefetch)
    let cached_badges = match get_cached_global_badges().await {
        Ok(Some(b)) => b,
        Ok(None) => return Ok(()),
        Err(e) => return Err(anyhow::anyhow!(e)),
    };

    if cached_badges.data.is_empty() {
        return Ok(());
    }

    let mut notifications: Vec<BadgeNotification> = Vec::new();

    // We copy the state out for fast checks, then write back once at the end.
    let mut local_state = state.read().await.clone();

    for badge_set in &cached_badges.data {
        for version in &badge_set.versions {
            let badge_key = format!("{}-v{}", badge_set.set_id, version.id);

            let metadata_key = format!("metadata:{}", badge_key);
            let metadata = match get_cached_item(CacheType::Badge, &metadata_key).await {
                Ok(Some(entry)) => serde_json::from_value::<BadgeMetadata>(entry.data).ok(),
                _ => None,
            };

            let (status, date_info) = get_badge_status(metadata.as_ref());

            // New badge
            if !local_state.known_badges.contains(&badge_key) {
                local_state.known_badges.insert(badge_key.clone());

                let should_notify = matches!(
                    status,
                    Some(BadgeStatus::Available) | Some(BadgeStatus::ComingSoon)
                ) || status.is_none();

                if should_notify {
                    notifications.push(BadgeNotification {
                        badge_name: version.title.clone(),
                        badge_set_id: badge_set.set_id.clone(),
                        badge_version: version.id.clone(),
                        badge_image_url: first_badge_image_url(version),
                        badge_description: if version.description.is_empty() {
                            None
                        } else {
                            Some(version.description.clone())
                        },
                        status: BadgeNotificationStatus::New,
                        date_info: date_info.clone(),
                    });
                }
            }

            // Known badge that just became available
            if local_state.known_badges.contains(&badge_key)
                && status == Some(BadgeStatus::Available)
                && !local_state.notified_available_badges.contains(&badge_key)
            {
                local_state
                    .notified_available_badges
                    .insert(badge_key.clone());

                notifications.push(BadgeNotification {
                    badge_name: version.title.clone(),
                    badge_set_id: badge_set.set_id.clone(),
                    badge_version: version.id.clone(),
                    badge_image_url: first_badge_image_url(version),
                    badge_description: if version.description.is_empty() {
                        None
                    } else {
                        Some(version.description.clone())
                    },
                    status: BadgeNotificationStatus::Available,
                    date_info,
                });
            }
        }
    }

    // Persist updated state
    local_state.last_poll_timestamp_ms = current_time_ms();
    if let Err(e) = save_state_to_disk(&local_state) {
        eprintln!("[BadgePolling] Failed to persist state: {e}");
    }
    *state.write().await = local_state;

    // Emit only the latest badge notification (mirrors old TS behavior)
    if let Some(latest) = notifications.pop() {
        // Always emit the generic event
        let _ = app_handle.emit("badge-notification", vec![latest.clone()]);

        // Emit the specific event for availability transitions
        if matches!(latest.status, BadgeNotificationStatus::Available) {
            let _ = app_handle.emit("badge-available", vec![latest]);
        }
    }

    Ok(())
}

fn first_badge_image_url(version: &crate::commands::badges::HelixBadgeVersion) -> String {
    if !version.image_url_4x.is_empty() {
        return version.image_url_4x.clone();
    }
    if !version.image_url_2x.is_empty() {
        return version.image_url_2x.clone();
    }
    version.image_url_1x.clone()
}

fn current_time_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn state_file_path() -> anyhow::Result<PathBuf> {
    Ok(cache_service::get_app_data_dir()?.join("badge_polling_state.json"))
}

fn load_state_from_disk() -> anyhow::Result<BadgePollingState> {
    let path = state_file_path()?;

    if !path.exists() {
        return Ok(BadgePollingState::default());
    }

    let text = std::fs::read_to_string(&path)?;
    let file: BadgePollingStateFile = serde_json::from_str(&text)?;
    Ok(BadgePollingState::from_file(file))
}

fn save_state_to_disk(state: &BadgePollingState) -> anyhow::Result<()> {
    let path = state_file_path()?;

    let file = state.to_file();
    let text = serde_json::to_string_pretty(&file)?;
    std::fs::write(path, text)?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BadgeStatus {
    Available,
    ComingSoon,
    Expired,
}

fn get_badge_status(metadata: Option<&BadgeMetadata>) -> (Option<BadgeStatus>, Option<String>) {
    let Some(metadata) = metadata else {
        return (None, None);
    };

    let Some(more_info) = metadata.more_info.as_deref() else {
        return (None, None);
    };

    let Some((start, end, date_info)) = parse_date_range(more_info) else {
        return (None, None);
    };

    let now = Local::now();

    if now < start {
        return (Some(BadgeStatus::ComingSoon), Some(date_info));
    }

    if now >= start && now <= end {
        return (Some(BadgeStatus::Available), Some(date_info));
    }

    (Some(BadgeStatus::Expired), Some(date_info))
}

/// Parse a date range embedded in `more_info`.
///
/// Supported formats (matching the old TS implementation):
/// - "Dec 06 – Dec 07" / "Dec 06 - Dec 07"
/// - "Dec 1-12" / "Dec 1 - 12"
fn parse_date_range(
    text: &str,
) -> Option<(chrono::DateTime<Local>, chrono::DateTime<Local>, String)> {
    static FULL_RANGE: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
        Regex::new(
            r"(?P<sm>[A-Za-z]{3})\s+(?P<sd>\d{1,2})\s*[–-]\s*(?P<em>[A-Za-z]{3})\s+(?P<ed>\d{1,2})",
        )
        .unwrap()
    });

    static SHORT_RANGE: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
        // Negative lookahead (like TS) isn’t supported in Rust regex.
        // We keep it simple: match "Mon D-D" and allow extra trailing text.
        Regex::new(r"(?P<m>[A-Za-z]{3})\s+(?P<sd>\d{1,2})\s*[–-]\s*(?P<ed>\d{1,2})").unwrap()
    });

    static DATE_INFO: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
        Regex::new(r"(?P<info>[A-Za-z]{3}\s+\d{1,2}(?:\s*[–-]\s*(?:[A-Za-z]{3}\s+)?\d{1,2})?)")
            .unwrap()
    });

    let year = Local::now().year();

    let date_info = DATE_INFO
        .captures(text)
        .and_then(|c| c.name("info").map(|m| m.as_str().to_string()))
        .unwrap_or_else(|| text.to_string());

    // Helper: month abbrev -> month number
    let month_num = |abbr: &str| -> Option<u32> {
        match abbr {
            "Jan" => Some(1),
            "Feb" => Some(2),
            "Mar" => Some(3),
            "Apr" => Some(4),
            "May" => Some(5),
            "Jun" => Some(6),
            "Jul" => Some(7),
            "Aug" => Some(8),
            "Sep" => Some(9),
            "Oct" => Some(10),
            "Nov" => Some(11),
            "Dec" => Some(12),
            _ => None,
        }
    };

    // Full month-to-month range
    if let Some(caps) = FULL_RANGE.captures(text) {
        let sm = month_num(caps.name("sm")?.as_str())?;
        let sd: u32 = caps.name("sd")?.as_str().parse().ok()?;
        let em = month_num(caps.name("em")?.as_str())?;
        let ed: u32 = caps.name("ed")?.as_str().parse().ok()?;

        let start_date = NaiveDate::from_ymd_opt(year, sm, sd)?;
        let end_date = NaiveDate::from_ymd_opt(year, em, ed)?;

        let start = Local
            .from_local_datetime(&start_date.and_hms_opt(0, 0, 0)?)
            .single()?;
        let end = Local
            .from_local_datetime(&end_date.and_hms_opt(23, 59, 59)?)
            .single()?;

        return Some((start, end, date_info));
    }

    // Short day range within same month
    if let Some(caps) = SHORT_RANGE.captures(text) {
        let m = month_num(caps.name("m")?.as_str())?;
        let sd: u32 = caps.name("sd")?.as_str().parse().ok()?;
        let ed: u32 = caps.name("ed")?.as_str().parse().ok()?;

        let start_date = NaiveDate::from_ymd_opt(year, m, sd)?;
        let end_date = NaiveDate::from_ymd_opt(year, m, ed)?;

        let start = Local
            .from_local_datetime(&start_date.and_hms_opt(0, 0, 0)?)
            .single()?;
        let end = Local
            .from_local_datetime(&end_date.and_hms_opt(23, 59, 59)?)
            .single()?;

        return Some((start, end, date_info));
    }

    None
}
