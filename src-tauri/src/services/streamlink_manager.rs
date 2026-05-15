use anyhow::{Context, Result};
use log::debug;
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

        let effective_path = Self::get_effective_path(None);
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

    /// Get the effective streamlink path
    /// Priority: Custom folder (if set and valid) -> Bundled -> Development paths
    pub fn get_effective_path(custom_folder: Option<&str>) -> String {
        // Step 1: Check custom folder if provided
        if let Some(folder) = custom_folder {
            if !folder.is_empty() {
                let custom_path = PathBuf::from(folder);

                // Smart path resolution to handle users pointing to different levels
                let custom_exe = if custom_path.is_file() {
                    // User pointed directly to the executable
                    custom_path
                } else if custom_path.ends_with("bin") {
                    // User pointed to the bin directory
                    custom_path.join("streamlinkw.exe")
                } else if custom_path.join("bin").join("streamlinkw.exe").exists() {
                    // User pointed to the root streamlink directory (standard)
                    custom_path.join("bin").join("streamlinkw.exe")
                } else if custom_path.join("streamlinkw.exe").exists() {
                    // Fallback to searching the directory itself
                    custom_path.join("streamlinkw.exe")
                } else {
                    // Default fallback
                    custom_path.join("bin").join("streamlinkw.exe")
                };

                debug!("[StreamlinkManager] Checking custom path: {:?}", custom_exe);

                if custom_exe.exists() {
                    debug!(
                        "[StreamlinkManager] Using custom streamlink: {:?}",
                        custom_exe
                    );
                    return custom_exe.to_string_lossy().to_string();
                } else {
                    debug!("[StreamlinkManager] Custom path not found, falling back to bundled");
                }
            }
        }

        let bundled_path = Self::get_bundled_path();

        // Debug: log what paths we're checking
        debug!(
            "[StreamlinkManager] Checking bundled path: {:?}",
            bundled_path
        );

        // Check if bundled streamlink exists (production mode - relative to exe)
        if bundled_path.exists() {
            debug!(
                "[StreamlinkManager] Using bundled streamlink: {:?}",
                bundled_path
            );
            return bundled_path.to_string_lossy().to_string();
        }

        // Development mode: check current working directory and its parent (project root)
        // CWD in tauri dev is src-tauri/, so we also check parent for project root
        if let Ok(cwd) = std::env::current_dir() {
            debug!("[StreamlinkManager] CWD is: {:?}", cwd);

            // First check CWD itself
            let cwd_streamlink = cwd.join("streamlink").join("bin").join("streamlinkw.exe");
            if cwd_streamlink.exists() {
                debug!(
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
                debug!(
                    "[StreamlinkManager] Checking parent path: {:?}",
                    parent_streamlink
                );
                if parent_streamlink.exists() {
                    debug!(
                        "[StreamlinkManager] Using streamlink from parent: {:?}",
                        parent_streamlink
                    );
                    return parent_streamlink.to_string_lossy().to_string();
                }
            }
        }

        // No fallbacks - bundled streamlink must exist
        debug!(
            "[StreamlinkManager] ERROR: Bundled streamlink not found! Expected at: {:?}",
            bundled_path
        );

        // Log additional debug info for troubleshooting
        debug!("[StreamlinkManager] === DIAGNOSTIC INFO ===");
        if let Ok(exe) = std::env::current_exe() {
            debug!("[StreamlinkManager] Current exe: {:?}", exe);
            if let Some(parent) = exe.parent() {
                debug!("[StreamlinkManager] Exe parent dir: {:?}", parent);

                // List contents of parent directory
                if let Ok(entries) = std::fs::read_dir(parent) {
                    debug!("[StreamlinkManager] Contents of exe directory:");
                    for entry in entries.flatten() {
                        debug!("[StreamlinkManager]   - {:?}", entry.file_name());
                    }
                }

                // Check if streamlink folder exists
                let streamlink_dir = parent.join("streamlink");
                if streamlink_dir.exists() {
                    debug!("[StreamlinkManager] streamlink/ folder EXISTS");
                    if let Ok(entries) = std::fs::read_dir(&streamlink_dir) {
                        debug!("[StreamlinkManager] Contents of streamlink/:");
                        for entry in entries.flatten() {
                            debug!("[StreamlinkManager]   - {:?}", entry.file_name());
                        }
                    }

                    let bin_dir = streamlink_dir.join("bin");
                    if bin_dir.exists() {
                        debug!("[StreamlinkManager] streamlink/bin/ folder EXISTS");
                        if let Ok(entries) = std::fs::read_dir(&bin_dir) {
                            debug!("[StreamlinkManager] Contents of streamlink/bin/:");
                            for entry in entries.flatten() {
                                debug!("[StreamlinkManager]   - {:?}", entry.file_name());
                            }
                        }
                    } else {
                        debug!("[StreamlinkManager] streamlink/bin/ folder DOES NOT EXIST");
                    }
                } else {
                    debug!("[StreamlinkManager] streamlink/ folder DOES NOT EXIST");
                }
            }
        }
        debug!("[StreamlinkManager] === END DIAGNOSTIC INFO ===");

        // Return the bundled path anyway - let the error propagate when trying to run
        bundled_path.to_string_lossy().to_string()
    }

    /// Check if bundled streamlink is available
    pub fn is_bundled_available() -> bool {
        Self::get_bundled_path().exists()
    }

    /// Get the plugins directory with 3-step resolution:
    /// 1. Check <custom_folder>/plugins (for Portable Streamlink)
    /// 2. Check %APPDATA%/streamlink/plugins (for Standard Installed Streamlink)
    /// 3. Fallback to Bundled location (<exe_directory>/streamlink/plugins/)
    pub fn get_plugins_directory(custom_folder: Option<&str>) -> Option<String> {
        // Step 1: Check custom folder plugins (for Portable versions)
        if let Some(folder) = custom_folder {
            if !folder.is_empty() {
                let user_path = PathBuf::from(folder);

                // Determine the base streamlink directory from the provided path
                let base_dir = if user_path.is_file() {
                    // C:/.../streamlink/bin/streamlinkw.exe -> C:/.../streamlink
                    user_path.parent().and_then(|p| {
                        if p.ends_with("bin") {
                            p.parent()
                        } else {
                            Some(p)
                        }
                    })
                } else if user_path.ends_with("bin") {
                    // C:/.../streamlink/bin -> C:/.../streamlink
                    user_path.parent()
                } else {
                    // C:/.../streamlink
                    Some(user_path.as_path())
                };

                if let Some(base) = base_dir {
                    let custom_plugins = base.join("plugins");
                    if custom_plugins.exists() {
                        debug!(
                            "[StreamlinkManager] Found plugins in custom folder: {:?}",
                            custom_plugins
                        );
                        return Some(custom_plugins.to_string_lossy().to_string());
                    } else {
                        debug!(
                            "[StreamlinkManager] No plugins in custom folder {:?}, checking AppData...",
                            custom_plugins
                        );
                    }
                }
            }
        }

        // Step 2: Check User AppData for installed Streamlink plugins
        // This is where the standard installer puts plugins: %APPDATA%/streamlink/plugins
        if let Some(config_dir) = dirs::config_dir() {
            let appdata_plugins = config_dir.join("streamlink").join("plugins");
            if appdata_plugins.exists() {
                debug!(
                    "[StreamlinkManager] Found plugins in AppData: {:?}",
                    appdata_plugins
                );
                return Some(appdata_plugins.to_string_lossy().to_string());
            } else {
                debug!(
                    "[StreamlinkManager] No plugins in AppData {:?}, checking bundled...",
                    appdata_plugins
                );
            }
        }

        // Step 3: Fallback to bundled location (production)
        if let Some(exe_dir) = Self::get_exe_directory() {
            let plugins_path = exe_dir.join("streamlink").join("plugins");
            if plugins_path.exists() {
                debug!(
                    "[StreamlinkManager] Found plugins directory at bundled: {:?}",
                    plugins_path
                );
                return Some(plugins_path.to_string_lossy().to_string());
            }
        }

        // Development mode: check CWD and parent
        if let Ok(cwd) = std::env::current_dir() {
            let cwd_plugins = cwd.join("streamlink").join("plugins");
            if cwd_plugins.exists() {
                debug!(
                    "[StreamlinkManager] Found plugins directory at CWD: {:?}",
                    cwd_plugins
                );
                return Some(cwd_plugins.to_string_lossy().to_string());
            }

            if let Some(parent) = cwd.parent() {
                let parent_plugins = parent.join("streamlink").join("plugins");
                if parent_plugins.exists() {
                    debug!(
                        "[StreamlinkManager] Found plugins directory at parent: {:?}",
                        parent_plugins
                    );
                    return Some(parent_plugins.to_string_lossy().to_string());
                }
            }
        }

        debug!("[StreamlinkManager] No plugins directory found");
        None
    }

    pub async fn get_stream_url_with_settings(
        url: &str,
        quality: &str,
        path: &str,
        args: &str,
        settings: &crate::models::settings::StreamlinkSettings,
        oauth_token: Option<&str>,
    ) -> Result<String> {
        // Debug logging to understand what's being passed
        debug!("[Streamlink] Path: '{}'", path);
        debug!("[Streamlink] URL: '{}'", url);
        debug!("[Streamlink] Quality: '{}'", quality);
        debug!("[Streamlink] Args: '{}'", args);

        // Verify the path exists and log detailed info if not
        let path_exists = std::path::Path::new(path).exists();
        debug!("[Streamlink] Path exists: {}", path_exists);

        if !path_exists {
            // Log detailed diagnostic info when path doesn't exist
            let diagnostics = Self::get_diagnostics();
            debug!("[Streamlink] === STREAMLINK NOT FOUND DIAGNOSTICS ===");
            debug!(
                "[Streamlink] Exe directory: {:?}",
                diagnostics.exe_directory
            );
            debug!("[Streamlink] CWD: {:?}", diagnostics.cwd);
            debug!(
                "[Streamlink] Bundled path checked: {}",
                diagnostics.bundled_path_checked
            );
            debug!(
                "[Streamlink] Bundled path exists: {}",
                diagnostics.bundled_path_exists
            );
            debug!(
                "[Streamlink] CWD path checked: {:?}",
                diagnostics.cwd_path_checked
            );
            debug!(
                "[Streamlink] CWD path exists: {}",
                diagnostics.cwd_path_exists
            );
            debug!(
                "[Streamlink] Parent path checked: {:?}",
                diagnostics.parent_path_checked
            );
            debug!(
                "[Streamlink] Parent path exists: {}",
                diagnostics.parent_path_exists
            );
            debug!("[Streamlink] === END DIAGNOSTICS ===");

            return Err(anyhow::anyhow!(
                "Streamlink executable not found at: '{}'. Expected location: streamlink/bin/streamlinkw.exe relative to the app. Exe dir: {:?}",
                path,
                diagnostics.exe_directory
            ));
        }

        // Build command with enhanced Streamlink options from settings
        let mut cmd = Command::new(path);

        // For portable streamlink, explicitly specify where to find plugins
        // This is CRITICAL for ttvlol plugin to be loaded
        let is_vod_or_clip =
            url.contains("/videos/") || url.contains("/clip/") || url.contains("clips.twitch.tv");

        if !is_vod_or_clip {
            let plugins_dir =
                Self::get_plugins_directory(settings.custom_streamlink_path.as_deref());
            if let Some(ref plugin_path) = plugins_dir {
                if std::path::Path::new(plugin_path).exists() {
                    debug!("[Streamlink] Adding --plugin-dirs: {}", plugin_path);
                    cmd.arg("--plugin-dirs").arg(plugin_path);
                }
            }
        } else {
            debug!("[Streamlink] Bypassing custom plugins for VOD/Clip URL");
        }

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

        // Allow h265/AV1 in addition to h264 — needed because 1440p on
        // Enhanced Broadcasting channels is AV1-only.
        if settings.enhanced_codecs {
            cmd.arg("--twitch-supported-codecs=h264,h265,av1");
        }

        // Auth header → 1440p / 2160p tiers in the manifest.
        // `--webbrowser-timeout=2` bounds the worst case if Twitch ever
        // pushes streamlink into its client-integrity Chromium fallback.
        if let Some(token) = oauth_token {
            if !token.is_empty() {
                cmd.arg("--twitch-api-header")
                    .arg(format!("Authorization=OAuth {}", token));
                cmd.arg("--webbrowser-timeout=2");
            }
        }

        // Add user-defined args (like ttvlol proxy args)
        // NOTE: We DON'T add settings.proxy_playlist separately because
        // the ttvlol args are already in `args` when ttvlol_plugin is enabled.
        // Adding both would cause duplicate arguments error.
        if !args.is_empty() {
            debug!("[Streamlink] Adding custom args: {}", args);
            cmd.args(args.split_whitespace());
        }

        debug!("[Streamlink] Executing command...");

        // Bound the wait so a hung Streamlink subprocess can't lock the UI. We
        // pad on top of the user's `--stream-timeout` (default 60s) so
        // Streamlink's own timeout fires first with a useful error message —
        // the wrapper here only catches the case where Streamlink itself hangs
        // past its own deadline. Floor of 45s for users who lowered the setting
        // below what TTVLOL proxies typically need.
        let wrapper_secs = (settings.stream_timeout as u64).saturating_add(15).max(45);
        let timeout_duration = std::time::Duration::from_secs(wrapper_secs);
        let output = tokio::time::timeout(timeout_duration, cmd.output())
            .await
            .map_err(|_| anyhow::anyhow!(
                "Streamlink timed out after {} seconds. This may be due to slow proxy servers or network issues. Try disabling ttvlol plugin or check your network connection.",
                wrapper_secs
            ))?
            .context("Failed to run Streamlink")?;

        debug!(
            "[Streamlink] Command completed with status: {:?}",
            output.status
        );

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

        let full_output = String::from_utf8_lossy(&output.stdout);
        let url = full_output
            .lines()
            .filter(|l| !l.trim().is_empty())
            .next_back()
            .unwrap_or("")
            .trim()
            .to_string();

        if url.is_empty() {
            return Err(anyhow::anyhow!("Streamlink returned empty output"));
        }

        Ok(url)
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
        Self::get_stream_url_with_settings(url, quality, path, args, &settings, None).await
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
        Self::get_qualities_authed(url, path, None, true).await
    }

    /// Authed variant — passes the OAuth token and enhanced-codecs flag so the
    /// returned quality list matches what start_stream can actually fetch.
    /// Without these, the in-player quality menu won't even list 1440p / 2160p
    /// because Twitch hides them from anonymous + h264-only manifests.
    pub async fn get_qualities_authed(
        url: &str,
        path: &str,
        oauth_token: Option<&str>,
        enhanced_codecs: bool,
    ) -> Result<Vec<String>> {
        let mut cmd = Command::new(path);
        cmd.arg(url).arg("--json");
        if enhanced_codecs {
            cmd.arg("--twitch-supported-codecs=h264,h265,av1");
        }
        if let Some(token) = oauth_token {
            if !token.is_empty() {
                cmd.arg("--twitch-api-header")
                    .arg(format!("Authorization=OAuth {}", token));
                cmd.arg("--webbrowser-timeout=2");
            }
        }
        let output = cmd.output().await?;

        let json: serde_json::Value = serde_json::from_slice(&output.stdout)?;
        let mut qualities: Vec<String> = json["streams"]
            .as_object()
            .ok_or(anyhow::anyhow!("No streams"))?
            .keys()
            .cloned()
            .collect();

        sort_qualities_descending(&mut qualities);
        Ok(qualities)
    }

    /// Try the requested quality; on a quality-not-found error, fall back to the
    /// closest available quality. Returns (stream_url, actual_quality_used).
    pub async fn get_stream_url_with_fallback(
        url: &str,
        quality: &str,
        path: &str,
        args: &str,
        settings: &crate::models::settings::StreamlinkSettings,
        oauth_token: Option<&str>,
    ) -> Result<(String, String)> {
        match Self::get_stream_url_with_settings(url, quality, path, args, settings, oauth_token)
            .await
        {
            Ok(stream_url) => Ok((stream_url, quality.to_string())),
            Err(err) => {
                let err_text = format!("{:#}", err).to_lowercase();
                let is_quality_error = err_text.contains("could not be found")
                    || err_text.contains("specified stream");
                if !is_quality_error {
                    return Err(err);
                }

                let available = match Self::get_qualities_authed(
                    url,
                    path,
                    oauth_token,
                    settings.enhanced_codecs,
                )
                .await
                {
                    Ok(q) if !q.is_empty() => q,
                    _ => return Err(err),
                };

                let closest = match pick_closest_quality(quality, &available) {
                    Some(c) if !c.eq_ignore_ascii_case(quality) => c,
                    _ => return Err(err),
                };

                log::info!(
                    "[Streamlink] Quality '{}' unavailable; falling back to closest '{}'. Available: {:?}",
                    quality, closest, available
                );

                let stream_url = Self::get_stream_url_with_settings(
                    url,
                    &closest,
                    path,
                    args,
                    settings,
                    oauth_token,
                )
                .await?;
                Ok((stream_url, closest))
            }
        }
    }
}

