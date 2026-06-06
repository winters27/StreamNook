use crate::models::chat_layout::ChatMessage;
use crate::models::settings::AppState;
use crate::services::chat_service::{ChatService, SendResult};
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
    broadcaster_id: Option<String>,
    sender_id: Option<String>,
    sender_account_id: Option<String>,
) -> Result<SendResult, String> {
    ChatService::send_message(
        &message,
        reply_parent_msg_id.as_deref(),
        target_channel.as_deref(),
        broadcaster_id.as_deref(),
        sender_id.as_deref(),
        sender_account_id.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn join_chat_channel(channel: String, state: State<'_, AppState>) -> Result<(), String> {
    ChatService::join_channel(&channel, &state)
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

    // Join the rest (each call also populates the per-channel emote cache so
    // 7TV/FFZ/BTTV emotes render for these channels too)
    for channel in channels.iter().skip(1) {
        ChatService::join_channel(channel, &state)
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
pub async fn parse_historical_messages(
    messages: Vec<String>,
    channel_name: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ChatMessage>, String> {
    // Don't block the backfill on the channel emote fetch. We used to await it so
    // BTTV/7TV/FFZ emotes could be matched during parse, but that put a slow
    // provider (a down 7TV) directly in front of the recent-messages display and
    // left chat blank for seconds. Instead parse immediately with whatever emotes
    // are already cached (warm on any repeat visit) so chat populates fast like
    // Twitch, and warm the cache in the BACKGROUND for live messages and the next
    // visit. Tradeoff: on the first visit to a channel in a session third-party
    // emotes in the short backfill may render as text until the cache fills;
    // Twitch emotes (carried in the IRC tags) always render.
    if let Some(channel) = channel_name {
        let emote_service = state.emote_service.clone();
        tokio::spawn(async move {
            IrcService::fetch_and_store_emotes(&channel, emote_service).await;
        });
    }

    Ok(IrcService::parse_historical_messages(messages).await)
}
