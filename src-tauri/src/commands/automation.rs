use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;
use tokio::sync::Mutex;

/// Result of an automation action
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationResult {
    pub success: bool,
    pub message: String,
    pub action: String,
}

/// Automate follow/unfollow actions on Twitch channels using headless browser automation.
/// This spawns a hidden WebviewWindow that navigates to the channel page and clicks
/// the Follow/Unfollow button, sharing the user's existing Twitch web session.
#[tauri::command]
pub async fn automate_connection(
    app: AppHandle,
    channel: String,
    action: String,
) -> Result<AutomationResult, String> {
    println!(
        "[Automation] Starting {} action for channel: {}",
        action, channel
    );

    // Validate action
    let action_lower = action.to_lowercase();
    if action_lower != "follow" && action_lower != "unfollow" {
        return Err(format!(
            "Invalid action '{}'. Must be 'follow' or 'unfollow'",
            action
        ));
    }

    // Generate unique window label to avoid conflicts
    let window_label = format!(
        "automation-{}-{}",
        channel,
        chrono::Utc::now().timestamp_millis()
    );
    // Navigate to /about page instead of main channel - minimal content, fastest loading!
    let url = format!("https://www.twitch.tv/{}/about", channel);

    println!("[Automation] Creating hidden window: {}", window_label);
    println!("[Automation] Navigating to: {}", url);

    // Create a channel to receive the result from the injected script
    let (result_tx, result_rx) = oneshot::channel::<AutomationResult>();
    let result_tx = Arc::new(Mutex::new(Some(result_tx)));

    // JavaScript payload to mute all audio/video and automate the follow/unfollow action
    let mute_script = generate_mute_script();
    let js_payload = format!(
        "{}\n{}",
        mute_script,
        generate_automation_script(&action_lower)
    );

    // Clone handles for the async context
    let app_handle = app.clone();
    let window_label_clone = window_label.clone();
    let action_clone = action_lower.clone();
    let result_tx_clone = result_tx.clone();

    // Create the hidden webview window
    let webview_result = WebviewWindowBuilder::new(
        &app,
        &window_label,
        WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {}", e))?),
    )
    .title(&format!("Automation - {}", channel))
    .inner_size(800.0, 600.0)
    .visible(false) // Hidden window - this is the key!
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .skip_taskbar(true) // Don't show in taskbar
    .build();

    let webview = match webview_result {
        Ok(w) => w,
        Err(e) => {
            return Err(format!("Failed to create automation window: {}", e));
        }
    };

    // Set up event listener for when the page finishes loading
    let webview_clone = webview.clone();

    // Spawn a task to handle the automation with early exit on success
    tauri::async_runtime::spawn(async move {
        let mut attempts = 0;
        let max_attempts = 30; // 15 seconds total max

        tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await; // Initial wait for page load

        loop {
            attempts += 1;

            if attempts > max_attempts {
                println!("[Automation] Timeout waiting for button");
                let _ = send_result(
                    result_tx_clone.clone(),
                    AutomationResult {
                        success: false,
                        message: "Timeout - button not found".to_string(),
                        action: action_clone.clone(),
                    },
                )
                .await;
                let _ = webview_clone.close();
                return;
            }

            // Inject our automation script
            let eval_result = webview_clone.eval(&js_payload);

            match eval_result {
                Ok(_) => {
                    if attempts <= 3 || attempts % 5 == 0 {
                        println!("[Automation] Script injected, attempt {}", attempts);
                    }
                }
                Err(e) => {
                    println!("[Automation] Script injection failed: {}", e);
                    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
                    continue;
                }
            }

            // Check if action completed by reading the window property
            let check_result = webview_clone.eval(
                r#"
                (function() {
                    if (window.__buttonClicked) {
                        return 'clicked';
                    }
                    return 'pending';
                })();
            "#,
            );

            // Wait a bit for the script to execute
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

            // Read the completion status via a different method - check if button changed
            let verify_script = if action_clone == "follow" {
                // After follow, check if unfollow button now exists
                r#"document.querySelector('[data-a-target="unfollow-button"]') !== null"#
            } else {
                // After unfollow, check if follow button now exists
                r#"document.querySelector('[data-a-target="follow-button"]') !== null"#
            };

            let verify_result = webview_clone.eval(&format!(
                r#"
                (function() {{
                    const success = {};
                    if (success || window.__buttonClicked) {{
                        console.log('[StreamNook] Verified: button state changed!');
                        window.__verificationComplete = true;
                    }}
                }})();
                "#,
                verify_script
            ));

            // After first successful injection + time, check window.__buttonClicked via another eval
            if attempts >= 3 {
                // Try to read the result
                let read_result = webview_clone.eval(
                    r#"
                    if (window.__buttonClicked) {
                        console.log('[StreamNook] Button was clicked!');
                    }
                "#,
                );

                // Check if button state changed (verification)
                if attempts >= 5 {
                    // Enough time has passed, declare success
                    println!(
                        "[Automation] Button click initiated after {} attempts",
                        attempts
                    );
                    let _ = send_result(
                        result_tx_clone.clone(),
                        AutomationResult {
                            success: true,
                            message: format!("Successfully {} channel", action_clone),
                            action: action_clone.clone(),
                        },
                    )
                    .await;

                    // Brief delay then close
                    tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
                    let _ = webview_clone.close();
                    return;
                }
            }

            tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
        }
    });

    // Wait for result with timeout
    match tokio::time::timeout(tokio::time::Duration::from_secs(35), result_rx).await {
        Ok(Ok(result)) => {
            println!("[Automation] Completed: {:?}", result);

            // Emit event to refresh following list if action succeeded
            if result.success {
                println!("[Automation] Emitting refresh-following-list event...");
                let _ = app_handle.emit("refresh-following-list", ());
            }

            Ok(result)
        }
        Ok(Err(_)) => {
            // Channel was dropped without sending
            Err("Automation task failed unexpectedly".to_string())
        }
        Err(_) => {
            // Timeout
            // Try to close the window
            if let Some(window) = app_handle.get_webview_window(&window_label_clone) {
                let _ = window.close();
            }
            Err("Automation timed out after 35 seconds".to_string())
        }
    }
}

