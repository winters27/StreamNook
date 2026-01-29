use anyhow::Result;
use cfspeedtest::speedtest::{fetch_metadata, test_download, test_latency, test_upload};
use cfspeedtest::OutputFormat;
use log::debug;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Live speed update for real-time display
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveSpeedUpdate {
    pub current_mbps: f64,
    pub phase: String, // "download" | "upload"
    pub iteration: usize,
    pub total_iterations: usize,
}

/// Baseline speed test result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaselineSpeedResult {
    pub download_mbps: f64,
    pub upload_mbps: f64,
    pub latency_ms: i32,
    pub jitter_ms: i32,
    pub stability_score: i32,
    pub test_server: String,
    pub timestamp: String,
}

/// Baseline speed test using Cloudflare's speed test infrastructure via cfspeedtest crate
pub struct BaselineSpeedService;

impl BaselineSpeedService {
    /// Run a comprehensive speed test using cfspeedtest crate
    pub async fn run_download_test(_duration_seconds: u32) -> Result<BaselineSpeedResult> {
        debug!("[BaselineSpeed] Starting Cloudflare speed test...");

        // Run the test in a blocking task since cfspeedtest is synchronous
        let result = tokio::task::spawn_blocking(|| Self::run_cfspeedtest()).await??;

        Ok(result)
    }

    /// Run cfspeedtest (blocking)
    fn run_cfspeedtest() -> Result<BaselineSpeedResult> {
        let client = reqwest::blocking::Client::new();

        // Fetch metadata about the connection
        let metadata = fetch_metadata(&client)?;
        debug!(
            "[BaselineSpeed] Connected to Cloudflare - Location: {}, IP: {}",
            metadata.colo, metadata.ip
        );

        // Run latency test (returns average in ms)
        debug!("[BaselineSpeed] Testing latency...");
        let latency = test_latency(&client);
        debug!("[BaselineSpeed] Latency: {:.1}ms", latency);

        // Run multiple download tests with different payload sizes for accuracy
        // Using larger payloads and multiple iterations for better measurement
        debug!("[BaselineSpeed] Testing download speed (this may take 15-20 seconds)...");
        let mut download_speeds = Vec::new();

        // Configuration for thorough testing:
        // - 25MB x 2 iterations = 50MB (warmup + initial measurement)
        // - 100MB x 2 iterations = 200MB (main measurement)
        // Total: ~250MB downloaded for accurate results
        let test_configs: [(usize, &str, usize); 2] = [
            (25_000_000, "25MB", 2),   // 2 warmup iterations
            (100_000_000, "100MB", 2), // 2 main iterations
        ];

        for (size, label, iterations) in test_configs {
            for i in 1..=iterations {
                let speed = test_download(&client, size, OutputFormat::None);
                debug!("[BaselineSpeed] Download ({label} #{i}): {:.2} Mbps", speed);
                download_speeds.push(speed);
            }
        }

        // Use the average of all tests
        let download_mbps = if download_speeds.is_empty() {
            0.0
        } else {
            download_speeds.iter().sum::<f64>() / download_speeds.len() as f64
        };

        // Calculate stability score based on variance
        let stability_score = Self::calculate_stability(&download_speeds);
        debug!("[BaselineSpeed] Stability: {}%", stability_score);

        // Run upload tests (smaller but still multiple iterations)
        debug!("[BaselineSpeed] Testing upload speed...");
        let mut upload_speeds = Vec::new();
        for i in 1..=3 {
            let speed = test_upload(&client, 5_000_000, OutputFormat::None); // 5MB x 3 = 15MB
            debug!("[BaselineSpeed] Upload (5MB #{i}): {:.2} Mbps", speed);
            upload_speeds.push(speed);
        }
        let upload_mbps = if upload_speeds.is_empty() {
            0.0
        } else {
            upload_speeds.iter().sum::<f64>() / upload_speeds.len() as f64
        };

        let server_info = format!("Cloudflare {} ({})", metadata.colo, metadata.country);

        debug!(
            "[BaselineSpeed] Test complete: {:.2} Mbps down, {:.2} Mbps up, {}ms latency",
            download_mbps, upload_mbps, latency as i32
        );

        Ok(BaselineSpeedResult {
            download_mbps,
            upload_mbps,
            latency_ms: latency as i32,
            jitter_ms: 0, // cfspeedtest doesn't provide jitter directly
            stability_score,
            test_server: server_info,
            timestamp: chrono::Utc::now().to_rfc3339(),
        })
    }

    /// Calculate stability score (0-100) based on variance in measurements
    fn calculate_stability(speeds: &[f64]) -> i32 {
        if speeds.len() < 2 {
            return 100; // Can't calculate variance with < 2 samples
        }

        let avg = speeds.iter().sum::<f64>() / speeds.len() as f64;
        if avg <= 0.0 {
            return 0;
        }

        let variance = speeds.iter().map(|&x| (x - avg).powi(2)).sum::<f64>() / speeds.len() as f64;
        let std_dev = variance.sqrt();
        let coefficient_of_variation = (std_dev / avg) * 100.0;

        // Lower variation = higher stability
        // CV of 0% = 100% stable, CV of 50%+ = 0% stable
        let stability = (100.0 - coefficient_of_variation.min(100.0)).max(0.0);
        stability as i32
    }

