use crate::models::chat_layout::ChatMessage;
use crate::models::settings::AppState;
use crate::services::chat_service::ChatService;
use crate::services::irc_service::IrcService;
use anyhow::Result;
use tauri::State;

#[tauri::command]
pub async fn start_chat(channel: String, state: State<'_, AppState>) -> Result<u16, String> {
    ChatService::start(&channel, &state)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_chat() -> Result<(), String> {
    ChatService::stop().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn send_chat_message(
    message: String,
    reply_parent_msg_id: Option<String>,
    target_channel: Option<String>,
) -> Result<(), String> {
    ChatService::send_message(
        &message,
        reply_parent_msg_id.as_deref(),
        target_channel.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn join_chat_channel(channel: String) -> Result<(), String> {
    ChatService::join_channel(&channel)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn leave_chat_channel(channel: String) -> Result<(), String> {
    ChatService::leave_channel(&channel)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_multi_chat(
    channels: Vec<String>,
    state: State<'_, AppState>,
) -> Result<u16, String> {
    if channels.is_empty() {
        return Err("No channels provided".to_string());
    }

    // Start with the first channel
    let port = ChatService::start(&channels[0], &state)
        .await
        .map_err(|e| e.to_string())?;

    // Join the rest
    for channel in channels.iter().skip(1) {
        ChatService::join_channel(channel)
            .await
            .unwrap_or_else(|e| {
                log::error!(
                    "[IRC Chat] Failed to join additional channel {}: {}",
                    channel,
                    e
                );
            });
    }

    Ok(port)
}

/// Parse historical IRC messages (from IVR API) through the Rust backend
/// Layout is handled by the browser - we just parse the message structure
#[tauri::command]
pub async fn parse_historical_messages(messages: Vec<String>) -> Result<Vec<ChatMessage>, String> {
    Ok(IrcService::parse_historical_messages(messages).await)
}
