use crate::models::settings::{AppState, Settings};
use crate::services::cache_service;
use crate::services::live_notification_service::LiveNotification;
use log::debug;
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
pub async fn save_settings(
    mut settings: Settings,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut state_settings = state.settings.lock().unwrap();
        // `drops` is owned by the drops service: it's written only through
        // update_drops_settings (the plugin's Autopilot panel writes through that
        // path too), which keeps state.settings.drops authoritative. A frontend
        // settings save carries the AppStore's copy of drops, which is loaded once
        // at startup and never refreshed when the plugin panel changes it, so it
        // goes stale. Letting it through here clobbers farming on/off and the
        // priority targets the moment any unrelated setting is saved (e.g. a
        // notifications toggle). Keep the backend's copy instead.
        settings.drops = state_settings.drops.clone();
        *state_settings = settings.clone();
    }

    // Save to our custom location in the same directory as cache
    let settings_path = get_settings_path()?;
    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    fs::write(&settings_path, json).map_err(|e| format!("Failed to write settings file: {}", e))?;

    Ok(())
}

/// Top-level keys tied to *this machine's* session, never written into a backup
/// and never pulled out of one on import: which Twitch accounts are signed in,
/// the active account, the onboarding flag, and the last-seen version. Everything
/// else (theme, chat design, keybindings, highlights, custom commands, custom
/// themes, ...) is a portable preference and is included.
const NON_PORTABLE_KEYS: &[&str] = &[
    "accounts",
    "current_account",
    "setup_complete",
    "last_seen_version",
];

/// Absolute path of the folder that holds settings.json (alongside caches/logs).
/// Surfaced in the Backup tab so power users can find their settings on disk.
#[tauri::command]
pub async fn get_settings_dir() -> Result<String, String> {
    let dir = cache_service::get_app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    Ok(dir.to_string_lossy().to_string())
}

/// Open the settings folder in the OS file browser. Routed through the opener
/// plugin from Rust (so it needs no extra JS-side capability).
#[tauri::command]
pub async fn open_settings_folder(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = cache_service::get_app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| format!("Failed to open settings folder: {}", e))
}

