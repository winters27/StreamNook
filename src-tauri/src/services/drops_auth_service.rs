use anyhow::Result;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use chrono::{Utc, Duration as ChronoDuration};
use std::fs;
use std::path::PathBuf;
use tokio::time::Duration;
use crate::services::cookie_jar_service::CookieJarService;

// Twitch Android App credentials (used by TwitchDropsMiner)
const DROPS_CLIENT_ID: &str = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";
const DROPS_TOKEN_FILE_NAME: &str = ".twitch_drops_token";

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct StorableDropsToken {
    access_token: String,
    // NOTE: refresh_token is not used - Android client doesn't support refresh without client secret
    // We store it anyway for potential future use, but never attempt to refresh
    refresh_token: String,
    // NOTE: expires_at is not used - we simply use the token until it's rejected by Twitch
    // This matches TwitchDropsMiner's behavior
    expires_at: i64, // Unix timestamp (unused but kept for compatibility)
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DropsDeviceCodeInfo {
    pub user_code: String,
    pub verification_uri: String,
    pub device_code: String,
    pub interval: u64,
    pub expires_in: u64,
}

pub struct DropsAuthService;

impl DropsAuthService {
    fn get_token_file_path() -> Result<PathBuf> {
        let mut path = dirs::config_dir()
            .ok_or_else(|| anyhow::anyhow!("Could not find config directory"))?;
        path.push("StreamNook");
        
        if !path.exists() {
            fs::create_dir_all(&path)?;
        }
        
        path.push(DROPS_TOKEN_FILE_NAME);
        Ok(path)
    }
    
    fn store_token_to_file(token: &StorableDropsToken) -> Result<()> {
        let path = Self::get_token_file_path()?;
        let token_json = serde_json::to_string(token)?;
        
        // Simple XOR encryption with a fixed key for basic obfuscation
        let key: Vec<u8> = "StreamNookDropsKey2024".bytes().cycle().take(token_json.len()).collect();
        let encrypted: Vec<u8> = token_json.bytes()
            .zip(key.iter())
            .map(|(a, b)| a ^ b)
            .collect();
        
        fs::write(&path, encrypted)?;
        println!("[DROPS_AUTH] Token saved to file: {:?}", path);
        Ok(())
    }
    
    fn load_token_from_file() -> Result<StorableDropsToken> {
        let path = Self::get_token_file_path()?;
        
        if !path.exists() {
            return Err(anyhow::anyhow!("Drops token file does not exist"));
        }
        
        let encrypted = fs::read(&path)?;
        
        // Decrypt using the same XOR method
        let key: Vec<u8> = "StreamNookDropsKey2024".bytes().cycle().take(encrypted.len()).collect();
        let decrypted: String = encrypted.iter()
            .zip(key.iter())
            .map(|(a, b)| (a ^ b) as char)
            .collect();
        
        let token: StorableDropsToken = serde_json::from_str(&decrypted)?;
        Ok(token)
    }
    
    fn delete_token_file() -> Result<()> {
        let path = Self::get_token_file_path()?;
        if path.exists() {
            fs::remove_file(&path)?;
            println!("[DROPS_AUTH] Drops token file deleted: {:?}", path);
        }
        Ok(())
    }

    // Cookie-based storage methods
    async fn store_token_to_cookies(token: &StorableDropsToken) -> Result<()> {
        let cookie_jar = CookieJarService::new_drops()?;
        cookie_jar.set_auth_token(&token.access_token).await?;
        println!("[DROPS_AUTH] ✅ Token saved to cookies");
        Ok(())
    }

    async fn load_token_from_cookies() -> Result<String> {
        let cookie_jar = CookieJarService::new_drops()?;
        cookie_jar.get_auth_token().await
            .ok_or_else(|| anyhow::anyhow!("No drops auth token in cookies"))
    }

    async fn delete_cookies() -> Result<()> {
        let cookie_jar = CookieJarService::new_drops()?;
        cookie_jar.clear().await?;
        println!("[DROPS_AUTH] Cookies deleted");
        Ok(())
    }

    /// Start the device code flow for drops authentication
    pub async fn start_device_flow() -> Result<DropsDeviceCodeInfo> {
        let client = Client::new();
        
        let params = [
            ("client_id", DROPS_CLIENT_ID),
            ("scopes", ""), // NO SCOPES - this is critical!
        ];
        
        println!("[DROPS_AUTH] Starting device flow with Android app client ID");
        println!("[DROPS_AUTH] Client ID: {}", DROPS_CLIENT_ID);
        println!("[DROPS_AUTH] Scopes: (empty)");
        
        let response = client
            .post("https://id.twitch.tv/oauth2/device")
            .form(&params)
            .send()
            .await?;
        
        if !response.status().is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!("Failed to start drops device flow: {}", error_text));
        }
        
        let device_response: DeviceCodeResponse = response.json().await?;
        
        println!("[DROPS_AUTH] Device flow started successfully");
        println!("[DROPS_AUTH] User code: {}", device_response.user_code);
        println!("[DROPS_AUTH] Verification URI: {}", device_response.verification_uri);
        
        Ok(DropsDeviceCodeInfo {
            user_code: device_response.user_code,
            verification_uri: device_response.verification_uri,
            device_code: device_response.device_code,
            interval: device_response.interval,
            expires_in: device_response.expires_in,
        })
    }
    
    /// Poll for the token after the user has entered the code
    pub async fn poll_for_token(
        device_code: &str,
        interval: u64,
        expires_in: u64,
    ) -> Result<String> {
        let client = Client::new();
        let start_time = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let expiry_time = start_time + expires_in;
        let mut poll_interval = interval;
        
        println!("[DROPS_AUTH] Starting token polling...");
        
        loop {
            let current_time = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
            if current_time >= expiry_time {
                return Err(anyhow::anyhow!("Device code expired. Please try logging in again."));
            }
            
            tokio::time::sleep(Duration::from_secs(poll_interval)).await;
            
            let params = [
                ("client_id", DROPS_CLIENT_ID),
                ("scopes", ""), // NO SCOPES
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
                
                let expires_at = Utc::now() + ChronoDuration::seconds(token_response.expires_in.unwrap_or(3600) as i64);
                
                let storable_token = StorableDropsToken {
                    access_token: token_response.access_token.clone(),
                    refresh_token: token_response.refresh_token.clone().unwrap_or_default(),
                    expires_at: expires_at.timestamp(),
                };
                
                // Store token to both file and cookies for persistence
                println!("[DROPS_AUTH] Storing token to file and cookies...");
                let file_result = Self::store_token_to_file(&storable_token);
                let cookie_result = Self::store_token_to_cookies(&storable_token).await;
                
                match (file_result, cookie_result) {
                    (Ok(_), Ok(_)) => {
                        println!("[DROPS_AUTH] ✅ Token stored successfully to file and cookies!");
                    }
                    (Ok(_), Err(e)) => {
                        eprintln!("[DROPS_AUTH] ⚠️ Token saved to file but cookies failed: {:?}", e);
                    }
                    (Err(e), Ok(_)) => {
                        eprintln!("[DROPS_AUTH] ⚠️ Token saved to cookies but file failed: {:?}", e);
                    }
                    (Err(file_err), Err(cookie_err)) => {
                        eprintln!("[DROPS_AUTH] ⚠️ Failed to store token! File: {:?}, Cookie: {:?}", file_err, cookie_err);
                        // Still continue since we have the token in memory
                    }
                }
                
                println!("[DROPS_AUTH] Access token (first 10 chars): {}...", &token_response.access_token[..10.min(token_response.access_token.len())]);
                
                return Ok(token_response.access_token);
            }
            
            let error_text = response.text().await?;
            
            if error_text.contains("authorization_pending") {
                // User hasn't authorized yet, continue polling
                println!("[DROPS_AUTH] Waiting for user authorization...");
                continue;
            } else if error_text.contains("slow_down") {
                // Twitch wants us to slow down
                poll_interval += 2;
                println!("[DROPS_AUTH] Slowing down polling interval to {} seconds", poll_interval);
                continue;
            } else if error_text.contains("expired_token") {
                return Err(anyhow::anyhow!("Device code expired. Please try logging in again."));
            } else {
                return Err(anyhow::anyhow!("Token polling failed: {}", error_text));
            }
        }
    }

    /// Logout - delete the drops token
    pub async fn logout() -> Result<()> {
        Self::delete_token_file()?;
        let _ = Self::delete_cookies().await;
        println!("[DROPS_AUTH] Drops logout complete - all tokens cleared");
        Ok(())
    }

    /// Refresh the drops token
    async fn refresh_token(refresh_token: &str) -> Result<StorableDropsToken> {
        let client = Client::new();
        let params = [
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", DROPS_CLIENT_ID),
        ];

        println!("[DROPS_AUTH] Refreshing drops token...");

        let response = client
            .post("https://id.twitch.tv/oauth2/token")
            .form(&params)
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await?;
            let error_msg = format!("Failed to refresh drops token: {}", error_text);
            
            // If refresh fails due to missing client secret or other OAuth issues,
            // delete the stored token so the user can re-authenticate
            if error_text.contains("client secret") || error_text.contains("invalid") {
                eprintln!("[DROPS_AUTH] ⚠️ Token refresh failed - clearing stored tokens");
                eprintln!("[DROPS_AUTH] Error: {}", error_text);
                let _ = Self::delete_token_file();
                let _ = Self::delete_cookies().await;
                return Err(anyhow::anyhow!("{}\n\nPlease log in again for drops functionality.", error_msg));
            }
            
            return Err(anyhow::anyhow!(error_msg));
        }

        let token_response: TokenResponse = response.json().await?;
        let expires_at = Utc::now() + ChronoDuration::seconds(token_response.expires_in.unwrap_or(3600) as i64);

        let new_storable_token = StorableDropsToken {
            access_token: token_response.access_token,
            refresh_token: token_response.refresh_token.unwrap_or_else(|| refresh_token.to_string()),
            expires_at: expires_at.timestamp(),
        };

        // Store the refreshed token
        Self::store_token_to_file(&new_storable_token)?;
        
        println!("[DROPS_AUTH] ✅ Token refreshed successfully");

        Ok(new_storable_token)
    }

    /// Get the current drops token
    /// NOTE: We don't attempt token refresh because the Android client ID doesn't support it
    /// without a client secret. Instead, we use the token until Twitch rejects it (401),
    /// at which point validate_token() will delete it and require re-authentication.
    /// This matches TwitchDropsMiner's behavior.
    pub async fn get_token() -> Result<String> {
        // Try to load from file
        match Self::load_token_from_file() {
            Ok(token) => {
                // NOTE: We don't check expires_at here - just use the token until it fails
                // Twitch will reject it with 401 when it's actually invalid
                Ok(token.access_token)
            }
            Err(_) => {
                Err(anyhow::anyhow!(
                    "Not authenticated for drops. Please log in to Twitch for drops functionality."
                ))
            }
        }
    }

    /// Check if the user is authenticated for drops
    pub async fn is_authenticated() -> bool {
        Self::load_token_from_file().is_ok()
    }

    /// Validate the current token
    pub async fn validate_token() -> Result<bool> {
        let token = match Self::get_token().await {
            Ok(t) => t,
            Err(_) => return Ok(false),
        };

        let client = Client::new();
        let response = client
            .get("https://id.twitch.tv/oauth2/validate")
            .header("Authorization", format!("OAuth {}", token))
            .send()
            .await?;

        if response.status() == 401 {
            // Token is invalid, delete it
            let _ = Self::delete_token_file();
            return Ok(false);
        }

        Ok(response.status().is_success())
    }
}
