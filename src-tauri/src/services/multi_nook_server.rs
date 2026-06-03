use crate::services::ad_detect;
use anyhow::Result;
use log::{debug, info};
use once_cell::sync::Lazy;
use rand::Rng;
use reqwest::Client;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::Mutex;
use warp::Filter;

/// Represents a single stream proxy instance
struct StreamInstance {
    handle: tokio::task::JoinHandle<()>,
    port: u16,
    proxy_url: Arc<Mutex<Option<String>>>,
    /// Per-tile ad-detection state (shared marker logic via `ad_detect`).
    ad_state: Arc<std::sync::Mutex<ad_detect::AdDetectionState>>,
}

pub struct MultiNookServer;

/// Registry of all active stream proxy instances, keyed by stream_id
static STREAM_REGISTRY: Lazy<Arc<Mutex<HashMap<String, StreamInstance>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

/// Global HTTP client with optimized connection pooling
static HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .tcp_keepalive(std::time::Duration::from_secs(15))
        .pool_idle_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("Failed to build global HTTP client")
});

impl MultiNookServer {
    /// Start a new proxy server for a specific stream, or update the URL if one already exists
    pub async fn start_proxy(stream_id: &str, stream_url: String) -> Result<u16> {
        let mut registry = STREAM_REGISTRY.lock().await;

        // If this stream_id already has a running server, just update the URL
        if let Some(instance) = registry.get(stream_id) {
            debug!(
                "[MultiNook] Updating proxy URL for stream '{}' on port {}",
                stream_id, instance.port
            );
            *instance.proxy_url.lock().await = Some(stream_url);
            // New stream on this tile: clear stale ad-detection state.
            *instance.ad_state.lock().unwrap() = ad_detect::AdDetectionState::default();
            return Ok(instance.port);
        }

        // Start a new server on a random port
        let port = rand::rng().random_range(10000..20000);
        let proxy_url: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(Some(stream_url)));
        let ad_state: Arc<std::sync::Mutex<ad_detect::AdDetectionState>> =
            Arc::new(std::sync::Mutex::new(ad_detect::AdDetectionState::default()));

        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let proxy_url_clone = proxy_url.clone();
        let ad_state_clone = ad_state.clone();
        let sid = stream_id.to_string();

        let proxy = warp::path("stream.m3u8")
            .and(warp::any().map(move || proxy_url_clone.clone()))
            .and(warp::any().map(move || ad_state_clone.clone()))
            .and(warp::any().map(move || sid.clone()))
            .and_then(Self::proxy_handler)
            .boxed();

        let handle = tokio::spawn(async move {
            warp::serve(proxy).run(addr).await;
        });

        debug!(
            "[MultiNook] Started proxy for stream '{}' on port {}",
            stream_id, port
        );

        registry.insert(
            stream_id.to_string(),
            StreamInstance {
                handle,
                port,
                proxy_url,
                ad_state,
            },
        );

        Ok(port)
    }

    /// Stop a specific stream's proxy server
    pub async fn stop_instance(stream_id: &str) -> Result<()> {
        let mut registry = STREAM_REGISTRY.lock().await;

        if let Some(instance) = registry.remove(stream_id) {
            debug!(
                "[MultiNook] Stopping proxy for stream '{}' on port {}",
                stream_id, instance.port
            );
            instance.handle.abort();
            *instance.proxy_url.lock().await = None;
        } else {
            debug!(
                "[MultiNook] No proxy found for stream '{}', nothing to stop",
                stream_id
            );
        }

        Ok(())
    }

    /// Stop all stream proxy servers (cleanup on exit or mode switch)
    pub async fn stop_all() -> Result<()> {
        let mut registry = STREAM_REGISTRY.lock().await;
        let count = registry.len();

        for (id, instance) in registry.drain() {
            debug!(
                "[MultiNook] Stopping proxy for stream '{}' on port {}",
                id, instance.port
            );
            instance.handle.abort();
            *instance.proxy_url.lock().await = None;
        }

        debug!("[MultiNook] Stopped {} proxy servers", count);
        Ok(())
    }

    /// Get the port for a specific stream
    pub async fn get_port(stream_id: &str) -> Option<u16> {
        let registry = STREAM_REGISTRY.lock().await;
        registry.get(stream_id).map(|i| i.port)
    }

    /// Get a list of all active stream IDs
    pub async fn get_active_streams() -> Vec<String> {
        let registry = STREAM_REGISTRY.lock().await;
        registry.keys().cloned().collect()
    }

    /// Get the count of active stream proxies
    pub async fn active_count() -> usize {
        let registry = STREAM_REGISTRY.lock().await;
        registry.len()
    }

    /// Snapshot every tile's ad-detection state, keyed by stream_id (for a
    /// command / the future auto-pivot). Parity with the solo `ad_state()`.
    pub async fn ad_snapshot() -> HashMap<String, ad_detect::AdDetectionState> {
        let registry = STREAM_REGISTRY.lock().await;
        registry
            .iter()
            .map(|(id, inst)| (id.clone(), inst.ad_state.lock().unwrap().clone()))
            .collect()
    }

    async fn proxy_handler(
        proxy_url: Arc<Mutex<Option<String>>>,
        ad_state: Arc<std::sync::Mutex<ad_detect::AdDetectionState>>,
        stream_id: String,
    ) -> Result<warp::http::Response<Vec<u8>>, warp::Rejection> {
        let url = proxy_url
            .lock()
            .await
            .clone()
            .ok_or_else(|| warp::reject::not_found())?;

        let response = match HTTP_CLIENT.get(&url).send().await {
            Ok(res) => res,
            Err(e) => {
                debug!("[MultiNook] Upstream request failed: {}", e);
                return Ok(warp::http::Response::builder()
                    .status(502)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(vec![])
                    .unwrap());
            }
        };

        let status = response.status();
        let mut bytes = match response.bytes().await {
            Ok(b) => b.to_vec(),
            Err(e) => {
                debug!("[MultiNook] Failed to read body bytes: {}", e);
                return Ok(warp::http::Response::builder()
                    .status(502)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(vec![])
                    .unwrap());
            }
        };

        // Detect (for per-tile state) then strip leaked ad segments before the
        // tile's player sees them — same shared logic as the solo player. This
        // server only relays the media playlist (not .ts), so every body is a
        // playlist worth scanning/filtering; free, no extra requests.
        if let Ok(text) = std::str::from_utf8(&bytes) {
            {
                let mut st = ad_state.lock().unwrap();
                if let Some(n) = ad_detect::update(&mut st, text) {
                    info!(
                        "[MultiNook] ad markers detected on '{}' (break #{}): {:?}",
                        stream_id, n, st.matched_markers
                    );
                }
            }
            let (filtered, dropped, _real) = ad_detect::filter_ad_segments(text);
            if dropped > 0 {
                debug!(
                    "[MultiNook] '{}' stripped {} ad segment(s)",
                    stream_id, dropped
                );
                bytes = filtered.into_bytes();
            }
        }

        Ok(warp::http::Response::builder()
            .status(status)
            .header("Content-Type", "application/x-mpegURL")
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "GET, OPTIONS")
            .header(
                "Cache-Control",
                "no-cache, no-store, must-revalidate, max-age=0",
            )
            .header("Pragma", "no-cache")
            .header("Expires", "0")
            .body(bytes)
            .unwrap())
    }
}
