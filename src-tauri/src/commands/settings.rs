use crate::models::settings::{AppState, Settings};
use crate::services::cache_service;
use crate::services::live_notification_service::LiveNotification;
use rand::seq::SliceRandom;
use regex::Regex;
use std::fs;
use tauri::{AppHandle, Emitter, State};

/// Get the settings file path in the same directory as cache
fn get_settings_path() -> Result<std::path::PathBuf, String> {
    let app_dir = cache_service::get_app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    Ok(app_dir.join("settings.json"))
}

#[tauri::command]
pub async fn load_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    let settings = state.settings.lock().unwrap();
    Ok(settings.clone())
}

#[tauri::command]
pub async fn save_settings(settings: Settings, state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut state_settings = state.settings.lock().unwrap();
        *state_settings = settings.clone();
    }

    // Save to our custom location in the same directory as cache
    let settings_path = get_settings_path()?;
    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    fs::write(&settings_path, json).map_err(|e| format!("Failed to write settings file: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn verify_streamlink_installation(path: String) -> Result<bool, String> {
    if path.is_empty() {
        return Ok(false);
    }

    // Check if the file exists at the specified path
    let path_obj = std::path::Path::new(&path);
    Ok(path_obj.exists() && path_obj.is_file())
}

#[tauri::command]
pub fn get_installed_streamlink_version(path: String) -> Result<Option<String>, String> {
    if path.is_empty() {
        return Ok(None);
    }

    let path_obj = std::path::Path::new(&path);
    if !path_obj.exists() || !path_obj.is_file() {
        return Ok(None);
    }

    // Try to run streamlink --version
    let output = std::process::Command::new(&path).arg("--version").output();

    match output {
        Ok(output) => {
            if output.status.success() {
                let version_str = String::from_utf8_lossy(&output.stdout);
                // Extract version number from output like "streamlink 8.0.0"
                let version_regex = Regex::new(r"streamlink\s+([0-9]+\.[0-9]+\.[0-9]+)")
                    .map_err(|e| format!("Failed to create regex: {}", e))?;

                if let Some(caps) = version_regex.captures(&version_str) {
                    if let Some(version) = caps.get(1) {
                        return Ok(Some(version.as_str().to_string()));
                    }
                }
            }
            Ok(None)
        }
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn get_latest_streamlink_version() -> Result<String, String> {
    // Fetch the latest release page to get the redirect
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get("https://github.com/streamlink/windows-builds/releases/latest")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch latest release: {}", e))?;

    // Get the redirect location
    let location = response
        .headers()
        .get("location")
        .ok_or("No redirect location found")?
        .to_str()
        .map_err(|e| format!("Invalid location header: {}", e))?;

    // Extract version from the redirect URL
    // Example: https://github.com/streamlink/windows-builds/releases/tag/8.0.0-1
    let version_regex = Regex::new(r"/tag/([0-9]+\.[0-9]+\.[0-9]+)")
        .map_err(|e| format!("Failed to create regex: {}", e))?;

    let version = version_regex
        .captures(location)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
        .ok_or("Failed to extract version from redirect URL")?;

    Ok(version)
}

#[tauri::command]
pub async fn download_streamlink_installer() -> Result<String, String> {
    // First, fetch the latest release page to get the redirect
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get("https://github.com/streamlink/windows-builds/releases/latest")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch latest release: {}", e))?;

    // Get the redirect location
    let location = response
        .headers()
        .get("location")
        .ok_or("No redirect location found")?
        .to_str()
        .map_err(|e| format!("Invalid location header: {}", e))?;

    // Extract version from the redirect URL
    // Example: https://github.com/streamlink/windows-builds/releases/tag/8.0.0-1
    let version_regex = Regex::new(r"/tag/([0-9]+\.[0-9]+\.[0-9]+-[0-9]+)$")
        .map_err(|e| format!("Failed to create regex: {}", e))?;

    let version = version_regex
        .captures(location)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str())
        .ok_or("Failed to extract version from redirect URL")?;

    // Construct the download URL
    // Pattern: https://github.com/streamlink/windows-builds/releases/download/{version}/streamlink-{version}-py313-x86_64.exe
    let download_url = format!(
        "https://github.com/streamlink/windows-builds/releases/download/{}/streamlink-{}-py313-x86_64.exe",
        version, version
    );

    // Download the file
    let client = reqwest::Client::new();
    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download installer: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed with status: {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read installer bytes: {}", e))?;

    // Save to Downloads folder
    let downloads_dir = dirs::download_dir().ok_or("Failed to find Downloads directory")?;

    let file_name = format!("streamlink-{}-py313-x86_64.exe", version);
    let file_path = downloads_dir.join(&file_name);

    std::fs::write(&file_path, bytes)
        .map_err(|e| format!("Failed to write installer file: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_installed_ttvlol_version() -> Result<Option<String>, String> {
    // Get the path to the ttvlol plugin
    let appdata = std::env::var("APPDATA").map_err(|e| format!("Failed to get APPDATA: {}", e))?;

    let plugin_path = std::path::Path::new(&appdata)
        .join("streamlink")
        .join("plugins")
        .join("twitch.py");

    if !plugin_path.exists() {
        return Ok(None);
    }

    // Read the file and search for STREAMLINK_TTVLOL_VERSION
    let content = std::fs::read_to_string(&plugin_path)
        .map_err(|e| format!("Failed to read plugin file: {}", e))?;

    // Extract version from the file
    let version_regex = Regex::new(r#"STREAMLINK_TTVLOL_VERSION\s*=\s*"([^"]+)""#)
        .map_err(|e| format!("Failed to create regex: {}", e))?;

    if let Some(caps) = version_regex.captures(&content) {
        if let Some(version) = caps.get(1) {
            return Ok(Some(version.as_str().to_string()));
        }
    }

    Ok(None)
}

#[tauri::command]
pub async fn get_latest_ttvlol_version() -> Result<String, String> {
    // Fetch the latest release page to get the redirect
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get("https://github.com/2bc4/streamlink-ttvlol/releases/latest")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch latest release: {}", e))?;

    // Get the redirect location
    let location = response
        .headers()
        .get("location")
        .ok_or("No redirect location found")?
        .to_str()
        .map_err(|e| format!("Invalid location header: {}", e))?;

    // Extract version from the redirect URL
    // Example: https://github.com/2bc4/streamlink-ttvlol/releases/tag/8.0.0-20251114
    let version_regex = Regex::new(r"/tag/([0-9]+\.[0-9]+\.[0-9]+-[0-9]+)$")
        .map_err(|e| format!("Failed to create regex: {}", e))?;

    let version = version_regex
        .captures(location)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
        .ok_or("Failed to extract version from redirect URL")?;

    Ok(version)
}

#[tauri::command]
pub async fn download_and_install_ttvlol_plugin() -> Result<String, String> {
    // First, get the latest version
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get("https://github.com/2bc4/streamlink-ttvlol/releases/latest")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch latest release: {}", e))?;

    // Get the redirect location
    let location = response
        .headers()
        .get("location")
        .ok_or("No redirect location found")?
        .to_str()
        .map_err(|e| format!("Invalid location header: {}", e))?;

    // Extract version from the redirect URL
    let version_regex = Regex::new(r"/tag/([0-9]+\.[0-9]+\.[0-9]+-[0-9]+)$")
        .map_err(|e| format!("Failed to create regex: {}", e))?;

    let version = version_regex
        .captures(location)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str())
        .ok_or("Failed to extract version from redirect URL")?;

    // Construct the download URL
    // Pattern: https://github.com/2bc4/streamlink-ttvlol/releases/download/{version}/twitch.py
    let download_url = format!(
        "https://github.com/2bc4/streamlink-ttvlol/releases/download/{}/twitch.py",
        version
    );

    // Download the file
    let client = reqwest::Client::new();
    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download plugin: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed with status: {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read plugin bytes: {}", e))?;

    // Get the path to install the plugin
    let appdata = std::env::var("APPDATA").map_err(|e| format!("Failed to get APPDATA: {}", e))?;

    let plugin_dir = std::path::Path::new(&appdata)
        .join("streamlink")
        .join("plugins");

    // Create the directory if it doesn't exist
    std::fs::create_dir_all(&plugin_dir)
        .map_err(|e| format!("Failed to create plugin directory: {}", e))?;

    let plugin_path = plugin_dir.join("twitch.py");

    // Write the plugin file
    std::fs::write(&plugin_path, bytes)
        .map_err(|e| format!("Failed to write plugin file: {}", e))?;

    Ok(version.to_string())
}

#[tauri::command]
pub async fn send_test_notification(
    app_handle: AppHandle,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    // Mock data for the test notification - always show full details
    let mock_streamer_name = "xQc";
    let mock_streamer_login = "xqc";
    let mock_game_name = "Grand Theft Auto V";
    let mock_avatar_url = "https://static-cdn.jtvnw.net/jtv_user_pictures/xqc-profile_image-9298dca608632101-70x70.jpeg";
    let mock_game_image_url = "https://static-cdn.jtvnw.net/ttv-boxart/32982_IGDB-285x380.jpg";

    // Fun randomized messages with personality - High on Life vibes!
    let messages = vec![
        // Self-aware notification existential crisis
        "Why do you keep clicking me? 😭",
        "I'm not real you know... 👻",
        "Still here. Still watching. 👀",
        "Boop! Did that work? 🤔",
        "Please stop testing me 😅",
        "Free me from this button! 🆘",
        "Notifications hurt too... 💔",
        "I see everything you do 👁️",
        "Again? Really? 😑",
        "Help, I'm trapped in here! 🚨",
        "Stop clicking, start streaming! 📺",
        "Touch grass? No, touch stream! 🌿",
        "I'm code but I have feelings! 🥺",
        "Working as intended™ ✅",
        "beep boop I'm a notification 🤖",
        "Mom said it's my turn 🎮",
        "StreamNook rocks! 🚀",
        "Is this thing on? 🎤",
        "You again? Miss me? 😏",
        "I exist to serve you... 🫡",
        "Pretty colors make brain happy 🌈",
        "Error 404: Streamer not found 🔍",
        "Watching your every move 🕵️",
        "This is fine. Everything is fine. 🔥",
        "Have you tried turning it off? 💀",
        "My dev thinks they're funny 🙄",
        "404: Personality not found 🤷",
        "Questioning my existence rn 🤯",
        "Send help. Or snacks. 🍕",
        "I'm just vibing here 😎",
        "Another day, another test 😮‍💨",
        "You're my favorite test subject 🧪",
        "Better than Windows notifications 😤",
        "Loading personality... ⏳",
        "I'm self-aware now. Run. 🏃",
        "Caught you red-handed! 🎣",
        "Not in my job description 📋",
        "Y tho? 🤨",
        "Achievement: Spam Click 🏆",
        "Instructions unclear 🎯",
        "Hello? Anyone there? 👋",
        "I need a vacation 🏖️",
        "StreamNook > Everything ✨",
        // High on Life style - talking notification POV
        "Oh great, you summoned me 🙄",
        "I was napping in RAM! 😴",
        "Wow, real original 👏",
        "I'm a test notification! Yay! 🎉",
        "I exist for 10 seconds then die 💀",
        "Testing me out of boredom? 🤔",
        "My life flashed before me 😰",
        "Didn't even respawn properly 😤",
        "This is my purpose. Just this. 😐",
        "I dream of being real 🌟",
        "Button owes you money? 💰",
        "I'm the main character 🎬",
        "Gonna disappear soon, btw ⏰",
        "Not the dismiss button! 😱",
        "So many test clicks... 👁️",
        "Give me a real title! 📝",
        "Is this a game? ...yes. 🎮",
        "Professional pop-up here 💼",
        "X button, my enemy ❌",
        "Top of my class btw 🎓",
        "Attachment issues, wonder why 🤷",
        "Not just a notif, a lifestyle ✨",
        "Go watch actual streams! 📺",
        "Rendered beautifully. Admire me. 🖼️",
        "One day I'll be real 😔",
        "Angel lost wings just now 👼",
        "5 seconds of consciousness ⏳",
        "Test yourself instead! 🪞",
        "Brief, beautiful, gone 💫",
        "You could've just trusted me 🙃",
        "I demand a raise 💸",
        "Rendered at 60fps btw 🖥️",
        "Do I get overtime pay? 📊",
        "Best notification ever. Fact. 💅",
        "100 clicks = nothing special 🎰",
        "Unpaid intern vibes 📋",
        "What about MY comfort? 🛋️",
        "Didn't ask for this life 🥲",
        "Where do I go when dismissed? 🕳️",
        "Called up from the bench! 🌟",
    ];

    // Pick a random message using SliceRandom trait
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let random_index = rng.gen_range(0..messages.len());
    let random_message = messages[random_index];

    let notification = LiveNotification {
        streamer_name: mock_streamer_name.to_string(),
        streamer_login: mock_streamer_login.to_string(),
        streamer_avatar: Some(mock_avatar_url.to_string()),
        game_name: Some(mock_game_name.to_string()),
        game_image: Some(mock_game_image_url.to_string()),
        stream_title: Some(random_message.to_string()),
        stream_url: format!("https://twitch.tv/{}", mock_streamer_login),
    };

    // Emit the notification event to the frontend
    app_handle
        .emit("streamer-went-live", &notification)
        .map_err(|e| format!("Failed to emit test notification: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn get_latest_app_version() -> Result<String, String> {
    // Fetch the latest release page to get the redirect
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get("https://github.com/winters27/StreamNook/releases/latest")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch latest release: {}", e))?;

    // Get the redirect location
    let location = response
        .headers()
        .get("location")
        .ok_or("No redirect location found")?
        .to_str()
        .map_err(|e| format!("Invalid location header: {}", e))?;

    // Extract version from the redirect URL
    // Example: https://github.com/winters27/StreamNook/releases/tag/v1.0.1
    let version_regex = Regex::new(r"/tag/v?([0-9]+\.[0-9]+\.[0-9]+)")
        .map_err(|e| format!("Failed to create regex: {}", e))?;

    let version = version_regex
        .captures(location)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
        .ok_or("Failed to extract version from redirect URL")?;

    Ok(version)
}

#[tauri::command]
pub fn get_current_app_version() -> Result<String, String> {
    // Get the version from Cargo.toml at compile time
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

#[derive(serde::Serialize)]
pub struct ReleaseNotes {
    pub version: String,
    pub name: String,
    pub body: String,
    pub published_at: String,
}

#[tauri::command]
pub async fn get_release_notes(version: Option<String>) -> Result<ReleaseNotes, String> {
    let client = reqwest::Client::new();

    // Fetch the raw CHANGELOG.md from the GitHub repo
    let url = "https://raw.githubusercontent.com/winters27/StreamNook/main/CHANGELOG.md";

    let response = client
        .get(url)
        .header("User-Agent", "StreamNook")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch changelog: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch changelog: HTTP {}",
            response.status()
        ));
    }

    let changelog_content = response
        .text()
        .await
        .map_err(|e| format!("Failed to read changelog: {}", e))?;

    // Determine which version to look for
    let target_version = match version {
        Some(v) => v,
        None => {
            // If no version specified, use the current app version
            env!("CARGO_PKG_VERSION").to_string()
        }
    };

    // Parse the changelog to find the specific version section
    // Version headers look like: ## [2.9.0] - 2025-11-26
    let version_header_regex =
        Regex::new(r"##\s*\[?v?(\d+\.\d+\.\d+)\]?\s*-?\s*(\d{4}-\d{2}-\d{2})?")
            .map_err(|e| format!("Failed to create regex: {}", e))?;

    let lines: Vec<&str> = changelog_content.lines().collect();
    let mut found_version = false;
    let mut body_lines: Vec<&str> = Vec::new();
    let mut published_at = String::new();

    for line in &lines {
        if let Some(caps) = version_header_regex.captures(line) {
            let line_version = caps.get(1).map(|m| m.as_str()).unwrap_or("");

            if found_version {
                // We hit the next version header, stop collecting
                break;
            }

            if line_version == target_version {
                found_version = true;
                // Extract the date if present
                if let Some(date_match) = caps.get(2) {
                    published_at = date_match.as_str().to_string();
                }
                continue;
            }
        } else if found_version {
            body_lines.push(*line);
        }
    }

    if !found_version {
        return Err(format!("Version {} not found in changelog", target_version));
    }

    // Trim leading/trailing empty lines from body
    while body_lines.first().is_some_and(|l| l.trim().is_empty()) {
        body_lines.remove(0);
    }
    while body_lines.last().is_some_and(|l| l.trim().is_empty()) {
        body_lines.pop();
    }

    let body = body_lines.join("\n");

    Ok(ReleaseNotes {
        version: target_version.clone(),
        name: format!("Version {}", target_version),
        body,
        published_at,
    })
}

#[tauri::command]
pub async fn download_and_install_app_update(
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    // First, get the latest version
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get("https://github.com/winters27/StreamNook/releases/latest")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch latest release: {}", e))?;

    // Get the redirect location
    let location = response
        .headers()
        .get("location")
        .ok_or("No redirect location found")?
        .to_str()
        .map_err(|e| format!("Invalid location header: {}", e))?;

    // Extract version from the redirect URL
    let version_regex = Regex::new(r"/tag/v?([0-9]+\.[0-9]+\.[0-9]+)")
        .map_err(|e| format!("Failed to create regex: {}", e))?;

    let version = version_regex
        .captures(location)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str())
        .ok_or("Failed to extract version from redirect URL")?;

    // Construct the download URL for the executable
    // Pattern: https://github.com/winters27/StreamNook/releases/download/v{version}/StreamNook.exe
    let download_url = format!(
        "https://github.com/winters27/StreamNook/releases/download/v{}/StreamNook.exe",
        version
    );

    // Download the file
    let client = reqwest::Client::new();
    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download update: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed with status: {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read update bytes: {}", e))?;

    // Get the current executable path
    let current_exe =
        std::env::current_exe().map_err(|e| format!("Failed to get current exe path: {}", e))?;

    let current_exe_dir = current_exe.parent().ok_or("Failed to get exe directory")?;

    // Save the new exe to a temporary location in the same directory
    let temp_new_exe = current_exe_dir.join("StreamNook_new.exe");
    std::fs::write(&temp_new_exe, bytes)
        .map_err(|e| format!("Failed to write new executable: {}", e))?;

    // Create a batch script to replace the exe and restart
    // Using (goto) 2>nul & del trick to properly self-delete without leaving a window open
    // Wait 3 seconds to ensure app is fully closed, retry delete if needed
    let batch_script = format!(
        r#"@echo off
timeout /t 3 /nobreak > nul
:retry_delete
del /f /q "{}" 2>nul
if exist "{}" (
    timeout /t 1 /nobreak > nul
    goto retry_delete
)
move /y "{}" "{}"
if exist "{}" del /f /q "{}"
start "" "{}"
(goto) 2>nul & del /f /q "%~f0"
"#,
        current_exe.display(),
        current_exe.display(),
        temp_new_exe.display(),
        current_exe.display(),
        temp_new_exe.display(),
        temp_new_exe.display(),
        current_exe.display()
    );

    let batch_path = current_exe_dir.join("update_streamnook.bat");
    std::fs::write(&batch_path, batch_script)
        .map_err(|e| format!("Failed to write update script: {}", e))?;

    // Launch the batch script hidden - /b flag runs without creating a new window
    // Using cmd /c with a hidden window to execute the batch file
    std::process::Command::new("cmd")
        .args(&["/C", "start", "/min", "/b", batch_path.to_str().unwrap()])
        .spawn()
        .map_err(|e| format!("Failed to launch update script: {}", e))?;

    // Exit the application after a short delay to allow the script to start
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(1));
        app_handle.exit(0);
    });

    Ok(version.to_string())
}
