use anyhow::Result;
use reqwest::header::{AUTHORIZATION, ACCEPT};
use reqwest::Client;
use crate::models::{stream::TwitchStream, user::{ChannelInfo, UserInfo}};
use crate::models::settings::AppState;
use crate::services::cookie_jar_service::CookieJarService;
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use once_cell::sync::Lazy;
use tokio::sync::Mutex;
use std::sync::Arc;

const CLIENT_ID: &str = "1qgws7yzcp21g5ledlzffw3lmqdvie";
const SCOPES: &str = "user:read:follows user:read:email chat:read chat:edit channel:read:redemptions channel:manage:redemptions moderator:read:followers";

// Global cookie jar instance for main app auth
static COOKIE_JAR: Lazy<Arc<Mutex<Option<CookieJarService>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ValidateResponse {
    client_id: String,
    user_id: String,
    login: Option<String>,
    scopes: Vec<String>,
    expires_in: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceCodeInfo {
    pub user_code: String,
    pub verification_uri: String,
    pub device_code: String,
    pub interval: u64,
    pub expires_in: u64,
}

pub struct TwitchService;

impl TwitchService {
    /// Initialize the cookie jar on app startup
    async fn get_cookie_jar() -> Result<CookieJarService> {
        let mut jar_lock = COOKIE_JAR.lock().await;
        
        if jar_lock.is_none() {
            println!("[TWITCH_AUTH] Initializing cookie jar...");
            let jar = CookieJarService::new_main()?;
            *jar_lock = Some(jar);
        }
        
        Ok(jar_lock.as_ref().unwrap().clone())
    }

    /// Device Code Flow - the main login method (mimics TwitchDropsMiner)
    pub async fn login(_state: &AppState, app_handle: tauri::AppHandle) -> Result<String> {
        let client = Client::new();
        let cookie_jar = Self::get_cookie_jar().await?;
        
        // Start device flow
        let device_response = Self::start_device_flow(&client).await?;
        
        println!("[TWITCH_AUTH] Device code flow started. User code: {}", device_response.user_code);
        
        // Clone values for the spawned task
        let device_code = device_response.device_code.clone();
        let interval = device_response.interval;
        let expires_in = device_response.expires_in;
        let verification_uri = device_response.verification_uri.clone();
        
        // Spawn a task to poll for token
        tokio::task::spawn(async move {
            println!("[TWITCH_AUTH] Starting token polling task...");
            let result = Self::poll_for_token(&client, &device_code, interval, expires_in).await;
            
            match result {
                Ok(token_response) => {
                    println!("[TWITCH_AUTH] ✅ Token received from Twitch!");
                    
                    // Store in cookies (mimicking TwitchDropsMiner's cookie jar approach)
                    if let Err(e) = cookie_jar.set_auth_token(&token_response.access_token).await {
                        eprintln!("[TWITCH_AUTH] ❌ Failed to save auth token to cookies: {}", e);
                        let _ = app_handle.emit("twitch-login-error", format!("Failed to save token: {}", e));
                        return;
                    }
                    
                    // Validate the token and get user info
                    match Self::validate_and_store_user_info(&token_response.access_token, &cookie_jar).await {
                        Ok(user_id) => {
                            println!("[TWITCH_AUTH] ✅ Login successful, user ID: {}", user_id);
                            
                            // Save cookies to disk
                            if let Err(e) = cookie_jar.save().await {
                                eprintln!("[TWITCH_AUTH] ⚠️ Failed to save cookies: {}", e);
                            }
                            
                            // Emit success event
                            if let Err(e) = app_handle.emit("twitch-login-complete", ()) {
                                eprintln!("[TWITCH_AUTH] ❌ Failed to emit login-complete event: {}", e);
                            } else {
                                println!("[TWITCH_AUTH] ✅ Login complete!");
                            }
                        }
                        Err(e) => {
                            eprintln!("[TWITCH_AUTH] ❌ Failed to validate token: {}", e);
                            let _ = app_handle.emit("twitch-login-error", format!("Token validation failed: {}", e));
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[TWITCH_AUTH] ❌ Token polling failed: {}", e);
                    let _ = app_handle.emit("twitch-login-error", e.to_string());
                }
            }
        });
        
        // Return the verification URI for the frontend to open
        Ok(verification_uri)
    }

    /// Validate token and store user info in cookies (mimics TwitchDropsMiner's _validate)
    async fn validate_and_store_user_info(access_token: &str, cookie_jar: &CookieJarService) -> Result<String> {
        let client = Client::new();
        
        // Validate the token
        let response = client
            .get("https://id.twitch.tv/oauth2/validate")
            .header("Authorization", format!("OAuth {}", access_token))
            .send()
            .await?;
        
        if response.status() == 401 {
            return Err(anyhow::anyhow!("Token is invalid"));
        }
        
        let validate_response: ValidateResponse = response.json().await?;
        
        // Verify client ID matches (like TwitchDropsMiner does)
        if validate_response.client_id != CLIENT_ID {
            println!("[TWITCH_AUTH] ⚠️ Cookie client ID mismatch, clearing cookies");
            let _ = cookie_jar.clear().await;
            return Err(anyhow::anyhow!("Client ID mismatch"));
        }
        
        // Store user ID as persistent cookie (mimics TwitchDropsMiner)
        let _ = cookie_jar.set_persistent_user_id(&validate_response.user_id).await;
        
        Ok(validate_response.user_id)
    }
    
    async fn start_device_flow(client: &Client) -> Result<DeviceCodeResponse> {
        let params = [
            ("client_id", CLIENT_ID),
            ("scopes", SCOPES),
        ];
        
        let response = client
            .post("https://id.twitch.tv/oauth2/device")
            .form(&params)
            .send()
            .await?;
        
        if !response.status().is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!("Failed to start device flow: {}", error_text));
        }
        
        let device_response: DeviceCodeResponse = response.json().await?;
        Ok(device_response)
    }
    
    async fn poll_for_token(
        client: &Client,
        device_code: &str,
        interval: u64,
        expires_in: u64,
    ) -> Result<TokenResponse> {
        let start_time = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let expiry_time = start_time + expires_in;
        let mut poll_interval = interval;
        
        loop {
            let current_time = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
            if current_time >= expiry_time {
                return Err(anyhow::anyhow!("Device code expired. Please try logging in again."));
            }
            
            tokio::time::sleep(Duration::from_secs(poll_interval)).await;
            
            let params = [
                ("client_id", CLIENT_ID),
                ("scopes", SCOPES),
                ("device_code", device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ];
            
            let response = client
                .post("https://id.twitch.tv/oauth2/token")
                .form(&params)
                .send()
                .await?;
            
            if response.status().is_success() {
                let token_response: TokenResponse = response.json().await?;
                return Ok(token_response);
            }
            
            let error_text = response.text().await?;
            
            if error_text.contains("authorization_pending") {
                continue;
            } else if error_text.contains("slow_down") {
                poll_interval += 2;
                continue;
            } else if error_text.contains("expired_token") {
                return Err(anyhow::anyhow!("Device code expired. Please try logging in again."));
            } else {
                return Err(anyhow::anyhow!("Token polling failed: {}", error_text));
            }
        }
    }

    pub async fn logout(_state: &AppState) -> Result<()> {
        let cookie_jar = Self::get_cookie_jar().await?;
        cookie_jar.clear().await?;
        println!("[TWITCH_AUTH] Logout complete - cookies cleared");
        Ok(())
    }

    /// Get the current access token from cookies (mimics TwitchDropsMiner's approach)
    pub async fn get_token() -> Result<String> {
        let cookie_jar = Self::get_cookie_jar().await?;
        
        // Check if we have an auth token in cookies
        if let Some(auth_token) = cookie_jar.get_auth_token().await {
            println!("[TWITCH_AUTH] Token retrieved from cookies");
            
            // Validate the token
            let client = Client::new();
            let response = client
                .get("https://id.twitch.tv/oauth2/validate")
                .header("Authorization", format!("OAuth {}", auth_token))
                .send()
                .await?;
            
            if response.status() == 401 {
                println!("[TWITCH_AUTH] Token is invalid, clearing cookies");
                let _ = cookie_jar.clear().await;
                return Err(anyhow::anyhow!("Not authenticated. Please log in to Twitch first."));
            }
            
            return Ok(auth_token);
        }
        
        Err(anyhow::anyhow!("Not authenticated. Please log in to Twitch first."))
    }

    pub async fn get_followed_streams(_state: &AppState) -> Result<Vec<TwitchStream>> {
        let token = Self::get_token().await?;
        let client = Client::new();
        
        // First, get the user ID
        let user_response = client.get("https://api.twitch.tv/helix/users")
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Client-Id", CLIENT_ID)
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;
        
        let user_id = user_response["data"][0]["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Failed to get user ID"))?;
        
        // Now get followed streams with user_id
        let response = client.get(format!("https://api.twitch.tv/helix/streams/followed?user_id={}", user_id))
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Client-Id", CLIENT_ID)
            .header(ACCEPT, "application/json")
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;
        
        let data = response.get("data").and_then(|d| d.as_array());
        
        match data {
            Some(arr) => {
                let mut streams: Vec<TwitchStream> = serde_json::from_value(serde_json::Value::Array(arr.clone()))?;
                
                if !streams.is_empty() {
                    let user_ids: Vec<String> = streams.iter().map(|s| s.user_id.clone()).collect();
                    let user_ids_param = user_ids.iter().map(|id| format!("id={}", id)).collect::<Vec<_>>().join("&");
                    
                    let users_url = format!("https://api.twitch.tv/helix/users?{}", user_ids_param);
                    let users_response = client.get(&users_url)
                        .header("Client-Id", CLIENT_ID)
                        .header(AUTHORIZATION, format!("Bearer {}", token))
                        .send()
                        .await?
                        .json::<serde_json::Value>()
                        .await?;
                    
                    if let Some(users_data) = users_response.get("data").and_then(|d| d.as_array()) {
                        let mut broadcaster_types = std::collections::HashMap::new();
                        for user in users_data {
                            if let (Some(id), Some(broadcaster_type)) = (
                                user.get("id").and_then(|v| v.as_str()),
                                user.get("broadcaster_type").and_then(|v| v.as_str())
                            ) {
                                if !broadcaster_type.is_empty() {
                                    broadcaster_types.insert(id.to_string(), broadcaster_type.to_string());
                                }
                            }
                        }
                        
                        for stream in &mut streams {
                            if let Some(broadcaster_type) = broadcaster_types.get(&stream.user_id) {
                                stream.broadcaster_type = Some(broadcaster_type.clone());
                            }
                        }
                    }
                }
                
                Ok(streams)
            },
            None => Ok(Vec::new()),
        }
    }

    pub async fn get_channel_info(channel_name: &str, _state: &AppState) -> Result<ChannelInfo> {
        let token = Self::get_token().await?;
        let client = Client::new();
        let response = client.get(format!("https://api.twitch.tv/helix/channels?broadcaster_login={}", channel_name))
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Client-Id", CLIENT_ID)
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;
        
        let data = response.get("data")
            .and_then(|d| d.as_array())
            .and_then(|arr| arr.first())
            .ok_or_else(|| anyhow::anyhow!("Channel '{}' not found", channel_name))?;
        
        let info: ChannelInfo = serde_json::from_value(data.clone())?;
        Ok(info)
    }

    pub async fn get_user_info() -> Result<UserInfo> {
        let token = Self::get_token().await?;
        let client = Client::new();
        
        let response = client.get("https://api.twitch.tv/helix/users")
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Client-Id", CLIENT_ID)
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;
        
        let data = response.get("data")
            .and_then(|d| d.as_array())
            .and_then(|arr| arr.first())
            .ok_or_else(|| anyhow::anyhow!("Failed to get user info"))?;
        
        let user_info: UserInfo = serde_json::from_value(data.clone())?;
        Ok(user_info)
    }

    pub async fn get_user_by_login(login: &str) -> Result<UserInfo> {
        let token = Self::get_token().await?;
        let client = Client::new();
        
        let response = client.get(format!("https://api.twitch.tv/helix/users?login={}", login))
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Client-Id", CLIENT_ID)
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;
        
        let data = response.get("data")
            .and_then(|d| d.as_array())
            .and_then(|arr| arr.first())
            .ok_or_else(|| anyhow::anyhow!("User '{}' not found", login))?;
        
        let user_info: UserInfo = serde_json::from_value(data.clone())?;
        Ok(user_info)
    }

    pub async fn get_user_by_id(user_id: &str) -> Result<UserInfo> {
        let token = Self::get_token().await?;
        let client = Client::new();
        
        let response = client.get(format!("https://api.twitch.tv/helix/users?id={}", user_id))
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Client-Id", CLIENT_ID)
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;
        
        let data = response.get("data")
            .and_then(|d| d.as_array())
            .and_then(|arr| arr.first())
            .ok_or_else(|| anyhow::anyhow!("User with ID '{}' not found", user_id))?;
        
        let user_info: UserInfo = serde_json::from_value(data.clone())?;
        Ok(user_info)
    }

    pub async fn get_recommended_streams_paginated(
        _state: &AppState,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<(Vec<TwitchStream>, Option<String>)> {
        let token = Self::get_token().await.ok();
        let client = Client::new();
        
        let mut url = format!("https://api.twitch.tv/helix/streams?first={}", limit);
        if let Some(cursor) = cursor {
            url.push_str(&format!("&after={}", cursor));
        }
        
        let mut request = client.get(&url)
            .header("Client-Id", CLIENT_ID);
        
        if let Some(token) = &token {
            request = request.header(AUTHORIZATION, format!("Bearer {}", token));
        }
        
        let response = request
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;
        
        let next_cursor = response
            .get("pagination")
            .and_then(|p| p.get("cursor"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());
        
        let data = response.get("data").and_then(|d| d.as_array());
        
        match data {
            Some(arr) => {
                let mut streams: Vec<TwitchStream> = serde_json::from_value(serde_json::Value::Array(arr.clone()))?;
                
                if !streams.is_empty() && token.is_some() {
                    let user_ids: Vec<String> = streams.iter().map(|s| s.user_id.clone()).collect();
                    let user_ids_param = user_ids.iter().map(|id| format!("id={}", id)).collect::<Vec<_>>().join("&");
                    
                    let users_url = format!("https://api.twitch.tv/helix/users?{}", user_ids_param);
                    let users_response = client.get(&users_url)
                        .header("Client-Id", CLIENT_ID)
                        .header(AUTHORIZATION, format!("Bearer {}", token.unwrap()))
                        .send()
                        .await?
                        .json::<serde_json::Value>()
                        .await?;
                    
                    if let Some(users_data) = users_response.get("data").and_then(|d| d.as_array()) {
                        let mut broadcaster_types = std::collections::HashMap::new();
                        for user in users_data {
                            if let (Some(id), Some(broadcaster_type)) = (
                                user.get("id").and_then(|v| v.as_str()),
                                user.get("broadcaster_type").and_then(|v| v.as_str())
                            ) {
                                if !broadcaster_type.is_empty() {
                                    broadcaster_types.insert(id.to_string(), broadcaster_type.to_string());
                                }
                            }
                        }
                        
                        for stream in &mut streams {
                            if let Some(broadcaster_type) = broadcaster_types.get(&stream.user_id) {
                                stream.broadcaster_type = Some(broadcaster_type.clone());
                            }
                        }
                    }
                }
                
                Ok((streams, next_cursor))
            },
            None => Ok((Vec::new(), None)),
        }
    }

    pub async fn get_recommended_streams(_state: &AppState) -> Result<Vec<TwitchStream>> {
        let (streams, _) = Self::get_recommended_streams_paginated(_state, None, 20).await?;
        Ok(streams)
    }

    pub async fn get_top_games(_state: &AppState, limit: u32) -> Result<Vec<serde_json::Value>> {
        let token = Self::get_token().await.ok();
        let client = Client::new();
        
        let url = format!("https://api.twitch.tv/helix/games/top?first={}", limit);
        
        let mut request = client.get(&url)
            .header("Client-Id", CLIENT_ID);
        
        if let Some(token) = &token {
            request = request.header(AUTHORIZATION, format!("Bearer {}", token));
        }
        
        let response = request
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;
        
        let data = response.get("data").and_then(|d| d.as_array());
        
        match data {
            Some(arr) => {
                let mut games_with_viewers = Vec::new();
                
                for game in arr {
                    let mut game_data = game.clone();
                    
                    if let Some(game_id) = game.get("id").and_then(|id| id.as_str()) {
                        let streams_url = format!("https://api.twitch.tv/helix/streams?game_id={}&first=100", game_id);
                        
                        let mut streams_request = client.get(&streams_url)
                            .header("Client-Id", CLIENT_ID);
                        
                        if let Some(token) = &token {
                            streams_request = streams_request.header(AUTHORIZATION, format!("Bearer {}", token));
                        }
                        
                        if let Ok(streams_response) = streams_request.send().await {
                            if let Ok(streams_json) = streams_response.json::<serde_json::Value>().await {
                                if let Some(streams_data) = streams_json.get("data").and_then(|d| d.as_array()) {
                                    let total_viewers: i64 = streams_data.iter()
                                        .filter_map(|s| s.get("viewer_count").and_then(|v| v.as_i64()))
                                        .sum();
                                    
                                    if let Some(obj) = game_data.as_object_mut() {
                                        obj.insert("viewer_count".to_string(), serde_json::json!(total_viewers));
                                    }
                                }
                            }
                        }
                    }
                    
                    games_with_viewers.push(game_data);
                }
                
                Ok(games_with_viewers)
            },
            None => Ok(Vec::new()),
        }
    }

    pub async fn get_streams_by_game(
        _state: &AppState,
        game_id: &str,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<(Vec<TwitchStream>, Option<String>)> {
        let token = Self::get_token().await.ok();
        let client = Client::new();
        
        let mut url = format!("https://api.twitch.tv/helix/streams?game_id={}&first={}", game_id, limit);
        if let Some(cursor) = cursor {
            url.push_str(&format!("&after={}", cursor));
        }
        
        let mut request = client.get(&url)
            .header("Client-Id", CLIENT_ID);
        
        if let Some(token) = &token {
            request = request.header(AUTHORIZATION, format!("Bearer {}", token));
        }
        
        let response = request
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;
        
        let next_cursor = response
            .get("pagination")
            .and_then(|p| p.get("cursor"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());
        
        let data = response.get("data").and_then(|d| d.as_array());
        
        match data {
            Some(arr) => {
                let mut streams: Vec<TwitchStream> = serde_json::from_value(serde_json::Value::Array(arr.clone()))?;
                
                if !streams.is_empty() && token.is_some() {
                    let user_ids: Vec<String> = streams.iter().map(|s| s.user_id.clone()).collect();
                    let user_ids_param = user_ids.iter().map(|id| format!("id={}", id)).collect::<Vec<_>>().join("&");
                    
                    let users_url = format!("https://api.twitch.tv/helix/users?{}", user_ids_param);
                    let users_response = client.get(&users_url)
                        .header("Client-Id", CLIENT_ID)
                        .header(AUTHORIZATION, format!("Bearer {}", token.unwrap()))
                        .send()
                        .await?
                        .json::<serde_json::Value>()
                        .await?;
                    
                    if let Some(users_data) = users_response.get("data").and_then(|d| d.as_array()) {
                        let mut broadcaster_types = std::collections::HashMap::new();
                        for user in users_data {
                            if let (Some(id), Some(broadcaster_type)) = (
                                user.get("id").and_then(|v| v.as_str()),
                                user.get("broadcaster_type").and_then(|v| v.as_str())
                            ) {
                                if !broadcaster_type.is_empty() {
                                    broadcaster_types.insert(id.to_string(), broadcaster_type.to_string());
                                }
                            }
                        }
                        
                        for stream in &mut streams {
                            if let Some(broadcaster_type) = broadcaster_types.get(&stream.user_id) {
                                stream.broadcaster_type = Some(broadcaster_type.clone());
                            }
                        }
                    }
                }
                
                Ok((streams, next_cursor))
            },
            None => Ok((Vec::new(), None)),
        }
    }

    pub async fn search_channels(_state: &AppState, query: &str) -> Result<Vec<TwitchStream>> {
        let token = Self::get_token().await.ok();
        let client = Client::new();
        
        let url = format!("https://api.twitch.tv/helix/search/channels?query={}&live_only=true&first=20", 
            urlencoding::encode(query));
        
        let mut request = client.get(&url)
            .header("Client-Id", CLIENT_ID);
        
        if let Some(token) = &token {
            request = request.header(AUTHORIZATION, format!("Bearer {}", token));
        }
        
        let response = request
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;
        
        let data = response.get("data").and_then(|d| d.as_array());
        
        match data {
            Some(arr) => {
                let mut streams = Vec::new();
                
                for channel in arr {
                    if let (Some(id), Some(user_id), Some(user_name), Some(user_login), Some(title), Some(game_name)) = (
                        channel.get("id").and_then(|v| v.as_str()),
                        channel.get("id").and_then(|v| v.as_str()),
                        channel.get("display_name").and_then(|v| v.as_str()),
                        channel.get("broadcaster_login").and_then(|v| v.as_str()),
                        channel.get("title").and_then(|v| v.as_str()),
                        channel.get("game_name").and_then(|v| v.as_str()),
                    ) {
                        let thumbnail_url = channel.get("thumbnail_url")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .replace("{width}", "320")
                            .replace("{height}", "180");
                        
                        let broadcaster_type = channel.get("broadcaster_type")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
