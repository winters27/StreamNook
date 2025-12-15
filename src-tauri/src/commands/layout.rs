use crate::models::chat_layout::ChatMessage;
use crate::models::settings::AppState;
use crate::services::user_message_history_service::UserMessageHistoryService;
use tauri::State;

#[tauri::command]
pub async fn update_layout_config(
    width: f32,
    font_size: f32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.layout_service.update_config(width, font_size);
    Ok(())
}

/// Extended layout config update with all chat design settings
/// This enables more accurate height pre-calculation by knowing:
/// - message_spacing: affects vertical padding
/// - show_timestamps: affects text width available
#[tauri::command]
pub async fn update_layout_config_extended(
    width: f32,
    font_size: f32,
    message_spacing: f32,
    show_timestamps: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .layout_service
        .update_config_extended(width, font_size, message_spacing, show_timestamps);
    Ok(())
}

/// Simplified layout width update - frontend only sends the container width.
/// The backend reads font_size, message_spacing, show_timestamps from its own
/// settings.chat_design. This is the preferred method since it keeps all
/// configuration in one place (backend) and frontend only reports DOM dimensions.
#[tauri::command]
pub async fn update_layout_width(width: f32, state: State<'_, AppState>) -> Result<(), String> {
    // Read chat design settings from AppState
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    let chat_design = &settings.chat_design;

    // Update layout service with width + settings from backend
    state.layout_service.update_config_extended(
        width,
        chat_design.font_size as f32,
        chat_design.message_spacing as f32,
        chat_design.show_timestamps,
    );

    Ok(())
}

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
