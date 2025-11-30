use crate::models::components::{BundleUpdateStatus, ComponentManifest};
use crate::services::cache_service::get_app_data_dir;
use std::path::PathBuf;

/// Get the path to the local components.json
fn get_components_json_path() -> Result<PathBuf, String> {
    let app_dir = get_app_data_dir().map_err(|e| e.to_string())?;
    Ok(app_dir.join("components.json"))
}

/// Get the path to bundled streamlink directory
fn get_bundled_streamlink_dir() -> Result<PathBuf, String> {
    let app_dir = get_app_data_dir().map_err(|e| e.to_string())?;
    Ok(app_dir.join("streamlink"))
}

/// Get the path to the bundled streamlink executable
#[tauri::command]
pub fn get_bundled_streamlink_path() -> Result<String, String> {
    let streamlink_dir = get_bundled_streamlink_dir()?;
    let exe_path = streamlink_dir.join("streamlink.exe");
    Ok(exe_path.to_string_lossy().to_string())
}

/// Check if bundled components are installed
#[tauri::command]
pub fn check_components_installed() -> Result<bool, String> {
    let streamlink_dir = get_bundled_streamlink_dir()?;
    let streamlink_exe = streamlink_dir.join("streamlink.exe");
    let plugin_path = streamlink_dir.join("plugins").join("twitch.py");
    let components_json = get_components_json_path()?;

    let installed = streamlink_exe.exists() && plugin_path.exists() && components_json.exists();
    Ok(installed)
}

/// Get local component versions from components.json
#[tauri::command]
pub fn get_local_component_versions() -> Result<ComponentManifest, String> {
    let components_path = get_components_json_path()?;

    if !components_path.exists() {
        return Err("Components not installed".to_string());
    }

    ComponentManifest::load_from_file(&components_path)
        .map_err(|e| format!("Failed to load components.json: {}", e))
}

