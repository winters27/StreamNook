use crate::models::chat_layout::ChatMessage;
use crate::models::settings::AppState;
use crate::services::chat_logger_service::ChatLoggerService;
use crate::services::chat_service::{ChatService, SendResult};
use crate::services::irc_service::IrcService;
use crate::services::providers::{registry, SendCapability, SendOutcome};
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

/// Connect a non-Twitch provider's chat for this window. Brings up (or reuses)
/// the shared local-WS bridge and returns its port so the frontend attaches to
/// the same socket the Twitch path uses. Errors if no adapter is registered for
/// the provider yet. Twitch keeps its own `start_chat` path.
#[tauri::command]
pub async fn provider_chat_connect(
    provider: String,
    channel: String,
    window: tauri::Window,
) -> Result<u16, String> {
    let port = IrcService::ensure_local_ws_bridge()
        .await
        .map_err(|e| e.to_string())?;
    match registry().await.get(&provider) {
        Some(p) => {
            p.connect(&channel, window.label())
                .await
                .map_err(|e| e.to_string())?;
            Ok(port)
        }
        None => Err(format!("provider '{}' is not available yet", provider)),
    }
}

/// Drop this window's claim on a non-Twitch source; the adapter disconnects when
/// the last consumer leaves.
#[tauri::command]
pub async fn provider_chat_disconnect(
    provider: String,
    channel: String,
    window: tauri::Window,
) -> Result<(), String> {
    if let Some(p) = registry().await.get(&provider) {
        p.disconnect(&channel, window.label())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Send a message to a non-Twitch source via its adapter.
#[tauri::command]
pub async fn provider_send_message(
    provider: String,
    channel: String,
    text: String,
    reply_to: Option<String>,
) -> Result<SendOutcome, String> {
    match registry().await.get(&provider) {
        Some(p) => p
            .send(&channel, &text, reply_to.as_deref())
            .await
            .map_err(|e| e.to_string()),
        None => Ok(SendOutcome {
            message_id: None,
            is_sent: false,
            drop_reason: Some("provider unavailable".into()),
        }),
    }
}

/// Whether the user can currently send to a non-Twitch source (read-only,
/// sendable, or needs sign-in). Defaults to read-only when no adapter exists.
#[tauri::command]
pub async fn provider_send_capability(
    provider: String,
    channel: String,
) -> Result<SendCapability, String> {
    Ok(match registry().await.get(&provider) {
        Some(p) => p.send_capability(&channel).await,
        None => SendCapability::ReadOnly,
    })
}

/// Injected JS in the hidden Kick resolver webview reports the resolved chatroom
/// id here (the Cloudflare-clearing fallback for the channel-id lookup).
#[tauri::command]
pub async fn report_kick_chatroom(
    label: String,
    chatroom_id: u64,
    sub_badges: Vec<crate::services::providers::kick::KickSubBadge>,
    meta: Option<crate::services::providers::kick::KickChannelMeta>,
) {
    let subs = sub_badges.into_iter().map(|b| (b.months, b.src)).collect();
    crate::services::providers::kick::resolve_pending(&label, chatroom_id, subs, meta).await;
}

/// The resolver webview reports the channel's native Kick emotes here, separately
/// from the chrome above (their fetch is slower, so it must not delay name /
/// viewers / uptime / chat connect).
#[tauri::command]
pub async fn report_kick_emotes(
    label: String,
    native_emotes: Vec<crate::services::providers::kick_emotes::KickNativeEmoteEntry>,
) {
    crate::services::providers::kick::resolve_emotes_pending(&label, native_emotes).await;
}

/// Live Kick channel metadata (viewers / uptime start_time / title / avatar)
/// captured during channel resolve, for the MultiChat chrome. Returns null until
/// the channel has been resolved.
#[tauri::command]
pub fn get_kick_channel_meta(
    slug: String,
) -> Option<crate::services::providers::kick::KickChannelMeta> {
    crate::services::providers::kick::channel_meta(&slug)
}

/// Live YouTube channel metadata (channel name / title / viewers / uptime start /
/// avatar) scraped from the watch page during resolve, for the MultiChat chrome.
/// `slug` is the source identifier (an `@handle`, `UC…` channel id, or video id).
/// Returns null until the live video has been resolved.
#[tauri::command]
pub fn get_youtube_channel_meta(
    slug: String,
) -> Option<crate::services::providers::youtube::YouTubeChannelMeta> {
    crate::services::providers::youtube::channel_meta(&slug)
}

/// Live TikTok creator metadata (name / title / viewers / avatar) resolved from the
/// profile page + webcast room info, for the MultiChat chrome. `slug` is the TikTok
/// handle. Returns null until the LIVE has been resolved.
#[tauri::command]
pub fn get_tiktok_channel_meta(
    slug: String,
) -> Option<crate::services::providers::tiktok::TikTokChannelMeta> {
    crate::services::providers::tiktok::channel_meta(&slug)
}

/// Sign into YouTube (webview-session): opens a login window, harvests the session
/// cookies once the user finishes, so send/moderation can drive the private API.
#[tauri::command]
pub async fn youtube_connect() -> Result<(), String> {
    crate::services::youtube_auth_service::connect()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn youtube_disconnect() {
    crate::services::youtube_auth_service::disconnect();
}

#[tauri::command]
pub fn youtube_is_connected() -> bool {
    crate::services::youtube_auth_service::is_connected()
}

/// The connected YouTube account's name for the Connections UI, or null. Fetches it
/// once (then cached) so an already-connected session gets its name without a reconnect.
#[tauri::command]
pub async fn youtube_account_name() -> Option<String> {
    crate::services::youtube_auth_service::account_name_lazy().await
}

/// Delete a single YouTube chat message (`message_id` is the live-chat item id).
/// `channel` is the source identifier (the same key the chat slice uses).
#[tauri::command]
pub async fn youtube_delete_message(channel: String, message_id: String) -> Result<(), String> {
    crate::services::providers::youtube::delete_message(&channel, &message_id)
        .await
        .map_err(|e| e.to_string())
}

/// Time out (`duration_seconds` Some — YouTube's fixed timeout) or permanently ban
/// (`duration_seconds` None) a user by their channel id on `channel`'s stream.
#[tauri::command]
pub async fn youtube_ban_user(
    channel: String,
    target_channel_id: String,
    duration_seconds: Option<u32>,
) -> Result<(), String> {
    crate::services::providers::youtube::ban_user(&channel, &target_channel_id, duration_seconds)
        .await
        .map_err(|e| e.to_string())
}

/// Lift a ban / hide on a YouTube user by their channel id.
#[tauri::command]
pub async fn youtube_unban_user(channel: String, target_channel_id: String) -> Result<(), String> {
    crate::services::providers::youtube::unban_user(&channel, &target_channel_id)
        .await
        .map_err(|e| e.to_string())
}

/// Whether the connected YouTube account can moderate this channel's chat (gates the
/// mod controls). Probes a message's context menu; cached after the first answer.
#[tauri::command]
pub async fn youtube_can_moderate(channel: String) -> bool {
    crate::services::providers::youtube::can_moderate(&channel).await
}

/// Connect a Kick account (OAuth, Authorization Code + PKCE) so the user can send
/// Kick chat. Opens the browser to id.kick.com and waits for the loopback redirect.
#[tauri::command]
pub async fn kick_connect() -> Result<(), String> {
    crate::services::kick_auth_service::connect()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn kick_disconnect() {
    crate::services::kick_auth_service::disconnect();
}

#[tauri::command]
pub fn kick_is_connected() -> bool {
    crate::services::kick_auth_service::is_connected()
}

/// The connected Kick account's username (for the Connections UI), or null.
#[tauri::command]
pub async fn kick_account_name() -> Option<String> {
    crate::services::kick_auth_service::account_name().await
}

/// Ban (omit duration) or time out (duration in minutes) a Kick user. Addressed by
/// numeric Kick user ids: the channel's broadcaster id + the target chatter's id.
#[tauri::command]
pub async fn kick_ban_user(
    broadcaster_user_id: u64,
    target_user_id: u64,
    duration_minutes: Option<u32>,
    reason: Option<String>,
) -> Result<(), String> {
    crate::services::providers::kick::ban_user(
        broadcaster_user_id,
        target_user_id,
        duration_minutes,
        reason,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Lift a ban / timeout on a Kick user.
#[tauri::command]
pub async fn kick_unban_user(broadcaster_user_id: u64, target_user_id: u64) -> Result<(), String> {
    crate::services::providers::kick::unban_user(broadcaster_user_id, target_user_id)
        .await
        .map_err(|e| e.to_string())
}

/// Delete a single Kick chat message by its id.
#[tauri::command]
pub async fn kick_delete_message(message_id: String) -> Result<(), String> {
    crate::services::providers::kick::delete_message(&message_id)
        .await
        .map_err(|e| e.to_string())
}

/// A Kick channel's 7TV emotes (channel set + 7TV globals) as an EmoteSet, for the
/// emote picker — parity with Twitch's `fetch_channel_emotes`.
#[tauri::command]
pub async fn get_kick_channel_emotes(slug: String) -> crate::services::emote_service::EmoteSet {
    crate::services::providers::kick_emotes::channel_emote_set(&slug).await
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