    /// Run a latency-only test (faster)
    pub async fn run_latency_test(_num_samples: u32) -> Result<(i32, i32)> {
        let result = tokio::task::spawn_blocking(|| {
            let client = reqwest::blocking::Client::new();
            let latency = test_latency(&client);
            Ok::<(i32, i32), anyhow::Error>((latency as i32, 0)) // (latency, jitter - not available)
        })
        .await??;

        debug!("[BaselineSpeed] Latency: {}ms", result.0);
        Ok(result)
    }

    /// Quick speed test with live updates - uses cfspeedtest for accurate results
    pub async fn run_quick_test(app_handle: AppHandle) -> Result<BaselineSpeedResult> {
        debug!("[BaselineSpeed] Starting Cloudflare speed test with live updates...");

        // Create a channel for live speed updates
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<LiveSpeedUpdate>();

        // Clone app_handle for the event emission task
        let app_for_events = app_handle.clone();

        // Spawn a task to forward events to frontend
        let event_task = tokio::spawn(async move {
            while let Some(update) = rx.recv().await {
                let _ = app_for_events.emit("speed-test-live-update", &update);
            }
        });

        // Run the test in a blocking task since cfspeedtest is synchronous
        let result =
            tokio::task::spawn_blocking(move || Self::run_cfspeedtest_with_events(tx)).await??;

        // Wait for event task to finish
        let _ = event_task.await;

        Ok(result)
    }

    /// Run cfspeedtest with live event emission (blocking)
    fn run_cfspeedtest_with_events(
        tx: tokio::sync::mpsc::UnboundedSender<LiveSpeedUpdate>,
    ) -> Result<BaselineSpeedResult> {
        let client = reqwest::blocking::Client::new();

        // Fetch metadata about the connection
        let metadata = fetch_metadata(&client)?;
        debug!(
            "[BaselineSpeed] Connected to Cloudflare - Location: {}, IP: {}",
            metadata.colo, metadata.ip
        );

        // Run latency test (returns average in ms)
        debug!("[BaselineSpeed] Testing latency...");
        let latency = test_latency(&client);
        debug!("[BaselineSpeed] Latency: {:.1}ms", latency);

        // Run multiple download tests with different payload sizes for accuracy
        debug!("[BaselineSpeed] Testing download speed (this may take 20-30 seconds)...");
        let mut download_speeds = Vec::new();

        // Configuration for thorough testing:
        // - 25MB x 2 iterations = 50MB (warmup)
        // - 100MB x 4 iterations = 400MB (main measurement)
        // Total: ~450MB downloaded for more accurate results
        let test_configs: [(usize, &str, usize); 2] = [
            (25_000_000, "25MB", 2),   // 2 warmup iterations
            (100_000_000, "100MB", 4), // 4 main iterations for better accuracy
        ];

        let total_download_iterations: usize = test_configs.iter().map(|(_, _, i)| *i).sum();
        let mut current_iteration = 0;

        for (size, label, iterations) in test_configs {
            for i in 1..=iterations {
                current_iteration += 1;
                let speed = test_download(&client, size, OutputFormat::None);
                debug!("[BaselineSpeed] Download ({label} #{i}): {:.2} Mbps", speed);
                download_speeds.push(speed);

                // Emit live update
                let _ = tx.send(LiveSpeedUpdate {
                    current_mbps: speed,
                    phase: "download".to_string(),
                    iteration: current_iteration,
                    total_iterations: total_download_iterations,
                });
            }
        }

        // Use the average of all tests
        let download_mbps = if download_speeds.is_empty() {
            0.0
        } else {
            download_speeds.iter().sum::<f64>() / download_speeds.len() as f64
        };

        // Calculate stability score based on variance
        let stability_score = Self::calculate_stability(&download_speeds);
        debug!("[BaselineSpeed] Stability: {}%", stability_score);

        // Run upload tests (smaller but still multiple iterations)
        debug!("[BaselineSpeed] Testing upload speed...");
        let mut upload_speeds = Vec::new();
        let total_upload_iterations = 3;
        for i in 1..=total_upload_iterations {
            let speed = test_upload(&client, 5_000_000, OutputFormat::None); // 5MB x 3 = 15MB
            debug!("[BaselineSpeed] Upload (5MB #{i}): {:.2} Mbps", speed);
            upload_speeds.push(speed);

            // Emit live update
            let _ = tx.send(LiveSpeedUpdate {
                current_mbps: speed,
                phase: "upload".to_string(),
                iteration: i,
                total_iterations: total_upload_iterations,
            });
        }
        let upload_mbps = if upload_speeds.is_empty() {
            0.0
        } else {
            upload_speeds.iter().sum::<f64>() / upload_speeds.len() as f64
        };

        let server_info = format!("Cloudflare {} ({})", metadata.colo, metadata.country);

        debug!(
            "[BaselineSpeed] Test complete: {:.2} Mbps down, {:.2} Mbps up, {}ms latency",
            download_mbps, upload_mbps, latency as i32
        );

        Ok(BaselineSpeedResult {
            download_mbps,
            upload_mbps,
            latency_ms: latency as i32,
            jitter_ms: 0, // cfspeedtest doesn't provide jitter directly
            stability_score,
            test_server: server_info,
            timestamp: chrono::Utc::now().to_rfc3339(),
        })
    }
}
