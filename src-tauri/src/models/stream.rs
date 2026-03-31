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
    #[serde(default)]
    pub is_live: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CategoryTag {
    pub id: String,
    pub localized_name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CategoryInfo {
    pub id: String,
    pub name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub followers_count: Option<u32>,
    #[serde(alias = "boxArtURL")]
    pub box_art_url: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<CategoryTag>>,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GqlGameResponse {
    pub game: Option<CategoryInfo>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GqlDataResponse {
    pub data: Option<GqlGameResponse>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TwitchClip {
    pub id: String,
    pub url: String,
    pub embed_url: String,
    pub broadcaster_id: String,
    pub broadcaster_name: String,
    pub creator_id: String,
    pub creator_name: String,
    pub video_id: String,
    pub game_id: String,
    pub language: String,
    pub title: String,
    pub view_count: u32,
    pub created_at: String,
    pub thumbnail_url: String,
    pub duration: f32,
    pub vod_offset: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TwitchVideo {
    pub id: String,
    pub stream_id: Option<String>,
    pub user_id: String,
    pub user_login: String,
    pub user_name: String,
    pub title: String,
    pub description: String,
    pub created_at: String,
    pub published_at: String,
    pub url: String,
    pub thumbnail_url: String,
    pub viewable: String,
    pub view_count: u32,
    pub language: String,
    #[serde(rename = "type")]
    pub video_type: String,
    pub duration: String,
}