/// Fetch remote component versions from GitHub
#[tauri::command]
pub async fn get_remote_component_versions() -> Result<ComponentManifest, String> {
    let client = reqwest::Client::builder()
        .user_agent("StreamNook")
        .build()
        .map_err(|e| e.to_string())?;

    // Get latest release info
    let release: serde_json::Value = client
        .get("https://api.github.com/repos/winters27/StreamNook/releases/latest")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch releases: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse releases: {}", e))?;

    // Find components.json asset
    let assets = release["assets"].as_array().ok_or("No assets in release")?;

    let components_asset = assets
        .iter()
        .find(|a| a["name"].as_str() == Some("components.json"))
        .ok_or("components.json not found in release")?;

    let download_url = components_asset["browser_download_url"]
        .as_str()
        .ok_or("No download URL for components.json")?;

    // Download and parse components.json
    let components_json: ComponentManifest = client
        .get(download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download components.json: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse components.json: {}", e))?;

    Ok(components_json)
}

/// Check for bundle updates
#[tauri::command]
pub async fn check_for_bundle_update() -> Result<BundleUpdateStatus, String> {
    let local = match get_local_component_versions() {
        Ok(m) => m,
        Err(_) => {
            // No local manifest, definitely needs install
            return Ok(BundleUpdateStatus {
                update_available: true,
                current_version: "Not installed".to_string(),
                latest_version: "Unknown".to_string(),
                download_url: None,
                bundle_name: None,
                download_size: None,
                component_changes: None,
            });
        }
    };

    let remote = get_remote_component_versions().await?;

    // Get bundle download info
    let client = reqwest::Client::builder()
        .user_agent("StreamNook")
        .build()
        .map_err(|e| e.to_string())?;

    let release: serde_json::Value = client
        .get("https://api.github.com/repos/winters27/StreamNook/releases/latest")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch releases: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse releases: {}", e))?;

    let assets = release["assets"].as_array().ok_or("No assets")?;

    // Find the bundle
    let bundle_asset = assets.iter().find(|a| {
        a["name"]
            .as_str()
            .map(|n| n.ends_with("-bundle.7z"))
            .unwrap_or(false)
    });

    let mut status = local.compare(&remote);

    if let Some(asset) = bundle_asset {
        status.download_url = asset["browser_download_url"]
            .as_str()
            .map(|s| s.to_string());
        status.bundle_name = asset["name"].as_str().map(|s| s.to_string());

        // Format download size
        if let Some(size) = asset["size"].as_u64() {
            let mb = size as f64 / 1_048_576.0;
            status.download_size = Some(format!("{:.1} MB", mb));
        }
    }

    Ok(status)
}

/// Extract bundled components from exe directory to AppData on first run
#[tauri::command]
pub async fn extract_bundled_components() -> Result<(), String> {
    // Get the exe directory (where StreamNook.exe is located)
    let exe_path = std::env::current_exe().map_err(|e| format!("Failed to get exe path: {}", e))?;
    let exe_dir = exe_path.parent().ok_or("Failed to get exe directory")?;

    // Source paths (next to exe)
    let source_streamlink = exe_dir.join("streamlink");
    let source_components = exe_dir.join("components.json");

    // Destination paths (in AppData)
    let dest_streamlink = get_bundled_streamlink_dir()?;
    let dest_components = get_components_json_path()?;

    // Check if source exists
    if !source_streamlink.exists() {
        return Err("Bundled streamlink not found next to exe".to_string());
    }

    // Create destination directory
    std::fs::create_dir_all(&dest_streamlink)
        .map_err(|e| format!("Failed to create streamlink directory: {}", e))?;

    // Copy streamlink directory recursively
    copy_dir_all(&source_streamlink, &dest_streamlink)
        .map_err(|e| format!("Failed to copy streamlink: {}", e))?;

    // Copy components.json
    if source_components.exists() {
        std::fs::copy(&source_components, &dest_components)
            .map_err(|e| format!("Failed to copy components.json: {}", e))?;
    }

    Ok(())
}

/// Download and install bundle update
#[tauri::command]
pub async fn download_and_install_bundle(app_handle: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;

    // Get update info
    let status = check_for_bundle_update().await?;

    if !status.update_available {
        return Err("No update available".to_string());
    }

    let download_url = status.download_url.ok_or("No download URL available")?;

    let bundle_name = status.bundle_name.ok_or("No bundle name available")?;

    // Emit progress
    let _ = app_handle.emit("bundle-update-progress", "Downloading bundle...");

    // Create temp directory
    let temp_dir = std::env::temp_dir().join("StreamNook-update");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp directory: {}", e))?;

    let bundle_path = temp_dir.join(&bundle_name);

    // Download the bundle
    let client = reqwest::Client::builder()
        .user_agent("StreamNook")
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download bundle: {}", e))?;

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read bundle: {}", e))?;

    std::fs::write(&bundle_path, &bytes).map_err(|e| format!("Failed to save bundle: {}", e))?;

    let _ = app_handle.emit("bundle-update-progress", "Extracting bundle...");

    // Extract using 7z command
    let extract_dir = temp_dir.join("extracted");
    std::fs::create_dir_all(&extract_dir)
        .map_err(|e| format!("Failed to create extract directory: {}", e))?;

    let output = std::process::Command::new("7z")
        .args([
            "x",
            "-y",
            &bundle_path.to_string_lossy(),
            &format!("-o{}", extract_dir.to_string_lossy()),
        ])
        .output()
        .map_err(|e| format!("Failed to run 7z: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "7z extraction failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let _ = app_handle.emit("bundle-update-progress", "Installing components...");

    // Get destination paths
    let dest_streamlink = get_bundled_streamlink_dir()?;
    let dest_components = get_components_json_path()?;

    // Copy streamlink directory
    let source_streamlink = extract_dir.join("streamlink");
    if source_streamlink.exists() {
        // Remove old streamlink
        if dest_streamlink.exists() {
            std::fs::remove_dir_all(&dest_streamlink)
                .map_err(|e| format!("Failed to remove old streamlink: {}", e))?;
        }
        copy_dir_all(&source_streamlink, &dest_streamlink)
            .map_err(|e| format!("Failed to copy streamlink: {}", e))?;
    }

    // Copy components.json
    let source_components = extract_dir.join("components.json");
    if source_components.exists() {
        std::fs::copy(&source_components, &dest_components)
            .map_err(|e| format!("Failed to copy components.json: {}", e))?;
    }

    // Handle exe update - create batch script to replace and restart
    let source_exe = extract_dir.join("StreamNook.exe");
    if source_exe.exists() {
        let current_exe = std::env::current_exe()
            .map_err(|e| format!("Failed to get current exe path: {}", e))?;

        let batch_script = format!(
            r#"@echo off
timeout /t 2 /nobreak >nul
copy /y "{source}" "{dest}"
start "" "{dest}"
del "%~f0"
"#,
            source = source_exe.to_string_lossy(),
            dest = current_exe.to_string_lossy()
        );

        let batch_path = temp_dir.join("update.bat");
        std::fs::write(&batch_path, batch_script)
            .map_err(|e| format!("Failed to write update script: {}", e))?;

        let _ = app_handle.emit("bundle-update-progress", "Restarting...");

        // Run the batch script and exit
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &batch_path.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("Failed to run update script: {}", e))?;

        // Exit the app
        std::process::exit(0);
    }

    // Clean up temp directory
    let _ = std::fs::remove_dir_all(&temp_dir);

    let _ = app_handle.emit("bundle-update-progress", "Update complete!");

    Ok(())
}

/// Recursively copy a directory
fn copy_dir_all(src: &PathBuf, dst: &PathBuf) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;

    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if ty.is_dir() {
            copy_dir_all(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }

    Ok(())
}
