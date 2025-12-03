use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::process::Command;

#[derive(Debug, Serialize, Deserialize)]
pub struct StreamMetadata {
    pub title: Option<String>,
    pub author: Option<String>,
    pub game: Option<String>,
    pub viewers: Option<i32>,
}

/// Detailed diagnostic information about streamlink installation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamlinkDiagnostics {
    pub exe_directory: Option<String>,
    pub cwd: Option<String>,
    pub bundled_path_checked: String,
    pub bundled_path_exists: bool,
    pub cwd_path_checked: Option<String>,
    pub cwd_path_exists: bool,
    pub parent_path_checked: Option<String>,
    pub parent_path_exists: bool,
    pub effective_path: String,
    pub streamlink_found: bool,
    pub streamlink_version: Option<String>,
    pub error_details: Option<String>,
}

pub struct StreamlinkManager;

impl StreamlinkManager {
    /// Get the directory where the executable is located
    fn get_exe_directory() -> Option<PathBuf> {
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
    }

    /// Get the bundled streamlink path
    /// Located at: <exe_directory>/streamlink/bin/streamlinkw.exe
    /// NOTE: We use streamlinkw.exe (not streamlink.exe) because:
    /// - streamlinkw.exe is designed for GUI applications (doesn't force terminal window)
    /// - StreamNook is a GUI application
    pub fn get_bundled_path() -> PathBuf {
        Self::get_exe_directory()
            .map(|exe_dir| {
                exe_dir
                    .join("streamlink")
                    .join("bin")
                    .join("streamlinkw.exe")
            })
            .unwrap_or_else(|| PathBuf::from("streamlink"))
    }

    /// Get comprehensive diagnostics about streamlink installation
    /// This helps debug issues where streamlink cannot be found
    pub fn get_diagnostics() -> StreamlinkDiagnostics {
        let exe_directory = Self::get_exe_directory().map(|p| p.to_string_lossy().to_string());
        let cwd = std::env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().to_string());

        let bundled_path = Self::get_bundled_path();
        let bundled_path_checked = bundled_path.to_string_lossy().to_string();
        let bundled_path_exists = bundled_path.exists();

        let mut cwd_path_checked = None;
        let mut cwd_path_exists = false;
        let mut parent_path_checked = None;
        let mut parent_path_exists = false;

        // Check CWD paths (for development)
        if let Ok(current_dir) = std::env::current_dir() {
            let cwd_streamlink = current_dir
                .join("streamlink")
                .join("bin")
                .join("streamlinkw.exe");
            cwd_path_checked = Some(cwd_streamlink.to_string_lossy().to_string());
            cwd_path_exists = cwd_streamlink.exists();

            if let Some(parent) = current_dir.parent() {
                let parent_streamlink = parent
                    .join("streamlink")
                    .join("bin")
                    .join("streamlinkw.exe");
                parent_path_checked = Some(parent_streamlink.to_string_lossy().to_string());
                parent_path_exists = parent_streamlink.exists();
            }
        }

        let effective_path = Self::get_effective_path("");
        let streamlink_found = std::path::Path::new(&effective_path).exists();

