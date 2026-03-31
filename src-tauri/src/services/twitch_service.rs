use crate::models::settings::AppState;
use crate::models::{
    stream::TwitchStream,
    user::{ChannelInfo, UserInfo},
};
use crate::services::cookie_jar_service::CookieJarService;
use anyhow::Result;
use chrono::{Duration as ChronoDuration, Utc};
use keyring::Entry;
use log::{debug, error};
use reqwest::header::{ACCEPT, AUTHORIZATION};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

const CLIENT_ID: &str = env!("TWITCH_APP_CLIENT_ID");
const CLIENT_SECRET: &str = env!("TWITCH_APP_CLIENT_SECRET");
const TWITCH_GQL_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const KEYRING_SERVICE: &str = "streamnook_twitch_token";
const KEYRING_USERNAME: &str = "user"; // Standardized username
const REDIRECT_URI: &str = "http://localhost:3000/callback";
const SCOPES: &str = "user:read:follows user:read:email chat:read chat:edit channel:read:redemptions channel:manage:redemptions moderator:read:followers openid user:manage:whispers user:read:whispers user:read:emotes channel:read:hype_train moderator:read:blocked_terms moderator:manage:chat_settings moderator:manage:unban_requests moderator:manage:banned_users moderator:manage:chat_messages moderator:read:moderators moderator:read:vips channel:manage:moderators channel:manage:vips moderator:manage:suspicious_users user:manage:chat_color user:manage:blocked_users user:read:blocked_users moderator:manage:announcements moderator:manage:shoutouts channel:edit:commercial channel:manage:raids channel:manage:broadcast moderation:read";
const TOKEN_FILE_NAME: &str = ".twitch_token";

