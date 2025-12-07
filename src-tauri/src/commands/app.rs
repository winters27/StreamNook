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
pub async fn is_dev_environment() -> Result<bool, String> {
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

    let path = project_root.join("analytics-dashboard");
    Ok(path.exists())
}

#[command]
pub async fn start_analytics_dashboard(app_handle: tauri::AppHandle) -> Result<bool, String> {
    use std::net::TcpStream;
    use std::process::{Command, Stdio};

    // 1. Check if already running on port 5173
    if TcpStream::connect("127.0.0.1:5173").is_ok() {
        return Ok(true);
    }

    // 2. Check if we're in development mode (analytics-dashboard source exists)
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

    // Development mode: Use npm run dev
    if dev_path.exists() && dev_path.join("package.json").exists() {
        #[cfg(target_os = "windows")]
        {
            Command::new("cmd")
                .args(["/C", "npm", "run", "dev"])
                .current_dir(&dev_path)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("Failed to start dashboard: {}", e))?;
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        return Ok(false);
    }

    // Production mode: Serve from bundled dist folder
    let resource_path = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;

    let dist_path = resource_path.join("analytics-dashboard");

    if !dist_path.exists() {
        return Err(format!(
            "Analytics dashboard not found. Expected at {:?}",
            dist_path
        ));
    }

    // Use a simple static file server for production
    // We'll use Python's http.server if available, or serve via npx serve
    #[cfg(target_os = "windows")]
    {
        // Try npx serve first (more reliable for SPA)
        let npx_result = Command::new("cmd")
            .args([
                "/C",
                "npx",
                "serve",
                "-s",
                "-p",
                "5173",
                dist_path.to_str().unwrap_or("."),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();

        match npx_result {
            Ok(_) => {
                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                return Ok(false);
            }
            Err(_) => {
                // Fallback: Try Python http.server
                let python_result = Command::new("cmd")
                    .args(["/C", "python", "-m", "http.server", "5173"])
                    .current_dir(&dist_path)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn();

                match python_result {
                    Ok(_) => {
                        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                        return Ok(false);
                    }
                    Err(e) => {
                        return Err(format!(
                            "Failed to start static file server. Please ensure 'npx' or 'python' is available. Error: {}",
                            e
                        ));
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        return Err(
            "Analytics dashboard is only supported on Windows in production mode".to_string(),
        );
    }
}