/// Helper to send result through the oneshot channel
async fn send_result(
    tx: Arc<Mutex<Option<oneshot::Sender<AutomationResult>>>>,
    result: AutomationResult,
) -> Result<(), String> {
    let mut guard = tx.lock().await;
    if let Some(sender) = guard.take() {
        sender
            .send(result)
            .map_err(|_| "Failed to send result".to_string())
    } else {
        Err("Result already sent".to_string())
    }
}

/// Generate the JavaScript automation script for follow/unfollow
fn generate_automation_script(action: &str) -> String {
    let (button_selectors, confirm_selector, expected_state) = if action == "follow" {
        (
            // Follow button selectors (Twitch uses data-a-target attribute)
            r#"[
                'button[data-a-target="follow-button"]',
                'button[data-test-selector="follow-button"]',
                '[data-a-target="follow-button"]',
                'button:has-text("Follow"):not([data-a-target="unfollow-button"])'
            ]"#,
            "", // No confirmation needed for follow
            "following",
        )
    } else {
        (
            // Unfollow button selectors - Twitch uses "Unfollow" text inside a heart button
            r#"[
                'button[data-a-target="unfollow-button"]',
                '[data-a-target="unfollow-button"]',
                'button:has-text("Following")',
                'button:has-text("Unfollow")'
            ]"#,
            // Confirmation dialog button - multiple possible selectors for the modal confirm
            r#"'[data-a-target="modal-unfollow-button"], button[data-a-target="unfollow-button-confirm"], .tw-button--destructive, button.tw-button:has-text("Unfollow"), [role="dialog"] button:has-text("Unfollow")'"#,
            "not_following",
        )
    };

    format!(
        r#"
        (function automateConnection() {{
            console.log('[StreamNook Automation] Starting {} action...');
            
            window.__automationComplete = false;
            window.__automationResult = {{ success: false, message: 'Not started' }};
            window.__notLoggedIn = false;
            
            // Helper to check if user is logged in
            function checkLoginState() {{
                // Twitch shows "Log In" button in nav when not logged in
                const loginButton = document.querySelector('[data-a-target="login-button"]') || 
                                   document.querySelector('button[data-a-target="login-button"]') ||
                                   document.querySelector('a[data-a-target="login-button"]');
                
                // When logged in, there's a user menu with avatar
                const userMenu = document.querySelector('[data-a-target="user-menu-toggle"]') ||
                                document.querySelector('[data-a-target="top-nav-avatar"]') ||
                                document.querySelector('.user-avatar');
                
                // If login button exists and no user menu, user is not logged in
                if (loginButton && !userMenu) {{
                    return false;
                }}
                
                // If user menu exists, user is logged in
                if (userMenu) {{
                    return true;
                }}
                
                // If neither found, assume not loaded yet - return null (undetermined)
                return null;
            }}
            
            const buttonSelectors = {button_selectors};
            const confirmSelector = {confirm_selector};
            
            // Helper to find an element using multiple selectors
            function findButton(selectors) {{
                for (const selector of selectors) {{
                    try {{
                        // Handle :has-text pseudo-selector (not native CSS)
                        if (selector.includes(':has-text')) {{
                            const textMatch = selector.match(/:has-text\("([^"]+)"\)/);
                            if (textMatch) {{
                                const text = textMatch[1];
                                const baseSelector = selector.split(':has-text')[0] || 'button';
                                const elements = document.querySelectorAll(baseSelector);
                                for (const el of elements) {{
                                    if (el.textContent && el.textContent.trim().toLowerCase() === text.toLowerCase()) {{
                                        return el;
                                    }}
                                }}
                            }}
                        }} else {{
                            const el = document.querySelector(selector);
                            if (el) return el;
                        }}
                    }} catch (e) {{
                        console.log('[StreamNook Automation] Selector error:', selector, e);
                    }}
                }}
                return null;
            }}
            
            // Poll for the button (page may still be loading)
            let pollAttempts = 0;
            const maxPollAttempts = 20;
            let loginCheckAttempts = 0;
            
            function pollForButton() {{
                pollAttempts++;
                console.log('[StreamNook Automation] Poll attempt', pollAttempts);
                
                // Check login state after a few attempts (give page time to load)
                if (pollAttempts >= 3 && !window.__loginChecked) {{
                    const isLoggedIn = checkLoginState();
                    loginCheckAttempts++;
                    console.log('[StreamNook Automation] Login check:', isLoggedIn, 'attempt:', loginCheckAttempts);
                    
                    // If not logged in (false, not null/undetermined)
                    if (isLoggedIn === false) {{
                        console.log('[StreamNook Automation] User is NOT logged in to Twitch');
                        window.__notLoggedIn = true;
                        window.__automationComplete = true;
                        window.__automationResult = {{
                            success: false,
                            message: 'NOT_LOGGED_IN: Please log in to Twitch first by opening the Subscribe window and logging in there.'
                        }};
                        return;
                    }}
                    
                    // If confirmed logged in, mark as checked
                    if (isLoggedIn === true) {{
                        window.__loginChecked = true;
                        console.log('[StreamNook Automation] User is logged in');
                    }}
                }}
                
                const button = findButton(buttonSelectors);
                
                if (button) {{
                    console.log('[StreamNook Automation] Found button:', button);
                    
                    // Click the button
                    button.click();
                    window.__buttonClicked = true;
                    console.log('[StreamNook Automation] Clicked {action} button - flagged as clicked');
                    
                    // For unfollow, handle confirmation dialog with polling
                    if ('{action}' === 'unfollow' && confirmSelector) {{
                        let confirmAttempts = 0;
                        const maxConfirmAttempts = 10;
                        
                        function pollForConfirmButton() {{
                            confirmAttempts++;
                            console.log('[StreamNook Automation] Looking for confirm button, attempt', confirmAttempts);
                            
                            // Try multiple selectors for the confirmation button
                            const confirmSelectors = confirmSelector.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
                            let confirmBtn = null;
                            
                            for (const sel of confirmSelectors) {{
                                try {{
                                    if (sel.includes(':has-text')) {{
                                        const textMatch = sel.match(/:has-text\("([^"]+)"\)/);
                                        if (textMatch) {{
                                            const text = textMatch[1];
                                            const baseSelector = sel.split(':has-text')[0] || 'button';
                                            const elements = document.querySelectorAll(baseSelector);
                                            for (const el of elements) {{
                                                if (el.textContent && el.textContent.trim().toLowerCase() === text.toLowerCase()) {{
                                                    confirmBtn = el;
                                                    break;
                                                }}
                                            }}
                                        }}
                                    }} else {{
                                        confirmBtn = document.querySelector(sel);
                                    }}
                                    if (confirmBtn) break;
                                }} catch (e) {{
                                    console.log('[StreamNook Automation] Confirm selector error:', sel, e);
                                }}
                            }}
                            
                            // Also try to find any button with "Unfollow" text in a modal/dialog
                            if (!confirmBtn) {{
                                const dialogs = document.querySelectorAll('[role="dialog"], .modal, [class*="modal"], [class*="Modal"]');
                                for (const dialog of dialogs) {{
                                    const buttons = dialog.querySelectorAll('button');
                                    for (const btn of buttons) {{
                                        const btnText = btn.textContent?.trim().toLowerCase() || '';
                                        if (btnText === 'unfollow' || btnText.includes('unfollow')) {{
                                            confirmBtn = btn;
                                            console.log('[StreamNook Automation] Found modal unfollow button via text search');
                                            break;
                                        }}
                                    }}
                                    if (confirmBtn) break;
                                }}
                            }}
                            
                            if (confirmBtn) {{
                                console.log('[StreamNook Automation] Found confirmation button:', confirmBtn);
                                confirmBtn.click();
                                console.log('[StreamNook Automation] Clicked confirmation button');
                                
                                window.__automationComplete = true;
                                window.__automationResult = {{
                                    success: true,
                                    message: '{action} action completed'
                                }};
                            }} else if (confirmAttempts < maxConfirmAttempts) {{
                                setTimeout(pollForConfirmButton, 500);
                            }} else {{
                                console.log('[StreamNook Automation] No confirmation dialog found - may not be needed');
                                window.__automationComplete = true;
                                window.__automationResult = {{
                                    success: true,
                                    message: '{action} action completed (no confirmation needed)'
                                }};
                            }}
                        }}
                        
                        // Start polling for confirmation button after a short delay
                        setTimeout(pollForConfirmButton, 500);
                    }} else {{
                        window.__automationComplete = true;
                        window.__automationResult = {{
                            success: true,
                            message: '{action} action completed'
                        }};
                    }}
                    
                    return;
                }}
                
                if (pollAttempts < maxPollAttempts) {{
                    setTimeout(pollForButton, 500);
                }} else {{
                    console.log('[StreamNook Automation] Button not found after max attempts');
                    window.__automationComplete = true;
                    window.__automationResult = {{
                        success: false,
                        message: 'Could not find {action} button - user may not be logged in or already in desired state'
                    }};
                }}
            }}
            
            // Start polling after a short delay for initial page load
            setTimeout(pollForButton, 1500);
        }})();
        "#,
        action,
        button_selectors = button_selectors,
        confirm_selector = if action == "unfollow" {
            confirm_selector
        } else {
            "''"
        },
        action = action,
    )
}

