use crate::services::seventv_auth_service::{
    SevenTVAuthService, SevenTVAuthStatus, SevenTVCosmeticsService,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Serialize, Deserialize)]
pub struct SevenTVCosmeticsResult {
    pub success: bool,
    pub message: String,
}

// ============================================================================
// 7TV Auth Commands
// ============================================================================

/// Get 7TV authentication status
#[tauri::command]
pub async fn get_seventv_auth_status() -> SevenTVAuthStatus {
    SevenTVAuthService::get_auth_status().await
}

/// Get the 7TV login URL for the user to authenticate
#[tauri::command]
pub fn get_seventv_login_url() -> String {
    SevenTVAuthService::get_login_url()
}

/// Open 7TV login in an in-app browser window with automatic token capture
#[tauri::command]
pub async fn open_seventv_login_window(app: AppHandle) -> Result<bool, String> {
    let window_label = format!("seventv-login-{}", chrono::Utc::now().timestamp_millis());
    let login_url = SevenTVAuthService::get_login_url();

    println!("[7TV] Opening login window: {}", login_url);

    // Simple JavaScript: find token, navigate to URL with token
    let token_capture_script = r#"
        (function() {
            console.log('[StreamNook 7TV] Token capture script loaded');
            let tokenFound = false;
            
            function checkForToken() {
                if (tokenFound) return;
                
                const token = localStorage.getItem('7tv-token');
                
                if (token && token.length > 50) {
                    tokenFound = true;
                    console.log('[StreamNook 7TV] Token found! Length:', token.length);
                    
                    // Show success overlay
                    const overlay = document.createElement('div');
                    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:999999;display:flex;align-items:center;justify-content:center;color:white;font-family:sans-serif;';
                    overlay.innerHTML = '<div style="text-align:center;"><div style="font-size:48px;margin-bottom:20px;">✓</div><h1 style="color:#29b6f6;">7TV Connected!</h1><p>This window will close automatically...</p></div>';
                    document.body.appendChild(overlay);
                    
                    // Navigate to URL with token - Rust will read this
                    setTimeout(() => {
                        window.location.href = 'about:blank#7TV_TOKEN=' + encodeURIComponent(token);
                    }, 1000);
                    return;
                }
                
                setTimeout(checkForToken, 500);
            }
            
            setTimeout(checkForToken, 1000);
            
            // Check on URL changes too
            setInterval(() => {
                if (!tokenFound) checkForToken();
            }, 1000);
        })();
    "#;

    let _window = WebviewWindowBuilder::new(
        &app,
        &window_label,
        WebviewUrl::External(
            login_url
                .parse()
                .map_err(|e| format!("Invalid URL: {}", e))?,
        ),
    )
    .title("Connect 7TV Account")
    .inner_size(900.0, 700.0)
    .center()
    .visible(true)
    .decorations(true)
    .resizable(true)
    .initialization_script(token_capture_script)
    .build()
    .map_err(|e| format!("Failed to create window: {}", e))?;

    // Poll the window URL for the token
    let app_handle = app.clone();
    let label_clone = window_label.clone();

    tauri::async_runtime::spawn(async move {
        // Poll for up to 5 minutes
        for poll_count in 0..600 {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

            if let Some(win) = app_handle.get_webview_window(&label_clone) {
                // Check the current URL
                if let Ok(url) = win.url() {
                    let url_str = url.to_string();

                    // Log occasionally
                    if poll_count % 20 == 0 {
                        println!(
                            "[7TV] Poll #{}: URL = {}",
                            poll_count,
                            &url_str[..url_str.len().min(50)]
                        );
                    }

                    // Check if URL contains our token marker
                    if url_str.contains("#7TV_TOKEN=") {
                        if let Some(token_part) = url_str.split("#7TV_TOKEN=").nth(1) {
                            if let Ok(token) = urlencoding::decode(token_part) {
                                println!("[7TV] Token captured! Length: {}", token.len());

                                // Decode JWT to get user_id
                                let mut user_id = String::new();
                                if token.contains('.') {
                                    let parts: Vec<&str> = token.split('.').collect();
                                    if parts.len() == 3 {
                                        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
                                        use base64::Engine;
                                        if let Ok(payload_bytes) = URL_SAFE_NO_PAD.decode(parts[1])
                                        {
                                            if let Ok(payload_str) =
                                                String::from_utf8(payload_bytes)
                                            {
                                                if let Ok(payload) =
                                                    serde_json::from_str::<serde_json::Value>(
                                                        &payload_str,
                                                    )
                                                {
                                                    user_id = payload
                                                        .get("sub")
                                                        .or_else(|| payload.get("user_id"))
                                                        .and_then(|v| v.as_str())
                                                        .unwrap_or("")
                                                        .to_string();
                                                    println!("[7TV] User ID from JWT: {}", user_id);
                                                }
                                            }
                                        }
                                    }
                                }

                                // Store the token
                                match SevenTVAuthService::store_token(
                                    token.to_string(),
                                    user_id,
                                    String::new(),
                                )
                                .await
                                {
                                    Ok(_) => {
                                        println!("[7TV] Token stored successfully!");
                                        let _ = app_handle.emit("seventv-connected", true);
                                    }
                                    Err(e) => println!("[7TV] Failed to store token: {}", e),
                                }

                                // Close window
                                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                                let _ = win.close();
                                return;
                            }
                        }
                    }
                }
            } else {
                println!("[7TV] Window closed by user");
                return;
            }
        }

        println!("[7TV] Token capture timed out");
    });

    Ok(true)
}

