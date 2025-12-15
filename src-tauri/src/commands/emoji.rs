/// Emoji Commands - Exposes emoji conversion functionality to frontend
use crate::services::emoji_service;

/// Converts emoji shortcodes in text to Unicode emojis
/// Called from frontend to offload emoji map from JavaScript heap
#[tauri::command]
pub fn convert_emoji_shortcodes(text: String) -> String {
    emoji_service::convert_emoji_shortcodes(&text)
}
