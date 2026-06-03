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

/// Whether onboarding's "components" step is satisfied. StreamNook is now a
/// self-contained native client (no external Streamlink/plugin to provision), so
/// there is nothing to install — always true.
#[tauri::command]
pub fn check_components_installed() -> Result<bool, String> {
    Ok(true)
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
    let mut builder = reqwest::Client::builder().user_agent("StreamNook");

    // Inject PAT to bypass 60-req/hour limit during intense development
    if let Ok(token) = std::env::var("GH_TOKEN").or_else(|_| std::env::var("GITHUB_TOKEN")) {
        builder = builder.default_headers(
            std::iter::once((
                reqwest::header::AUTHORIZATION,
                reqwest::header::HeaderValue::from_str(&format!("Bearer {}", token)).unwrap(),
            ))
            .collect(),
        );
    }

    let client = builder.build().map_err(|e| e.to_string())?;

    // Directly download components.json from the latest release asset redirect
    // This entirely bypasses the api.github.com rate limit for unauthenticated users
    let components_json: ComponentManifest = client
        .get("https://github.com/winters27/StreamNook/releases/latest/download/components.json")
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
    // Fetch remote version info
    let mut builder = reqwest::Client::builder().user_agent("StreamNook");

    // Inject PAT to bypass 60-req/hour limit during intense development
    if let Ok(token) = std::env::var("GH_TOKEN").or_else(|_| std::env::var("GITHUB_TOKEN")) {
        builder = builder.default_headers(
            std::iter::once((
                reqwest::header::AUTHORIZATION,
                reqwest::header::HeaderValue::from_str(&format!("Bearer {}", token)).unwrap(),
            ))
            .collect(),
        );
    }

    let client = builder.build().map_err(|e| e.to_string())?;

    // Directly download components.json from the latest release asset redirect
    // This entirely bypasses the api.github.com rate limit for unauthenticated users
    let remote: ComponentManifest = client
        .get("https://github.com/winters27/StreamNook/releases/latest/download/components.json")
        .send()
        .await
        .map_err(|e| format!("Failed to download remote components.json: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse remote components.json: {}", e))?;

    // The running binary's compiled-in version is the single source of truth for
    // "what's installed." We no longer consult the local components.json: the
    // exe-only bundle intentionally leaves it stale, so trusting it would falsely
    // report that an update is available.
    let current_version = get_current_app_version();
    let update_available = current_version != remote.streamnook.version;

    let mut status = BundleUpdateStatus {
        update_available,
        current_version: current_version.clone(),
        latest_version: remote.streamnook.version.clone(),
        download_url: None,
        bundle_name: None,
        download_size: None,
        component_changes: if update_available {
            Some(ComponentChanges {
                streamnook: Some(VersionChange {
                    from: current_version,
                    to: remote.streamnook.version.clone(),
                }),
                streamlink: None,
                ttvlol: None,
            })
        } else {
            None
        },
        release_notes: None,
    };

    // Set deterministic download URLs since we bypassed the API
    let download_url = format!(
        "https://github.com/winters27/StreamNook/releases/download/v{}/StreamNook.7z",
        remote.streamnook.version
    );
    status.bundle_name = Some("StreamNook.7z".to_string());
    status.download_url = Some(download_url.clone());

    // Fetch release notes strictly from raw CHANGELOG.md to bypass the API restrictions entirely.
    let changelog_url = format!(
        "https://raw.githubusercontent.com/winters27/StreamNook/v{}/CHANGELOG.md",
        remote.streamnook.version
    );

    if let Ok(changelog_res) = client.get(&changelog_url).send().await {
        if let Ok(changelog_text) = changelog_res.text().await {
            // Find the start of the version section
            let pattern = format!(
                r"(?s)## \[?{}\]?",
                regex::escape(&remote.streamnook.version)
            );
            if let Ok(re) = regex::Regex::new(&pattern) {
                if let Some(mat) = re.find(&changelog_text) {
                    let text_after = &changelog_text[mat.start()..];
                    // Slice until the next version block starts (denoted by a newline followed by "## ")
                    let end_idx = text_after[mat.len()..]
                        .find("\n## ")
                        .map(|i| i + mat.len())
                        .unwrap_or(text_after.len());
                    status.release_notes = Some(text_after[..end_idx].trim().to_string());
                }
            }
        }
    }

    // Optionally grab the download size using an HTTP HEAD request via redirects, skipping API data
    if let Ok(head_res) = client.head(&download_url).send().await {
        if let Some(content_length) = head_res.headers().get(reqwest::header::CONTENT_LENGTH) {
            if let Ok(len_str) = content_length.to_str() {
                if let Ok(size) = len_str.parse::<u64>() {
                    let mb = size as f64 / 1_048_576.0;
                    status.download_size = Some(format!("{:.1} MB", mb));
                }
            }
        }
    }

    Ok(status)
}