/// Receive captured 7TV token from the browser window
#[tauri::command]
pub async fn receive_seventv_token(
    app: AppHandle,
    access_token: String,
    user_id: String,
    twitch_id: String,
) -> Result<bool, String> {
    SevenTVAuthService::store_token(access_token, user_id, twitch_id)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit("seventv-connected", true);
    Ok(true)
}

/// Store a 7TV token
#[tauri::command]
pub async fn store_seventv_token(
    access_token: String,
    user_id: String,
    twitch_id: String,
) -> Result<bool, String> {
    SevenTVAuthService::store_token(access_token, user_id, twitch_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Validate the current 7TV token
#[tauri::command]
pub async fn validate_seventv_token() -> bool {
    SevenTVAuthService::validate_token().await.unwrap_or(false)
}

/// Logout from 7TV
#[tauri::command]
pub async fn logout_seventv() -> Result<bool, String> {
    SevenTVAuthService::logout()
        .await
        .map_err(|e| e.to_string())?;
    Ok(true)
}

// ============================================================================
// 7TV Cosmetics Commands
// ============================================================================

/// Set the user's active 7TV paint
#[tauri::command]
pub async fn set_seventv_paint(
    user_id: String,
    paint_id: Option<String>,
) -> Result<SevenTVCosmeticsResult, String> {
    match SevenTVCosmeticsService::set_active_paint(&user_id, paint_id.as_deref()).await {
        Ok(_) => Ok(SevenTVCosmeticsResult {
            success: true,
            message: match &paint_id {
                Some(id) => format!("Paint changed to {}", id),
                None => "Paint unequipped".to_string(),
            },
        }),
        Err(e) => Err(e.to_string()),
    }
}

/// Set the user's active 7TV badge
#[tauri::command]
pub async fn set_seventv_badge(
    user_id: String,
    badge_id: Option<String>,
) -> Result<SevenTVCosmeticsResult, String> {
    match SevenTVCosmeticsService::set_active_badge(&user_id, badge_id.as_deref()).await {
        Ok(_) => Ok(SevenTVCosmeticsResult {
            success: true,
            message: match &badge_id {
                Some(id) => format!("Badge changed to {}", id),
                None => "Badge unequipped".to_string(),
            },
        }),
        Err(e) => Err(e.to_string()),
    }
}
