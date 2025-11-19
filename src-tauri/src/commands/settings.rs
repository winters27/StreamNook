use tauri::State;
use crate::models::settings::{Settings, AppState};
use crate::services::cache_service;
use regex::Regex;
use std::fs;

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
    
    fs::write(&settings_path, json)
        .map_err(|e| format!("Failed to write settings file: {}", e))?;
    
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
    let output = std::process::Command::new(&path)
        .arg("--version")
        .output();
    
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
        Err(_) => Ok(None)
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
        return Err(format!("Download failed with status: {}", response.status()));
    }
    
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read installer bytes: {}", e))?;
    
    // Save to Downloads folder
    let downloads_dir = dirs::download_dir()
        .ok_or("Failed to find Downloads directory")?;
    
    let file_name = format!("streamlink-{}-py313-x86_64.exe", version);
    let file_path = downloads_dir.join(&file_name);
    
    std::fs::write(&file_path, bytes)
        .map_err(|e| format!("Failed to write installer file: {}", e))?;
    
    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_installed_ttvlol_version() -> Result<Option<String>, String> {
    // Get the path to the ttvlol plugin
    let appdata = std::env::var("APPDATA")
        .map_err(|e| format!("Failed to get APPDATA: {}", e))?;
    
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
        return Err(format!("Download failed with status: {}", response.status()));
    }
    
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read plugin bytes: {}", e))?;
    
    // Get the path to install the plugin
    let appdata = std::env::var("APPDATA")
        .map_err(|e| format!("Failed to get APPDATA: {}", e))?;
    
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