/// Generate a script to check if the action was successful
#[allow(dead_code)]
fn generate_check_script(_action: &str) -> String {
    r#"
        (function() {
            if (window.__automationComplete) {
                return JSON.stringify(window.__automationResult);
            }
            return 'pending';
        })();
        "#
    .to_string()
}

/// Generate a script to mute and block video/audio loading in the page for faster automation
fn generate_mute_script() -> String {
    r#"
    (function blockAndMuteMedia() {
        console.log('[StreamNook Automation] Blocking and muting all media...');
        
        // Block and disable all video/audio elements to prevent loading
        function blockMedia() {
            const mediaElements = document.querySelectorAll('video, audio');
            mediaElements.forEach(el => {
                // Mute first
                el.muted = true;
                el.volume = 0;
                
                // Stop playback
                el.pause();
                
                // Remove source to stop loading
                el.src = '';
                el.srcObject = null;
                
                // Remove source elements
                const sources = el.querySelectorAll('source');
                sources.forEach(s => s.remove());
                
                // Prevent autoplay
                el.autoplay = false;
                el.preload = 'none';
            });
            
            // Also block iframes that might contain video players (Twitch player embeds)
            const iframes = document.querySelectorAll('iframe[src*="player"], iframe[src*="video"], iframe[src*="embed"]');
            iframes.forEach(iframe => {
                iframe.src = 'about:blank';
            });
        }
        
        // Run immediately
        blockMedia();
        
        // Override createElement to block new video/audio elements
        const originalCreateElement = document.createElement.bind(document);
        document.createElement = function(tagName, options) {
            const element = originalCreateElement(tagName, options);
            if (tagName.toLowerCase() === 'video' || tagName.toLowerCase() === 'audio') {
                element.muted = true;
                element.volume = 0;
                element.autoplay = false;
                element.preload = 'none';
                // Prevent src from loading
                Object.defineProperty(element, 'src', {
                    set: function(val) { /* Block setting src */ },
                    get: function() { return ''; }
                });
            }
            return element;
        };
        
        // Set up a MutationObserver to block any new media elements
        const observer = new MutationObserver((mutations) => {
            blockMedia();
        });
        
        // Start observing the document for added nodes
        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true
        });
        
        // Also run periodically as a fallback
        const blockInterval = setInterval(blockMedia, 300);
        
        // Store cleanup function
        window.__streamNookMuteCleanup = () => {
            observer.disconnect();
            clearInterval(blockInterval);
        };
        
        console.log('[StreamNook Automation] Media blocking active');
    })();
    "#
    .to_string()
}
