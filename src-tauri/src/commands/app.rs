use crate::services::embedded_dashboard;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::env;
use std::sync::Mutex;
use tauri::command;
use tauri::window::Window;
use tauri::Manager;

// In-memory cache for emoji images (codepoint -> base64 data URL)
static EMOJI_CACHE: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));

// Compile-time admin IDs from .env or CI environment
// This is injected by build.rs reading from the .env file
const ADMIN_IDS: Option<&str> = option_env!("VITE_ADMIN_USER_ID");

#[command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[command]
pub fn get_app_name() -> String {
    env!("CARGO_PKG_NAME").to_string()
}

#[command]
pub fn get_app_description() -> String {
    env!("CARGO_PKG_DESCRIPTION").to_string()
}

#[command]
pub fn get_app_authors() -> String {
    env!("CARGO_PKG_AUTHORS").to_string()
}

#[command]
pub async fn get_window_size(window: Window) -> Result<(u32, u32), String> {
    let size = window.inner_size().map_err(|e| e.to_string())?;
    Ok((size.width, size.height))
}

#[command]
pub async fn calculate_aspect_ratio_size(
    current_width: u32,
    current_height: u32,
    chat_size: u32,
    chat_placement: String,
    title_bar_height: u32,
) -> Result<(u32, u32), String> {
    // Standard video aspect ratio (16:9)
    let video_aspect_ratio = 16.0 / 9.0;

    // For the new placement, calculate window size that maintains 16:9 video
    // The key insight: the VIDEO dimensions should drive the calculation
    // We want to find window size where video is 16:9, based on current window dimensions

    let (new_width, new_height) = match chat_placement.as_str() {
        "right" => {
            // Chat is on the right, so video width = total width - chat width
            let video_width = current_width.saturating_sub(chat_size);

            // Calculate ideal height for the video to maintain 16:9
            let ideal_video_height = (video_width as f64 / video_aspect_ratio) as u32;

            // Total window height = ideal video height + title bar
            let total_height = ideal_video_height + title_bar_height;

            (current_width, total_height)
        }
        "bottom" => {
            // Chat is on the bottom, so video height = total height - chat height - title bar
            let video_height = current_height
                .saturating_sub(chat_size)
                .saturating_sub(title_bar_height);

            // Calculate ideal width for the video to maintain 16:9
            let ideal_video_width = (video_height as f64 * video_aspect_ratio) as u32;

            // Total window width = ideal video width (video takes full width)
            // Total window height stays the same
            (ideal_video_width, current_height)
        }
        "hidden" => {
            // No chat, video takes full space
            // Keep width, adjust height for 16:9
            let video_width = current_width;
            let ideal_video_height = (video_width as f64 / video_aspect_ratio) as u32;
            let total_height = ideal_video_height + title_bar_height;

            (video_width, total_height)
        }
        _ => (current_width, current_height),
    };

    Ok((new_width, new_height))
}

/// Calculate window size to preserve video dimensions when chat placement changes
/// This version preserves the actual video pixel dimensions
#[command]
pub async fn calculate_aspect_ratio_size_preserve_video(
    current_width: u32,
    current_height: u32,
    old_chat_size: u32,
    new_chat_size: u32,
    old_chat_placement: String,
    new_chat_placement: String,
    title_bar_height: u32,
) -> Result<(u32, u32), String> {
    // First, calculate the current video dimensions based on old layout
    let (video_width, video_height) = match old_chat_placement.as_str() {
        "right" => {
            let vw = current_width.saturating_sub(old_chat_size);
            let vh = current_height.saturating_sub(title_bar_height);
            (vw, vh)
        }
        "bottom" => {
            let vw = current_width;
            let vh = current_height
                .saturating_sub(old_chat_size)
                .saturating_sub(title_bar_height);
            (vw, vh)
        }
        "hidden" => {
            let vw = current_width;
            let vh = current_height.saturating_sub(title_bar_height);
            (vw, vh)
        }
        _ => (
            current_width,
            current_height.saturating_sub(title_bar_height),
        ),
    };

    // Now calculate the new window size to preserve these video dimensions
    let (new_width, new_height) = match new_chat_placement.as_str() {
        "right" => {
            // Video on left, chat on right
            // Window width = video width + chat width
            // Window height = video height + title bar
            let total_width = video_width + new_chat_size;
            let total_height = video_height + title_bar_height;
            (total_width, total_height)
        }
        "bottom" => {
            // Video on top, chat on bottom
            // Window width = video width
            // Window height = video height + chat height + title bar
            let total_width = video_width;
            let total_height = video_height + new_chat_size + title_bar_height;
            (total_width, total_height)
        }
        "hidden" => {
            // Just video, no chat
            // Window width = video width
            // Window height = video height + title bar
            let total_width = video_width;
            let total_height = video_height + title_bar_height;
            (total_width, total_height)
        }
        _ => (current_width, current_height),
    };

    Ok((new_width, new_height))
}

