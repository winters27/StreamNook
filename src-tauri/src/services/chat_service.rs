// This module now uses IRC for chat instead of EventSub
// Simply re-exports the IrcService as ChatService for backwards compatibility

use crate::models::settings::AppState;
use crate::services::irc_service::IrcService;
use anyhow::Result;

pub struct ChatService;

impl ChatService {
    pub async fn start(channel: &str, state: &AppState) -> Result<u16> {
        IrcService::start(channel, state).await
    }

    pub async fn send_message(
        message: &str,
        reply_parent_msg_id: Option<&str>,
        target_channel: Option<&str>,
    ) -> Result<()> {
        IrcService::send_message(message, reply_parent_msg_id, target_channel).await
    }

    pub async fn stop() -> Result<()> {
        IrcService::stop().await
    }

    pub async fn join_channel(channel: &str, state: &AppState) -> Result<()> {
        IrcService::join_channel(channel).await?;
        // Populate the per-channel emote cache for the newly-JOINed channel.
        // Without this, `parse_text_segment` can't find 7TV/FFZ/BTTV emotes
        // for messages from this channel (it reads from CHANNEL_EMOTES which
        // is keyed per channel). Previously every `start_chat` did a full
        // tear-down + re-fetch which masked the gap; with idempotent `start`,
        // additional-channel JOINs (channel switching, MultiChat tabs, etc.)
        // now route through this path.
        IrcService::fetch_and_store_emotes(channel, state.emote_service.clone()).await;
        Ok(())
    }

    pub async fn leave_channel(channel: &str) -> Result<()> {
        IrcService::leave_channel(channel).await
    }
}