/// Write the user's portable preferences to `path` (chosen via a save dialog on
/// the frontend). Session/login keys are stripped so a backup carries pure
/// app/UI customization and no account info.
#[tauri::command]
pub async fn export_settings(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let settings = { state.settings.lock().unwrap().clone() };
    let mut value = serde_json::to_value(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    if let Some(obj) = value.as_object_mut() {
        for key in NON_PORTABLE_KEYS {
            obj.remove(*key);
        }
    }
    let json = serde_json::to_string_pretty(&value)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write backup file: {}", e))?;
    Ok(())
}

/// Apply a previously exported backup at `path`. Portable preferences from the
/// file overwrite the current ones; this machine's session/login keys are kept
/// as-is (a backup carries none anyway). The merged result is validated by
/// round-tripping through the typed Settings struct *before* anything is written,
/// so an unrelated or malformed file fails cleanly without disturbing live
/// settings. On success the in-memory state and settings.json are both updated;
/// the frontend reloads to re-apply everything.
#[tauri::command]
pub async fn import_settings(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let contents =
        fs::read_to_string(&path).map_err(|e| format!("Couldn't read that file: {}", e))?;
    let incoming: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|_| "That file isn't a valid StreamNook settings backup.".to_string())?;
    let incoming_obj = incoming
        .as_object()
        .ok_or_else(|| "That file isn't a valid StreamNook settings backup.".to_string())?;

    // Start from the live settings so session/login keys survive, then overlay
    // every portable key the backup provides.
    let current = { state.settings.lock().unwrap().clone() };
    let mut merged = serde_json::to_value(&current)
        .map_err(|e| format!("Failed to read current settings: {}", e))?;
    {
        let merged_obj = merged
            .as_object_mut()
            .ok_or_else(|| "Failed to read current settings.".to_string())?;
        for (key, val) in incoming_obj {
            if NON_PORTABLE_KEYS.contains(&key.as_str()) {
                continue;
            }
            merged_obj.insert(key.clone(), val.clone());
        }
    }

    let imported: Settings = serde_json::from_value(merged)
        .map_err(|e| format!("That backup isn't compatible with this version: {}", e))?;

    {
        let mut state_settings = state.settings.lock().unwrap();
        *state_settings = imported.clone();
    }
    let settings_path = get_settings_path()?;
    let json = serde_json::to_string_pretty(&imported)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(&settings_path, json).map_err(|e| format!("Failed to write settings file: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn send_test_notification(
    app_handle: AppHandle,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    // Mock data for the test notification
    let mock_streamer_name = "xQc";
    let mock_streamer_login = "xqc";
    let mock_game_name = "Grand Theft Auto V";
    let mock_avatar_url = "https://static-cdn.jtvnw.net/jtv_user_pictures/xqc-profile_image-9298dca608632101-300x300.jpeg";
    let mock_game_image_url = "https://static-cdn.jtvnw.net/ttv-boxart/32982_IGDB-285x380.jpg";

    // Fun randomized messages with personality
    let messages: &[&str] = &[
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

    // Pick a random message
    let random_message = {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let random_index = rng.gen_range(0..messages.len());
        messages[random_index].to_string()
    };

    let notification = LiveNotification {
        streamer_name: mock_streamer_name.to_string(),
        streamer_login: mock_streamer_login.to_string(),
        streamer_avatar: Some(mock_avatar_url.to_string()),
        game_name: Some(mock_game_name.to_string()),
        game_image: Some(mock_game_image_url.to_string()),
        stream_title: Some(random_message),
        stream_url: format!("https://twitch.tv/{}", mock_streamer_login),
        is_test: true,
    };

    // Emit the notification event to the frontend (for in-app notification)
    app_handle
        .emit("streamer-went-live", &notification)
        .map_err(|e| format!("Failed to emit test notification: {}", e))?;

    debug!("[Test Notification] Sent in-app notification");

    Ok(())
}

#[tauri::command]
pub async fn get_latest_app_version() -> Result<String, String> {
    // Follow the full redirect chain so the version survives a repo
    // rename/transfer (old URLs 301 to the new home before the tag hop)
    let client = crate::services::http::client().clone();

    let response = client
        .get("https://github.com/winters27/StreamNook/releases/latest")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch latest release: {}", e))?;

    let final_url = response.url().to_string();

    // Extract version from the final URL
    // Example: https://github.com/winters27/StreamNook/releases/tag/v1.0.1
    let version_regex = Regex::new(r"/tag/v?([0-9]+\.[0-9]+\.[0-9]+)")
        .map_err(|e| format!("Failed to create regex: {}", e))?;

    let version = version_regex
        .captures(&final_url)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
        .ok_or("Failed to extract version from final release URL")?;

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
    let client = crate::services::http::client().clone();

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
    // First, get the latest version. Follow the full redirect chain so this
    // survives a repo rename/transfer (old URLs 301 to the new home first)
    let client = crate::services::http::client().clone();

    let response = client
        .get("https://github.com/winters27/StreamNook/releases/latest")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch latest release: {}", e))?;

    let final_url = response.url().to_string();

    // Extract version from the final URL
    let version_regex = Regex::new(r"/tag/v?([0-9]+\.[0-9]+\.[0-9]+)")
        .map_err(|e| format!("Failed to create regex: {}", e))?;

    let version = version_regex
        .captures(&final_url)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str())
        .ok_or("Failed to extract version from final release URL")?;

    // Construct the download URL for the executable
    // Pattern: https://github.com/winters27/StreamNook/releases/download/v{version}/StreamNook.exe
    let download_url = format!(
        "https://github.com/winters27/StreamNook/releases/download/v{}/StreamNook.exe",
        version
    );

    // Download the file
    let client = crate::services::http::client().clone();
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

    // Launch the batch script hidden
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
