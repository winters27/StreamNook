use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TwitchStream {
    pub id: String,
    pub user_id: String,
    pub user_name: String,
    pub user_login: String,
    pub title: String,
    pub viewer_count: u32,
    #[serde(default)]
    pub game_id: String,
    pub game_name: String,
    pub thumbnail_url: String,
    pub started_at: String,
    #[serde(default)]
    pub broadcaster_type: Option<String>,
    #[serde(default)]
    pub has_shared_chat: Option<bool>,
    #[serde(default)]
    pub profile_image_url: Option<String>,
}
