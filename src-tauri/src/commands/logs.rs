use crate::services::log_service::{ActivityEntry, LogEntry, LogLevel, LogService};
use tauri::command;

#[command]
pub async fn log_message(
    level: String,
    category: String,
    message: String,
    data: Option<serde_json::Value>,
) -> Result<(), String> {
    let log_level = match level.to_lowercase().as_str() {
        "debug" => LogLevel::Debug,
        "info" => LogLevel::Info,
        "warn" => LogLevel::Warn,
        "error" => LogLevel::Error,
        _ => LogLevel::Info,
    };

    LogService::log_message(log_level, category, message, data)
        .await
        .map_err(|e| e.to_string())
}

#[command]
pub async fn track_activity(action: String) -> Result<(), String> {
    LogService::track_activity(action)
        .await
        .map_err(|e| e.to_string())
}

#[command]
pub async fn get_recent_logs(limit: Option<usize>) -> Result<Vec<LogEntry>, String> {
    LogService::get_recent_logs(limit)
        .await
        .map_err(|e| e.to_string())
}

#[command]
pub async fn get_logs_by_level(level: String) -> Result<Vec<LogEntry>, String> {
    let log_level = match level.to_lowercase().as_str() {
        "debug" => LogLevel::Debug,
        "info" => LogLevel::Info,
        "warn" => LogLevel::Warn,
        "error" => LogLevel::Error,
        _ => LogLevel::Info,
    };

    LogService::get_logs_by_level(log_level)
        .await
        .map_err(|e| e.to_string())
}

#[command]
pub async fn get_recent_activity() -> Result<Vec<ActivityEntry>, String> {
    LogService::get_recent_activity()
        .await
        .map_err(|e| e.to_string())
}

#[command]
pub async fn clear_logs() -> Result<(), String> {
    LogService::clear_logs().await.map_err(|e| e.to_string())
}
