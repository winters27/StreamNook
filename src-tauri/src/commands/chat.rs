use crate::models::chat_layout::ChatMessage;
use crate::models::settings::AppState;
use crate::services::chat_logger_service::ChatLoggerService;
use crate::services::chat_service::{ChatService, SendResult};
use crate::services::irc_service::IrcService;
use anyhow::Result;
use tauri::State;

/// The folder chat logs are written to right now (the custom folder when one
/// is set, else the default under the app data dir), for the settings UI.
/// While logging is enabled the folder is created, so opening it always works.
#[tauri::command]
pub async fn get_chat_log_dir(state: State<'_, AppState>) -> Result<String, String> {
    let (folder, enabled) = state
        .settings
        .lock()
        .map(|s| (s.chat_logging.folder.clone(), s.chat_logging.enabled))
        .map_err(|_| "settings unavailable".to_string())?;
    let Some(dir) = ChatLoggerService::resolve_dir(&folder) else {
        return Ok(String::new());
    };
    if enabled {
        let _ = std::fs::create_dir_all(&dir);
    }
    Ok(dir.to_string_lossy().to_string())
}

/// `claim` (default true) marks the calling window as a real chat consumer
/// that will later balance itself with `leave_chat_channel`. Pass false for
/// ensure-only calls (the stream-start warm-up) so the channel can still PART
/// once its actual consumers are gone. `reattach` (default false) is for the
/// reconnect path, whose store still holds channels: it suppresses the sweep
/// of this window's recorded claims that a fresh first-acquire start performs
/// (that sweep is what garbage-collects claims left behind by a previous JS
/// context of the same window, e.g. before a webview reload).
#[tauri::command]
pub async fn start_chat(
    channel: String,
    claim: Option<bool>,
    reattach: Option<bool>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<u16, String> {
    ChatService::start(
        &channel,
        &state,
        claim.unwrap_or(true),
        reattach.unwrap_or(false),
        window.label(),
    )
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
pub async fn join_chat_channel(
    channel: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<(), String> {
    ChatService::join_channel(&channel, &state, window.label())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn leave_chat_channel(channel: String, window: tauri::Window) -> Result<(), String> {
    ChatService::leave_channel(&channel, window.label())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_multi_chat(
    channels: Vec<String>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<u16, String> {
    if channels.is_empty() {
        return Err("No channels provided".to_string());
    }

    // Start with the first channel
    let port = ChatService::start(&channels[0], &state, true, false, window.label())
        .await
        .map_err(|e| e.to_string())?;

    // Join the rest (each call also populates the per-channel emote cache so
    // 7TV/FFZ/BTTV emotes render for these channels too)
    for channel in channels.iter().skip(1) {
        ChatService::join_channel(channel, &state, window.label())
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
