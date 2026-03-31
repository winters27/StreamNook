use anyhow::Result;
use log::error;
use once_cell::sync::Lazy;
use rand::Rng;
use reqwest::Client;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::Mutex;
use warp::Filter;

pub struct StreamServer;

static SERVER_HANDLE: Lazy<Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));
static PROXY_URL: Lazy<Arc<Mutex<Option<String>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));
static CURRENT_PORT: Lazy<Arc<Mutex<Option<u16>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));

/// Global HTTP client with optimized connection pooling
static HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .tcp_keepalive(std::time::Duration::from_secs(15))
        .pool_idle_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .expect("Failed to build global HTTP client")
});

impl StreamServer {
    pub async fn start_proxy_server(stream_url: String) -> Result<u16> {
        // Check if server is already running
        let server_exists = SERVER_HANDLE.lock().await.is_some();

        if server_exists {
            // Server already running - just update the URL
            *PROXY_URL.lock().await = Some(stream_url);
            // Return the existing port by parsing it from a static variable
            return Self::get_current_port().await;
        }

        // Start new server
        let port = rand::rng().random_range(10000..20000);

        *PROXY_URL.lock().await = Some(stream_url);

        // Store the port
        *CURRENT_PORT.lock().await = Some(port);

        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let proxy_url_clone = PROXY_URL.clone();

        // Use a wildcard proxy that catches ALL paths so relative chunks are automatically mapped
        let proxy = warp::path::full()
            .and(warp::method())
            .and(warp::any().map(move || proxy_url_clone.clone()))
            .and_then(Self::dynamic_proxy_handler)
            .boxed();

        let handle = tokio::spawn(async move {
            warp::serve(proxy).run(addr).await;
        });

        *SERVER_HANDLE.lock().await = Some(handle);

        Ok(port)
    }

    async fn dynamic_proxy_handler(
        path: warp::path::FullPath,
        method: warp::http::Method,
        proxy_url: Arc<Mutex<Option<String>>>,
    ) -> Result<warp::http::Response<Vec<u8>>, warp::Rejection> {
        let manifest_url = proxy_url
            .lock()
            .await
            .clone()
            .ok_or_else(|| warp::reject::not_found())?;

        // Handle CORS Preflight INSTANTLY without hitting Twitch
        if method == warp::http::Method::OPTIONS {
            return Ok(warp::http::Response::builder()
                .status(200)
                .header("Access-Control-Allow-Origin", "*")
                .header("Access-Control-Allow-Methods", "GET, OPTIONS")
                .header("Access-Control-Allow-Headers", "*")
                .header("Access-Control-Max-Age", "86400")
                .body(vec![])
                .unwrap());
        }

        let request_path = path.as_str().trim_start_matches('/');

        // Map the local path to the upstream Twitch CDN
        let fetch_url = if request_path == "stream.m3u8" || request_path.is_empty() {
            manifest_url.clone()
        } else {
            // Extract query parameters from manifest_url (vital for Twitch auth on variant playlists!)
            let (url_without_query, query) = if let Some(q_idx) = manifest_url.find('?') {
                (&manifest_url[..q_idx], &manifest_url[q_idx..])
            } else {
                (manifest_url.as_str(), "")
            };

            // It's a chunk or variant request. Join with base URL of manifest_url (without query)
            let base_url = if let Some(last_slash) = url_without_query.rfind('/') {
                &url_without_query[..=last_slash]
            } else {
                url_without_query
            };
            format!("{}{}{}", base_url, request_path, query)
        };

        let response = match HTTP_CLIENT.get(&fetch_url).send().await {
            Ok(res) => res,
            Err(e) => {
                error!("[StreamServer] Upstream request failed: {}", e);
                return Ok(warp::http::Response::builder()
                    .status(502)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(vec![])
                    .unwrap());
            }
        };

        let status = response.status();
        let bytes = match response.bytes().await {
            Ok(b) => b.to_vec(),
            Err(e) => {
                error!("[StreamServer] Failed to read body bytes: {}", e);
                return Ok(warp::http::Response::builder()
                    .status(502)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(vec![])
                    .unwrap());
            }
        };

        // Determine content-type (chunks are video/MP2T, playlists are x-mpegURL)
        let content_type = if request_path.ends_with(".ts") {
            "video/MP2T"
        } else {
            "application/x-mpegURL"
        };

        Ok(warp::http::Response::builder()
            .status(status)
            .header("Content-Type", content_type)
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "GET, OPTIONS")
            .header("Access-Control-Allow-Headers", "*")
            .header(
                "Cache-Control",
                "no-cache, no-store, must-revalidate, max-age=0",
            )
            .header("Pragma", "no-cache")
            .header("Expires", "0")
            .body(bytes) // Return perfectly preserved source bytes!
            .unwrap())
    }

    async fn proxy_handler() -> Result<warp::http::Response<Vec<u8>>, warp::Rejection> {
        let url = PROXY_URL
            .lock()
            .await
            .clone()
            .ok_or_else(|| warp::reject::not_found())?;

        let response = match HTTP_CLIENT.get(&url).send().await {
            Ok(res) => res,
            Err(e) => {
                error!("[StreamServer] Upstream request failed: {}", e);
                return Ok(warp::http::Response::builder()
                    .status(502)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(vec![])
                    .unwrap());
            }
        };

        let status = response.status();
        let bytes = match response.bytes().await {
            Ok(b) => b.to_vec(),
            Err(e) => {
                error!("[StreamServer] Failed to read body bytes: {}", e);
                return Ok(warp::http::Response::builder()
                    .status(502)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(vec![])
                    .unwrap());
            }
        };

        let mut rewritten_bytes = bytes.clone();

        // Rewrite relative URLs to absolute URLs for VOD/Clip M3U8 manifests
        if let Ok(m3u8_str) = String::from_utf8(bytes) {
            if m3u8_str.starts_with("#EXTM3U") {
                let base_url = if let Some(last_slash) = url.rfind('/') {
                    &url[..=last_slash]
                } else {
                    &url
                };

                let mut new_m3u8 = String::with_capacity(m3u8_str.len() + 1024);
                for line in m3u8_str.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        new_m3u8.push('\n');
                        continue;
                    }
                    if trimmed.starts_with('#')
                        || trimmed.starts_with("http://")
                        || trimmed.starts_with("https://")
                    {
                        new_m3u8.push_str(line);
                        new_m3u8.push('\n');
                    } else {
                        new_m3u8.push_str(base_url);
                        new_m3u8.push_str(trimmed);
                        new_m3u8.push('\n');
                    }
                }
                rewritten_bytes = new_m3u8.into_bytes();
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
            .body(rewritten_bytes)
            .unwrap())
    }

    pub async fn stop() -> Result<()> {
        if let Some(handle) = SERVER_HANDLE.lock().await.take() {
            handle.abort();
        }
        *PROXY_URL.lock().await = None;
        *CURRENT_PORT.lock().await = None;
        Ok(())
    }

    async fn get_current_port() -> Result<u16> {
        CURRENT_PORT
            .lock()
            .await
            .ok_or_else(|| anyhow::anyhow!("No server running"))
    }
}
