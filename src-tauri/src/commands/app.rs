use tauri::{command, AppHandle, Manager};
use tauri::window::Window;

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
            let video_height = current_height.saturating_sub(title_bar_height);
            
            // Calculate ideal height for the video to maintain 16:9
            let ideal_video_height = (video_width as f64 / video_aspect_ratio) as u32;
            
            // Total window height = ideal video height + title bar
            let total_height = ideal_video_height + title_bar_height;
            
            (current_width, total_height)
        }
        "bottom" => {
            // Chat is on the bottom, so video height = total height - chat height - title bar
            let video_height = current_height.saturating_sub(chat_size).saturating_sub(title_bar_height);
            let video_width = current_width;
            
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
