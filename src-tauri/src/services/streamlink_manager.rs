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

        // Verify the path exists
        let path_exists = std::path::Path::new(path).exists();
        println!("[Streamlink] Path exists: {}", path_exists);

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

        // Add proxy settings if enabled (should be passed as custom args)
        if settings.use_proxy && !settings.proxy_playlist.is_empty() {
            cmd.args(settings.proxy_playlist.split_whitespace());
        }

        // Add user-defined args (like ttvlol)
        if !args.is_empty() {
            cmd.args(args.split_whitespace());
        }

        let output = cmd.output().await.context("Failed to run Streamlink")?;

        if !output.status.success() {
            return Err(anyhow::anyhow!(
                "Streamlink failed: {}",
                String::from_utf8_lossy(&output.stderr)
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
