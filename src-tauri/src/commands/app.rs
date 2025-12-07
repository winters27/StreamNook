use crate::services::embedded_dashboard;
use std::env;
use tauri::command;
use tauri::window::Window;
use tauri::Manager;

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

    let (new_width, new_height) = match chat_placement.as_str() {
        "right" => {
            // Chat is on the right, so video width = total width - chat width
            let video_width = current_width.saturating_sub(chat_size);
            let _video_height = current_height.saturating_sub(title_bar_height);

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
            let _video_width = current_width;

            // Calculate ideal width for the video to maintain 16:9
            let ideal_video_width = (video_height as f64 * video_aspect_ratio) as u32;

            (ideal_video_width, current_height)
        }
        "hidden" => {
            // No chat, just maintain video aspect ratio
            let video_height = current_height.saturating_sub(title_bar_height);
            let ideal_video_width = (video_height as f64 * video_aspect_ratio) as u32;

            (ideal_video_width, current_height)
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

    Ok(is_dev)
}

#[command]
pub async fn start_analytics_dashboard(_app_handle: tauri::AppHandle) -> Result<bool, String> {
    use std::net::TcpStream;
    use std::process::{Command, Stdio};

    // 1. Check if already running on port 5173
    if TcpStream::connect("127.0.0.1:5173").is_ok() {
        return Ok(true);
    }

    // 2. First, check for embedded dashboard (compiled into exe)
    if embedded_dashboard::has_embedded_dashboard() {
        embedded_dashboard::start_embedded_dashboard().await?;
        return Ok(false);
    }

    // 3. Fall back to development mode (source code with node_modules)
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
        return Ok(false);
    }

    // No dashboard available
    Err(
        "Analytics dashboard not available. In development, run 'npm install' in analytics-dashboard folder."
            .to_string(),
    )
}
