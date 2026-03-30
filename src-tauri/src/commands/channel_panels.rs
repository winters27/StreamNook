use log::debug;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// Use Twitch web client ID - works without authentication for read operations
const WEB_CLIENT_ID: &str = env!("TWITCH_WEB_CLIENT_ID");
const GQL_URL: &str = "https://gql.twitch.tv/gql";

/// Create headers for GQL requests (no auth required for read operations)
fn create_gql_headers() -> HeaderMap {
    let device_id = Uuid::new_v4().to_string().replace("-", "");
    let session_id = Uuid::new_v4().to_string().replace("-", "");

    let mut headers = HeaderMap::new();
    headers.insert("Client-ID", HeaderValue::from_static(WEB_CLIENT_ID));
    headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
    headers.insert("X-Device-Id", HeaderValue::from_str(&device_id).unwrap());
    headers.insert(
        "Client-Session-Id",
        HeaderValue::from_str(&session_id).unwrap(),
    );
    headers
}

// ============================================================================
// GQL RESPONSE STRUCTS
// ============================================================================

#[derive(Debug, Deserialize)]
struct GqlPanelsResponse {
    data: Option<GqlPanelsData>,
}

#[derive(Debug, Deserialize)]
struct GqlPanelsData {
    user: Option<GqlPanelsUser>,
}

#[derive(Debug, Deserialize)]
struct GqlPanelsUser {
    #[serde(default)]
    description: Option<String>,
    panels: Option<Vec<GqlPanel>>,
    #[serde(default)]
    followers: Option<GqlFollowers>,
    #[serde(rename = "profileImageURL", default)]
    profile_image_url: Option<String>,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
    #[serde(rename = "broadcastSettings", default)]
    broadcast_settings: Option<GqlBroadcastSettings>,
    /// Social media data lives on user.channel, not user directly
    #[serde(default)]
    channel: Option<GqlChannel>,
}

#[derive(Debug, Deserialize)]
struct GqlPanel {
    id: Option<String>,
    #[serde(rename = "type")]
    panel_type: Option<String>,
    title: Option<String>,
    description: Option<String>,
    #[serde(rename = "imageURL")]
    image_url: Option<String>,
    #[serde(rename = "linkURL")]
    link_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GqlChannel {
    #[serde(rename = "socialMedias", default)]
    social_medias: Option<Vec<GqlSocialMedia>>,
}

#[derive(Debug, Deserialize)]
struct GqlSocialMedia {
    name: Option<String>,
    title: Option<String>,
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GqlFollowers {
    #[serde(rename = "totalCount")]
    total_count: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct GqlBroadcastSettings {
    title: Option<String>,
    game: Option<GqlGame>,
}

#[derive(Debug, Deserialize)]
struct GqlGame {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
}

// ============================================================================
// PUBLIC API STRUCTS (sent to frontend)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelPanel {
    pub id: String,
    pub panel_type: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image_url: Option<String>,
    pub link_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocialMediaLink {
    pub name: String,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelAboutData {
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub profile_image_url: Option<String>,
    pub follower_count: Option<i64>,
    pub panels: Vec<ChannelPanel>,
    pub social_links: Vec<SocialMediaLink>,
    pub stream_title: Option<String>,
    pub game_name: Option<String>,
}

// ============================================================================
// TAURI COMMAND
// ============================================================================

/// Fetch channel about data (panels, social links, description) via GQL
/// Uses inline query — no persisted query hash required
#[tauri::command]
pub async fn get_channel_about_data(channel_login: String) -> Result<ChannelAboutData, String> {
    debug!(
        "[ChannelPanels] Fetching about data for channel: {}",
        channel_login
    );

    let client = Client::new();

    // Inline GQL query for channel panels + social media
    // - Panel is a union type — use inline fragment for DefaultPanel fields
    // - Social media data lives on user.channel.socialMedias, not user.socialMedias
    let query = r#"
        query ChannelPanels($login: String!) {
            user(login: $login) {
                displayName
                description
                profileImageURL(width: 300)
                followers {
                    totalCount
                }
                panels {
                    id
                    type
                    ... on DefaultPanel {
                        title
                        description
                        imageURL
                        linkURL
                    }
                }
                channel {
                    socialMedias {
                        name
                        title
                        url
                    }
                }
                broadcastSettings {
                    title
                    game {
                        displayName
                    }
                }
            }
        }
    "#;

    let request_body = serde_json::json!({
        "operationName": "ChannelPanels",
        "query": query,
        "variables": {
            "login": channel_login.to_lowercase()
        }
    });

    let response = client
        .post(GQL_URL)
        .headers(create_gql_headers())
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("Failed to send GQL request: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "GQL request failed with status: {}",
            response.status()
        ));
    }

    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read GQL response: {}", e))?;

    let gql_response: GqlPanelsResponse = serde_json::from_str(&response_text).map_err(|e| {
        format!(
            "Failed to parse GQL response: {} - Raw: {}",
            e,
            &response_text[..500.min(response_text.len())]
        )
    })?;

    let user = gql_response
        .data
        .and_then(|d| d.user)
        .ok_or_else(|| format!("No user data found for channel: {}", channel_login))?;

    // Transform panels
    let panels: Vec<ChannelPanel> = user
        .panels
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| {
            let id = p.id?;
            let panel_type = p.panel_type.unwrap_or_else(|| "DEFAULT".to_string());
            Some(ChannelPanel {
                id,
                panel_type,
                title: p.title,
                description: p.description,
                image_url: p.image_url,
                link_url: p.link_url,
            })
        })
        .collect();

    // Transform social links (from user.channel.socialMedias)
    let social_links: Vec<SocialMediaLink> = user
        .channel
        .and_then(|c| c.social_medias)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|s| {
            let name = s.name?;
            let url = s.url?;
            let title = s.title.unwrap_or_else(|| name.clone());
            Some(SocialMediaLink { name, title, url })
        })
        .collect();

    // Extract follower count
    let follower_count = user.followers.and_then(|f| f.total_count);

    // Extract stream info
    let (stream_title, game_name) = if let Some(bs) = user.broadcast_settings {
        (bs.title, bs.game.and_then(|g| g.display_name))
    } else {
        (None, None)
    };

    debug!(
        "[ChannelPanels] ✅ Fetched {} panels, {} social links for {}",
        panels.len(),
        social_links.len(),
        channel_login
    );

    Ok(ChannelAboutData {
        display_name: user.display_name,
        description: user.description,
        profile_image_url: user.profile_image_url,
        follower_count,
        panels,
        social_links,
        stream_title,
        game_name,
    })
}