/// Parse the leading resolution height from a quality string (e.g. "480p30" -> 480).
/// Returns None for non-resolution qualities like "best", "worst", "audio_only".
fn parse_quality_height(q: &str) -> Option<u32> {
    let digits: String = q
        .trim()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

/// Parse the framerate suffix from a quality string (e.g. "720p60" -> 60, "720p" -> None).
fn parse_quality_fps(q: &str) -> Option<u32> {
    let lower = q.trim().to_lowercase();
    let after_p = lower.split_once('p')?.1;
    let digits: String = after_p.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

/// Sort quality strings into the order we surface in the player's quality
/// menu. Resolutions come first, descending by height and then framerate
/// (so 1440p60 outranks 1080p60 outranks 720p60). The non-resolution
/// sentinels follow in a fixed order: `best` (shortcut for highest tier
/// available), then `audio_only`, then `worst`. Anything else falls at the
/// end alphabetically. Comparison is case-insensitive.
fn sort_qualities_descending(qualities: &mut [String]) {
    fn rank(q: &str) -> (u8, u32, u32, String) {
        // Lower outer-tuple element sorts earlier. We use four tiers:
        //   0 = numeric resolution (sort by -height, -fps)
        //   1 = "best"
        //   2 = "audio_only" / "audio-only" / "audio"
        //   3 = "worst"
        //   4 = unknown sentinel (alphabetical)
        let lower = q.trim().to_lowercase();
        if let Some(h) = parse_quality_height(&lower) {
            let fps = parse_quality_fps(&lower).unwrap_or(0);
            // Negate via u32::MAX - x so default ascending sort becomes descending.
            return (0, u32::MAX - h, u32::MAX - fps, String::new());
        }
        match lower.as_str() {
            "best" | "source" => (1, 0, 0, String::new()),
            "audio_only" | "audio-only" | "audio" => (2, 0, 0, String::new()),
            "worst" => (3, 0, 0, String::new()),
            _ => (4, 0, 0, lower),
        }
    }
    qualities.sort_by_key(|q| rank(q));
}

/// Pick the closest available quality to the requested one.
/// Tiebreak: prefer higher resolution, then closer (or higher) framerate.
pub fn pick_closest_quality(requested: &str, available: &[String]) -> Option<String> {
    if available.is_empty() {
        return None;
    }

    if let Some(exact) = available.iter().find(|q| q.eq_ignore_ascii_case(requested)) {
        return Some(exact.clone());
    }

    let req_height = match parse_quality_height(requested) {
        Some(h) => h,
        None => {
            return available
                .iter()
                .find(|q| q.eq_ignore_ascii_case("best"))
                .cloned()
                .or_else(|| available.first().cloned());
        }
    };
    let req_fps = parse_quality_fps(requested);

    let mut candidates: Vec<(&String, u32, Option<u32>)> = available
        .iter()
        .filter_map(|q| Some((q, parse_quality_height(q)?, parse_quality_fps(q))))
        .collect();

    if candidates.is_empty() {
        return available
            .iter()
            .find(|q| q.eq_ignore_ascii_case("best"))
            .cloned();
    }

    candidates.sort_by(|a, b| {
        let da = (a.1 as i64 - req_height as i64).abs();
        let db = (b.1 as i64 - req_height as i64).abs();
        da.cmp(&db)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| match (a.2, b.2, req_fps) {
                (Some(af), Some(bf), Some(rf)) => {
                    let fa = (af as i64 - rf as i64).abs();
                    let fb = (bf as i64 - rf as i64).abs();
                    fa.cmp(&fb).then_with(|| bf.cmp(&af))
                }
                (Some(af), Some(bf), None) => bf.cmp(&af),
                (Some(_), None, _) => std::cmp::Ordering::Less,
                (None, Some(_), _) => std::cmp::Ordering::Greater,
                (None, None, _) => std::cmp::Ordering::Equal,
            })
    });

    Some(candidates[0].0.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn picks_exact_when_present() {
        let avail = s(&["audio_only", "360p", "480p", "720p60", "best", "worst"]);
        assert_eq!(
            pick_closest_quality("480p", &avail).as_deref(),
            Some("480p")
        );
    }

    #[test]
    fn picks_closest_when_fps_suffix_missing() {
        // User saved "480p30", channel only offers "480p" (no fps suffix) etc.
        let avail = s(&["audio_only", "360p", "480p", "720p60", "best", "worst"]);
        assert_eq!(
            pick_closest_quality("480p30", &avail).as_deref(),
            Some("480p")
        );
    }

    #[test]
    fn picks_closest_when_height_missing() {
        // User saved "480p30", channel only has 360p and 720p.
        let avail = s(&["audio_only", "360p", "720p60", "best", "worst"]);
        // 480 - 360 = 120; 720 - 480 = 240. Closest is 360p.
        assert_eq!(
            pick_closest_quality("480p30", &avail).as_deref(),
            Some("360p")
        );
    }

    #[test]
    fn ties_prefer_higher_resolution() {
        // 360 and 600 are both 120 away from 480; prefer 600 (higher).
        let avail = s(&["360p", "600p", "best"]);
        assert_eq!(
            pick_closest_quality("480p30", &avail).as_deref(),
            Some("600p")
        );
    }

    #[test]
    fn picks_matching_fps_on_tie() {
        let avail = s(&["720p30", "720p60", "best"]);
        assert_eq!(
            pick_closest_quality("480p30", &avail).as_deref(),
            Some("720p30")
        );
    }

    #[test]
    fn best_request_with_only_best_falls_through() {
        let avail = s(&["360p", "best"]);
        assert_eq!(
            pick_closest_quality("best", &avail).as_deref(),
            Some("best")
        );
    }

    #[test]
    fn empty_available_returns_none() {
        assert_eq!(pick_closest_quality("480p30", &[]), None);
    }

    #[test]
    fn picks_1080p_when_user_wants_1440p_but_stream_only_has_1080() {
        // 1440p60 saved; channel maxes out at 1080p60. Fall down to 1080p60.
        let avail = s(&["audio_only", "480p30", "720p60", "1080p60", "best", "worst"]);
        assert_eq!(
            pick_closest_quality("1440p60", &avail).as_deref(),
            Some("1080p60")
        );
    }

    #[test]
    fn picks_1440p_when_offered() {
        // Channel offers 1440p (Twitch is rolling this out). User has 1440p60 saved.
        let avail = s(&["audio_only", "720p60", "1080p60", "1440p60", "best"]);
        assert_eq!(
            pick_closest_quality("1440p60", &avail).as_deref(),
            Some("1440p60")
        );
    }

    #[test]
    fn handles_bare_resolution_alias() {
        // User saved "480" (no `p`); channel uses "480p30". Picker must match.
        let avail = s(&["audio_only", "360p", "480p30", "720p60", "best"]);
        assert_eq!(
            pick_closest_quality("480", &avail).as_deref(),
            Some("480p30")
        );
    }

    // Dropdown values match Twitch's player UI ("480p30" etc.). Streamlink in
    // the wild returns one of two shapes for the same Twitch stream:
    //   - caedrel-style: "audio_only, 160p, 360p, 480p, 720p60, 1080p60, best"
    //   - nickmercs-style: "audio_only, 160p30, 360p30, 480p30, 720p60, 1080p60, best"
    // Both must reconcile silently with the dropdown's saved value.

    #[test]
    fn dropdown_value_matches_caedrel_format() {
        let avail = s(&[
            "audio_only",
            "160p",
            "360p",
            "480p",
            "720p60",
            "1080p60",
            "worst",
            "best",
        ]);
        assert_eq!(
            pick_closest_quality("480p30", &avail).as_deref(),
            Some("480p")
        );
        assert_eq!(
            pick_closest_quality("360p30", &avail).as_deref(),
            Some("360p")
        );
        assert_eq!(
            pick_closest_quality("160p30", &avail).as_deref(),
            Some("160p")
        );
    }

    #[test]
    fn dropdown_value_matches_nickmercs_format() {
        let avail = s(&[
            "audio_only",
            "160p30",
            "360p30",
            "480p30",
            "720p60",
            "1080p60",
            "worst",
            "best",
        ]);
        assert_eq!(
            pick_closest_quality("480p30", &avail).as_deref(),
            Some("480p30")
        );
    }

    #[test]
    fn high_tier_dropdown_finds_60fps_exact() {
        let avail = s(&[
            "audio_only",
            "160p",
            "360p",
            "480p",
            "720p60",
            "1080p60",
            "best",
        ]);
        assert_eq!(
            pick_closest_quality("1080p60", &avail).as_deref(),
            Some("1080p60")
        );
        assert_eq!(
            pick_closest_quality("720p60", &avail).as_deref(),
            Some("720p60")
        );
    }

    #[test]
    fn sorts_qualities_highest_resolution_first() {
        let mut q: Vec<String> = vec![
            "1080p60",
            "1440p60",
            "160p30",
            "360p30",
            "480p30",
            "720p60",
            "audio_only",
            "best",
            "worst",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        sort_qualities_descending(&mut q);
        assert_eq!(
            q,
            vec![
                "1440p60",
                "1080p60",
                "720p60",
                "480p30",
                "360p30",
                "160p30",
                "best",
                "audio_only",
                "worst",
            ]
        );
    }

    #[test]
    fn sort_breaks_height_ties_by_fps() {
        let mut q: Vec<String> = vec!["720p30", "720p60", "1080p30", "1080p60"]
            .into_iter()
            .map(String::from)
            .collect();
        sort_qualities_descending(&mut q);
        assert_eq!(q, vec!["1080p60", "1080p30", "720p60", "720p30"]);
    }
}