/// Legacy onboarding hook. Streamlink is no longer bundled or required, so there
/// is nothing to extract — kept as a no-op so the setup wizard's flow stays intact.
#[tauri::command]
pub async fn extract_bundled_components() -> Result<(), String> {
    Ok(())
}

/// Download and install bundle update
#[tauri::command]
pub async fn download_and_install_bundle(app_handle: tauri::AppHandle) -> Result<(), String> {
    let status = check_for_bundle_update().await?;
    if !status.update_available {
        return Err("No update available".to_string());
    }
    install_bundle_from_status(app_handle, status).await
}

/// Shared install body. Downloads the exe-only 7z, extracts it, and writes the
/// hardened batch script that swaps StreamNook.exe and restarts.
async fn install_bundle_from_status(
    app_handle: tauri::AppHandle,
    status: BundleUpdateStatus,
) -> Result<(), String> {
    use tauri::Emitter;

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

    // Manifest destination. (Streamlink is no longer bundled, so the updater
    // only swaps StreamNook.exe + components.json.)
    let dest_components = get_components_json_path()?;

    // Decide whether components.json copy happens HERE (no exe to swap, just a
    // component-only update) or DEFERRED into the batch script (exe swap is
    // needed; components.json must lag the exe so check_for_bundle_update's
    // local version never claims a version that isn't actually installed).
    let source_components = extract_dir.join("components.json");
    let source_exe = extract_dir.join("StreamNook.exe");

    if !source_exe.exists() && source_components.exists() {
        std::fs::copy(&source_components, &dest_components)
            .map_err(|e| format!("Failed to copy components.json: {}", e))?;
    }

    // Handle exe update - create batch script to replace and restart.
    // Hardening for v7.5.1: previous version ignored the `copy /y` errorlevel,
    // so an exe swap that silently failed (file lock, AV scan, etc.) left the
    // user on the OLD exe while components.json had already been overwritten
    // by the Rust side above — version reported as new while the running JS
    // was old. New batch:
    //   - retries the exe copy up to 5 times with 2-second backoff
    //   - only copies components.json AFTER the exe copy succeeds, so the
    //     two stay in lockstep
    //   - logs every step to %TEMP%\streamnook-update.log
    //   - on terminal failure, opens the extracted dir in Explorer and pops
    //     the log in Notepad so the user has a recovery path
    if source_exe.exists() {
        let current_exe = std::env::current_exe()
            .map_err(|e| format!("Failed to get current exe path: {}", e))?;

        let batch_script = format!(
            r#"@echo off
setlocal enabledelayedexpansion
set "SOURCE_EXE={source_exe}"
set "DEST_EXE={dest_exe}"
set "SOURCE_COMPONENTS={source_components}"
set "DEST_COMPONENTS={dest_components}"
set "TEMPDIR={tempdir}"
set "EXTRACTDIR={extractdir}"
set "LOG=%TEMP%\streamnook-update.log"
set "ERRFILE=%TEMP%\streamnook-update.err"

echo [%date% %time%] Update started > "%LOG%"
echo Source exe: %SOURCE_EXE% >> "%LOG%"
echo Dest exe: %DEST_EXE% >> "%LOG%"

:: Wait for the app to fully close
:waitloop
timeout /t 1 /nobreak >nul 2>&1
tasklist /FI "IMAGENAME eq StreamNook.exe" 2>nul | find /I "StreamNook.exe" >nul
if not errorlevel 1 goto waitloop

echo [%date% %time%] StreamNook process closed, beginning exe copy >> "%LOG%"

set "ATTEMPTS=0"
:copyloop
copy /y "%SOURCE_EXE%" "%DEST_EXE%" >nul 2>"%ERRFILE%"
if not errorlevel 1 goto copysuccess

set /a ATTEMPTS+=1
echo [%date% %time%] Copy attempt !ATTEMPTS! failed: >> "%LOG%"
type "%ERRFILE%" >> "%LOG%" 2>nul
if !ATTEMPTS! GEQ 5 goto copyfailed
timeout /t 2 /nobreak >nul 2>&1
goto copyloop

:copysuccess
echo [%date% %time%] Exe copy succeeded after !ATTEMPTS! retries >> "%LOG%"

:: Now safe to bump components.json so it matches the installed exe
if exist "%SOURCE_COMPONENTS%" (
    copy /y "%SOURCE_COMPONENTS%" "%DEST_COMPONENTS%" >nul 2>"%ERRFILE%"
    if errorlevel 1 (
        echo [%date% %time%] WARNING: components.json copy failed but exe is installed >> "%LOG%"
        type "%ERRFILE%" >> "%LOG%" 2>nul
    ) else (
        echo [%date% %time%] components.json updated >> "%LOG%"
    )
)

echo [%date% %time%] Starting new exe >> "%LOG%"
start "" "%DEST_EXE%"

del "%ERRFILE%" >nul 2>&1
rd /s /q "%TEMPDIR%" >nul 2>&1
exit /b 0

:copyfailed
echo [%date% %time%] Update FAILED after 5 retries. >> "%LOG%"
echo [%date% %time%] Manually copy %SOURCE_EXE% to %DEST_EXE% to complete the update. >> "%LOG%"
echo [%date% %time%] components.json was NOT updated, so the app will continue to prompt for v{latest_version_for_log}. >> "%LOG%"

:: Surface the failure to the user. Explorer lands them in the extracted folder
:: where the new StreamNook.exe is sitting; Notepad shows them the log.
start "" "explorer.exe" "%EXTRACTDIR%"
start "" "notepad.exe" "%LOG%"

:: Restart the OLD exe so the user isn't left with no app open at all.
start "" "%DEST_EXE%"
del "%ERRFILE%" >nul 2>&1
exit /b 1
"#,
            source_exe = source_exe.to_string_lossy(),
            dest_exe = current_exe.to_string_lossy(),
            source_components = source_components.to_string_lossy(),
            dest_components = dest_components.to_string_lossy(),
            tempdir = temp_dir.to_string_lossy(),
            extractdir = extract_dir.to_string_lossy(),
            latest_version_for_log = status.latest_version,
        );

        let batch_path = temp_dir.join("update.bat");
        std::fs::write(&batch_path, batch_script)
            .map_err(|e| format!("Failed to write update script: {}", e))?;

        let _ = app_handle.emit("bundle-update-progress", "Restarting...");

        // Launch the batch through a VBS wrapper run via wscript with window
        // style 0 (hidden). wscript gives the batch a real (hidden) console, so
        // its console-dependent commands (`timeout`, the `tasklist | find` wait
        // loop) run correctly. Do NOT spawn cmd directly with
        // CREATE_NO_WINDOW | DETACHED_PROCESS: the OS ignores CREATE_NO_WINDOW
        // when DETACHED_PROCESS is also set, which surfaces a visible console
        // and breaks the wait loop. A brief flash on creation is accepted in
        // exchange for a relaunch path that reliably completes.
        let vbs_script = format!(
            r#"Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """{batch}""", 0, False
"#,
            batch = batch_path.to_string_lossy().replace("\\", "\\\\")
        );

        let vbs_path = temp_dir.join("update_launcher.vbs");
        std::fs::write(&vbs_path, vbs_script)
            .map_err(|e| format!("Failed to write VBS launcher: {}", e))?;

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
