use anyhow::{Context, Result};
use tokio::process::Command;

pub struct StreamlinkManager;

impl StreamlinkManager {
    pub async fn get_stream_url(
        url: &str,
        quality: &str,
        path: &str,
        args: &str,
    ) -> Result<String> {
        let output = Command::new(path)
            .arg(url)
            .arg(quality)
            .arg("--stream-url")
            .args(args.split_whitespace())
            .output()
            .await
            .context("Failed to run Streamlink")?;

        if !output.status.success() {
            return Err(anyhow::anyhow!(
                "Streamlink failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
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
