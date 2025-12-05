use crate::models::components::{
    BundleUpdateStatus, ComponentChanges, ComponentManifest, VersionChange,
};
use sevenz_rust::decompress_file;
use std::path::PathBuf;

/// Get the directory where the executable is located (portable mode)
fn get_exe_directory() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|e| format!("Failed to get current exe path: {}", e))?
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "Failed to get exe directory".to_string())
}

/// Get the path to the local components.json (next to exe in portable mode)
fn get_components_json_path() -> Result<PathBuf, String> {
    let exe_dir = get_exe_directory()?;
    Ok(exe_dir.join("components.json"))
}

/// Get the path to bundled streamlink directory (portable)
fn get_bundled_streamlink_dir() -> Result<PathBuf, String> {
    let exe_dir = get_exe_directory()?;
    Ok(exe_dir.join("streamlink"))
}

/// Get the path to the bundled streamlink executable (portable)
/// Located at: <exe_directory>/streamlink/bin/streamlinkw.exe
/// NOTE: We use streamlinkw.exe (not streamlink.exe) because:
/// - streamlinkw.exe is designed for GUI applications (doesn't force terminal window)
/// - StreamNook is a GUI application
#[tauri::command]
pub fn get_bundled_streamlink_path() -> Result<String, String> {
    let streamlink_dir = get_bundled_streamlink_dir()?;
    let exe_path = streamlink_dir.join("bin").join("streamlinkw.exe");
    Ok(exe_path.to_string_lossy().to_string())
}

