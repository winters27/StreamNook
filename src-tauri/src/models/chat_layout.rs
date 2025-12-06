use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Badge {
    pub name: String,
    pub version: String,
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
    pub emotes: Vec<EmotePos>,
    pub tags: HashMap<String, String>,
    pub layout: LayoutResult,
}
