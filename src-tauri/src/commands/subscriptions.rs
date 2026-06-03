//! Subscriptions Command
//!
//! Lists the current user's active subscriptions via the Twitch GraphQL
//! `currentUser.subscriptionBenefits` field. Uses the same first-party auth
//! path as the resub feature (Android client-id + OAuth token from
//! DropsAuthService) so that `currentUser` resolves - the Helix client-id /
//! token available in the frontend does not resolve `currentUser`.

use crate::services::drops_auth_service::DropsAuthService;
use log::debug;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

// Twitch Android app client ID for GQL operations (same as resub.rs).
const ANDROID_CLIENT_ID: &str = env!("TWITCH_ANDROID_CLIENT_ID");
const CLIENT_URL: &str = "https://www.twitch.tv";

/// One active subscription. Serialized camelCase to match the frontend
/// `MySubscription` interface.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MySubscription {
    pub channel_id: String,
    pub channel_login: String,
    pub channel_display_name: String,
    /// 1, 2, or 3.
    pub tier: u8,
    pub is_prime: bool,
    pub is_gift: bool,
}

/// Create headers for GQL requests (mirrors resub.rs).
fn create_gql_headers(token: &str) -> HeaderMap {
    let device_id = Uuid::new_v4().to_string().replace('-', "");
    let session_id = Uuid::new_v4().to_string().replace('-', "");

    let mut headers = HeaderMap::new();
    headers.insert("Client-ID", HeaderValue::from_static(ANDROID_CLIENT_ID));
    headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
    headers.insert("Accept-Encoding", HeaderValue::from_static("gzip"));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("OAuth {}", token)).unwrap(),
    );
    headers.insert("Origin", HeaderValue::from_static(CLIENT_URL));
    headers.insert("Referer", HeaderValue::from_static(CLIENT_URL));
    headers.insert("X-Device-Id", HeaderValue::from_str(&device_id).unwrap());
    headers.insert(
        "Client-Session-Id",
        HeaderValue::from_str(&session_id).unwrap(),
    );
    headers
}

/// Twitch encodes tiers as "1000" / "2000" / "3000".
fn map_tier(tier: Option<&str>) -> u8 {
    match tier {
        Some("3000") => 3,
        Some("2000") => 2,
        _ => 1,
    }
}

/// Fetch the current user's active subscriptions.
#[tauri::command]
pub async fn get_my_subscriptions() -> Result<Vec<MySubscription>, String> {
    debug!("[Subscriptions] Fetching current user's subscriptions");

    let token = DropsAuthService::get_token()
        .await
        .map_err(|e| format!("Failed to get auth token: {}", e))?;

    let client = crate::services::http::client().clone();

    let query = r#"
        query StreamNookSubscriptions {
          currentUser {
            subscriptionBenefits(first: 100, criteria: { filter: ALL }) {
              edges {
                node {
                  id
                  tier
                  purchasedWithPrime
                  gift { isGift }
                  user { id login displayName }
                }
              }
            }
          }
        }
    "#;

    let response = client
        .post("https://gql.twitch.tv/gql")
        .headers(create_gql_headers(&token))
        .json(&serde_json::json!({ "query": query }))
        .send()
        .await
        .map_err(|e| format!("GQL request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("GQL returned HTTP {}", response.status()));
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    let json: Value =
        serde_json::from_str(&text).map_err(|e| format!("Failed to parse response: {}", e))?;

    // Surface GraphQL errors so the cause (e.g. a missing argument or integrity
    // requirement) is visible in the logs rather than read as "no subs".
    if let Some(errors) = json.get("errors") {
        debug!("[Subscriptions] GQL errors: {:?}", errors);
        return Err(format!("GraphQL errors: {}", errors));
    }

    let edges = json["data"]["currentUser"]["subscriptionBenefits"]["edges"]
        .as_array()
        .cloned()
        .ok_or_else(|| "No subscriptionBenefits in response".to_string())?;

    let mut subs = Vec::new();
    for edge in edges {
        let node = &edge["node"];
        // `user` on a SubscriptionBenefit is "the user who is subscribed to",
        // i.e. the broadcaster / channel.
        let owner = &node["user"];
        let login = match owner["login"].as_str() {
            Some(l) if !l.is_empty() => l.to_string(),
            _ => continue,
        };
        subs.push(MySubscription {
            channel_id: owner["id"].as_str().unwrap_or("").to_string(),
            channel_display_name: owner["displayName"].as_str().unwrap_or(&login).to_string(),
            channel_login: login,
            tier: map_tier(node["tier"].as_str()),
            is_prime: node["purchasedWithPrime"].as_bool().unwrap_or(false),
            is_gift: node["gift"]["isGift"].as_bool().unwrap_or(false),
        });
    }

    debug!("[Subscriptions] Found {} subscriptions", subs.len());
    Ok(subs)
}

/// One expired / past subscription, with the tenure months for that period.
/// Past subs don't expose Prime/gift flags, so the caller counts them at tier
/// price.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PastSubscription {
    pub channel_id: String,
    pub channel_login: String,
    pub channel_display_name: String,
    pub tier: u8,
    pub months: i64,
}

/// Fetch the current user's expired (past) subscriptions. Field shape taken
/// from a real capture of `SubscriptionsManagement_ExpiredSubscriptions`.
#[tauri::command]
pub async fn get_my_past_subscriptions() -> Result<Vec<PastSubscription>, String> {
    debug!("[Subscriptions] Fetching current user's past subscriptions");

    let token = DropsAuthService::get_token()
        .await
        .map_err(|e| format!("Failed to get auth token: {}", e))?;

    let client = crate::services::http::client().clone();

    let query = r#"
        query StreamNookExpiredSubs {
          currentUser {
            expiredSubscriptions(first: 100) {
              edges {
                node {
                  id
                  tenure { months }
                  channelOwner { id login displayName }
                  product { tier }
                }
              }
              pageInfo { hasNextPage }
            }
          }
        }
    "#;

    let response = client
        .post("https://gql.twitch.tv/gql")
        .headers(create_gql_headers(&token))
        .json(&serde_json::json!({ "query": query }))
        .send()
        .await
        .map_err(|e| format!("GQL request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("GQL returned HTTP {}", response.status()));
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    let json: Value =
        serde_json::from_str(&text).map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(errors) = json.get("errors") {
        debug!("[Subscriptions] expired GQL errors: {:?}", errors);
        return Err(format!("GraphQL errors: {}", errors));
    }

    let edges = json["data"]["currentUser"]["expiredSubscriptions"]["edges"]
        .as_array()
        .cloned()
        .ok_or_else(|| "No expiredSubscriptions in response".to_string())?;

    let mut subs = Vec::new();
    for edge in edges {
        let node = &edge["node"];
        let owner = &node["channelOwner"];
        let login = match owner["login"].as_str() {
            Some(l) if !l.is_empty() => l.to_string(),
            _ => continue,
        };
        subs.push(PastSubscription {
            channel_id: owner["id"].as_str().unwrap_or("").to_string(),
            channel_display_name: owner["displayName"].as_str().unwrap_or(&login).to_string(),
            channel_login: login,
            tier: map_tier(node["product"]["tier"].as_str()),
            months: node["tenure"]["months"].as_i64().unwrap_or(0),
        });
    }

    debug!("[Subscriptions] Found {} past subscriptions", subs.len());
    Ok(subs)
}
