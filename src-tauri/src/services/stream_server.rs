use anyhow::Result;
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

        // Define filter outside spawn to avoid lifetime issues in warp 0.4
        let proxy = warp::path("stream.m3u8")
            .and(warp::any().map(move || proxy_url_clone.clone()))
            .and_then(Self::proxy_handler_with_url)
            .boxed();

        let handle = tokio::spawn(async move {
            warp::serve(proxy).run(addr).await;
        });

        *SERVER_HANDLE.lock().await = Some(handle);

        Ok(port)
    }

    async fn proxy_handler_with_url(
        proxy_url: Arc<Mutex<Option<String>>>,
    ) -> Result<impl warp::Reply, warp::Rejection> {
        let url = proxy_url
            .lock()
            .await
            .clone()
            .ok_or_else(|| warp::reject::not_found())?;
        let client = Client::new();
        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|_| warp::reject::not_found())?;

        let bytes = response
            .bytes()
            .await
            .map_err(|_| warp::reject::not_found())?
            .to_vec();

        Ok(warp::reply::with_header(
            warp::reply::with_header(
                warp::reply::with_header(bytes, "Content-Type", "application/x-mpegURL"),
                "Access-Control-Allow-Origin",
                "*",
            ),
            "Access-Control-Allow-Methods",
            "GET, OPTIONS",
        ))
    }

    async fn proxy_handler() -> Result<impl warp::Reply, warp::Rejection> {
        let url = PROXY_URL
            .lock()
            .await
            .clone()
            .ok_or_else(|| warp::reject::not_found())?;
        let client = Client::new();
        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|_| warp::reject::not_found())?;

        let bytes = response
            .bytes()
            .await
            .map_err(|_| warp::reject::not_found())?
            .to_vec();

        Ok(warp::reply::with_header(
            warp::reply::with_header(
                warp::reply::with_header(bytes, "Content-Type", "application/x-mpegURL"),
                "Access-Control-Allow-Origin",
                "*",
            ),
            "Access-Control-Allow-Methods",
            "GET, OPTIONS",
        ))
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