/// Check if bundled components are installed (portable)
/// Uses streamlinkw.exe (designed for GUI apps)
#[tauri::command]
pub fn check_components_installed() -> Result<bool, String> {
    let streamlink_dir = get_bundled_streamlink_dir()?;
    let streamlink_exe = streamlink_dir.join("bin").join("streamlinkw.exe");
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

/// Try to copy components.json from exe directory to AppData if missing
fn try_copy_components_from_exe() -> Option<ComponentManifest> {
    let exe_path = std::env::current_exe().ok()?;
    let exe_dir = exe_path.parent()?;
    let source_components = exe_dir.join("components.json");

    if source_components.exists() {
        // Try to load from exe directory
        if let Ok(manifest) = ComponentManifest::load_from_file(&source_components) {
            // Try to copy to AppData for future use
            if let Ok(dest_path) = get_components_json_path() {
                if let Some(parent) = dest_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::copy(&source_components, &dest_path);
            }
            return Some(manifest);
        }
    }
    None
}

/// Get the current app version from Cargo.toml
fn get_current_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Check for bundle updates
#[tauri::command]
pub async fn check_for_bundle_update() -> Result<BundleUpdateStatus, String> {
    // Try to get local manifest, with fallback to exe directory
    let local = match get_local_component_versions() {
        Ok(m) => Some(m),
        Err(_) => {
            // Try to copy from exe directory
            try_copy_components_from_exe()
        }
    };

    // Fetch remote version info
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

    // Find components.json in the release
    let components_asset = assets
        .iter()
        .find(|a| a["name"].as_str() == Some("components.json"));

    // Get remote manifest
    let remote = if let Some(asset) = components_asset {
        let download_url = asset["browser_download_url"]
            .as_str()
            .ok_or("No download URL for components.json")?;

        client
            .get(download_url)
            .send()
            .await
            .map_err(|e| format!("Failed to download components.json: {}", e))?
            .json::<ComponentManifest>()
            .await
            .map_err(|e| format!("Failed to parse components.json: {}", e))?
    } else {
        return Err("components.json not found in release".to_string());
    };

    // Find the bundle
    let bundle_asset = assets.iter().find(|a| {
        a["name"]
            .as_str()
            .map(|n| n == "StreamNook.7z")
            .unwrap_or(false)
    });

    // Build status based on whether we have local manifest or not
    let mut status = if let Some(ref local_manifest) = local {
        local_manifest.compare(&remote)
    } else {
        // No local manifest - use app's built-in version
        let current_version = get_current_app_version();
        let update_available = current_version != remote.streamnook.version;

        BundleUpdateStatus {
            update_available,
            current_version,
            latest_version: remote.streamnook.version.clone(),
            download_url: None,
            bundle_name: None,
            download_size: None,
            component_changes: if update_available {
                Some(ComponentChanges {
                    streamnook: Some(VersionChange {
                        from: get_current_app_version(),
                        to: remote.streamnook.version.clone(),
                    }),
                    streamlink: None, // Unknown without local manifest
                    ttvlol: None,
                })
            } else {
                None
            },
            release_notes: None,
        }
    };

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

    // Extract release notes
    status.release_notes = release["body"].as_str().map(|s| s.to_string());

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

    // Extract using native sevenz-rust library (no external 7z dependency)
    let extract_dir = temp_dir.join("extracted");
    std::fs::create_dir_all(&extract_dir)
        .map_err(|e| format!("Failed to create extract directory: {}", e))?;

    decompress_file(&bundle_path, &extract_dir)
        .map_err(|e| format!("Failed to extract 7z bundle: {}", e))?;

    let _ = app_handle.emit("bundle-update-progress", "Installing components...");

    // Get destination paths
    let dest_streamlink = get_bundled_streamlink_dir()?;
    let dest_components = get_components_json_path()?;

    // Copy streamlink directory
    let source_streamlink = extract_dir.join("streamlink");
    if source_streamlink.exists() {
        // Remove old streamlink
        if dest_streamlink.exists() {
            // Force kill any running streamlink processes to release file locks
            #[cfg(target_os = "windows")]
            {
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/IM", "streamlinkw.exe", "/T"])
                    .output();
            }

            // Retry removal loop to handle race conditions with file locks
            let mut attempts = 0;
            loop {
                attempts += 1;
                match std::fs::remove_dir_all(&dest_streamlink) {
                    Ok(_) => break,
                    Err(e) => {
                        if attempts >= 5 {
                            return Err(format!(
                                "Failed to remove old streamlink after {} attempts. Please ensure Streamlink is not running. Error: {}",
                                attempts, e
                            ));
                        }

                        // Wait before retrying
                        std::thread::sleep(std::time::Duration::from_millis(1000));

                        // Try killing again on retry to ensure it's dead
                        #[cfg(target_os = "windows")]
                        {
                            let _ = std::process::Command::new("taskkill")
                                .args(["/F", "/IM", "streamlinkw.exe", "/T"])
                                .output();
                        }
                    }
                }
            }
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

        // Create batch script that:
        // 1. Waits for current app to close
        // 2. Copies the new exe
        // 3. Starts the new app minimized initially then normal
        // 4. Cleans up temp files and deletes itself
        let batch_script = format!(
            r#"@echo off
setlocal
set "SOURCE={source}"
set "DEST={dest}"
set "TEMPDIR={tempdir}"

:: Wait for the app to fully close
:waitloop
timeout /t 1 /nobreak >nul 2>&1
tasklist /FI "IMAGENAME eq StreamNook.exe" 2>nul | find /I "StreamNook.exe" >nul
if not errorlevel 1 goto waitloop

:: Copy the new executable
copy /y "%SOURCE%" "%DEST%" >nul 2>&1

:: Start the updated app
start "" "%DEST%"

:: Clean up temp directory (will fail on current batch file, which is fine)
rd /s /q "%TEMPDIR%" >nul 2>&1

:: Exit without showing any window artifacts
exit
"#,
            source = source_exe.to_string_lossy(),
            dest = current_exe.to_string_lossy(),
            tempdir = temp_dir.to_string_lossy()
        );

        let batch_path = temp_dir.join("update.bat");
        std::fs::write(&batch_path, batch_script)
            .map_err(|e| format!("Failed to write update script: {}", e))?;

        let _ = app_handle.emit("bundle-update-progress", "Restarting...");

        // Launch batch script in a hidden window using wscript
        // Create a VBS wrapper to run the batch silently
        let vbs_script = format!(
            r#"Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """{batch}""", 0, False
"#,
            batch = batch_path.to_string_lossy().replace("\\", "\\\\")
        );

        let vbs_path = temp_dir.join("update_launcher.vbs");
        std::fs::write(&vbs_path, vbs_script)
            .map_err(|e| format!("Failed to write VBS launcher: {}", e))?;

        // Run the VBS script which launches the batch silently
        std::process::Command::new("wscript")
            .arg(&vbs_path)
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