#[command]
pub fn get_system_info() -> String {
    let os = env::consts::OS;
    let arch = env::consts::ARCH;
    let family = env::consts::FAMILY;

    format!("{} {} ({})", os, arch, family)
}

#[command]
pub async fn is_dev_environment(_app_handle: tauri::AppHandle) -> Result<bool, String> {
    // First check if we have an embedded dashboard (production mode)
    // If embedded dashboard exists, we're NOT in dev mode
    if embedded_dashboard::has_embedded_dashboard() {
        println!("[App] Embedded dashboard detected - not in dev mode");
        return Ok(false);
    }

    // Check for development environment - must have source AND node_modules
    let current_dir = std::env::current_dir().map_err(|e| e.to_string())?;

    // Logic to find project root from potential src-tauri subdir
    let project_root = if current_dir.ends_with("src-tauri") {
        current_dir
            .parent()
            .ok_or("Failed to get parent dir of src-tauri")?
            .to_path_buf()
    } else {
        current_dir
    };

    let dashboard_path = project_root.join("analytics-dashboard");

    // Only consider it dev mode if we have:
    // 1. The analytics-dashboard source folder
    // 2. A package.json (indicating it's a proper project)
    // 3. node_modules (indicating dependencies are installed)
    let is_dev = dashboard_path.exists()
        && dashboard_path.join("package.json").exists()
        && dashboard_path.join("node_modules").exists();

    println!(
        "[App] Dev environment check: {} (path: {:?})",
        is_dev, dashboard_path
    );
    Ok(is_dev)
}

/// Internal function to check if the current user is an admin
async fn is_admin() -> bool {
    use crate::services::twitch_service::TwitchService;

    // Log the admin IDs we have configured (at compile time)
    println!("[App] Admin IDs configured: {:?}", ADMIN_IDS);

    // Check if we have admin IDs configured
    let admin_ids_str = match ADMIN_IDS {
        Some(ids) if !ids.is_empty() => ids,
        _ => {
            println!("[App] No admin IDs configured - admin check failed");
            return false;
        }
    };

    // Verify token health and get user ID
    match TwitchService::verify_token_health().await {
        Ok(status) => {
            if status.is_valid {
                if let Some(user_id) = &status.user_id {
                    println!(
                        "[App] Current user ID: {}, checking against admin list: {}",
                        user_id, admin_ids_str
                    );
                    // Check if user ID is in the comma-separated list
                    let is_match = admin_ids_str.split(',').any(|id| id.trim() == user_id);
                    println!("[App] Admin check result: {}", is_match);
                    return is_match;
                } else {
                    println!("[App] Token valid but no user_id in status");
                }
            } else {
                println!("[App] Token not valid: {:?}", status.error);
            }
        }
        Err(e) => {
            println!("[App] Token health check error: {}", e);
        }
    }

    false
}

#[command]
pub async fn is_admin_user() -> Result<bool, String> {
    let result = is_admin().await;
    println!("[App] is_admin_user command result: {}", result);
    Ok(result)
}

/// Check if the analytics dashboard is available (either embedded or dev mode)
#[command]
pub async fn check_dashboard_available(app_handle: tauri::AppHandle) -> Result<bool, String> {
    // Check for embedded dashboard first
    if embedded_dashboard::has_embedded_dashboard() {
        println!("[App] Dashboard available: embedded");
        return Ok(true);
    }

    // Check for dev mode
    let is_dev = is_dev_environment(app_handle).await?;
    if is_dev {
        println!("[App] Dashboard available: dev mode");
        return Ok(true);
    }

    println!("[App] Dashboard NOT available");
    Ok(false)
}

/// Check if the dashboard server is currently running
#[command]
pub fn is_dashboard_running() -> Result<bool, String> {
    use std::net::TcpStream;
    let running = TcpStream::connect("127.0.0.1:5173").is_ok();
    println!("[App] Dashboard server running: {}", running);
    Ok(running)
}

