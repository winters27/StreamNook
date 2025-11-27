use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
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
    pub async fn get_stream_url_with_settings(
        url: &str,
        quality: &str,
        path: &str,
        args: &str,
        settings: &crate::models::settings::StreamlinkSettings,
    ) -> Result<String> {
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
