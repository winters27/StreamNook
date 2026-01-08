use crate::models::chat_layout::ChatMessage;
use crate::services::user_message_history_service::UserMessageHistoryService;

/// Get user message history from Rust LRU cache
/// This replaces the frontend's userMessageHistory Map
#[tauri::command]
pub async fn get_user_message_history(user_id: String) -> Result<Vec<ChatMessage>, String> {
    let service = UserMessageHistoryService::global();
    Ok(service.get_history(&user_id).await)
}

/// Get user message history with limit
#[tauri::command]
pub async fn get_user_message_history_limited(
    user_id: String,
    limit: usize,
) -> Result<Vec<ChatMessage>, String> {
    let service = UserMessageHistoryService::global();
    Ok(service.get_history_limited(&user_id, limit).await)
}

/// Clear user message history (e.g., when switching channels)
#[tauri::command]
pub async fn clear_user_message_history() -> Result<(), String> {
    let service = UserMessageHistoryService::global();
    service.clear_all().await;
    Ok(())
}

/// Get the number of users being tracked
#[tauri::command]
pub async fn get_user_history_count() -> Result<usize, String> {
    let service = UserMessageHistoryService::global();
    Ok(service.user_count().await)
}
