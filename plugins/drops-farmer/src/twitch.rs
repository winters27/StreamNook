//! The farming engine's Twitch calls, ported from StreamNook's former native
//! channel-points service. This logic lives only here now: the core binary no
//! longer contains the spade endpoint, the claim mutation, or the watch loop.
//!
//! The credential (an Android-client OAuth token plus its client id) is handed
//! over by the host's broker on user consent; this plugin does all of its own
//! networking. The watch report standardizes on the `sendSpadeEvents` GraphQL
//! mutation (the legacy `spade.twitch.tv/track` path is not used).

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use flate2::write::GzEncoder;
use flate2::Compression;
use reqwest::Client;
use serde_json::{json, Value};
use std::io::Write;

/// Public Twitch web client id, used for reading the channel-points context.
const WEB_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CLIENT_URL: &str = "https://www.twitch.tv";
/// Persisted query hash for the ClaimCommunityPoints mutation.
const CLAIM_QUERY_HASH: &str =
    "46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0";

/// A Twitch credential from the host broker.
#[derive(Clone)]
pub struct Cred {
    pub token: String,
    pub client_id: String,
}

#[derive(Clone, Debug)]
pub struct Channel {
    pub channel_id: String,
    pub login: String,
}

/// Live broadcast id plus game info; None when the channel is not live.
pub async fn fetch_stream_info(
    client: &Client,
    channel_id: &str,
    cred: &Cred,
) -> Result<Option<(String, String, String)>> {
    let query = r#"
    query GetStreamInfo($channelID: ID!) {
        user(id: $channelID) { stream { id game { id name } } }
    }"#;
    let body: Value = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", &cred.client_id)
        .header("Authorization", format!("Bearer {}", cred.token))
        .json(&json!({ "query": query, "variables": { "channelID": channel_id } }))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?
        .json()
        .await?;
    let stream = &body["data"]["user"]["stream"];
    let Some(id) = stream["id"].as_str() else {
        return Ok(None);
    };
    Ok(Some((
        id.to_string(),
        stream["game"]["id"].as_str().unwrap_or_default().to_string(),
        stream["game"]["name"].as_str().unwrap_or_default().to_string(),
    )))
}

/// Validates the token and returns the watching user's id (caller caches it).
pub async fn fetch_user_id(client: &Client, token: &str) -> Result<String> {
    let body: Value = client
        .get("https://id.twitch.tv/oauth2/validate")
        .header("Authorization", format!("OAuth {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?
        .json()
        .await?;
    body["user_id"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| anyhow!("token validation returned no user id"))
}

/// One minute-watched event via `sendSpadeEvents`. true when credited (204).
pub async fn send_minute_watched(
    client: &Client,
    channel: &Channel,
    broadcast_id: &str,
    game_id: &str,
    game_name: &str,
    user_id: &str,
    cred: &Cred,
) -> Result<bool> {
    let inner = json!([{
        "event": "minute-watched",
        "properties": {
            "broadcast_id": broadcast_id,
            "channel_id": channel.channel_id,
            "channel": channel.login,
            "client_time": Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
            "game": game_name,
            "game_id": game_id,
            "hidden": false,
            "is_live": true,
            "live": true,
            "logged_in": true,
            "minutes_logged": 1,
            "muted": false,
            "user_id": user_id
        }
    }]);
    let minified = serde_json::to_string(&inner)?;
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(minified.as_bytes())?;
    let g64 = general_purpose::STANDARD.encode(gz.finish()?);
    let mutation = json!({
        "query": "\n mutation SendEvents($input: SendSpadeEventsInput!) {\n sendSpadeEvents(input: $input) {\n statusCode\n}\n}\n",
        "variables": { "input": { "data": g64, "repository": "twilight", "encoding": "GZIP_B64" } }
    });
    let body: Value = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-ID", &cred.client_id)
        .header("Authorization", format!("OAuth {}", cred.token))
        .header("Origin", CLIENT_URL)
        .header("Referer", CLIENT_URL)
        .header("Accept-Language", "en-US")
        .json(&mutation)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await?
        .json()
        .await
        .unwrap_or(json!({}));
    Ok(body["data"]["sendSpadeEvents"]["statusCode"].as_i64() == Some(204))
}

/// Channel-points context: the channel id and the available bonus claim id,
/// if one is ready. Read with the public web client id.
pub async fn fetch_claim(
    client: &Client,
    login: &str,
    device_id: &str,
    session_id: &str,
    token: &str,
) -> Result<Option<(String, String)>> {
    let query = r#"
        query ChannelPointsContext($channelLogin: String!) {
            user(login: $channelLogin) {
                id channel { id self { communityPoints { availableClaim { id } } } }
            }
        }"#;
    let body: Value = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", WEB_CLIENT_ID)
        .header("Authorization", format!("OAuth {token}"))
        .header("User-Agent", USER_AGENT)
        .header("X-Device-Id", device_id)
        .header("Client-Session-Id", session_id)
        .json(&json!({
            "operationName": "ChannelPointsContext",
            "query": query,
            "variables": { "channelLogin": login.to_lowercase() }
        }))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?
        .json()
        .await?;
    let channel = &body["data"]["user"]["channel"];
    let Some(channel_id) = channel["id"].as_str() else {
        return Ok(None);
    };
    let claim_id = channel["self"]["communityPoints"]["availableClaim"]["id"].as_str();
    Ok(claim_id.map(|id| (channel_id.to_string(), id.to_string())))
}

/// Claims a bonus chest via ClaimCommunityPoints. Uses the Android client id
/// to match the token. true on success.
pub async fn claim_points(
    client: &Client,
    channel_id: &str,
    claim_id: &str,
    device_id: &str,
    session_id: &str,
    cred: &Cred,
) -> Result<bool> {
    let body: Value = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", &cred.client_id)
        .header("Authorization", format!("OAuth {}", cred.token))
        .header("User-Agent", USER_AGENT)
        .header("X-Device-Id", device_id)
        .header("Client-Session-Id", session_id)
        .json(&json!({
            "operationName": "ClaimCommunityPoints",
            "extensions": { "persistedQuery": { "version": 1, "sha256Hash": CLAIM_QUERY_HASH } },
            "variables": { "input": { "claimID": claim_id, "channelID": channel_id } }
        }))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?
        .json()
        .await?;
    if body["data"]["claimCommunityPoints"]["error"].is_object() {
        return Ok(false);
    }
    Ok(body["data"]["claimCommunityPoints"].is_object())
}