        StreamlinkDiagnostics {
            exe_directory,
            cwd,
            bundled_path_checked,
            bundled_path_exists,
            cwd_path_checked,
            cwd_path_exists,
            parent_path_checked,
            parent_path_exists,
            effective_path,
            streamlink_found,
            streamlink_version: None, // Will be populated by async version check
            error_details: if !streamlink_found {
                Some(format!(
                    "Streamlink not found at expected location. Exe dir: {:?}, CWD: {:?}",
                    Self::get_exe_directory(),
                    std::env::current_dir().ok()
                ))
            } else {
                None
            },
        }
    }

    /// Get comprehensive diagnostics including version check (async)
    pub async fn get_diagnostics_with_version() -> StreamlinkDiagnostics {
        let mut diagnostics = Self::get_diagnostics();

        if diagnostics.streamlink_found {
            // Try to get version
            match Command::new(&diagnostics.effective_path)
                .arg("--version")
                .output()
                .await
            {
                Ok(output) => {
                    if output.status.success() {
                        diagnostics.streamlink_version =
                            Some(String::from_utf8_lossy(&output.stdout).trim().to_string());
                    } else {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        diagnostics.error_details =
                            Some(format!("Streamlink found but --version failed: {}", stderr));
                    }
                }
                Err(e) => {
                    diagnostics.error_details =
                        Some(format!("Failed to execute streamlink --version: {}", e));
                }
            }
        }

        diagnostics
    }

    /// Get the effective streamlink path (bundled only - no fallbacks)
    pub fn get_effective_path(_user_path: &str) -> String {
        let bundled_path = Self::get_bundled_path();

        // Debug: log what paths we're checking
        println!(
            "[StreamlinkManager] Checking bundled path: {:?}",
            bundled_path
        );

        // Check if bundled streamlink exists (production mode - relative to exe)
        if bundled_path.exists() {
            println!(
                "[StreamlinkManager] Using bundled streamlink: {:?}",
                bundled_path
            );
            return bundled_path.to_string_lossy().to_string();
        }

        // Development mode: check current working directory and its parent (project root)
        // CWD in tauri dev is src-tauri/, so we also check parent for project root
        if let Ok(cwd) = std::env::current_dir() {
            println!("[StreamlinkManager] CWD is: {:?}", cwd);

            // First check CWD itself
            let cwd_streamlink = cwd.join("streamlink").join("bin").join("streamlinkw.exe");
            if cwd_streamlink.exists() {
                println!(
                    "[StreamlinkManager] Using streamlink from CWD: {:?}",
                    cwd_streamlink
                );
                return cwd_streamlink.to_string_lossy().to_string();
            }

            // Then check parent directory (project root when CWD is src-tauri)
            if let Some(parent) = cwd.parent() {
                let parent_streamlink = parent
                    .join("streamlink")
                    .join("bin")
                    .join("streamlinkw.exe");
                println!(
                    "[StreamlinkManager] Checking parent path: {:?}",
                    parent_streamlink
                );
                if parent_streamlink.exists() {
                    println!(
                        "[StreamlinkManager] Using streamlink from parent: {:?}",
                        parent_streamlink
                    );
                    return parent_streamlink.to_string_lossy().to_string();
                }
            }
        }

        // No fallbacks - bundled streamlink must exist
        println!(
            "[StreamlinkManager] ERROR: Bundled streamlink not found! Expected at: {:?}",
            bundled_path
        );

        // Log additional debug info for troubleshooting
        println!("[StreamlinkManager] === DIAGNOSTIC INFO ===");
        if let Ok(exe) = std::env::current_exe() {
            println!("[StreamlinkManager] Current exe: {:?}", exe);
            if let Some(parent) = exe.parent() {
                println!("[StreamlinkManager] Exe parent dir: {:?}", parent);

                // List contents of parent directory
                if let Ok(entries) = std::fs::read_dir(parent) {
                    println!("[StreamlinkManager] Contents of exe directory:");
                    for entry in entries.flatten() {
                        println!("[StreamlinkManager]   - {:?}", entry.file_name());
                    }
                }

                // Check if streamlink folder exists
                let streamlink_dir = parent.join("streamlink");
                if streamlink_dir.exists() {
                    println!("[StreamlinkManager] streamlink/ folder EXISTS");
                    if let Ok(entries) = std::fs::read_dir(&streamlink_dir) {
                        println!("[StreamlinkManager] Contents of streamlink/:");
                        for entry in entries.flatten() {
                            println!("[StreamlinkManager]   - {:?}", entry.file_name());
                        }
                    }

                    let bin_dir = streamlink_dir.join("bin");
                    if bin_dir.exists() {
                        println!("[StreamlinkManager] streamlink/bin/ folder EXISTS");
                        if let Ok(entries) = std::fs::read_dir(&bin_dir) {
                            println!("[StreamlinkManager] Contents of streamlink/bin/:");
                            for entry in entries.flatten() {
                                println!("[StreamlinkManager]   - {:?}", entry.file_name());
                            }
                        }
                    } else {
                        println!("[StreamlinkManager] streamlink/bin/ folder DOES NOT EXIST");
                    }
                } else {
                    println!("[StreamlinkManager] streamlink/ folder DOES NOT EXIST");
                }
            }
        }
        println!("[StreamlinkManager] === END DIAGNOSTIC INFO ===");

        // Return the bundled path anyway - let the error propagate when trying to run
        bundled_path.to_string_lossy().to_string()
    }

    /// Check if bundled streamlink is available
    pub fn is_bundled_available() -> bool {
        Self::get_bundled_path().exists()
    }

    pub async fn get_stream_url_with_settings(
        url: &str,
        quality: &str,
        path: &str,
        args: &str,
        settings: &crate::models::settings::StreamlinkSettings,
    ) -> Result<String> {
        // Debug logging to understand what's being passed
        println!("[Streamlink] Path: '{}'", path);
        println!("[Streamlink] URL: '{}'", url);
        println!("[Streamlink] Quality: '{}'", quality);
        println!("[Streamlink] Args: '{}'", args);

        // Verify the path exists and log detailed info if not
        let path_exists = std::path::Path::new(path).exists();
        println!("[Streamlink] Path exists: {}", path_exists);

        if !path_exists {
            // Log detailed diagnostic info when path doesn't exist
            let diagnostics = Self::get_diagnostics();
            println!("[Streamlink] === STREAMLINK NOT FOUND DIAGNOSTICS ===");
            println!(
                "[Streamlink] Exe directory: {:?}",
                diagnostics.exe_directory
            );
            println!("[Streamlink] CWD: {:?}", diagnostics.cwd);
            println!(
                "[Streamlink] Bundled path checked: {}",
                diagnostics.bundled_path_checked
            );
            println!(
                "[Streamlink] Bundled path exists: {}",
                diagnostics.bundled_path_exists
            );
            println!(
                "[Streamlink] CWD path checked: {:?}",
                diagnostics.cwd_path_checked
            );
            println!(
                "[Streamlink] CWD path exists: {}",
                diagnostics.cwd_path_exists
            );
            println!(
                "[Streamlink] Parent path checked: {:?}",
                diagnostics.parent_path_checked
            );
            println!(
                "[Streamlink] Parent path exists: {}",
                diagnostics.parent_path_exists
            );
            println!("[Streamlink] === END DIAGNOSTICS ===");

            return Err(anyhow::anyhow!(
                "Streamlink executable not found at: '{}'. Expected location: streamlink/bin/streamlinkw.exe relative to the app. Exe dir: {:?}",
                path,
                diagnostics.exe_directory
            ));
        }

        // Build command with enhanced Streamlink options from settings
        let mut cmd = Command::new(path);
        cmd.arg(url).arg(quality).arg("--stream-url");

        // Apply low latency mode if enabled
        if settings.low_latency_enabled {
            cmd.arg("--twitch-low-latency");
        }

        // Configure HLS live edge (how close to live we want to be)
        cmd.arg("--hls-live-edge")
            .arg(settings.hls_live_edge.to_string());

        // Set stream timeout
        cmd.arg("--stream-timeout")
            .arg(settings.stream_timeout.to_string());

        // Apply retry settings (retry-streams is for how many times to retry)
        if settings.retry_streams > 0 {
            cmd.arg("--retry-streams")
                .arg(settings.retry_streams.to_string());
        }

        // Disable hosting if configured
        if settings.disable_hosting {
            cmd.arg("--twitch-disable-hosting");
        }

        // Skip SSL verification if configured
        if settings.skip_ssl_verify {
            cmd.arg("--http-no-ssl-verify");
        }

        // Add user-defined args (like ttvlol proxy args)
        // NOTE: We DON'T add settings.proxy_playlist separately because
        // the ttvlol args are already in `args` when ttvlol_plugin is enabled.
        // Adding both would cause duplicate arguments error.
        if !args.is_empty() {
            println!("[Streamlink] Adding custom args: {}", args);
            cmd.args(args.split_whitespace());
        }

        let output = cmd.output().await.context("Failed to run Streamlink")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!(
                "Streamlink failed (path: '{}', url: '{}', quality: '{}'): {}",
                path,
                url,
                quality,
                stderr
            ));
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    // Keep legacy method for backwards compatibility
    pub async fn get_stream_url(
        url: &str,
        quality: &str,
        path: &str,
        args: &str,
    ) -> Result<String> {
        // Use default settings for backwards compatibility
        let settings = crate::models::settings::StreamlinkSettings::default();
        Self::get_stream_url_with_settings(url, quality, path, args, &settings).await
    }

    pub async fn get_stream_metadata(url: &str, path: &str) -> Result<StreamMetadata> {
        let output = Command::new(path)
            .arg(url)
            .arg("--json")
            .arg("--stream-metadata")
            .output()
            .await?;

        let json: serde_json::Value = serde_json::from_slice(&output.stdout)?;

        Ok(StreamMetadata {
            title: json["metadata"]["title"].as_str().map(String::from),
            author: json["metadata"]["author"].as_str().map(String::from),
            game: json["metadata"]["game"].as_str().map(String::from),
            viewers: json["metadata"]["viewers"].as_i64().map(|v| v as i32),
        })
    }

    pub async fn get_qualities(url: &str, path: &str) -> Result<Vec<String>> {
        let output = Command::new(path).arg(url).arg("--json").output().await?;

        let json: serde_json::Value = serde_json::from_slice(&output.stdout)?;
        let qualities: Vec<String> = json["streams"]
            .as_object()
            .ok_or(anyhow::anyhow!("No streams"))?
            .keys()
            .cloned()
            .collect();

        Ok(qualities)
    }
}
