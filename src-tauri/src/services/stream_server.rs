use anyhow::Result;
use warp::Filter;
use reqwest::Client;
use std::sync::Arc;
use tokio::sync::Mutex;
use std::net::SocketAddr;
use rand::Rng;
use once_cell::sync::Lazy;

pub struct StreamServer;

static SERVER_HANDLE: Lazy<Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));
static PROXY_URL: Lazy<Arc<Mutex<Option<String>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));

impl StreamServer {
    pub async fn start_proxy_server(stream_url: String) -> Result<u16> {
        let port = rand::rng().random_range(10000..20000);
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        
        *PROXY_URL.lock().await = Some(stream_url);
        
        let proxy_url_clone = PROXY_URL.clone();
        let handle = tokio::spawn(async move {
            let proxy = warp::path("stream.m3u8")
                .and(warp::any().map(move || proxy_url_clone.clone()))
                .and_then(Self::proxy_handler_with_url);
            warp::serve(proxy).run(addr).await;
        });
        
        *SERVER_HANDLE.lock().await = Some(handle);
        
        Ok(port)
    }

    async fn proxy_handler_with_url(proxy_url: Arc<Mutex<Option<String>>>) -> Result<impl warp::Reply, warp::Rejection> {
        let url = proxy_url.lock().await.clone().ok_or_else(|| warp::reject::not_found())?;
        let client = Client::new();
        let response = client.get(&url).send().await.map_err(|_| warp::reject::not_found())?;
        
        let bytes = response.bytes().await.map_err(|_| warp::reject::not_found())?.to_vec();
        
        Ok(warp::reply::with_header(
            warp::reply::with_header(
                warp::reply::with_header(
                    bytes,
                    "Content-Type",
                    "application/x-mpegURL",
                ),
                "Access-Control-Allow-Origin",
                "*",
            ),
            "Access-Control-Allow-Methods",
            "GET, OPTIONS",
        ))
    }

    async fn proxy_handler() -> Result<impl warp::Reply, warp::Rejection> {
        let url = PROXY_URL.lock().await.clone().ok_or_else(|| warp::reject::not_found())?;
        let client = Client::new();
        let response = client.get(&url).send().await.map_err(|_| warp::reject::not_found())?;
        
        let bytes = response.bytes().await.map_err(|_| warp::reject::not_found())?.to_vec();
        
        Ok(warp::reply::with_header(
            warp::reply::with_header(
                warp::reply::with_header(
                    bytes,
                    "Content-Type",
                    "application/x-mpegURL",
                ),
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
        Ok(())
    }
}
