use anyhow::Result;
use log::debug;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

// 7TV API endpoint
const SEVENTV_GQL_URL: &str = "https://7tv.io/v4/gql";
const SEVENTV_TOKEN_FILE_NAME: &str = ".seventv_token";

lazy_static::lazy_static! {
    static ref SEVENTV_TOKEN: Arc<RwLock<Option<StorableSevenTVToken>>> = Arc::new(RwLock::new(None));
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct StorableSevenTVToken {
    pub access_token: String,
    pub user_id: String,   // 7TV user ID
    pub twitch_id: String, // Associated Twitch ID
    pub created_at: i64,   // Unix timestamp
}

#[derive(Debug, Clone, Serialize)]
pub struct SevenTVAuthStatus {
    pub is_authenticated: bool,
    pub user_id: Option<String>,
    pub twitch_id: Option<String>,
}

pub struct SevenTVAuthService;

impl SevenTVAuthService {
    fn get_token_file_path() -> Result<PathBuf> {
        let mut path =
            dirs::config_dir().ok_or_else(|| anyhow::anyhow!("Could not find config directory"))?;
        path.push("StreamNook");

        if !path.exists() {
            fs::create_dir_all(&path)?;
        }

        path.push(SEVENTV_TOKEN_FILE_NAME);
        Ok(path)
    }

    fn store_token_to_file(token: &StorableSevenTVToken) -> Result<()> {
        let path = Self::get_token_file_path()?;
        let token_json = serde_json::to_string(token)?;

        // Simple XOR encryption with a fixed key for basic obfuscation
        let key: Vec<u8> = "StreamNook7TVKey2024"
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
        debug!("[7TV_AUTH] Token saved to file: {:?}", path);
        Ok(())
    }

    fn load_token_from_file() -> Result<StorableSevenTVToken> {
        let path = Self::get_token_file_path()?;

        if !path.exists() {
            return Err(anyhow::anyhow!("7TV token file does not exist"));
        }

        let encrypted = fs::read(&path)?;

        // Decrypt using the same XOR method
        let key: Vec<u8> = "StreamNook7TVKey2024"
            .bytes()
            .cycle()
            .take(encrypted.len())
            .collect();
        let decrypted: String = encrypted
            .iter()
            .zip(key.iter())
            .map(|(a, b)| (a ^ b) as char)
            .collect();

        let token: StorableSevenTVToken = serde_json::from_str(&decrypted)?;
        Ok(token)
    }

    fn delete_token_file() -> Result<()> {
        let path = Self::get_token_file_path()?;
        if path.exists() {
            fs::remove_file(&path)?;
            debug!("[7TV_AUTH] 7TV token file deleted: {:?}", path);
        }
        Ok(())
    }

    /// Store a 7TV token (called after OAuth flow captures the token)
    pub async fn store_token(
        access_token: String,
        user_id: String,
        twitch_id: String,
    ) -> Result<()> {
        let storable_token = StorableSevenTVToken {
            access_token,
            user_id,
            twitch_id,
            created_at: chrono::Utc::now().timestamp(),
        };

        // Store to file
        Self::store_token_to_file(&storable_token)?;

        // Cache in memory
        let mut cached = SEVENTV_TOKEN.write().await;
        *cached = Some(storable_token);

        debug!("[7TV_AUTH] ✅ 7TV token stored successfully");
        Ok(())
    }

    /// Get the current 7TV token
    pub async fn get_token() -> Result<String> {
        // Check memory cache first
        {
            let cached = SEVENTV_TOKEN.read().await;
            if let Some(token) = cached.as_ref() {
                return Ok(token.access_token.clone());
            }
        }

        // Try to load from file
        match Self::load_token_from_file() {
            Ok(token) => {
                // Cache in memory for next time
                let mut cached = SEVENTV_TOKEN.write().await;
                *cached = Some(token.clone());
                Ok(token.access_token)
            }
            Err(_) => Err(anyhow::anyhow!(
                "Not authenticated with 7TV. Please connect your 7TV account."
            )),
        }
    }

    /// Get full token info (including user IDs)
    pub async fn get_token_info() -> Result<StorableSevenTVToken> {
        // Check memory cache first
        {
            let cached = SEVENTV_TOKEN.read().await;
            if let Some(token) = cached.as_ref() {
                return Ok(token.clone());
            }
        }

        // Try to load from file
        match Self::load_token_from_file() {
            Ok(token) => {
                // Cache in memory for next time
                let mut cached = SEVENTV_TOKEN.write().await;
                *cached = Some(token.clone());
                Ok(token)
            }
            Err(e) => Err(e),
        }
    }

    /// Check if authenticated
    pub async fn is_authenticated() -> bool {
        Self::get_token().await.is_ok()
    }

    /// Get auth status with details
    pub async fn get_auth_status() -> SevenTVAuthStatus {
        match Self::get_token_info().await {
            Ok(token) => SevenTVAuthStatus {
                is_authenticated: true,
                user_id: Some(token.user_id),
                twitch_id: Some(token.twitch_id),
            },
            Err(_) => SevenTVAuthStatus {
                is_authenticated: false,
                user_id: None,
                twitch_id: None,
            },
        }
    }

    /// Validate the current token by making a test request
    pub async fn validate_token() -> Result<bool> {
        let token = match Self::get_token().await {
            Ok(t) => t,
            Err(_) => return Ok(false),
        };

        let client = Client::new();

        // Make a simple authenticated query to verify the token works
        let query = r#"{ users { me { id } } }"#;

        let response = client
            .post(SEVENTV_GQL_URL)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", token))
            .json(&serde_json::json!({
                "query": query
            }))
            .send()
            .await?;

        if !response.status().is_success() {
            // Token might be invalid, clear it
            debug!("[7TV_AUTH] Token validation failed - clearing stored token");
            let _ = Self::logout().await;
            return Ok(false);
        }

        let response_json: serde_json::Value = response.json().await?;

        // Check if we got user data (token is valid)
        if response_json["data"]["users"]["me"]["id"].is_string() {
            Ok(true)
        } else {
            // Token invalid
            let _ = Self::logout().await;
            Ok(false)
        }
    }

    /// Logout - delete the 7TV token
    pub async fn logout() -> Result<()> {
        Self::delete_token_file()?;

        // Clear memory cache
        let mut cached = SEVENTV_TOKEN.write().await;
        *cached = None;

        debug!("[7TV_AUTH] 7TV logout complete - token cleared");
        Ok(())
    }

    /// Get the 7TV OAuth login URL
    /// User needs to visit this URL to authenticate, then we capture the token
    pub fn get_login_url() -> String {
        // 7TV uses Twitch OAuth - the user logs into 7TV via Twitch
        // After login, they can get their token from the browser's localStorage or cookies
        "https://7tv.app/?login=true".to_string()
    }
}

/// 7TV Cosmetics Service - uses the auth token to change paints/badges
pub struct SevenTVCosmeticsService;

impl SevenTVCosmeticsService {
    /// Set active paint
    pub async fn set_active_paint(user_id: &str, paint_id: Option<&str>) -> Result<bool> {
        let token = SevenTVAuthService::get_token().await?;
        let client = Client::new();

        // Use the simplified mutation (we only need the response status)
        let mutation = r#"
        mutation SetActivePaint($id: Id!, $paintId: Id) {
            users {
                user(id: $id) {
                    activePaint(paintId: $paintId) {
                        id
                        style {
                            activePaintId
                        }
                    }
                }
            }
        }
        "#;

        let response = client
            .post(SEVENTV_GQL_URL)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", token))
            .json(&serde_json::json!({
                "query": mutation,
                "variables": {
                    "id": user_id,
                    "paintId": paint_id
                },
                "operationName": "SetActivePaint"
            }))
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!("Failed to set paint: {}", error_text));
        }

        let result: serde_json::Value = response.json().await?;

        if result.get("errors").is_some() {
            return Err(anyhow::anyhow!("GraphQL errors: {:?}", result["errors"]));
        }

        debug!("[7TV] ✅ Paint changed successfully to: {:?}", paint_id);
        Ok(true)
    }

    /// Set active badge
    pub async fn set_active_badge(user_id: &str, badge_id: Option<&str>) -> Result<bool> {
        let token = SevenTVAuthService::get_token().await?;
        let client = Client::new();

        // Use the simplified mutation
        let mutation = r#"
        mutation SetActiveBadge($id: Id!, $badgeId: Id) {
            users {
                user(id: $id) {
                    activeBadge(badgeId: $badgeId) {
                        id
                        style {
                            activeBadgeId
                        }
                    }
                }
            }
        }
        "#;

        let response = client
            .post(SEVENTV_GQL_URL)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", token))
            .json(&serde_json::json!({
                "query": mutation,
                "variables": {
                    "id": user_id,
                    "badgeId": badge_id
                },
                "operationName": "SetActiveBadge"
            }))
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!("Failed to set badge: {}", error_text));
        }

        let result: serde_json::Value = response.json().await?;

        if result.get("errors").is_some() {
            return Err(anyhow::anyhow!("GraphQL errors: {:?}", result["errors"]));
        }

        debug!("[7TV] ✅ Badge changed successfully to: {:?}", badge_id);
        Ok(true)
    }
}
