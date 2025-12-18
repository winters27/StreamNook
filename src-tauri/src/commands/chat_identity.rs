use crate::services::drops_auth_service::DropsAuthService;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

// Use Twitch Android app client ID for GQL operations
const ANDROID_CLIENT_ID: &str = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";
const CLIENT_URL: &str = "https://www.twitch.tv";
// GQL hash for badge selection mutation
const BADGE_MUTATION_HASH: &str =
    "5e1b7f0ba771ca8eb81c0fcd5b8f4ff559ec2dc71cc9256e04ec2665049fc4e5";

/// Create headers for GQL requests
fn create_gql_headers(token: &str) -> HeaderMap {
    let device_id = Uuid::new_v4().to_string().replace("-", "");
    let session_id = Uuid::new_v4().to_string().replace("-", "");

    let mut headers = HeaderMap::new();
    headers.insert("Client-ID", HeaderValue::from_static(ANDROID_CLIENT_ID));
    headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
    // Accept-Language omitted - not required for GQL mutations and keeps it region-neutral
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

/// Try to update badge via direct GQL mutation (fast path)
/// Returns Ok(true) if successful, Ok(false) if should fallback, Err on actual error
async fn try_gql_badge_update(badge_id: &str, badge_version: &str) -> Result<bool, String> {
    // Try to get drops token - if not available, return false to trigger fallback
    let token = match DropsAuthService::get_token().await {
        Ok(t) => t,
        Err(_) => {
            println!("[ChatIdentity] No drops auth token available, will use browser fallback");
            return Ok(false);
        }
    };

    println!(
        "[ChatIdentity] 🚀 Attempting fast GQL badge update for '{}'",
        badge_id
    );

    let client = Client::new();
    let request_body = serde_json::json!({
        "operationName": "ChatSettings_SelectGlobalBadge",
        "variables": {
            "input": {
                "badgeSetID": badge_id,
                "badgeSetVersion": badge_version
            }
        },
        "extensions": {
            "persistedQuery": {
                "version": 1,
                "sha256Hash": BADGE_MUTATION_HASH
            }
        }
    });

    let response = match client
        .post("https://gql.twitch.tv/gql")
        .headers(create_gql_headers(&token))
        .json(&request_body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            println!(
                "[ChatIdentity] GQL request failed: {}, will use browser fallback",
                e
            );
            return Ok(false);
        }
    };

    let status = response.status();

    if !status.is_success() {
        println!(
            "[ChatIdentity] GQL returned {}, will use browser fallback",
            status
        );
        return Ok(false);
    }

    let response_text = match response.text().await {
        Ok(t) => t,
        Err(e) => {
            println!(
                "[ChatIdentity] Failed to read GQL response: {}, will use browser fallback",
                e
            );
            return Ok(false);
        }
    };

    // Check for GraphQL errors
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&response_text) {
        if json.get("errors").is_some() {
            println!("[ChatIdentity] GQL returned errors, will use browser fallback");
            return Ok(false);
        }

        if json.get("data").is_some() {
            println!("[ChatIdentity] ✅ GQL badge update successful!");
            return Ok(true);
        }
    }

    // Unexpected response format
    println!("[ChatIdentity] Unexpected GQL response format, will use browser fallback");
    Ok(false)
}

