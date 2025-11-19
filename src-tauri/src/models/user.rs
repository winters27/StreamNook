use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct ChannelInfo {
    pub broadcaster_id: String,
    pub broadcaster_name: String,
    pub game_name: String,
    pub title: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UserInfo {
    pub id: String,
    pub login: String,
    pub display_name: String,
    pub email: Option<String>,
    pub profile_image_url: Option<String>,
    pub broadcaster_type: Option<String>,
}