/// Get the app data directory (works consistently in dev and release)
fn get_app_data_dir() -> Result<PathBuf> {
    // Try to use the standard config directory first
    if let Some(config_dir) = dirs::config_dir() {
        let app_dir = config_dir.join("StreamNook");
        return Ok(app_dir);
    }

    // Fallback to data directory
    if let Some(data_dir) = dirs::data_dir() {
        let app_dir = data_dir.join("StreamNook");
        return Ok(app_dir);
    }

    // Last resort: use current exe directory
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let app_dir = exe_dir.join("data");
            return Ok(app_dir);
        }
    }

    Err(anyhow::anyhow!("Could not determine app data directory"))
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct StorableToken {
    access_token: String,
    refresh_token: String,
    expires_at: i64, // Unix timestamp
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
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

/// Token health status returned by verify_token_health
#[derive(Debug, Clone, Serialize)]
pub struct TokenHealthStatus {
    pub is_valid: bool,
    pub seconds_remaining: i64,
    pub hours_remaining: i64,
    pub minutes_remaining: i64,
    pub scopes: Vec<String>,
    pub user_id: Option<String>,
    pub login: Option<String>,
    pub needs_refresh: bool,
    pub error: Option<String>,
}

pub struct TwitchService;

impl TwitchService {
    fn get_token_file_path() -> Result<PathBuf> {
        let mut path = get_app_data_dir()?;

        // Create directory if it doesn't exist
        if !path.exists() {
            debug!("[TWITCH_SERVICE] Creating directory: {:?}", path);
            fs::create_dir_all(&path)?;
        }

        path.push(TOKEN_FILE_NAME);
        debug!("[TWITCH_SERVICE] Token file path: {:?}", path);
        Ok(path)
    }

    /// Check if stored credentials exist (for showing appropriate toast)
    pub async fn has_stored_credentials() -> bool {
        // Check file first
        if let Ok(path) = Self::get_token_file_path() {
            if path.exists() {
                debug!("[TWITCH_SERVICE] Found stored token file");
                return true;
            }
        }

        // Check cookies
        if let Ok(cookie_jar) = CookieJarService::new_main() {
            if cookie_jar.has_auth_token().await {
                debug!("[TWITCH_SERVICE] Found stored cookie token");
                return true;
            }
        }

        // Check keyring
        if let Ok(entry) = Entry::new(KEYRING_SERVICE, KEYRING_USERNAME) {
            if entry.get_password().is_ok() {
                debug!("[TWITCH_SERVICE] Found stored keyring token");
                return true;
            }
        }

        false
    }

    fn store_token_to_file(token: &StorableToken) -> Result<()> {
        let path = Self::get_token_file_path()?;
        let token_json = serde_json::to_string(token)?;

        // Simple XOR encryption with a fixed key for basic obfuscation
        let key: Vec<u8> = "StreamNookTokenKey2024"
            .bytes()
            .cycle()
            .take(token_json.len())
            .collect();
        let encrypted: Vec<u8> = token_json
            .bytes()
            .zip(key.iter())
            .map(|(a, b)| a ^ b)
            .collect();

        fs::write(&path, encrypted)?;
        debug!("[STORAGE] Token saved to file: {:?}", path);
        Ok(())
    }

    fn load_token_from_file() -> Result<StorableToken> {
        let path = Self::get_token_file_path()?;

        if !path.exists() {
            return Err(anyhow::anyhow!("Token file does not exist"));
        }

        let encrypted = fs::read(&path)?;

        // Decrypt using the same XOR method
        let key: Vec<u8> = "StreamNookTokenKey2024"
            .bytes()
            .cycle()
            .take(encrypted.len())
            .collect();
        let decrypted: String = encrypted
            .iter()
            .zip(key.iter())
            .map(|(a, b)| (a ^ b) as char)
            .collect();

        let token: StorableToken = serde_json::from_str(&decrypted)?;
        Ok(token)
    }

    fn delete_token_file() -> Result<()> {
        let path = Self::get_token_file_path()?;
        if path.exists() {
            fs::remove_file(&path)?;
            debug!("[STORAGE] Token file deleted: {:?}", path);
        }
        Ok(())
    }

    // Cookie-based storage methods
    async fn store_token_to_cookies(token: &StorableToken) -> Result<()> {
        let cookie_jar = CookieJarService::new_main()?;
        // Store full token data including refresh token and expiration
        cookie_jar
            .set_full_token_data(&token.access_token, &token.refresh_token, token.expires_at)
            .await?;
        debug!("[STORAGE] ✅ Full token data saved to cookies (access, refresh, expires_at)");
        Ok(())
    }

    async fn load_token_from_cookies() -> Result<StorableToken> {
        let cookie_jar = CookieJarService::new_main()?;

        let access_token = cookie_jar
            .get_auth_token()
            .await
            .ok_or_else(|| anyhow::anyhow!("No auth token in cookies"))?;

        let refresh_token = cookie_jar.get_refresh_token().await.unwrap_or_default();

        let expires_at = cookie_jar.get_token_expires_at().await.unwrap_or(0);

        Ok(StorableToken {
            access_token,
            refresh_token,
            expires_at,
        })
    }

    async fn delete_cookies() -> Result<()> {
        let cookie_jar = CookieJarService::new_main()?;
        cookie_jar.clear().await?;
        debug!("[STORAGE] Cookies deleted");
        Ok(())
    }

    // Device Code Flow - the main login method (like Python app)
    pub async fn login(_state: &AppState, app_handle: tauri::AppHandle) -> Result<String> {
        let client = Client::new();

        // Start device flow
        let device_response = Self::start_device_flow(&client).await?;

        debug!(
            "Device code flow started. User code: {}",
            device_response.user_code
        );

        // Clone values for the spawned task
        let device_code = device_response.device_code.clone();
        let interval = device_response.interval;
        let expires_in = device_response.expires_in;
        let verification_uri = device_response.verification_uri.clone();

        // Spawn a task to poll for token
        tokio::task::spawn(async move {
            debug!("[LOGIN] Starting token polling task...");
            let result = Self::poll_for_token(&client, &device_code, interval, expires_in).await;

            match result {
                Ok(token_response) => {
                    debug!("[LOGIN] Token received from Twitch!");
                    debug!(
                        "[LOGIN] Access token (first 10 chars): {}...",
                        &token_response.access_token[..10.min(token_response.access_token.len())]
                    );
                    debug!(
                        "[LOGIN] Refresh token present: {}",
                        token_response.refresh_token.is_some()
                    );
                    debug!(
                        "[LOGIN] Expires in: {} seconds",
                        token_response.expires_in.unwrap_or(0)
                    );

                    // Store the token
                    let expires_at = chrono::Utc::now()
                        + chrono::Duration::seconds(
                            token_response.expires_in.unwrap_or(3600) as i64
                        );

                    let storable_token = StorableToken {
                        access_token: token_response.access_token.clone(),
                        refresh_token: token_response.refresh_token.clone().unwrap_or_default(),
                        expires_at: expires_at.timestamp(),
                    };

                    // Store token to both file and cookies for persistence
                    debug!("[LOGIN] Storing token to file and cookies...");

                    // Store to file (backward compatibility)
                    let file_result = Self::store_token_to_file(&storable_token);

                    // Store to cookies (new persistent storage)
                    let cookie_result = Self::store_token_to_cookies(&storable_token).await;

                    match (file_result, cookie_result) {
                        (Ok(_), Ok(_)) => {
                            debug!("[LOGIN] ✅ Token stored successfully to file and cookies!");

                            // Try to also store in keyring as backup (but don't fail if it doesn't work)
                            if let Ok(entry) = Entry::new(KEYRING_SERVICE, KEYRING_USERNAME) {
                                if let Ok(token_json) = serde_json::to_string(&storable_token) {
                                    let _ = entry.set_password(&token_json);
                                    debug!("[LOGIN] Also stored token in keyring as backup");
                                }
                            }

                            // Emit success event
                            debug!("[LOGIN] Emitting twitch-login-complete event...");
                            if let Err(e) = app_handle.emit("twitch-login-complete", ()) {
                                error!("[LOGIN] ❌ Failed to emit login-complete event: {}", e);
                            } else {
                                debug!("[LOGIN] ✅ Event emitted successfully");
                            }
                        }
                        (Ok(_), Err(e)) => {
                            error!("[LOGIN] ⚠️ Token saved to file but cookies failed: {:?}", e);
                            // Still emit success since file storage worked
                            let _ = app_handle.emit("twitch-login-complete", ());
                        }
                        (Err(e), Ok(_)) => {
                            error!("[LOGIN] ⚠️ Token saved to cookies but file failed: {:?}", e);
                            // Still emit success since cookies worked
                            let _ = app_handle.emit("twitch-login-complete", ());
                        }
                        (Err(file_err), Err(cookie_err)) => {
                            error!(
                                "[LOGIN] ❌ Failed to store token anywhere! File: {:?}, Cookie: {:?}",
                                file_err, cookie_err
                            );
                            let _ = app_handle.emit(
                                "twitch-login-error",
                                format!("Failed to store token: {}", file_err),
                            );
                        }
                    }
                }
                Err(e) => {
                    error!("[LOGIN] ❌ Token polling failed: {}", e);
                    let _ = app_handle.emit("twitch-login-error", e.to_string());
                }
            }
        });

        // Return the verification URI for the frontend to open
        Ok(verification_uri)
    }

    // Device code flow methods (kept for backward compatibility if needed)
    pub async fn start_device_login(_state: &AppState) -> Result<DeviceCodeInfo> {
        let client = Client::new();
        let device_response = Self::start_device_flow(&client).await?;

        Ok(DeviceCodeInfo {
            user_code: device_response.user_code,
            verification_uri: device_response.verification_uri,
            device_code: device_response.device_code,
            interval: device_response.interval,
            expires_in: device_response.expires_in,
        })
    }

    pub async fn complete_device_login(device_code: &str, _state: &AppState) -> Result<String> {
        let client = Client::new();

        let token_response = Self::poll_for_token(&client, device_code, 5, 1800).await?;

        let expires_at =
            Utc::now() + ChronoDuration::seconds(token_response.expires_in.unwrap_or(3600) as i64);

        let storable_token = StorableToken {
            access_token: token_response.access_token.clone(),
            refresh_token: token_response.refresh_token.clone().unwrap_or_default(),
            expires_at: expires_at.timestamp(),
        };

        // Store token to file (primary storage)
        Self::store_token_to_file(&storable_token)?;

        // Also try to store in keyring as backup
        if let Ok(entry) = Entry::new(KEYRING_SERVICE, KEYRING_USERNAME) {
            let token_json = serde_json::to_string(&storable_token)?;
            let _ = entry.set_password(&token_json);
        }

        // Log for debugging
        debug!(
            "Token stored successfully in keyring. Service: {}, Username: {}",
            KEYRING_SERVICE, KEYRING_USERNAME
        );
        debug!(
            "Access token: {}...",
            &token_response.access_token[..10.min(token_response.access_token.len())]
        );

        Ok("Login successful".to_string())
    }

    async fn start_device_flow(client: &Client) -> Result<DeviceCodeResponse> {
        let params = [("client_id", CLIENT_ID), ("scopes", SCOPES)];

        let response = client
            .post("https://id.twitch.tv/oauth2/device")
            .form(&params)
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!(
                "Failed to start device flow: {}",
                error_text
            ));
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
                return Err(anyhow::anyhow!(
                    "Device code expired. Please try logging in again."
                ));
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
                // User hasn't authorized yet, continue polling
                continue;
            } else if error_text.contains("slow_down") {
                // Twitch wants us to slow down
                poll_interval += 2;
                continue;
            } else if error_text.contains("expired_token") {
                return Err(anyhow::anyhow!(
                    "Device code expired. Please try logging in again."
                ));
            } else {
                return Err(anyhow::anyhow!("Token polling failed: {}", error_text));
            }
        }
    }

    pub async fn logout() -> Result<()> {
        // Delete token from file storage
        let _ = Self::delete_token_file();

        // Delete cookies
        let _ = Self::delete_cookies().await;

        // Also try to delete from all known keyring locations
        if let Ok(entry) = Entry::new(KEYRING_SERVICE, KEYRING_USERNAME) {
            let _ = entry.delete_credential();
        }

        if let Ok(entry) = Entry::new("StreamNook", "twitch_token") {
            let _ = entry.delete_credential();
        }

        if let Ok(entry) = Entry::new("streamnook", "twitch_token") {
            let _ = entry.delete_credential();
        }

        debug!("[LOGOUT] Complete - all tokens cleared from all storage locations");
        Ok(())
    }

    async fn refresh_token(refresh_token: &str) -> Result<StorableToken> {
        let client = Client::new();
        let params = [
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
        ];

        debug!("[REFRESH] Attempting to refresh token...");

        let response = client
            .post("https://id.twitch.tv/oauth2/token")
            .form(&params)
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!("Failed to refresh token: {}", error_text));
        }

        let token_response: TokenResponse = response.json().await?;
        let expires_at =
            Utc::now() + ChronoDuration::seconds(token_response.expires_in.unwrap_or(3600) as i64);

        let new_storable_token = StorableToken {
            access_token: token_response.access_token,
            refresh_token: token_response
                .refresh_token
                .unwrap_or_else(|| refresh_token.to_string()),
            expires_at: expires_at.timestamp(),
        };

        // Store the refreshed token
        Self::store_token_to_file(&new_storable_token)?;

        // Also try keyring as backup
        if let Ok(entry) = Entry::new(KEYRING_SERVICE, KEYRING_USERNAME) {
            let _ = entry.set_password(&serde_json::to_string(&new_storable_token)?);
        }

        Ok(new_storable_token)
    }

    pub async fn get_token() -> Result<String> {
        // debug!("[GET_TOKEN] Attempting to retrieve token from storage...");

        // Try to load from file first (primary storage)
        match Self::load_token_from_file() {
            Ok(mut token) => {
                // debug!("[GET_TOKEN] ✅ Token retrieved from file storage");

                // Check if token is expired or about to expire (within 5 minutes)
                let buffer_time = 300; // 5 minutes buffer
                if Utc::now().timestamp() >= (token.expires_at - buffer_time) {
                    // Token is expired or about to expire, refresh it
                    if !token.refresh_token.is_empty() {
                        debug!("[GET_TOKEN] Token expired or expiring soon, refreshing...");
                        match Self::refresh_token(&token.refresh_token).await {
                            Ok(new_token) => {
                                token = new_token;
                                // Also update cookies with refreshed token
                                let _ = Self::store_token_to_cookies(&token).await;
                            }
                            Err(e) => {
                                error!("[GET_TOKEN] Failed to refresh token: {:?}", e);
                                return Err(anyhow::anyhow!(
                                    "Token expired and refresh failed. Please log in again."
                                ));
                            }
                        }
                    } else {
                        return Err(anyhow::anyhow!(
                            "Token expired and no refresh token available. Please log in again."
                        ));
                    }
                }

                return Ok(token.access_token);
            }
            Err(file_err) => {
                debug!("[GET_TOKEN] Could not read from file: {:?}", file_err);

                // Try cookies as fallback (new persistent storage)
                debug!("[GET_TOKEN] Trying cookies as fallback...");
                match Self::load_token_from_cookies().await {
                    Ok(mut cookie_token) => {
                        debug!("[GET_TOKEN] ✅ Token retrieved from cookies");

                        // Check if token is expired or about to expire
                        let buffer_time = 300; // 5 minutes buffer
                        if cookie_token.expires_at > 0
                            && Utc::now().timestamp() >= (cookie_token.expires_at - buffer_time)
                        {
                            // Try to refresh if we have a refresh token
                            if !cookie_token.refresh_token.is_empty() {
                                debug!(
                                    "[GET_TOKEN] Cookie token expired or expiring soon, refreshing..."
                                );
                                match Self::refresh_token(&cookie_token.refresh_token).await {
                                    Ok(new_token) => {
                                        cookie_token = new_token.clone();
                                        // Update both file and cookies
                                        let _ = Self::store_token_to_file(&new_token);
                                        let _ = Self::store_token_to_cookies(&new_token).await;
                                    }
                                    Err(e) => {
                                        error!(
                                            "[GET_TOKEN] Failed to refresh cookie token: {:?}",
                                            e
                                        );
                                        let _ = Self::delete_cookies().await;
                                        return Err(anyhow::anyhow!(
                                            "Token expired and refresh failed. Please log in again."
                                        ));
                                    }
                                }
                            } else {
                                // No refresh token, validate the token directly
                                let client = Client::new();
                                let response = client
                                    .get("https://id.twitch.tv/oauth2/validate")
                                    .header(
                                        "Authorization",
                                        format!("OAuth {}", cookie_token.access_token),
                                    )
                                    .send()
                                    .await?;

                                if response.status() == 401 {
                                    debug!("[GET_TOKEN] Cookie token is invalid, clearing cookies");
                                    let _ = Self::delete_cookies().await;
                                    return Err(anyhow::anyhow!(
                                        "Not authenticated. Please log in to Twitch first."
                                    ));
                                }
                            }
                        }

                        // Save to file for next time
                        let _ = Self::store_token_to_file(&cookie_token);

                        return Ok(cookie_token.access_token);
                    }
                    Err(_) => {
                        // Fallback to keyring if cookies don't exist
                        debug!("[GET_TOKEN] Trying keyring as fallback...");

                        if let Ok(entry) = Entry::new(KEYRING_SERVICE, KEYRING_USERNAME) {
                            if let Ok(pwd) = entry.get_password() {
                                debug!("[GET_TOKEN] ✅ Token retrieved from keyring fallback");

                                let mut token: StorableToken = match serde_json::from_str(&pwd) {
                                    Ok(t) => t,
                                    Err(e) => {
                                        error!(
                                            "[GET_TOKEN] Failed to parse keyring token: {:?}",
                                            e
                                        );
                                        return Err(anyhow::anyhow!(
                                            "Not authenticated. Please log in to Twitch first."
                                        ));
                                    }
                                };

                                // Save it to file and cookies for next time
                                let _ = Self::store_token_to_file(&token);
                                let _ = Self::store_token_to_cookies(&token).await;

                                // Check if token needs refresh
                                let buffer_time = 300;
                                if Utc::now().timestamp() >= (token.expires_at - buffer_time) {
                                    if !token.refresh_token.is_empty() {
                                        debug!("[GET_TOKEN] Keyring token expired, refreshing...");
                                        match Self::refresh_token(&token.refresh_token).await {
                                            Ok(new_token) => {
                                                token = new_token;
                                                let _ = Self::store_token_to_cookies(&token).await;
                                            }
                                            Err(e) => {
                                                error!(
                                                    "[GET_TOKEN] Failed to refresh keyring token: {:?}",
                                                    e
                                                );
                                                return Err(anyhow::anyhow!(
                                                    "Token expired and refresh failed. Please log in again."
                                                ));
                                            }
                                        }
                                    }
                                }

                                return Ok(token.access_token);
                            }
                        }

                        error!(
                            "[GET_TOKEN] ❌ No token found in file, cookies, or keyring storage"
                        );
                        Err(anyhow::anyhow!(
                            "Not authenticated. Please log in to Twitch first."
                        ))
                    }
                }
            }
        }
    }

    /// Verify the current token's health and return detailed status
    /// This should be called on app startup to proactively check/refresh the token
    pub async fn verify_token_health() -> Result<TokenHealthStatus> {
        let client = Client::new();

        // Try to get the current token (this will auto-refresh if needed)
        let access_token = match Self::get_token().await {
            Ok(t) => t,
            Err(e) => {
                debug!("❌ [Auth Debug] No valid token available: {:?}", e);
                return Ok(TokenHealthStatus {
                    is_valid: false,
                    seconds_remaining: 0,
                    hours_remaining: 0,
                    minutes_remaining: 0,
                    scopes: vec![],
                    user_id: None,
                    login: None,
                    needs_refresh: false,
                    error: Some(e.to_string()),
                });
            }
        };

        // Validate the token with Twitch
        let response = client
            .get("https://id.twitch.tv/oauth2/validate")
            .header("Authorization", format!("OAuth {}", access_token))
            .send()
            .await?;

        if !response.status().is_success() {
            debug!("❌ [Auth Debug] Token is INVALID or EXPIRED. User needs to login or refresh.");
            return Ok(TokenHealthStatus {
                is_valid: false,
                seconds_remaining: 0,
                hours_remaining: 0,
                minutes_remaining: 0,
                scopes: vec![],
                user_id: None,
                login: None,
                needs_refresh: true,
                error: Some("Token validation failed".to_string()),
            });
        }

        let data: serde_json::Value = response.json().await?;

        let seconds_remaining = data["expires_in"].as_i64().unwrap_or(0);
        let hours = seconds_remaining / 3600;
        let minutes = (seconds_remaining % 3600) / 60;

        let scopes: Vec<String> = data["scopes"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let required_scopes: Vec<&str> = SCOPES.split_whitespace().collect();
        let missing_scopes: Vec<&str> = required_scopes
            .into_iter()
            .filter(|&required| !scopes.iter().any(|s| s == required))
            .collect();

        if !missing_scopes.is_empty() {
            debug!(
                "❌ [Auth Debug] Token is missing required scopes: {:?}",
                missing_scopes
            );

            // Delete the invalid token from storage
            if let Err(e) = Self::logout().await {
                debug!(
                    "⚠️ [Auth Debug] Failed to clean up token with missing scopes: {}",
                    e
                );
            }

            return Ok(TokenHealthStatus {
                is_valid: false,
                seconds_remaining: 0,
                hours_remaining: 0,
                minutes_remaining: 0,
                scopes,
                user_id: None,
                login: None,
                needs_refresh: false,
                error: Some(format!(
                    "Missing scopes: {}. Please log in again.",
                    missing_scopes.join(", ")
                )),
            });
        }

        let user_id = data["user_id"].as_str().map(|s| s.to_string());
        let login = data["login"].as_str().map(|s| s.to_string());

        debug!("✅ [Auth Debug] Token is VALID and has all required scopes.");
        debug!("ℹ️ [Auth Debug] Scopes: {}", scopes.join(", "));
        debug!(
            "⏳ [Auth Debug] Time remaining: {}h {}m ({}s)",
            hours, minutes, seconds_remaining
        );

        let needs_refresh = seconds_remaining < 3600;
        if needs_refresh {
            debug!("⚠️ [Auth Debug] Token expires in less than 1 hour! Consider refreshing soon.");
        }

        Ok(TokenHealthStatus {
            is_valid: true,
            seconds_remaining,
            hours_remaining: hours,
            minutes_remaining: minutes,
            scopes,
            user_id,
            login,
            needs_refresh,
            error: None,
        })
    }

    /// Force refresh the token even if it hasn't expired yet
    pub async fn force_refresh_token() -> Result<String> {
        // Try to load token from any storage
        let token = Self::load_token_from_file()
            .or_else(|_| {
                // Try synchronous approach for cookies
                futures::executor::block_on(Self::load_token_from_cookies())
            })
            .or_else(|_| {
                // Try keyring
                if let Ok(entry) = Entry::new(KEYRING_SERVICE, KEYRING_USERNAME) {
                    if let Ok(pwd) = entry.get_password() {
                        return serde_json::from_str::<StorableToken>(&pwd).map_err(|e| {
                            anyhow::anyhow!("Failed to parse keyring token: {:?}", e)
                        });
                    }
                }
                Err(anyhow::anyhow!("No token found in any storage"))
            })?;

        if token.refresh_token.is_empty() {
            return Err(anyhow::anyhow!(
                "No refresh token available. Please log in again."
            ));
        }

        debug!("🔄 [Auth Debug] Force refreshing token...");
        let new_token = Self::refresh_token(&token.refresh_token).await?;

        // Update all storage locations
        let _ = Self::store_token_to_cookies(&new_token).await;

        debug!("🔄 [Auth Debug] Token refreshed successfully!");
        Ok(new_token.access_token)
    }

    pub async fn get_followed_streams(_state: &AppState) -> Result<Vec<TwitchStream>> {
        let token = match Self::get_token().await {
            Ok(t) => t,
            Err(_) => {
                return Err(anyhow::anyhow!(
                    "Not authenticated. Please log in to Twitch first."
                ));
            }
        };
        let client = Client::new();

        // First, get the user ID
        let user_response = client
            .get("https://api.twitch.tv/helix/users")
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
        let response = client
            .get(format!(
                "https://api.twitch.tv/helix/streams/followed?user_id={}",
                user_id
            ))
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Client-Id", CLIENT_ID)
            .header(ACCEPT, "application/json")
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;

        // Handle null or missing data field
        let data = response.get("data").and_then(|d| d.as_array());

        match data {
            Some(arr) => {
                let mut streams: Vec<TwitchStream> =
                    serde_json::from_value(serde_json::Value::Array(arr.clone()))?;

                // Fetch broadcaster types for all streams in a batch
                if !streams.is_empty() {
                    let user_ids: Vec<String> = streams.iter().map(|s| s.user_id.clone()).collect();
                    let user_ids_param = user_ids
                        .iter()
                        .map(|id| format!("id={}", id))
                        .collect::<Vec<_>>()
                        .join("&");

                    let users_url = format!("https://api.twitch.tv/helix/users?{}", user_ids_param);
                    let users_response = client
                        .get(&users_url)
                        .header("Client-Id", CLIENT_ID)
                        .header(AUTHORIZATION, format!("Bearer {}", token))
                        .send()
                        .await?
                        .json::<serde_json::Value>()
                        .await?;

                    if let Some(users_data) = users_response.get("data").and_then(|d| d.as_array())
                    {
                        // Create a map of user_id -> broadcaster_type
                        let mut broadcaster_types = std::collections::HashMap::new();
                        for user in users_data {
                            if let (Some(id), Some(broadcaster_type)) = (
                                user.get("id").and_then(|v| v.as_str()),
                                user.get("broadcaster_type").and_then(|v| v.as_str()),
                            ) {
                                if !broadcaster_type.is_empty() {
                                    broadcaster_types
                                        .insert(id.to_string(), broadcaster_type.to_string());
                                }
                            }
                        }

                        // Update streams with broadcaster types
                        for stream in &mut streams {
                            if let Some(broadcaster_type) = broadcaster_types.get(&stream.user_id) {
                                stream.broadcaster_type = Some(broadcaster_type.clone());
                            }
                        }
                    }
                }

                Ok(streams)
            }
            None => Ok(Vec::new()), // Return empty vec if no data
        }
    }

    pub async fn get_channel_info(channel_name: &str, _state: &AppState) -> Result<ChannelInfo> {
        let token = match Self::get_token().await {
            Ok(t) => t,
            Err(_) => {
                return Err(anyhow::anyhow!(
                    "Not authenticated. Please log in to Twitch first."
                ));
            }
        };
        let client = Client::new();
        let response = client
            .get(format!(
                "https://api.twitch.tv/helix/channels?broadcaster_login={}",
                channel_name
            ))
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Client-Id", CLIENT_ID)
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;

        // Check if data exists and has at least one element
        let data = response
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|arr| arr.first())
            .ok_or_else(|| anyhow::anyhow!("Channel '{}' not found", channel_name))?;

        let info: ChannelInfo = serde_json::from_value(data.clone())?;
        Ok(info)
    }

    pub async fn get_user_info() -> Result<UserInfo> {
        let token = Self::get_token().await?;
        let client = Client::new();

        let response = client
            .get("https://api.twitch.tv/helix/users")
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Client-Id", CLIENT_ID)
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;

        let data = response
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|arr| arr.first())
            .ok_or_else(|| anyhow::anyhow!("Failed to get user info"))?;

        let user_info: UserInfo = serde_json::from_value(data.clone())?;
        Ok(user_info)
    }

    pub async fn get_user_by_login(login: &str) -> Result<UserInfo> {
        let token = Self::get_token().await?;
        let client = Client::new();

        let response = client
            .get(format!("https://api.twitch.tv/helix/users?login={}", login))
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Client-Id", CLIENT_ID)
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;

        let data = response
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|arr| arr.first())
            .ok_or_else(|| anyhow::anyhow!("User '{}' not found", login))?;

        let user_info: UserInfo = serde_json::from_value(data.clone())?;
        Ok(user_info)
    }

    pub async fn get_user_by_id(user_id: &str) -> Result<UserInfo> {
        let token = Self::get_token().await?;
        let client = Client::new();

        let response = client
            .get(format!("https://api.twitch.tv/helix/users?id={}", user_id))
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Client-Id", CLIENT_ID)
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;

        let data = response
            .get("data")
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
        // Try to get token, but don't fail if not authenticated
        let token = Self::get_token().await.ok();
        let client = Client::new();

        // Build URL with pagination
        let mut url = format!("https://api.twitch.tv/helix/streams?first={}", limit);
        if let Some(cursor) = cursor {
            url.push_str(&format!("&after={}", cursor));
        }

        let mut request = client.get(&url).header("Client-Id", CLIENT_ID);

        // Add authorization if we have a token
        if let Some(token) = &token {
            request = request.header(AUTHORIZATION, format!("Bearer {}", token));
        }

        let response = request.send().await?.json::<serde_json::Value>().await?;

        // Get pagination cursor
        let next_cursor = response
            .get("pagination")
            .and_then(|p| p.get("cursor"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());

        // Handle null or missing data field
        let data = response.get("data").and_then(|d| d.as_array());

        match data {
            Some(arr) => {
                let mut streams: Vec<TwitchStream> =
                    serde_json::from_value(serde_json::Value::Array(arr.clone()))?;

                // Fetch broadcaster types for all streams in a batch
                if !streams.is_empty() && token.is_some() {
                    let user_ids: Vec<String> = streams.iter().map(|s| s.user_id.clone()).collect();
                    let user_ids_param = user_ids
                        .iter()
                        .map(|id| format!("id={}", id))
                        .collect::<Vec<_>>()
                        .join("&");

                    let users_url = format!("https://api.twitch.tv/helix/users?{}", user_ids_param);
                    let users_response = client
                        .get(&users_url)
                        .header("Client-Id", CLIENT_ID)
                        .header(AUTHORIZATION, format!("Bearer {}", token.unwrap()))
                        .send()
                        .await?
                        .json::<serde_json::Value>()
                        .await?;

                    if let Some(users_data) = users_response.get("data").and_then(|d| d.as_array())
                    {
                        // Create a map of user_id -> broadcaster_type
                        let mut broadcaster_types = std::collections::HashMap::new();
                        for user in users_data {
                            if let (Some(id), Some(broadcaster_type)) = (
                                user.get("id").and_then(|v| v.as_str()),
                                user.get("broadcaster_type").and_then(|v| v.as_str()),
                            ) {
                                if !broadcaster_type.is_empty() {
                                    broadcaster_types
                                        .insert(id.to_string(), broadcaster_type.to_string());
                                }
                            }
                        }

                        // Update streams with broadcaster types
                        for stream in &mut streams {
                            if let Some(broadcaster_type) = broadcaster_types.get(&stream.user_id) {
                                stream.broadcaster_type = Some(broadcaster_type.clone());
                            }
                        }
                    }
                }

                Ok((streams, next_cursor))
            }
            None => Ok((Vec::new(), None)),
        }
    }

    pub async fn get_recommended_streams(_state: &AppState) -> Result<Vec<TwitchStream>> {
        let (streams, _) = Self::get_recommended_streams_paginated(_state, None, 20).await?;

        Ok(streams)
    }

    async fn populate_shared_chat_status(streams: &mut Vec<TwitchStream>) {
        let token = match Self::get_token().await {
            Ok(t) => t,
            Err(_) => return, // Can't check without token
        };

        let client = Client::new();

        for stream in streams.iter_mut() {
            // Check if this broadcaster is in a shared chat session
            let url = format!(
                "https://api.twitch.tv/helix/chat/shared?broadcaster_id={}",
                stream.user_id
            );

            match client
                .get(&url)
                .header("Client-Id", CLIENT_ID)
                .header(AUTHORIZATION, format!("Bearer {}", token))
                .send()
                .await
            {
                Ok(response) => {
                    // 200 OK means they're in a shared chat session
                    // 404 means they're not
                    stream.has_shared_chat = Some(response.status().is_success());
                }
                Err(_) => {
                    stream.has_shared_chat = Some(false);
                }
            }
        }
    }

    pub async fn get_top_games(_state: &AppState, limit: u32) -> Result<Vec<serde_json::Value>> {
        let (games, _) = Self::get_top_games_paginated(_state, None, limit).await?;
        Ok(games)
    }

    pub async fn get_top_games_paginated(
        _state: &AppState,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<(Vec<serde_json::Value>, Option<String>)> {
        let token = Self::get_token().await.ok();
        let client = Client::new();

        let mut url = format!("https://api.twitch.tv/helix/games/top?first={}", limit);
        if let Some(cursor) = cursor {
            url.push_str(&format!("&after={}", cursor));
        }

        let mut request = client.get(&url).header("Client-Id", CLIENT_ID);

        if let Some(token) = &token {
            request = request.header(AUTHORIZATION, format!("Bearer {}", token));
        }

        let response = request.send().await?.json::<serde_json::Value>().await?;

        // Get pagination cursor
        let next_cursor = response
            .get("pagination")
            .and_then(|p| p.get("cursor"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());

        let data = response.get("data").and_then(|d| d.as_array());

        match data {
            Some(arr) => {
                // For each game, fetch the viewer count by getting streams for that game
                let mut games_with_viewers = Vec::new();

                for game in arr {
                    let mut game_data = game.clone();

                    // Get game ID
                    if let Some(game_id) = game.get("id").and_then(|id| id.as_str()) {
                        // Fetch streams for this game to get total viewer count
                        let streams_url = format!(
                            "https://api.twitch.tv/helix/streams?game_id={}&first=100",
                            game_id
                        );

                        let mut streams_request =
                            client.get(&streams_url).header("Client-Id", CLIENT_ID);

                        if let Some(token) = &token {
                            streams_request =
                                streams_request.header(AUTHORIZATION, format!("Bearer {}", token));
                        }

                        if let Ok(streams_response) = streams_request.send().await {
                            if let Ok(streams_json) =
                                streams_response.json::<serde_json::Value>().await
                            {
                                // Sum up viewer counts from all streams
                                if let Some(streams_data) =
                                    streams_json.get("data").and_then(|d| d.as_array())
                                {
                                    let total_viewers: i64 = streams_data
                                        .iter()
                                        .filter_map(|s| {
                                            s.get("viewer_count").and_then(|v| v.as_i64())
                                        })
                                        .sum();

                                    // Add viewer_count to game data
                                    if let Some(obj) = game_data.as_object_mut() {
                                        obj.insert(
                                            "viewer_count".to_string(),
                                            serde_json::json!(total_viewers),
                                        );
                                    }
                                }
                            }
                        }
                    }

                    games_with_viewers.push(game_data);
                }

                Ok((games_with_viewers, next_cursor))
            }
            None => Ok((Vec::new(), None)),
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

        let mut url = format!(
            "https://api.twitch.tv/helix/streams?game_id={}&first={}",
            game_id, limit
        );
        if let Some(cursor) = cursor {
            url.push_str(&format!("&after={}", cursor));
        }

        let mut request = client.get(&url).header("Client-Id", CLIENT_ID);

        if let Some(token) = &token {
            request = request.header(AUTHORIZATION, format!("Bearer {}", token));
        }

        let response = request.send().await?.json::<serde_json::Value>().await?;

        let next_cursor = response
            .get("pagination")
            .and_then(|p| p.get("cursor"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());

        let data = response.get("data").and_then(|d| d.as_array());

        match data {
            Some(arr) => {
                let mut streams: Vec<TwitchStream> =
                    serde_json::from_value(serde_json::Value::Array(arr.clone()))?;

                if !streams.is_empty() && token.is_some() {
                    let user_ids: Vec<String> = streams.iter().map(|s| s.user_id.clone()).collect();
                    let user_ids_param = user_ids
                        .iter()
                        .map(|id| format!("id={}", id))
                        .collect::<Vec<_>>()
                        .join("&");

                    let users_url = format!("https://api.twitch.tv/helix/users?{}", user_ids_param);
                    let users_response = client
                        .get(&users_url)
                        .header("Client-Id", CLIENT_ID)
                        .header(AUTHORIZATION, format!("Bearer {}", token.unwrap()))
                        .send()
                        .await?
                        .json::<serde_json::Value>()
                        .await?;

                    if let Some(users_data) = users_response.get("data").and_then(|d| d.as_array())
                    {
                        let mut broadcaster_types = std::collections::HashMap::new();
                        for user in users_data {
                            if let (Some(id), Some(broadcaster_type)) = (
                                user.get("id").and_then(|v| v.as_str()),
                                user.get("broadcaster_type").and_then(|v| v.as_str()),
                            ) {
                                if !broadcaster_type.is_empty() {
                                    broadcaster_types
                                        .insert(id.to_string(), broadcaster_type.to_string());
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
            }
            None => Ok((Vec::new(), None)),
        }
    }

    pub async fn search_channels(_state: &AppState, query: &str) -> Result<Vec<TwitchStream>> {
        let token = Self::get_token().await.ok();
        let client = Client::new();

        let url = format!(
            "https://api.twitch.tv/helix/search/channels?query={}&first=60&live_only=false",
            urlencoding::encode(query)
        );

        let mut request = client.get(&url).header("Client-Id", CLIENT_ID);

        if let Some(token) = &token {
            request = request.header(AUTHORIZATION, format!("Bearer {}", token));
        }

        let response = request.send().await?.json::<serde_json::Value>().await?;

        let data = response.get("data").and_then(|d| d.as_array());

        match data {
            Some(arr) => {
                // Convert search results to TwitchStream format
                let mut streams = Vec::new();
                let mut user_ids = Vec::new();

                for channel in arr {
                    if let (
                        Some(id),
                        Some(user_id),
                        Some(user_name),
                        Some(user_login),
                        Some(title),
                    ) = (
                        channel.get("id").and_then(|v| v.as_str()),
                        channel.get("id").and_then(|v| v.as_str()), // Note: Search result 'id' is the user_id
                        channel.get("display_name").and_then(|v| v.as_str()),
                        channel.get("broadcaster_login").and_then(|v| v.as_str()),
                        channel.get("title").and_then(|v| v.as_str()),
                    ) {
                        let game_name = channel
                            .get("game_name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");

                        let thumbnail_url = channel
                            .get("thumbnail_url")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();

                        let broadcaster_type = channel
                            .get("broadcaster_type")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string());

                        user_ids.push(user_id.to_string());

                        streams.push(TwitchStream {
                            id: id.to_string(), // This is user_id, but search result doesn't provide stream_id
                            user_id: user_id.to_string(),
                            user_name: user_name.to_string(),
                            user_login: user_login.to_string(),
                            title: title.to_string(),
                            viewer_count: 0, // Will be populated from streams API
                            game_id: String::new(), // Will be populated from streams API
                            game_name: game_name.to_string(),
                            thumbnail_url: thumbnail_url.clone(),
                            started_at: channel
                                .get("started_at")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            broadcaster_type,
                            has_shared_chat: None, // Will be populated later
                            profile_image_url: Some(thumbnail_url.clone()), // Preserve the actual profile picture from search
                            is_live: channel.get("is_live").and_then(|v| v.as_bool()),
                        });
                    }
                }

                // Fetch actual stream data to get viewer counts and accurate info
                if !user_ids.is_empty() {
                    let user_ids_param = user_ids
                        .iter()
                        .map(|id| format!("user_id={}", id))
                        .collect::<Vec<_>>()
                        .join("&");

                    let streams_url =
                        format!("https://api.twitch.tv/helix/streams?{}", user_ids_param);

                    let mut streams_request =
                        client.get(&streams_url).header("Client-Id", CLIENT_ID);

                    if let Some(token) = &token {
                        streams_request =
                            streams_request.header(AUTHORIZATION, format!("Bearer {}", token));
                    }

                    if let Ok(streams_response) = streams_request.send().await {
                        if let Ok(streams_json) = streams_response.json::<serde_json::Value>().await
                        {
                            if let Some(streams_data) =
                                streams_json.get("data").and_then(|d| d.as_array())
                            {
                                // Create a map of user_id -> stream data
                                let mut stream_data_map = std::collections::HashMap::new();
                                for stream_data in streams_data {
                                    if let Some(uid) =
                                        stream_data.get("user_id").and_then(|v| v.as_str())
                                    {
                                        stream_data_map.insert(uid.to_string(), stream_data);
                                    }
                                }

                                // Update our streams with actual stream data
                                for stream in &mut streams {
                                    if let Some(stream_data) = stream_data_map.get(&stream.user_id)
                                    {
                                        // Update viewer count
                                        if let Some(viewer_count) =
                                            stream_data.get("viewer_count").and_then(|v| v.as_u64())
                                        {
                                            stream.viewer_count = viewer_count as u32;
                                        }

                                        // Update stream ID (actual stream_id, not user_id)
                                        if let Some(stream_id) =
                                            stream_data.get("id").and_then(|v| v.as_str())
                                        {
                                            stream.id = stream_id.to_string();
                                        }

                                        // Update thumbnail URL with actual stream thumbnail
                                        if let Some(thumbnail) = stream_data
                                            .get("thumbnail_url")
                                            .and_then(|v| v.as_str())
                                        {
                                            stream.thumbnail_url = thumbnail.to_string();
                                        }

                                        // Update started_at if available
                                        if let Some(started_at) =
                                            stream_data.get("started_at").and_then(|v| v.as_str())
                                        {
                                            stream.started_at = started_at.to_string();
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // Append exact match if query looks like a username, to patch Twitch's search algo filtering out inactive direct matches
                let trimmed_query = query.trim();
                if !trimmed_query.contains(' ')
                    && !streams
                        .iter()
                        .any(|s| s.user_login.eq_ignore_ascii_case(trimmed_query))
                {
                    if let Ok(exact_user) = Self::get_user_by_login(trimmed_query).await {
                        let synthesize = TwitchStream {
                            id: exact_user.id.clone(),
                            user_id: exact_user.id,
                            user_name: exact_user.display_name,
                            user_login: exact_user.login,
                            title: String::new(),
                            viewer_count: 0,
                            game_id: String::new(),
                            game_name: String::new(),
                            thumbnail_url: exact_user.profile_image_url.clone().unwrap_or_default(),
                            started_at: String::new(),
                            broadcaster_type: exact_user.broadcaster_type,
                            has_shared_chat: None,
                            profile_image_url: exact_user.profile_image_url,
                            is_live: Some(false),
                        };
                        streams.insert(0, synthesize);
                    }
                }

                Ok(streams)
            }
            None => Ok(Vec::new()),
        }
    }

    /// Follow a channel via Twitch GQL persisted mutation (FollowButton_FollowUser)
    /// Hash captured live from Twitch web client on 2025-03-25
    pub async fn follow_channel(target_user_id: &str) -> Result<()> {
        use crate::services::drops_auth_service::DropsAuthService;

        // GQL mutations require token + Client-Id to match.
        // DropsAuthService provides a token issued for the Android client ID.
        let token = DropsAuthService::get_token().await?;
        let client = Client::new();

        // Twitch Android app client ID — matches the DropsAuthService token
        const GQL_CLIENT_ID: &str = env!("TWITCH_ANDROID_CLIENT_ID");

        let payload = serde_json::json!({
            "operationName": "FollowButton_FollowUser",
            "variables": {
                "input": {
                    "disableNotifications": false,
                    "targetID": target_user_id
                }
            },
            "extensions": {
                "persistedQuery": {
                    "version": 1,
                    "sha256Hash": "800e7346bdf7e5278a3c1d3f21b2b56e2639928f86815677a7126b093b2fdd08"
                }
            }
        });

        debug!(
            "[follow_channel] Sending GQL FollowButton_FollowUser for target: {}",
            target_user_id
        );

        let response = client
            .post("https://gql.twitch.tv/gql")
            .header("Client-Id", GQL_CLIENT_ID)
            .header(AUTHORIZATION, format!("OAuth {}", token))
            .header(ACCEPT, "*/*")
            .json(&payload)
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!(
                "GQL follow failed (HTTP {}): {}",
                status,
                error_text
            ));
        }

        let body: serde_json::Value = response.json().await?;

        // Check for GQL-level errors
        if let Some(errors) = body.get("errors") {
            return Err(anyhow::anyhow!("GQL follow errors: {:?}", errors));
        }

        debug!(
            "[follow_channel] Successfully followed user {}",
            target_user_id
        );
        Ok(())
    }

    /// Unfollow a channel via Twitch GQL persisted mutation (FollowButton_UnfollowUser)
    /// Hash captured live from Twitch web client on 2025-03-25
    pub async fn unfollow_channel(target_user_id: &str) -> Result<()> {
        use crate::services::drops_auth_service::DropsAuthService;

        let token = DropsAuthService::get_token().await?;
        let client = Client::new();

        const GQL_CLIENT_ID: &str = env!("TWITCH_ANDROID_CLIENT_ID");

        let payload = serde_json::json!({
            "operationName": "FollowButton_UnfollowUser",
            "variables": {
                "input": {
                    "targetID": target_user_id
                }
            },
            "extensions": {
                "persistedQuery": {
                    "version": 1,
                    "sha256Hash": "f7dae976ebf41c755ae2d758546bfd176b4eeb856656098bb40e0a672ca0d880"
                }
            }
        });

        debug!(
            "[unfollow_channel] Sending GQL FollowButton_UnfollowUser for target: {}",
            target_user_id
        );

        let response = client
            .post("https://gql.twitch.tv/gql")
            .header("Client-Id", GQL_CLIENT_ID)
            .header(AUTHORIZATION, format!("OAuth {}", token))
            .header(ACCEPT, "*/*")
            .json(&payload)
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!(
                "GQL unfollow failed (HTTP {}): {}",
                status,
                error_text
            ));
        }

        let body: serde_json::Value = response.json().await?;

        if let Some(errors) = body.get("errors") {
            return Err(anyhow::anyhow!("GQL unfollow errors: {:?}", errors));
        }

        debug!(
            "[unfollow_channel] Successfully unfollowed user {}",
            target_user_id
        );
        Ok(())
    }

    /// Fetch pinned chat messages for a channel via Twitch GQL (GetPinnedChat)
    /// Hash captured live from Twitch web client on 2026-03-25
    pub async fn get_pinned_chat_messages(channel_id: &str) -> Result<Vec<serde_json::Value>> {
        use crate::services::drops_auth_service::DropsAuthService;

        let token = DropsAuthService::get_token().await?;
        let client = Client::new();

        const GQL_CLIENT_ID: &str = env!("TWITCH_ANDROID_CLIENT_ID");

        let payload = serde_json::json!({
            "operationName": "GetPinnedChat",
            "variables": {
                "channelID": channel_id,
                "count": 10
            },
            "extensions": {
                "persistedQuery": {
                    "version": 1,
                    "sha256Hash": "2d099d4c9b6af80a07d8440140c4f3dbb04d516b35c401aab7ce8f60765308d5"
                }
            }
        });

        debug!(
            "[get_pinned_chat] Fetching pinned messages for channel: {}",
            channel_id
        );

        let response = client
            .post("https://gql.twitch.tv/gql")
            .header("Client-Id", GQL_CLIENT_ID)
            .header(AUTHORIZATION, format!("OAuth {}", token))
            .header(ACCEPT, "*/*")
            .json(&payload)
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!(
                "GQL GetPinnedChat failed (HTTP {}): {}",
                status,
                error_text
            ));
        }

        let body: serde_json::Value = response.json().await?;

        if let Some(errors) = body.get("errors") {
            return Err(anyhow::anyhow!("GQL GetPinnedChat errors: {:?}", errors));
        }

        // Parse pinned messages and collect unique user IDs for avatar lookup
        let mut raw_pins = Vec::new();
        let mut user_ids = std::collections::HashSet::new();

        if let Some(edges) = body
            .pointer("/data/channel/pinnedChatMessages/edges")
            .and_then(|v| v.as_array())
        {
            for edge in edges {
                if let Some(node) = edge.get("node") {
                    let sender_id = node
                        .pointer("/pinnedMessage/sender/id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let pinned_by_id = node
                        .pointer("/pinnedBy/id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    if !sender_id.is_empty() {
                        user_ids.insert(sender_id.to_string());
                    }
                    if !pinned_by_id.is_empty() {
                        user_ids.insert(pinned_by_id.to_string());
                    }

                    // Extract badges array
                    let badges: Vec<serde_json::Value> = node
                        .pointer("/pinnedMessage/sender/displayBadges")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter().map(|b| {
                            serde_json::json!({
                                "set_id": b.get("setID").and_then(|v| v.as_str()).unwrap_or(""),
                                "version": b.get("version").and_then(|v| v.as_str()).unwrap_or("1"),
                            })
                        }).collect()
                        })
                        .unwrap_or_default();

                    raw_pins.push((
                        node.clone(),
                        sender_id.to_string(),
                        pinned_by_id.to_string(),
                        badges,
                    ));
                }
            }
        }

        // Batch fetch profile images via Helix API for all unique user IDs
        let mut avatar_map: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        if !user_ids.is_empty() {
            if let Ok(helix_token) = Self::get_token().await {
                let ids: Vec<&str> = user_ids.iter().map(|s| s.as_str()).collect();
                let mut url = String::from("https://api.twitch.tv/helix/users?");
                for (i, id) in ids.iter().enumerate() {
                    if i > 0 {
                        url.push('&');
                    }
                    url.push_str(&format!("id={}", id));
                }

                if let Ok(resp) = client
                    .get(&url)
                    .header("Client-ID", CLIENT_ID)
                    .header(AUTHORIZATION, format!("Bearer {}", helix_token))
                    .send()
                    .await
                {
                    if let Ok(data) = resp.json::<serde_json::Value>().await {
                        if let Some(users) = data.get("data").and_then(|v| v.as_array()) {
                            for user in users {
                                if let (Some(id), Some(img)) = (
                                    user.get("id").and_then(|v| v.as_str()),
                                    user.get("profile_image_url").and_then(|v| v.as_str()),
                                ) {
                                    avatar_map.insert(id.to_string(), img.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }

        // Build final response with avatars
        let pinned_messages: Vec<serde_json::Value> = raw_pins.iter().map(|(node, sender_id, pinned_by_id, badges)| {
            serde_json::json!({
                "id": node.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                "type": node.get("type").and_then(|v| v.as_str()).unwrap_or("MOD"),
                "message_text": node.pointer("/pinnedMessage/content/text").and_then(|v| v.as_str()).unwrap_or(""),
                "sender_id": sender_id,
                "sender_name": node.pointer("/pinnedMessage/sender/displayName").and_then(|v| v.as_str()).unwrap_or("Unknown"),
                "sender_color": node.pointer("/pinnedMessage/sender/chatColor").and_then(|v| v.as_str()).unwrap_or("#FFFFFF"),
                "sender_avatar": avatar_map.get(sender_id).cloned().unwrap_or_default(),
                "sender_badges": badges,
                "pinned_by": node.pointer("/pinnedBy/displayName").and_then(|v| v.as_str()).unwrap_or(""),
                "pinned_by_id": pinned_by_id,
                "pinned_by_avatar": avatar_map.get(pinned_by_id).cloned().unwrap_or_default(),
                "started_at": node.get("startsAt").and_then(|v| v.as_str()).unwrap_or(""),
            })
        }).collect();

        debug!(
            "[get_pinned_chat] Found {} pinned messages for channel {}",
            pinned_messages.len(),
            channel_id
        );
        Ok(pinned_messages)
    }

    pub async fn get_all_followed_channels(
        limit: u32,
        cursor: Option<String>,
    ) -> Result<(Vec<TwitchStream>, Option<String>)> {
        let token = Self::get_token().await?;
        let client = Client::new();

        let user_info = Self::get_user_info().await?;

        let mut url = format!(
            "https://api.twitch.tv/helix/channels/followed?user_id={}&first={}",
            user_info.id, limit
        );
        if let Some(c) = cursor {
            url.push_str(&format!("&after={}", c));
        }

        let response = client
            .get(&url)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Client-Id", CLIENT_ID)
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
                let mut streams = Vec::new();
                let mut user_ids = Vec::new();

                for channel in arr {
                    if let (
                        Some(broadcaster_id),
                        Some(broadcaster_login),
                        Some(broadcaster_name),
                        Some(followed_at),
                    ) = (
                        channel.get("broadcaster_id").and_then(|v| v.as_str()),
                        channel.get("broadcaster_login").and_then(|v| v.as_str()),
                        channel.get("broadcaster_name").and_then(|v| v.as_str()),
                        channel.get("followed_at").and_then(|v| v.as_str()),
                    ) {
                        user_ids.push(broadcaster_id.to_string());

                        streams.push(TwitchStream {
                            id: broadcaster_id.to_string(),
                            user_id: broadcaster_id.to_string(),
                            user_name: broadcaster_name.to_string(),
                            user_login: broadcaster_login.to_string(),
                            title: String::new(),
                            viewer_count: 0,
                            game_id: String::new(),
                            game_name: String::new(),
                            thumbnail_url: String::new(),
                            started_at: followed_at.to_string(), // use started_at to store followed_at temporarily
                            broadcaster_type: None,
                            has_shared_chat: None,
                            profile_image_url: None,
                            is_live: Some(false),
                        });
                    }
                }

                // Fetch actual user avatars via helix/users
                if !user_ids.is_empty() {
                    // Split into chunks of 100 (Twitch API max) just in case
                    for chunk in user_ids.chunks(100) {
                        let user_ids_param = chunk
                            .iter()
                            .map(|id| format!("id={}", id))
                            .collect::<Vec<_>>()
                            .join("&");

                        let users_url =
                            format!("https://api.twitch.tv/helix/users?{}", user_ids_param);
                        if let Ok(users_response) = client
                            .get(&users_url)
                            .header("Client-Id", CLIENT_ID)
                            .header(AUTHORIZATION, format!("Bearer {}", token))
                            .send()
                            .await
                        {
                            if let Ok(users_json) = users_response.json::<serde_json::Value>().await
                            {
                                if let Some(users_data) =
                                    users_json.get("data").and_then(|d| d.as_array())
                                {
                                    let mut profiles = std::collections::HashMap::new();
                                    for user in users_data {
                                        if let (Some(id), Some(profile_image_url)) = (
                                            user.get("id").and_then(|v| v.as_str()),
                                            user.get("profile_image_url").and_then(|v| v.as_str()),
                                        ) {
                                            profiles.insert(
                                                id.to_string(),
                                                profile_image_url.to_string(),
                                            );
                                        }
                                    }

                                    for stream in &mut streams {
                                        if let Some(avatar) = profiles.get(&stream.user_id) {
                                            stream.profile_image_url = Some(avatar.clone());
                                            stream.thumbnail_url = avatar.clone();
                                            // use avatar as thumbnail fallback
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                Ok((streams, next_cursor))
            }
            None => Ok((Vec::new(), None)),
        }
    }

    pub async fn get_offline_last_broadcasts(
        user_ids: Vec<String>,
    ) -> Result<std::collections::HashMap<String, Option<String>>> {
        let client = Client::new();
        // create the query
        let query = format!(
            r#"query {{ users(ids: {}) {{ id lastBroadcast {{ startedAt }} videos(first: 1, sort: TIME) {{ edges {{ node {{ createdAt lengthSeconds }} }} }} }} }}"#,
            serde_json::to_string(&user_ids).unwrap_or_else(|_| "[]".to_string())
        );

        let payload = serde_json::json!([{
            "operationName": null,
            "variables": {},
            "query": query
        }]);

        // IMPORTANT: Unauthenticated GQL requires the Twitch Web Client-ID, NOT the Helix Developer application Client-ID
        let response = client
            .post("https://gql.twitch.tv/gql")
            .header("Client-ID", env!("TWITCH_WEB_CLIENT_ID"))
            .json(&payload)
            .send()
            .await?;

        let text = response.text().await?;
        let json: serde_json::Value = serde_json::from_str(&text)?;

        let mut result_map = std::collections::HashMap::new();

        if let Some(arr) = json.as_array() {
            if let Some(users_data) = arr
                .first()
                .and_then(|obj| obj.get("data"))
                .and_then(|d| d.get("users"))
                .and_then(|u| u.as_array())
            {
                for user in users_data {
                    if let Some(id) = user.get("id").and_then(|i| i.as_str()) {
                        let mut final_time = None;

                        // Try calculating exact true end time using their most recent VOD/Stream duration
                        if let Some(edges) = user
                            .get("videos")
                            .and_then(|v| v.get("edges"))
                            .and_then(|e| e.as_array())
                        {
                            if let Some(node) = edges.first().and_then(|e| e.get("node")) {
                                if let (Some(created_at), Some(length)) = (
                                    node.get("createdAt").and_then(|c| c.as_str()),
                                    node.get("lengthSeconds").and_then(|l| l.as_i64()),
                                ) {
                                    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(created_at)
                                    {
                                        let end_time = dt + ChronoDuration::seconds(length);
                                        // Format back to RFC3339 string so frontend can trivially parse it using new Date()
                                        final_time = Some(end_time.to_rfc3339());
                                    }
                                }
                            }
                        }

                        // Fallback to start time for streamers who completely disable all VOD recordings
                        if final_time.is_none() {
                            final_time = user
                                .get("lastBroadcast")
                                .and_then(|lb| lb.get("startedAt"))
                                .and_then(|sa| sa.as_str())
                                .map(|s| s.to_string());
                        }

                        result_map.insert(id.to_string(), final_time);
                    }
                }
            }
        }

        debug!(
            "[TWITCH] Parsed {} last broadcast timestamps",
            result_map.len()
        );
        Ok(result_map)
    }

    pub async fn check_following_status(target_user_id: &str) -> Result<bool> {
        let token = Self::get_token().await?;
        let client = Client::new();

        // Get the current user's ID
        let user_info = Self::get_user_info().await?;

        // Use the new channels/followed endpoint (the old users/follows was deprecated)
        // This endpoint checks if user_id follows broadcaster_id
        let url = format!(
            "https://api.twitch.tv/helix/channels/followed?user_id={}&broadcaster_id={}",
            user_info.id, target_user_id
        );

        let response = client
            .get(&url)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Client-Id", CLIENT_ID)
            .send()
            .await?;

        // Check if request was successful
        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            debug!(
                "[check_following_status] API error: {} - {}",
                status, error_text
            );
            // Return false if we can't check (might not be following)
            return Ok(false);
        }

        let json: serde_json::Value = response.json().await?;

        // If data array has items, user is following
        // The new endpoint returns total in the response and data array with the follow info
        let is_following = json
            .get("data")
            .and_then(|d| d.as_array())
            .map(|arr| !arr.is_empty())
            .unwrap_or(false);

        debug!(
            "[check_following_status] User {} following {}: {}",
            user_info.id, target_user_id, is_following
        );

        Ok(is_following)
    }

    /// Check if a specific stream is currently online by user login
    /// Returns the stream data if online, None if offline
    pub async fn check_stream_online(user_login: &str) -> Result<Option<TwitchStream>> {
        let token = Self::get_token().await.ok();
        let client = Client::new();

        let url = format!(
            "https://api.twitch.tv/helix/streams?user_login={}",
            urlencoding::encode(user_login)
        );

        let mut request = client.get(&url).header("Client-Id", CLIENT_ID);

        if let Some(token) = &token {
            request = request.header(AUTHORIZATION, format!("Bearer {}", token));
        }

        let response = request.send().await?.json::<serde_json::Value>().await?;

        let data = response.get("data").and_then(|d| d.as_array());

        match data {
            Some(arr) if !arr.is_empty() => {
                let stream: TwitchStream = serde_json::from_value(arr[0].clone())?;
                Ok(Some(stream))
            }
            _ => Ok(None), // Stream is offline
        }
    }

    /// Get the game ID by game name
    pub async fn get_game_id_by_name(game_name: &str) -> Result<Option<String>> {
        let token = Self::get_token().await.ok();
        let client = Client::new();

        let url = format!(
            "https://api.twitch.tv/helix/games?name={}",
            urlencoding::encode(game_name)
        );

        let mut request = client.get(&url).header("Client-Id", CLIENT_ID);

        if let Some(token) = &token {
            request = request.header(AUTHORIZATION, format!("Bearer {}", token));
        }

        let response = request.send().await?.json::<serde_json::Value>().await?;

        let game_id = response
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|arr| arr.first())
            .and_then(|game| game.get("id"))
            .and_then(|id| id.as_str())
            .map(|s| s.to_string());

        Ok(game_id)
    }

    /// Search for categories by name (uses Twitch search API for fuzzy matching)
    /// Returns a list of matching categories with id, name, and box_art_url
    pub async fn search_categories(query: &str, limit: u32) -> Result<Vec<serde_json::Value>> {
        let token = Self::get_token().await.ok();
        let client = Client::new();

        let url = format!(
            "https://api.twitch.tv/helix/search/categories?query={}&first={}",
            urlencoding::encode(query),
            limit
        );

        let mut request = client.get(&url).header("Client-Id", CLIENT_ID);

        if let Some(token) = &token {
            request = request.header(AUTHORIZATION, format!("Bearer {}", token));
        }

        let response = request.send().await?.json::<serde_json::Value>().await?;

        let data = response
            .get("data")
            .and_then(|d| d.as_array())
            .cloned()
            .unwrap_or_default();

        Ok(data)
    }

    /// Send a whisper message to another user
    /// Requires user:manage:whispers scope
    pub async fn send_whisper(to_user_id: &str, message: &str) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();

        // Get the current user's ID
        let user_info = Self::get_user_info().await?;

        let response = client
            .post(format!(
                "https://api.twitch.tv/helix/whispers?from_user_id={}&to_user_id={}",
                user_info.id, to_user_id
            ))
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Client-Id", CLIENT_ID)
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "message": message
            }))
            .send()
            .await?;

        if response.status().is_success() || response.status() == 204 {
            Ok(())
        } else {
            let error_text = response.text().await?;
            Err(anyhow::anyhow!("Failed to send whisper: {}", error_text))
        }
    }

    /// Get streams by game name (convenience method that resolves game name to ID)
    /// Returns streams sorted by viewer count (highest first)
    pub async fn get_streams_by_game_name(
        _state: &AppState,
        game_name: &str,
        exclude_user_login: Option<&str>,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<(Vec<TwitchStream>, Option<String>)> {
        // First, get the game ID from the game name
        let game_id = match Self::get_game_id_by_name(game_name).await? {
            Some(id) => id,
            None => return Ok((Vec::new(), None)), // Game not found
        };

        let token = Self::get_token().await.ok();
        let client = Client::new();

        let mut url = format!(
            "https://api.twitch.tv/helix/streams?game_id={}&first={}",
            game_id, limit
        );

        if let Some(c) = cursor {
            url.push_str(&format!("&after={}", c));
        }

        let mut request = client.get(&url).header("Client-Id", CLIENT_ID);

        if let Some(token) = &token {
            request = request.header(AUTHORIZATION, format!("Bearer {}", token));
        }

        let response = request.send().await?.json::<serde_json::Value>().await?;

        let data = response.get("data").and_then(|d| d.as_array());

        match data {
            Some(arr) => {
                let mut streams: Vec<TwitchStream> =
                    serde_json::from_value(serde_json::Value::Array(arr.clone()))?;

                // Filter out the excluded user if provided
                if let Some(exclude_login) = exclude_user_login {
                    streams.retain(|s| s.user_login.to_lowercase() != exclude_login.to_lowercase());
                }

                // Fetch broadcaster types for all streams in a batch
                if !streams.is_empty() && token.is_some() {
                    let user_ids: Vec<String> = streams.iter().map(|s| s.user_id.clone()).collect();
                    let user_ids_param = user_ids
                        .iter()
                        .map(|id| format!("id={}", id))
                        .collect::<Vec<_>>()
                        .join("&");

                    let users_url = format!("https://api.twitch.tv/helix/users?{}", user_ids_param);
                    let users_response = client
                        .get(&users_url)
                        .header("Client-Id", CLIENT_ID)
                        .header(AUTHORIZATION, format!("Bearer {}", token.unwrap()))
                        .send()
                        .await?
                        .json::<serde_json::Value>()
                        .await?;

                    if let Some(users_data) = users_response.get("data").and_then(|d| d.as_array())
                    {
                        let mut broadcaster_types = std::collections::HashMap::new();
                        let mut profile_images = std::collections::HashMap::new();
                        for user in users_data {
                            if let Some(id) = user.get("id").and_then(|v| v.as_str()) {
                                if let Some(broadcaster_type) =
                                    user.get("broadcaster_type").and_then(|v| v.as_str())
                                {
                                    if !broadcaster_type.is_empty() {
                                        broadcaster_types
                                            .insert(id.to_string(), broadcaster_type.to_string());
                                    }
                                }
                                if let Some(profile_image) =
                                    user.get("profile_image_url").and_then(|v| v.as_str())
                                {
                                    profile_images
                                        .insert(id.to_string(), profile_image.to_string());
                                }
                            }
                        }

                        for stream in &mut streams {
                            if let Some(broadcaster_type) = broadcaster_types.get(&stream.user_id) {
                                stream.broadcaster_type = Some(broadcaster_type.clone());
                            }
                            if let Some(profile_image) = profile_images.get(&stream.user_id) {
                                stream.profile_image_url = Some(profile_image.clone());
                            }
                        }
                    }
                }

                // Extract pagination cursor
                let pagination_cursor = response
                    .get("pagination")
                    .and_then(|p| p.get("cursor"))
                    .and_then(|c| c.as_str())
                    .map(|s| s.to_string());

                // Streams are already sorted by viewer count (highest first) from the API
                Ok((streams, pagination_cursor))
            }
            None => Ok((Vec::new(), None)),
        }
    }

    pub async fn get_category_info(
        game_name: &str,
    ) -> Result<Option<crate::models::stream::CategoryInfo>> {
        let client = Client::new();
        let query = "query($name: String!) { game(name: $name) { id name displayName description followersCount boxArtURL tags(tagType: CONTENT) { id localizedName } } }";

        let body = serde_json::json!({
            "query": query,
            "variables": { "name": game_name }
        });

        let response = client
            .post("https://gql.twitch.tv/gql")
            .header("Client-Id", TWITCH_GQL_CLIENT_ID)
            .json(&body)
            .send()
            .await?;

        if response.status().is_success() {
            let data: crate::models::stream::GqlDataResponse = response.json().await?;
            if let Some(game_data) = data.data {
                return Ok(game_data.game);
            }
        }

        Ok(None)
    }

    pub async fn get_clips_by_game(
        game_id: &str,
        limit: u32,
        cursor: Option<&str>,
        period: Option<&str>,
    ) -> Result<(Vec<crate::models::stream::TwitchClip>, Option<String>)> {
        let token = Self::get_token().await?;
        let client = Client::new();

        let mut url = format!(
            "https://api.twitch.tv/helix/clips?game_id={}&first={}",
            game_id, limit
        );

        if let Some(p) = period {
            if p != "all" && !p.is_empty() {
                let now = chrono::Utc::now();
                let started_at = match p {
                    "day" | "24h" => Some(now - chrono::Duration::days(1)),
                    "week" | "7d" => Some(now - chrono::Duration::days(7)),
                    "month" | "30d" => Some(now - chrono::Duration::days(30)),
                    _ => None,
                };

                if let Some(date) = started_at {
                    // Twitch API requires RFC3339 format for started_at
                    url.push_str(&format!("&started_at={}", date.to_rfc3339()));
                }
            }
        }

        if let Some(c) = cursor {
            url.push_str(&format!("&after={}", c));
        }

        let response = client
            .get(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;

        let data = response.get("data").and_then(|d| d.as_array());

        match data {
            Some(arr) => {
                let clips: Vec<crate::models::stream::TwitchClip> =
                    serde_json::from_value(serde_json::Value::Array(arr.clone()))?;

                let pagination_cursor = response
                    .get("pagination")
                    .and_then(|p| p.get("cursor"))
                    .and_then(|c| c.as_str())
                    .map(|s| s.to_string());

                Ok((clips, pagination_cursor))
            }
            None => Ok((Vec::new(), None)),
        }
    }

    pub async fn get_videos_by_game(
        game_id: &str,
        sort: &str,
        period: Option<&str>,
        limit: u32,
        cursor: Option<&str>,
    ) -> Result<(Vec<crate::models::stream::TwitchVideo>, Option<String>)> {
        let token = Self::get_token().await?;
        let client = Client::new();

        let mut url = format!(
            "https://api.twitch.tv/helix/videos?game_id={}&sort={}&first={}",
            game_id, sort, limit
        );

        if let Some(p) = period {
            if !p.is_empty() && p != "all" {
                url.push_str(&format!("&period={}", p));
            }
        }

        if let Some(c) = cursor {
            url.push_str(&format!("&after={}", c));
        }

        let response = client
            .get(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;

        let data = response.get("data").and_then(|d| d.as_array());

        match data {
            Some(arr) => {
                let videos: Vec<crate::models::stream::TwitchVideo> =
                    serde_json::from_value(serde_json::Value::Array(arr.clone()))?;

                let pagination_cursor = response
                    .get("pagination")
                    .and_then(|p| p.get("cursor"))
                    .and_then(|c| c.as_str())
                    .map(|s| s.to_string());

                Ok((videos, pagination_cursor))
            }
            None => Ok((Vec::new(), None)),
        }
    }

    pub async fn get_user_videos(
        user_id: &str,
        sort: &str,
        limit: u32,
    ) -> Result<Vec<crate::models::stream::TwitchVideo>> {
        let token = Self::get_token().await?;
        let client = Client::new();

        let url = format!(
            "https://api.twitch.tv/helix/videos?user_id={}&sort={}&first={}",
            user_id, sort, limit
        );

        let response = client
            .get(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;

        let data = response.get("data").and_then(|d| d.as_array());

        match data {
            Some(arr) => {
                let videos: Vec<crate::models::stream::TwitchVideo> =
                    serde_json::from_value(serde_json::Value::Array(arr.clone()))?;

                Ok(videos)
            }
            None => Ok(Vec::new()),
        }
    }

    /// Update Chat Settings (Emote mode, Follower mode, Slow mode, etc.)
    pub async fn update_chat_settings(
        broadcaster_id: &str,
        settings: serde_json::Value,
    ) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();
        let user_info = Self::get_user_info().await?;
        let moderator_id = &user_info.id;

        let url = format!(
            "https://api.twitch.tv/helix/chat/settings?broadcaster_id={}&moderator_id={}",
            broadcaster_id, moderator_id
        );

        let response = client
            .patch(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&settings)
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            error!(
                "[TwitchService] Failed to update chat settings: {}",
                error_text
            );
            return Err(anyhow::anyhow!("Failed to update chat settings"));
        }

        Ok(())
    }

    /// Clear all messages from chat
    pub async fn clear_chat(broadcaster_id: &str) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();
        let user_info = Self::get_user_info().await?;
        let moderator_id = &user_info.id;

        let url = format!(
            "https://api.twitch.tv/helix/chat/messages?broadcaster_id={}&moderator_id={}",
            broadcaster_id, moderator_id
        );

        let response = client
            .delete(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .send()
            .await?;

        if !response.status().is_success() && response.status() != 204 {
            let error_text = response.text().await.unwrap_or_default();
            error!("[TwitchService] Failed to clear chat: {}", error_text);
            return Err(anyhow::anyhow!("Failed to clear chat"));
        }

        Ok(())
    }

    /// Delete a specific chat message
    pub async fn delete_chat_message(broadcaster_id: &str, message_id: &str) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();
        let user_info = Self::get_user_info().await?;
        let moderator_id = &user_info.id;

        let url = format!(
            "https://api.twitch.tv/helix/chat/messages?broadcaster_id={}&moderator_id={}&message_id={}",
            broadcaster_id, moderator_id, message_id
        );

        let response = client
            .delete(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .send()
            .await?;

        if !response.status().is_success() && response.status() != 204 {
            let error_text = response.text().await.unwrap_or_default();
            error!("[TwitchService] Failed to delete message: {}", error_text);
            return Err(anyhow::anyhow!("Failed to delete message"));
        }

        Ok(())
    }

    /// Ban or timeout a user
    pub async fn ban_user(
        broadcaster_id: &str,
        target_user_id: &str,
        duration: Option<u32>,
        reason: Option<&str>,
    ) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();
        let user_info = Self::get_user_info().await?;
        let moderator_id = &user_info.id;

        let url = format!(
            "https://api.twitch.tv/helix/moderation/bans?broadcaster_id={}&moderator_id={}",
            broadcaster_id, moderator_id
        );

        let mut payload = serde_json::json!({
            "data": {
                "user_id": target_user_id,
            }
        });

        if let Some(d) = duration {
            payload["data"]["duration"] = serde_json::json!(d);
        }

        if let Some(r) = reason {
            if !r.is_empty() {
                payload["data"]["reason"] = serde_json::json!(r);
            }
        }

        let response = client
            .post(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            error!("[TwitchService] Failed to ban/timeout user: {}", error_text);
            return Err(anyhow::anyhow!("Failed to ban or timeout user"));
        }

        Ok(())
    }

    /// Unban a user
    pub async fn unban_user(broadcaster_id: &str, target_user_id: &str) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();
        let user_info = Self::get_user_info().await?;
        let moderator_id = &user_info.id;

        let url = format!(
            "https://api.twitch.tv/helix/moderation/bans?broadcaster_id={}&moderator_id={}&user_id={}",
            broadcaster_id, moderator_id, target_user_id
        );

        let response = client
            .delete(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .send()
            .await?;

        if !response.status().is_success() && response.status() != 204 {
            let error_text = response.text().await.unwrap_or_default();
            error!("[TwitchService] Failed to unban user: {}", error_text);
            return Err(anyhow::anyhow!("Failed to unban user"));
        }

        Ok(())
    }

    /// Add a channel moderator
    pub async fn add_channel_moderator(broadcaster_id: &str, user_id: &str) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();

        let url = format!(
            "https://api.twitch.tv/helix/moderation/moderators?broadcaster_id={}&user_id={}",
            broadcaster_id, user_id
        );

        let response = client
            .post(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .send()
            .await?;

        if !response.status().is_success() && response.status() != 204 {
            let error_text = response.text().await.unwrap_or_default();
            error!("[TwitchService] Failed to add moderator: {}", error_text);
            return Err(anyhow::anyhow!("Failed to add moderator"));
        }

        Ok(())
    }

    /// Remove a channel moderator
    pub async fn remove_channel_moderator(broadcaster_id: &str, user_id: &str) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();

        let url = format!(
            "https://api.twitch.tv/helix/moderation/moderators?broadcaster_id={}&user_id={}",
            broadcaster_id, user_id
        );

        let response = client
            .delete(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .send()
            .await?;

        if !response.status().is_success() && response.status() != 204 {
            let error_text = response.text().await.unwrap_or_default();
            error!("[TwitchService] Failed to remove moderator: {}", error_text);
            return Err(anyhow::anyhow!("Failed to remove moderator"));
        }

        Ok(())
    }

    /// Add a channel VIP
    pub async fn add_channel_vip(broadcaster_id: &str, user_id: &str) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();

        let url = format!(
            "https://api.twitch.tv/helix/channels/vips?broadcaster_id={}&user_id={}",
            broadcaster_id, user_id
        );

        let response = client
            .post(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .send()
            .await?;

        if !response.status().is_success() && response.status() != 204 {
            let error_text = response.text().await.unwrap_or_default();
            error!("[TwitchService] Failed to add VIP: {}", error_text);
            return Err(anyhow::anyhow!("Failed to add VIP"));
        }

        Ok(())
    }

    /// Remove a channel VIP
    pub async fn remove_channel_vip(broadcaster_id: &str, user_id: &str) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();

        let url = format!(
            "https://api.twitch.tv/helix/channels/vips?broadcaster_id={}&user_id={}",
            broadcaster_id, user_id
        );

        let response = client
            .delete(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .send()
            .await?;

        if !response.status().is_success() && response.status() != 204 {
            let error_text = response.text().await.unwrap_or_default();
            error!("[TwitchService] Failed to remove VIP: {}", error_text);
            return Err(anyhow::anyhow!("Failed to remove VIP"));
        }

        Ok(())
    }

    /// Update Suspicious User Status (Restrict/Monitor)
    pub async fn update_suspicious_user_status(
        broadcaster_id: &str,
        target_user_id: &str,
        status: &str,
    ) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();
        let user_info = Self::get_user_info().await?;
        let moderator_id = &user_info.id;

        let url = format!(
            "https://api.twitch.tv/helix/moderation/suspicious_users?broadcaster_id={}&moderator_id={}",
            broadcaster_id, moderator_id
        );

        let payload = serde_json::json!({
            "user_id": target_user_id,
            "status": status // "RESTRICTED", "NO_TREATMENT", "ACTIVE_MONITORING"
        });

        let response = client
            .put(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            error!(
                "[TwitchService] Failed to update suspicious user status: {}",
                error_text
            );
            return Err(anyhow::anyhow!("Failed to update suspicious user status"));
        }

        Ok(())
    }

    /// Update User Chat Color
    pub async fn update_user_chat_color(user_id: &str, color: &str) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();

        let url = format!(
            "https://api.twitch.tv/helix/chat/color?user_id={}&color={}",
            user_id, color
        );

        let response = client
            .put(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .send()
            .await?;

        if !response.status().is_success() && response.status() != 204 {
            let error_text = response.text().await.unwrap_or_default();
            error!(
                "[TwitchService] Failed to update user chat color: {}",
                error_text
            );
            return Err(anyhow::anyhow!("Failed to update user chat color"));
        }

        Ok(())
    }

    /// Block user
    pub async fn block_user(target_user_id: &str) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();
        let user_info = Self::get_user_info().await?;

        let url = format!(
            "https://api.twitch.tv/helix/users/blocks?target_user_id={}",
            target_user_id
        );

        let response = client
            .put(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .send()
            .await?;

        if !response.status().is_success() && response.status() != 204 {
            let error_text = response.text().await.unwrap_or_default();
            error!("[TwitchService] Failed to block user: {}", error_text);
            return Err(anyhow::anyhow!("Failed to block user"));
        }

        Ok(())
    }

    /// Unblock user
    pub async fn unblock_user(target_user_id: &str) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();
        let user_info = Self::get_user_info().await?;

        let url = format!(
            "https://api.twitch.tv/helix/users/blocks?target_user_id={}",
            target_user_id
        );

        let response = client
            .delete(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .send()
            .await?;

        if !response.status().is_success() && response.status() != 204 {
            let error_text = response.text().await.unwrap_or_default();
            error!("[TwitchService] Failed to unblock user: {}", error_text);
            return Err(anyhow::anyhow!("Failed to unblock user"));
        }

        Ok(())
    }

    /// Get Channel Moderators
    pub async fn get_channel_moderators(broadcaster_id: &str) -> Result<Vec<serde_json::Value>> {
        let token = Self::get_token().await?;
        let client = Client::new();

        let url = format!(
            "https://api.twitch.tv/helix/moderation/moderators?broadcaster_id={}",
            broadcaster_id
        );

        let response = client
            .get(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            error!(
                "[TwitchService] Failed to get moderators ({}): {}",
                status, error_text
            );
            return Err(anyhow::anyhow!("Failed to get moderators: HTTP {}", status));
        }

        let json: serde_json::Value = response.json().await?;

        if let Some(data) = json.get("data").and_then(|d| d.as_array()) {
            Ok(data.clone())
        } else {
            Ok(Vec::new())
        }
    }

    /// Get Channel VIPs
    pub async fn get_channel_vips(broadcaster_id: &str) -> Result<Vec<serde_json::Value>> {
        let token = Self::get_token().await?;
        let client = Client::new();

        let url = format!(
            "https://api.twitch.tv/helix/channels/vips?broadcaster_id={}",
            broadcaster_id
        );

        let response = client
            .get(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            error!(
                "[TwitchService] Failed to get VIPs ({}): {}",
                status, error_text
            );
            return Err(anyhow::anyhow!("Failed to get VIPs: HTTP {}", status));
        }

        let json: serde_json::Value = response.json().await?;

        if let Some(data) = json.get("data").and_then(|d| d.as_array()) {
            Ok(data.clone())
        } else {
            Ok(Vec::new())
        }
    }

    /// Get channel chatters (moderators and VIPs) via GQL
    /// The Helix API requires broadcaster_id to match the access token user_id,
    /// so we use the GQL Mods/VIPs queries which work for any authenticated user.
    pub async fn get_chatters_by_role(channel_login: &str) -> Result<serde_json::Value> {
        let client = Client::new();

        // Build batch GQL request — both Mods and VIPs in one round trip
        let payload = serde_json::json!([
            {
                "operationName": "Mods",
                "variables": {
                    "login": channel_login
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "cb912a7e0789e0f8a4c85c25041a08324475831024d03d624172b59498caf085"
                    }
                }
            },
            {
                "operationName": "VIPs",
                "variables": {
                    "login": channel_login
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "612a574d07afe5db2f9e878e290225224a0b955e65b5d1235dcd4b68ff668218"
                    }
                }
            }
        ]);

        let response = client
            .post("https://gql.twitch.tv/gql")
            .header("Client-Id", TWITCH_GQL_CLIENT_ID)
            .json(&payload)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            error!(
                "[TwitchService] GQL Mods/VIPs failed ({}): {}",
                status, error_text
            );
            return Err(anyhow::anyhow!("GQL Mods/VIPs failed: HTTP {}", status));
        }

        let json: serde_json::Value = response.json().await?;

        // Response is an array of two results: [ModsResponse, VIPsResponse]
        // Mods: data.user.mods.edges[].node.login
        // VIPs: data.user.vips.edges[].node.login
        let mut moderators: Vec<serde_json::Value> = Vec::new();
        let mut vips: Vec<serde_json::Value> = Vec::new();

        if let Some(arr) = json.as_array() {
            // Parse Mods response (index 0)
            if let Some(mods_data) = arr.first() {
                if let Some(edges) = mods_data
                    .get("data")
                    .and_then(|d| d.get("user"))
                    .and_then(|u| u.get("mods"))
                    .and_then(|m| m.get("edges"))
                    .and_then(|e| e.as_array())
                {
                    for edge in edges {
                        if let Some(node) = edge.get("node") {
                            moderators.push(node.clone());
                        }
                    }
                }
            }

            // Parse VIPs response (index 1)
            if let Some(vips_data) = arr.get(1) {
                if let Some(edges) = vips_data
                    .get("data")
                    .and_then(|d| d.get("user"))
                    .and_then(|u| u.get("vips"))
                    .and_then(|v| v.get("edges"))
                    .and_then(|e| e.as_array())
                {
                    for edge in edges {
                        if let Some(node) = edge.get("node") {
                            vips.push(node.clone());
                        }
                    }
                }
            }
        }

        Ok(serde_json::json!({
            "moderators": moderators,
            "vips": vips
        }))
    }

    /// Send Chat Announcement
    pub async fn send_chat_announcement(
        broadcaster_id: &str,
        message: &str,
        color: Option<&str>,
    ) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();
        let user_info = Self::get_user_info().await?;
        let moderator_id = &user_info.id;

        let url = format!(
            "https://api.twitch.tv/helix/chat/announcements?broadcaster_id={}&moderator_id={}",
            broadcaster_id, moderator_id
        );

        let mut payload = serde_json::json!({
            "message": message
        });

        if let Some(c) = color {
            payload["color"] = serde_json::json!(c);
        }

        let response = client
            .post(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await?;

        if !response.status().is_success() && response.status() != 204 {
            let error_text = response.text().await.unwrap_or_default();
            error!(
                "[TwitchService] Failed to send announcement: {}",
                error_text
            );
            return Err(anyhow::anyhow!("Failed to send chat announcement"));
        }

        Ok(())
    }

    /// Send Shoutout
    pub async fn send_shoutout(broadcaster_id: &str, target_user_id: &str) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();
        let user_info = Self::get_user_info().await?;
        let moderator_id = &user_info.id;

        let url = format!(
            "https://api.twitch.tv/helix/chat/shoutouts?from_broadcaster_id={}&to_broadcaster_id={}&moderator_id={}",
            broadcaster_id, target_user_id, moderator_id
        );

        let response = client
            .post(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .send()
            .await?;

        if !response.status().is_success() && response.status() != 204 {
            let error_text = response.text().await.unwrap_or_default();
            error!("[TwitchService] Failed to send shoutout: {}", error_text);
            return Err(anyhow::anyhow!("Failed to send shoutout"));
        }

        Ok(())
    }

    /// Start Commercial
    pub async fn start_commercial(broadcaster_id: &str, length: u32) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();

        let url = "https://api.twitch.tv/helix/channels/commercial";

        let payload = serde_json::json!({
            "broadcaster_id": broadcaster_id,
            "length": length
        });

        let response = client
            .post(url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            error!("[TwitchService] Failed to start commercial: {}", error_text);
            return Err(anyhow::anyhow!("Failed to start commercial"));
        }

        Ok(())
    }

    /// Start Raid
    pub async fn start_raid(broadcaster_id: &str, target_user_id: &str) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();

        let url = format!(
            "https://api.twitch.tv/helix/raids?from_broadcaster_id={}&to_broadcaster_id={}",
            broadcaster_id, target_user_id
        );

        let response = client
            .post(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            error!("[TwitchService] Failed to start raid: {}", error_text);
            return Err(anyhow::anyhow!("Failed to start raid"));
        }

        Ok(())
    }

    /// Cancel Raid
    pub async fn cancel_raid(broadcaster_id: &str) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();

        let url = format!(
            "https://api.twitch.tv/helix/raids?broadcaster_id={}",
            broadcaster_id
        );

        let response = client
            .delete(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .send()
            .await?;

        if !response.status().is_success() && response.status() != 204 {
            let error_text = response.text().await.unwrap_or_default();
            error!("[TwitchService] Failed to cancel raid: {}", error_text);
            return Err(anyhow::anyhow!("Failed to cancel raid"));
        }

        Ok(())
    }

    /// Create Stream Marker
    pub async fn create_stream_marker(user_id: &str, description: Option<&str>) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();

        let url = "https://api.twitch.tv/helix/streams/markers";

        let mut payload = serde_json::json!({
            "user_id": user_id
        });

        if let Some(desc) = description {
            if !desc.is_empty() {
                payload["description"] = serde_json::json!(desc);
            }
        }

        let response = client
            .post(url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            error!(
                "[TwitchService] Failed to create stream marker: {}",
                error_text
            );
            return Err(anyhow::anyhow!("Failed to create stream marker"));
        }

        Ok(())
    }

    /// Warn a chat user (Helix: POST /moderation/warnings)
    pub async fn warn_chat_user(
        broadcaster_id: &str,
        target_user_id: &str,
        reason: &str,
    ) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();
        let user_info = Self::get_user_info().await?;
        let moderator_id = &user_info.id;

        let url = format!(
            "https://api.twitch.tv/helix/moderation/warnings?broadcaster_id={}&moderator_id={}",
            broadcaster_id, moderator_id
        );

        let payload = serde_json::json!({
            "data": {
                "user_id": target_user_id,
                "reason": reason
            }
        });

        let response = client
            .post(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            error!("[TwitchService] Failed to warn user: {}", error_text);
            return Err(anyhow::anyhow!("Failed to warn user"));
        }

        Ok(())
    }

    /// Update Shield Mode (Helix: PUT /moderation/shield_mode)
    pub async fn update_shield_mode(broadcaster_id: &str, is_active: bool) -> Result<()> {
        let token = Self::get_token().await?;
        let client = Client::new();
        let user_info = Self::get_user_info().await?;
        let moderator_id = &user_info.id;

        let url = format!(
            "https://api.twitch.tv/helix/moderation/shield_mode?broadcaster_id={}&moderator_id={}",
            broadcaster_id, moderator_id
        );

        let payload = serde_json::json!({
            "is_active": is_active
        });

        let response = client
            .put(&url)
            .header("Client-Id", CLIENT_ID)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            error!(
                "[TwitchService] Failed to update shield mode: {}",
                error_text
            );
            return Err(anyhow::anyhow!("Failed to update shield mode"));
        }

        Ok(())
    }
}
