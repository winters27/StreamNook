use log::debug;
use lru::LruCache;
use once_cell::sync::Lazy;
use std::env;
use std::num::NonZeroUsize;
use std::sync::Mutex;
use tauri::command;
use tauri::window::Window;
use tauri::Manager;

// In-memory cache for emoji images (codepoint -> base64 data URL).
// LRU-bounded at 256 entries (~5 KB per entry → ~1.3 MB cap). Twitch chat uses
// emojis sparingly; in practice this rarely fills. Cap exists so an edge-case
// emoji-heavy session can't pin 15-20 MB of base64 data indefinitely.
const EMOJI_CACHE_CAP: usize = 256;
static EMOJI_CACHE: Lazy<Mutex<LruCache<String, String>>> = Lazy::new(|| {
    Mutex::new(LruCache::new(
        NonZeroUsize::new(EMOJI_CACHE_CAP).expect("cap > 0"),
    ))
});

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

/// Fetch latest FX rates from frankfurter.app (ECB data, free, no key) for the
/// Super Chat currency converter. Done in Rust because a browser fetch from the web
/// origin is CORS-blocked (the API sends no Access-Control-Allow-Origin). Returns the
/// rates map; the API omits the base currency, so the caller treats it as 1.0.
#[command]
pub async fn fetch_exchange_rates(
    base: String,
) -> Result<std::collections::HashMap<String, f64>, String> {
    let base = base.to_uppercase();
    if base.len() != 3 || !base.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err("invalid base currency".to_string());
    }
    let url = format!("https://api.frankfurter.app/latest?base={}", base);
    let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let rates = json
        .get("rates")
        .and_then(|r| r.as_object())
        .ok_or_else(|| "no rates in response".to_string())?;
    let mut map = std::collections::HashMap::new();
    for (k, v) in rates {
        if let Some(n) = v.as_f64() {
            map.insert(k.clone(), n);
        }
    }
    Ok(map)
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
    target_aspect_ratio: Option<f64>,
    ui_width_offset: Option<u32>,
    ui_height_offset: Option<u32>,
) -> Result<(u32, u32), String> {
    // Default to standard video aspect ratio (16:9) if not provided
    let video_aspect_ratio = target_aspect_ratio.unwrap_or(16.0 / 9.0);
    let extra_w = ui_width_offset.unwrap_or(0);
    let extra_h = ui_height_offset.unwrap_or(0);

    // The old logic rigidly locked width when chat was horizontal, and locked height when chat was vertical.
    // This provides exact 1-to-1 tracking when dragging the chat slider, instead of a dynamic 2D bounding box
    // which caused the window to shrink unexpectedly.

    let (new_width, new_height) = match chat_placement.as_str() {
        "right" | "left" => {
            // Keep window width strictly locked, recalculate height to match.
            // Video width = total width - chat size - extra width
            let video_width = current_width
                .saturating_sub(chat_size)
                .saturating_sub(extra_w);

            // Ideal video height = video width / aspect ratio
            let ideal_video_height = (video_width as f64 / video_aspect_ratio) as u32;

            // Total height = ideal video height + title bar + extra height
            let total_height = ideal_video_height + title_bar_height + extra_h;

            (current_width, total_height)
        }
        "bottom" => {
            // Keep window height strictly locked, recalculate width to match.
            // Video height = total height - chat size - title bar - extra height
            let video_height = current_height
                .saturating_sub(chat_size)
                .saturating_sub(title_bar_height)
                .saturating_sub(extra_h);

            // Ideal video width = video height * aspect ratio
            let ideal_video_width = (video_height as f64 * video_aspect_ratio) as u32;

            // Total width = ideal video width + extra width
            let total_width = ideal_video_width + extra_w;

            (total_width, current_height)
        }
        "hidden" => {
            // No chat. Keep width rigidly locked, recalculate height.
            let video_width = current_width.saturating_sub(extra_w);
            let ideal_video_height = (video_width as f64 / video_aspect_ratio) as u32;
            let total_height = ideal_video_height + title_bar_height + extra_h;

            (current_width, total_height)
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
    _target_aspect_ratio: Option<f64>, // Included for signature consistency, though this specifically preserves pixel dimensions
    ui_width_offset: Option<u32>,
    ui_height_offset: Option<u32>,
) -> Result<(u32, u32), String> {
    let extra_w = ui_width_offset.unwrap_or(0);
    let extra_h = ui_height_offset.unwrap_or(0);

    // First, calculate the current video dimensions based on old layout
    let (video_width, video_height) = match old_chat_placement.as_str() {
        "right" | "left" => {
            let vw = current_width
                .saturating_sub(old_chat_size)
                .saturating_sub(extra_w);
            let vh = current_height
                .saturating_sub(title_bar_height)
                .saturating_sub(extra_h);
            (vw, vh)
        }
        "bottom" => {
            let vw = current_width.saturating_sub(extra_w);
            let vh = current_height
                .saturating_sub(old_chat_size)
                .saturating_sub(title_bar_height)
                .saturating_sub(extra_h);
            (vw, vh)
        }
        "hidden" => {
            let vw = current_width.saturating_sub(extra_w);
            let vh = current_height
                .saturating_sub(title_bar_height)
                .saturating_sub(extra_h);
            (vw, vh)
        }
        _ => (
            current_width.saturating_sub(extra_w),
            current_height
                .saturating_sub(title_bar_height)
                .saturating_sub(extra_h),
        ),
    };

    // Now calculate the new window size to preserve these video dimensions
    let (new_width, new_height) = match new_chat_placement.as_str() {
        "right" | "left" => {
            // Video on left, chat on right
            // Window width = video width + chat width
            // Window height = video height + title bar
            let total_width = video_width + new_chat_size + extra_w;
            let total_height = video_height + title_bar_height + extra_h;
            (total_width, total_height)
        }
        "bottom" => {
            // Video on top, chat on bottom
            // Window width = video width
            // Window height = video height + chat height + title bar
            let total_width = video_width + extra_w;
            let total_height = video_height + new_chat_size + title_bar_height + extra_h;
            (total_width, total_height)
        }
        "hidden" => {
            // Just video, no chat
            // Window width = video width
            // Window height = video height + title bar
            let total_width = video_width + extra_w;
            let total_height = video_height + title_bar_height + extra_h;
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

/// Fetch an emoji image from CDN and return as base64 data URL
/// This bypasses the browser's tracking prevention by using Tauri's HTTP client
#[command]
pub async fn get_emoji_image(codepoint: String) -> Result<String, String> {
    // Check cache first. `LruCache::get` takes &mut self because it bumps the
    // entry to most-recently-used — so the lock has to be a mutable borrow.
    {
        let mut cache = EMOJI_CACHE.lock().map_err(|e| e.to_string())?;
        if let Some(data_url) = cache.get(&codepoint) {
            return Ok(data_url.clone());
        }
    }

    // emoji-datasource-apple names some older text-default symbols (clock, dove,
    // heart, etc.) WITH the -fe0f variation selector in the filename, which our
    // codepoint strips. Try the bare codepoint first, then the -fe0f variant, so
    // those emojis cache instead of 404ing into a permanent blank.
    let base = "https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64";
    let candidates = [
        format!("{}/{}.png", base, codepoint),
        format!("{}/{}-fe0f.png", base, codepoint),
    ];

    let mut last_err = String::from("Failed to fetch emoji: no candidate URLs");
    for url in &candidates {
        let response = match reqwest::get(url).await {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("Failed to fetch emoji: {}", e);
                continue;
            }
        };

        if !response.status().is_success() {
            last_err = format!("Failed to fetch emoji: HTTP {}", response.status());
            continue;
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("Failed to read emoji bytes: {}", e))?;

        // Convert to base64 data URL
        use base64::{engine::general_purpose::STANDARD, Engine};
        let base64_data = STANDARD.encode(&bytes);
        let data_url = format!("data:image/png;base64,{}", base64_data);

        // Cache the result. `put` returns the previous value if any; we ignore it.
        {
            let mut cache = EMOJI_CACHE.lock().map_err(|e| e.to_string())?;
            cache.put(codepoint.clone(), data_url.clone());
        }

        return Ok(data_url);
    }

    Err(last_err)
}