/// Result of a badge scrape action
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BadgeScrapeResult {
    pub success: bool,
    pub message: String,
    pub badges: Vec<ChatIdentityBadge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatIdentityBadge {
    pub id: String,
    pub version: String,
    pub title: String,
    pub image_url: String,
    pub is_selected: bool,
}

/// Result of setting a badge
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BadgeUpdateResult {
    pub success: bool,
    pub message: String,
    pub badge_id: String,
}

/// Generate the scraper script for fetching chat identity badges
fn generate_badge_scraper_script() -> String {
    r#"
    // StreamNook Chat Identity Badge Scraper
    (async function() {
        // Wait for page to fully load - popout chat can be slow
        await new Promise(r => setTimeout(r, 3000));
        
        console.log('%c✨ StreamNook Badge Scraper', 'font-size:16px;font-weight:bold;color:#a855f7');
        
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        
        // Wait for element helper with better logging
        async function waitFor(selector, timeout = 15000, description = '') {
            const start = Date.now();
            console.log('[BadgeScraper] Waiting for:', description || selector);
            while (Date.now() - start < timeout) {
                const el = document.querySelector(selector);
                if (el) {
                    console.log('[BadgeScraper] Found:', description || selector);
                    return el;
                }
                await wait(300);
            }
            console.log('[BadgeScraper] Timeout waiting for:', description || selector);
            return null;
        }

        try {
            // 1. Wait for chat to be ready - try multiple indicators
            console.log('[BadgeScraper] Waiting for chat to load...');
            
            // First check if we're logged in
            const loginBtn = document.querySelector('[data-a-target="login-button"]');
            if (loginBtn) {
                throw new Error('NOT_LOGGED_IN: Please log in to Twitch in your browser first');
            }
            
            // Wait for chat input OR the chat room container
            let chatReady = await waitFor('[data-a-target="chat-input"]', 12000, 'chat input');
            if (!chatReady) {
                chatReady = await waitFor('.chat-room', 5000, 'chat room');
            }
            if (!chatReady) {
                chatReady = await waitFor('.stream-chat', 5000, 'stream chat');
            }
            
            if (!chatReady) {
                throw new Error('Chat failed to load - chat input/room not found');
            }
            
            console.log('[BadgeScraper] Chat loaded, looking for identity button...');
            await wait(1000);

            // 2. Find and click Identity Button - try multiple approaches
            let identityBtn = null;
            
            // Method 1: Look for ChatBadgeCarousel (the actual Twitch label)
            identityBtn = document.querySelector('[aria-label="ChatBadgeCarousel"]') || 
                         document.querySelector('button[aria-label="ChatBadgeCarousel"]');
            
            // Method 2: Also try "Chat Identity" as fallback
            if (!identityBtn) {
                identityBtn = document.querySelector('[aria-label="Chat Identity"]') || 
                             document.querySelector('button[aria-label="Chat Identity"]');
            }
            
            // Method 3: Look in chat input buttons container for various identity-related labels
            if (!identityBtn) {
                const chatButtons = document.querySelectorAll('.chat-input__buttons-container button, [class*="chat-input"] button');
                for (const btn of chatButtons) {
                    const label = btn.getAttribute('aria-label') || '';
                    const lowerLabel = label.toLowerCase();
                    if (lowerLabel.includes('identity') || 
                        lowerLabel.includes('badge') || 
                        lowerLabel.includes('appearance') ||
                        lowerLabel.includes('carousel')) {
                        identityBtn = btn;
                        console.log('[BadgeScraper] Found identity button by label:', label);
                        break;
                    }
                }
            }
            
            // Method 4: Search all buttons for badge/carousel related labels
            if (!identityBtn) {
                const allButtons = document.querySelectorAll('button');
                for (const btn of allButtons) {
                    const ariaLabel = btn.getAttribute('aria-label') || '';
                    const lowerLabel = ariaLabel.toLowerCase();
                    if (lowerLabel.includes('badgecarousel') || 
                        lowerLabel.includes('badge carousel') ||
                        lowerLabel === 'chatbadgecarousel') {
                        identityBtn = btn;
                        console.log('[BadgeScraper] Found identity button:', ariaLabel);
                        break;
                    }
                }
            }
            
            if (!identityBtn) {
                // Log available buttons for debugging
                const btns = document.querySelectorAll('button');
                const btnLabels = Array.from(btns).map(b => b.getAttribute('aria-label')).filter(Boolean);
                console.log('[BadgeScraper] Available button labels:', btnLabels.join(', '));
                throw new Error('Identity button not found. Available buttons: ' + btnLabels.slice(0, 10).join(', '));
            }
            
            console.log('[BadgeScraper] Found identity button, clicking...');
            identityBtn.click();
            await wait(500);

            // 3. Wait for the identity menu to appear
            console.log('[BadgeScraper] Waiting for identity menu...');
            let menu = await waitFor('.chat-identity-menu', 5000, 'identity menu');
            
            // Sometimes the menu class is different
            if (!menu) {
                menu = await waitFor('.scrollable-area.chat-identity-menu', 3000, 'scrollable identity menu');
            }
            if (!menu) {
                // Look for any scrollable area that appeared after the click
                menu = await waitFor('[class*="chat-identity"]', 3000, 'chat identity container');
            }
            
            if (!menu) {
                throw new Error('Identity menu did not appear after clicking the button');
            }

            console.log('[BadgeScraper] Identity menu opened!');

            // 4. Wait for badges to populate (they load async)
            await wait(2000);

            // 5. Scrape Global Badges
            console.log('[BadgeScraper] Scraping badges...');
            const badges = [];
            
            // Find all badge elements with data-badge-id attribute
            const badgeElements = document.querySelectorAll('[data-badge-id]');
            
            console.log('[BadgeScraper] Found', badgeElements.length, 'badge elements with data-badge-id');
            
            if (badgeElements.length === 0) {
                // Debug: log the menu content
                console.log('[BadgeScraper] Menu HTML snippet:', menu.innerHTML.substring(0, 500));
            }
            
            badgeElements.forEach(el => {
                const id = el.getAttribute('data-badge-id');
                const version = el.getAttribute('data-badge-version') || '1';
                const title = el.getAttribute('data-badge-title') || id;
                const img = el.querySelector('img');
                
                // Skip "none" badge entry and channel-specific badges (broadcaster, subscriber)
                if (!id || id === 'none' || id === 'broadcaster' || id === 'subscriber') return;
                
                if (id && img) {
                    // Check selection state - Twitch uses aria-checked on the img or a selected class on wrapper
                    const imgAriaChecked = img.getAttribute('aria-checked') === 'true';
                    const hasSelectedClass = el.classList.contains('edit-appearance__badge-chooser--selected--thick') ||
                                            el.classList.contains('edit-appearance__badge-chooser--selected');
                    
                    const isSelected = imgAriaChecked || hasSelectedClass;
                    
                    badges.push({
                        id: id,
                        version: version,
                        title: title,
                        image_url: img.src,
                        is_selected: isSelected
                    });
                }
            });

            console.log('[BadgeScraper] Collected', badges.length, 'badges');
            
            // Sort badges: selected first, then alphabetically
            badges.sort((a, b) => {
                if (a.is_selected && !b.is_selected) return -1;
                if (!a.is_selected && b.is_selected) return 1;
                return a.title.localeCompare(b.title);
            });

            // Send result back to Tauri
            console.log('[BadgeScraper] Sending result to Tauri...');
            await window.__TAURI_INTERNALS__.invoke('receive_badge_data', {
                result: {
                    success: badges.length > 0,
                    message: badges.length > 0 ? 'Found ' + badges.length + ' badges' : 'No badges found in menu',
                    badges: badges
                }
            });
            
            console.log('[BadgeScraper] ✅ Complete!');

        } catch (e) {
            console.error('[BadgeScraper] ❌ Error:', e.message);
            await window.__TAURI_INTERNALS__.invoke('receive_badge_data', {
                result: {
                    success: false,
                    message: e.message,
                    badges: []
                }
            });
        }
    })();
    "#.to_string()
}

/// Generate the script for updating/selecting a chat identity badge
fn generate_badge_update_script(badge_id: &str, badge_version: &str) -> String {
    format!(
        r#"
    // StreamNook Chat Identity Badge Updater
    (async function() {{
        // Wait for page to load
        await new Promise(r => setTimeout(r, 2000));
        
        console.log('%c✨ StreamNook Badge Updater', 'font-size:16px;font-weight:bold;color:#a855f7');
        console.log('[BadgeUpdater] Setting badge:', '{badge_id}', 'version:', '{badge_version}');
        
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        
        async function waitFor(selector, timeout = 10000) {{
            const start = Date.now();
            while (Date.now() - start < timeout) {{
                const el = document.querySelector(selector);
                if (el) return el;
                await wait(200);
            }}
            return null;
        }}

        try {{
            // 1. Wait for chat input
            const chatInput = await waitFor('[data-a-target="chat-input"]', 15000);
            if (!chatInput) {{
                if (document.querySelector('[data-a-target="login-button"]')) {{
                    throw new Error('NOT_LOGGED_IN');
                }}
                throw new Error('Chat not loaded');
            }}

            // 2. Open identity menu - try ChatBadgeCarousel first (actual Twitch label)
            let identityBtn = document.querySelector('[aria-label="ChatBadgeCarousel"]') || 
                             document.querySelector('button[aria-label="ChatBadgeCarousel"]') ||
                             document.querySelector('[aria-label="Chat Identity"]') || 
                             document.querySelector('button[aria-label="Chat Identity"]');
            
            if (!identityBtn) {{
                // Search all buttons for badge carousel
                const allButtons = document.querySelectorAll('button');
                for (const btn of allButtons) {{
                    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                    if (label.includes('badge') && label.includes('carousel')) {{
                        identityBtn = btn;
                        break;
                    }}
                }}
            }}
            
            if (!identityBtn) {{
                throw new Error('Identity button not found');
            }}
            
            identityBtn.click();
            console.log('[BadgeUpdater] Opened identity menu');

            // 3. Wait for menu
            const menu = await waitFor('.chat-identity-menu', 5000);
            if (!menu) {{
                throw new Error('Menu did not appear');
            }}

            await wait(1000); // Let badges populate

            // 4. Find and click the target badge
            const targetId = '{badge_id}';
            let badgeBtn = menu.querySelector('[data-badge-id="' + targetId + '"]');
            
            if (!badgeBtn) {{
                // Try alternate search - look through all badge elements
                const allBadges = menu.querySelectorAll('[data-badge-id]');
                for (const badge of allBadges) {{
                    if (badge.getAttribute('data-badge-id') === targetId) {{
                        badgeBtn = badge;
                        break;
                    }}
                }}
            }}
            
            if (!badgeBtn) {{
                throw new Error('Badge not found in menu: ' + targetId);
            }}

            // Click the badge to select it
            badgeBtn.click();
            console.log('[BadgeUpdater] Clicked badge:', targetId);
            
            // Wait for Twitch to process the selection
            await wait(1000);
            
            // Verify the badge is now selected
            const isNowSelected = badgeBtn.classList.contains('edit-appearance__badge-chooser--selected--thick') ||
                                 badgeBtn.classList.contains('edit-appearance__badge-chooser--selected') ||
                                 badgeBtn.querySelector('[aria-checked="true"]') !== null;
            
            console.log('[BadgeUpdater] Badge selected state:', isNowSelected);

            // Send success result
            await window.__TAURI_INTERNALS__.invoke('receive_update_result', {{
                result: {{
                    success: true,
                    message: 'Badge updated successfully',
                    badge_id: targetId
                }}
            }});
            
            console.log('[BadgeUpdater] ✅ Complete!');

        }} catch (e) {{
            console.error('[BadgeUpdater] ❌ Error:', e.message || 'Unknown error');
            await window.__TAURI_INTERNALS__.invoke('receive_update_result', {{
                result: {{
                    success: false,
                    message: e.message || 'Unknown error',
                    badge_id: '{badge_id}'
                }}
            }});
        }}
    }})();
    "#,
        badge_id = badge_id,
        badge_version = badge_version
    )
}

/// Fetch available global badges via hidden chat window automation
#[tauri::command]
pub async fn fetch_chat_identity_badges(
    app: AppHandle,
    channel_name: String,
) -> Result<BadgeScrapeResult, String> {
    println!(
        "[ChatIdentity] Fetching badges using channel: {}",
        channel_name
    );

    let window_label = format!("identity-fetch-{}", chrono::Utc::now().timestamp_millis());
    let url = format!("https://www.twitch.tv/popout/{}/chat", channel_name);

    // Close any existing fetch windows first
    for (label, window) in app.webview_windows() {
        if label.starts_with("identity-fetch-") {
            let _ = window.close();
        }
    }
    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;

    // Generate the scraper script
    let scraper_script = generate_badge_scraper_script();

    println!("[ChatIdentity] Creating hidden window for badge scraping...");

    // Create hidden window with initialization script
    let webview = WebviewWindowBuilder::new(
        &app,
        &window_label,
        WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {}", e))?),
    )
    .title("StreamNook - Fetching Badges")
    .inner_size(500.0, 600.0)
    .visible(false)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .skip_taskbar(true)
    .initialization_script(&scraper_script)
    .build()
    .map_err(|e| format!("Failed to create window: {}", e))?;

    println!("[ChatIdentity] Window created, script will auto-run when page loads");

    // Return immediately - the script will call receive_badge_data when done
    Ok(BadgeScrapeResult {
        success: true,
        message: "Badge fetching started...".to_string(),
        badges: vec![],
    })
}

/// Command called by the hidden window when badges are found
#[tauri::command]
pub async fn receive_badge_data(app: AppHandle, result: BadgeScrapeResult) -> Result<(), String> {
    println!(
        "[ChatIdentity] Received {} badges from scraper (success: {}, message: {})",
        result.badges.len(),
        result.success,
        result.message
    );

    // Emit to frontend
    let _ = app.emit("chat-identity-badges-found", &result);

    // Always close fetch windows (production mode)
    for (label, window) in app.webview_windows() {
        if label.starts_with("identity-fetch-") {
            println!("[ChatIdentity] Closing fetch window: {}", label);
            let _ = window.close();
        }
    }

    Ok(())
}

/// Update the selected chat identity badge
/// Tries fast GQL mutation first, falls back to browser automation if needed
#[tauri::command]
pub async fn update_chat_identity(
    app: AppHandle,
    channel_name: String,
    badge_id: String,
    badge_version: String,
) -> Result<BadgeUpdateResult, String> {
    println!(
        "[ChatIdentity] Setting badge '{}' (v{}) in channel {}",
        badge_id, badge_version, channel_name
    );

    // FAST PATH: Try GQL mutation first (requires drops auth)
    match try_gql_badge_update(&badge_id, &badge_version).await {
        Ok(true) => {
            // GQL succeeded! Emit success immediately and return
            println!("[ChatIdentity] ✅ Fast GQL update succeeded!");
            let result = BadgeUpdateResult {
                success: true,
                message: "Badge updated via GQL (instant)".to_string(),
                badge_id: badge_id.clone(),
            };
            let _ = app.emit("chat-identity-update-result", &result);
            return Ok(result);
        }
        Ok(false) => {
            // GQL not available or failed, fall through to browser automation
            println!("[ChatIdentity] GQL not available, using browser fallback...");
        }
        Err(e) => {
            // Actual error occurred, but we'll still try browser fallback
            println!("[ChatIdentity] GQL error: {}, using browser fallback...", e);
        }
    }

    // FALLBACK: Use browser automation (slower but works without drops auth)
    let window_label = format!("identity-update-{}", chrono::Utc::now().timestamp_millis());
    let url = format!("https://www.twitch.tv/popout/{}/chat", channel_name);

    // Close any existing update windows first
    for (label, window) in app.webview_windows() {
        if label.starts_with("identity-update-") {
            let _ = window.close();
        }
    }
    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;

    // Generate the update script
    let update_script = generate_badge_update_script(&badge_id, &badge_version);

    println!("[ChatIdentity] Creating hidden window for badge update (fallback)...");

    // Create hidden window with initialization script
    let _webview = WebviewWindowBuilder::new(
        &app,
        &window_label,
        WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {}", e))?),
    )
    .title("StreamNook - Updating Badge")
    .inner_size(500.0, 600.0)
    .visible(false)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .skip_taskbar(true)
    .initialization_script(&update_script)
    .build()
    .map_err(|e| format!("Failed to create window: {}", e))?;

    println!("[ChatIdentity] Window created, script will auto-run when page loads");

    Ok(BadgeUpdateResult {
        success: true,
        message: "Update started (browser)".to_string(),
        badge_id,
    })
}

/// Receive update result from the hidden window
#[tauri::command]
pub async fn receive_update_result(
    app: AppHandle,
    result: BadgeUpdateResult,
) -> Result<(), String> {
    println!(
        "[ChatIdentity] Update result: {} - {} (badge: {})",
        if result.success { "✅" } else { "❌" },
        result.message,
        result.badge_id
    );

    let _ = app.emit("chat-identity-update-result", &result);

    // Always close update windows (production mode)
    for (label, window) in app.webview_windows() {
        if label.starts_with("identity-update-") {
            println!("[ChatIdentity] Closing update window: {}", label);
            let _ = window.close();
        }
    }

    Ok(())
}