/// Auto-start dashboard if user is an admin (called after login)
#[command]
pub async fn auto_start_dashboard_for_admin(app_handle: tauri::AppHandle) -> Result<bool, String> {
    // Check if user is admin
    if !is_admin().await {
        println!("[App] Not an admin user - skipping auto-start");
        return Ok(false);
    }

    println!("[App] Admin user detected - auto-starting analytics dashboard");

    // Check if dashboard is available
    let available = check_dashboard_available(app_handle.clone()).await?;
    if !available {
        println!("[App] Dashboard not available - cannot auto-start");
        return Ok(false);
    }

    // Start the dashboard
    match start_analytics_dashboard(app_handle).await {
        Ok(_) => {
            println!("[App] Analytics dashboard auto-started successfully");
            Ok(true)
        }
        Err(e) => {
            println!("[App] Failed to auto-start analytics dashboard: {}", e);
            Ok(false)
        }
    }
}

#[command]
pub async fn start_analytics_dashboard(app_handle: tauri::AppHandle) -> Result<bool, String> {
    use std::net::TcpStream;
    use std::process::{Command, Stdio};

    println!("[App] start_analytics_dashboard called");

    // 1. Check if already running on port 5173
    if TcpStream::connect("127.0.0.1:5173").is_ok() {
        println!("[App] Dashboard already running on port 5173");
        return Ok(true);
    }

    // Check permissions: either dev environment OR admin user
    let is_dev = is_dev_environment(app_handle.clone()).await?;
    let is_admin_user = is_admin().await;

    println!(
        "[App] Permission check - isDev: {}, isAdmin: {}",
        is_dev, is_admin_user
    );

    if !is_dev && !is_admin_user {
        return Err(
            "Unauthorized: Only admins can access the dashboard in release mode.".to_string(),
        );
    }

    // 2. First, check for embedded dashboard (compiled into exe)
    // This is the preferred way for released app (even for admins)
    if embedded_dashboard::has_embedded_dashboard() {
        println!("[App] Starting embedded dashboard server...");
        embedded_dashboard::start_embedded_dashboard().await?;
        println!("[App] Embedded dashboard server started successfully");
        return Ok(false);
    }

    // 3. Fall back to development mode (source code with node_modules)
    // This is for local dev or if embedded is missing but source is present
    let current_dir = std::env::current_dir().map_err(|e| e.to_string())?;
    let project_root = if current_dir.ends_with("src-tauri") {
        current_dir
            .parent()
            .ok_or("Failed to get parent dir of src-tauri")?
            .to_path_buf()
    } else {
        current_dir.clone()
    };

    let dev_path = project_root.join("analytics-dashboard");

    // Development mode: Use npm run dev (requires source + node_modules)
    if dev_path.exists()
        && dev_path.join("package.json").exists()
        && dev_path.join("node_modules").exists()
    {
        println!("[App] Starting dashboard in dev mode from: {:?}", dev_path);

        #[cfg(target_os = "windows")]
        {
            Command::new("cmd")
                .args(["/C", "npm", "run", "dev"])
                .current_dir(&dev_path)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("Failed to start dashboard in dev mode: {}", e))?;
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        println!("[App] Dev mode dashboard started");
        return Ok(false);
    }

    // No dashboard available
    Err(
        "Analytics dashboard not available. In development, run 'npm install' in analytics-dashboard folder."
            .to_string(),
    )
}

/// Fetch an emoji image from CDN and return as base64 data URL
/// This bypasses the browser's tracking prevention by using Tauri's HTTP client
#[command]
pub async fn get_emoji_image(codepoint: String) -> Result<String, String> {
    // Check cache first
    {
        let cache = EMOJI_CACHE.lock().map_err(|e| e.to_string())?;
        if let Some(data_url) = cache.get(&codepoint) {
            return Ok(data_url.clone());
        }
    }

    // Construct the CDN URL
    let url = format!(
        "https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64/{}.png",
        codepoint
    );

    // Fetch the image using reqwest
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to fetch emoji: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Failed to fetch emoji: HTTP {}", response.status()));
    }

    // Get the image bytes
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read emoji bytes: {}", e))?;

    // Convert to base64 data URL
    use base64::{engine::general_purpose::STANDARD, Engine};
    let base64_data = STANDARD.encode(&bytes);
    let data_url = format!("data:image/png;base64,{}", base64_data);

    // Cache the result
    {
        let mut cache = EMOJI_CACHE.lock().map_err(|e| e.to_string())?;
        cache.insert(codepoint, data_url.clone());
    }

    Ok(data_url)
}
