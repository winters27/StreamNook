// This module now uses IRC for chat instead of EventSub
// Simply re-exports the IrcService as ChatService for backwards compatibility

use anyhow::Result;
use crate::services::irc_service::IrcService;
use crate::models::settings::AppState;

pub struct ChatService;

impl ChatService {
    pub async fn start(channel: &str, state: &AppState) -> Result<u16> {
        IrcService::start(channel, state).await
    }

    pub async fn send_message(message: &str, reply_parent_msg_id: Option<&str>) -> Result<()> {
        IrcService::send_message(message, reply_parent_msg_id).await
    }

    pub async fn stop() -> Result<()> {
        IrcService::stop().await
    }

    pub async fn join_channel(channel: &str) -> Result<()> {
        IrcService::join_channel(channel).await
    }

    pub async fn leave_channel(channel: &str) -> Result<()> {
        IrcService::leave_channel(channel).await
    }
}
