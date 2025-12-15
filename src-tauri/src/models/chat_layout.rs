use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Badge {
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url_1x: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url_2x: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url_4x: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct EmotePos {
    pub id: String,
    pub start: usize,
    pub end: usize,
    pub url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LayoutResult {
    pub height: f32,
    pub width: f32,
    #[serde(default)]
    pub has_reply: bool,
    #[serde(default)]
    pub is_first_message: bool,
}

/// Reply information parsed from IRC tags
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ReplyInfo {
    pub parent_msg_id: String,
    pub parent_display_name: String,
    pub parent_msg_body: String,
    pub parent_user_id: String,
    pub parent_user_login: String,
}

/// Pre-computed message metadata - THE ENDGAME
/// All these fields are computed in Rust to eliminate frontend processing
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct MessageMetadata {
    /// Whether this is an ACTION message (/me command)
    #[serde(default)]
    pub is_action: bool,
    /// Whether this message mentions the current user (set by frontend context)
    #[serde(default)]
    pub is_mentioned: bool,
    /// Whether this is the user's first message in the channel
    #[serde(default)]
    pub is_first_message: bool,
    /// Pre-formatted timestamp string (e.g., "3:45 PM")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formatted_timestamp: Option<String>,
    /// Pre-formatted timestamp with seconds (e.g., "3:45:30 PM")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formatted_timestamp_with_seconds: Option<String>,
    /// Reply information if this is a reply message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_info: Option<ReplyInfo>,
    /// Source room ID for shared chat messages
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_room_id: Option<String>,
    /// Whether this message is from shared chat (different from current room)
    #[serde(default)]
    pub is_from_shared_chat: bool,
    /// Message type for special messages (sub, resub, subgift, etc.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msg_type: Option<String>,
    /// Bits amount if this is a cheer message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bits_amount: Option<u32>,
    /// System message for subscriptions/donations
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_message: Option<String>,
}

/// Represents a parsed segment of a chat message
/// These segments are pre-calculated in Rust for instant React rendering
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum MessageSegment {
    Text {
        content: String,
    },
    Emote {
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        emote_id: Option<String>,
        emote_url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_zero_width: Option<bool>,
    },
    Emoji {
        content: String,
        emoji_url: String,
    },
    Link {
        content: String,
        url: String,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub id: String,
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub color: Option<String>,
    pub badges: Vec<Badge>,
    pub timestamp: String,
    pub content: String,
    /// Legacy field for backwards compatibility - will be deprecated
    #[serde(default)]
    pub emotes: Vec<EmotePos>,
    pub tags: HashMap<String, String>,
    pub layout: LayoutResult,
    /// Pre-parsed message segments ready for rendering
    /// This is the "endgame" - all parsing done in Rust, zero regex on main thread
    #[serde(default)]
    pub segments: Vec<MessageSegment>,
    /// Pre-computed metadata - THE ENDGAME
    /// All message analysis done in Rust, frontend just renders
    #[serde(default)]
    pub metadata: MessageMetadata,
}
