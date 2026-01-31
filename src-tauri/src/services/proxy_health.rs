// Proxy health checking and smart selection
use log::{debug, info, warn};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

/// A proxy server entry from the bundled proxies.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyServer {
    pub id: String,
    pub url: String,
    pub name: String,
    pub region: String,
    pub provider: String,
    pub priority: u32,
}

/// Result of a health check on a single proxy
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyHealthResult {
    pub id: String,
    pub url: String,
    pub name: String,
    pub region: String,
    pub is_healthy: bool,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
    pub checked_at: String,
}

/// Aggregated proxy health check results
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyHealthCheckResponse {
    pub results: Vec<ProxyHealthResult>,
    pub best_proxy: Option<ProxyHealthResult>,
    pub check_duration_ms: u64,
    pub total_checked: usize,
    pub healthy_count: usize,
}

/// Bundled proxy list structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyList {
    pub version: String,
    #[serde(rename = "lastUpdated")]
    pub last_updated: String,
    pub proxies: Vec<ProxyServer>,
}

/// Get the bundled proxy list
pub fn get_bundled_proxies() -> ProxyList {
    // This is the bundled proxy list - matches src/data/proxies.json
    ProxyList {
        version: "1.0.0".to_string(),
        last_updated: "2026-01-30".to_string(),
        proxies: vec![
            ProxyServer {
                id: "cdn-perfprod-na".to_string(),
                url: "https://lb-na.cdn-perfprod.com".to_string(),
                name: "CDN PerfProd NA".to_string(),
                region: "NA".to_string(),
                provider: "TTV-LOL-PRO".to_string(),
                priority: 1,
            },
            ProxyServer {
                id: "cdn-perfprod-eu".to_string(),
                url: "https://lb-eu.cdn-perfprod.com".to_string(),
                name: "CDN PerfProd EU".to_string(),
                region: "EU".to_string(),
                provider: "TTV-LOL-PRO".to_string(),
                priority: 2,
            },
            ProxyServer {
                id: "cdn-perfprod-eu2".to_string(),
                url: "https://lb-eu2.cdn-perfprod.com".to_string(),
                name: "CDN PerfProd EU 2".to_string(),
                region: "EU".to_string(),
                provider: "TTV-LOL-PRO".to_string(),
                priority: 3,
            },
            ProxyServer {
                id: "cdn-perfprod-eu3".to_string(),
                url: "https://lb-eu3.cdn-perfprod.com".to_string(),
                name: "CDN PerfProd EU 3 (Russia)".to_string(),
                region: "RU".to_string(),
                provider: "TTV-LOL-PRO".to_string(),
                priority: 4,
            },
            ProxyServer {
                id: "cdn-perfprod-eu4".to_string(),
                url: "https://lb-eu4.cdn-perfprod.com".to_string(),
                name: "CDN PerfProd EU 4".to_string(),
                region: "EU".to_string(),
                provider: "TTV-LOL-PRO".to_string(),
                priority: 5,
            },
            ProxyServer {
                id: "cdn-perfprod-eu5".to_string(),
                url: "https://lb-eu5.cdn-perfprod.com".to_string(),
                name: "CDN PerfProd EU 5".to_string(),
                region: "EU".to_string(),
                provider: "TTV-LOL-PRO".to_string(),
                priority: 6,
            },
            ProxyServer {
                id: "cdn-perfprod-as".to_string(),
                url: "https://lb-as.cdn-perfprod.com".to_string(),
                name: "CDN PerfProd Asia".to_string(),
                region: "AS".to_string(),
                provider: "TTV-LOL-PRO".to_string(),
                priority: 7,
            },
            ProxyServer {
                id: "cdn-perfprod-sa".to_string(),
                url: "https://lb-sa.cdn-perfprod.com".to_string(),
                name: "CDN PerfProd SA".to_string(),
                region: "SA".to_string(),
                provider: "TTV-LOL-PRO".to_string(),
                priority: 8,
            },
            ProxyServer {
                id: "luminous-eu".to_string(),
                url: "https://eu.luminous.dev".to_string(),
                name: "Luminous EU".to_string(),
                region: "EU".to_string(),
                provider: "luminous-ttv".to_string(),
                priority: 9,
            },
            ProxyServer {
                id: "luminous-eu2".to_string(),
                url: "https://eu2.luminous.dev".to_string(),
                name: "Luminous EU 2".to_string(),
                region: "EU".to_string(),
                provider: "luminous-ttv".to_string(),
                priority: 10,
            },
            ProxyServer {
                id: "luminous-as".to_string(),
                url: "https://as.luminous.dev".to_string(),
                name: "Luminous Asia".to_string(),
                region: "AS".to_string(),
                provider: "luminous-ttv".to_string(),
                priority: 11,
            },
            ProxyServer {
                id: "nadeko-ru".to_string(),
                url: "https://twitch.nadeko.net".to_string(),
                name: "Nadeko RU".to_string(),
                region: "RU".to_string(),
                provider: "community".to_string(),
                priority: 12,
            },
        ],
    }
}

/// Check health of a single proxy by making an HTTP HEAD request
async fn check_proxy_health(client: &Client, proxy: &ProxyServer) -> ProxyHealthResult {
    let start = Instant::now();
    let checked_at = chrono::Utc::now().to_rfc3339();

    // We test the proxy by hitting its base URL or a known endpoint
    // TTV-LOL uses /ping or just accepts HEAD requests on root
    let test_url = format!("{}/ping", proxy.url);

    debug!("[ProxyHealth] Checking {} ({})", proxy.name, test_url);

    match client
        .head(&test_url)
        .timeout(Duration::from_secs(5))
        .send()
        .await
    {
        Ok(response) => {
            let latency = start.elapsed().as_millis() as u64;
            let is_healthy = response.status().is_success() || response.status().as_u16() == 404;
            // 404 is acceptable since /ping might not exist, but server is reachable

            debug!(
                "[ProxyHealth] {} - Status: {}, Latency: {}ms",
                proxy.name,
                response.status(),
                latency
            );

            ProxyHealthResult {
                id: proxy.id.clone(),
                url: proxy.url.clone(),
                name: proxy.name.clone(),
                region: proxy.region.clone(),
                is_healthy,
                latency_ms: Some(latency),
                error: if !is_healthy {
                    Some(format!("HTTP {}", response.status()))
                } else {
                    None
                },
                checked_at,
            }
        }
        Err(e) => {
            let latency = start.elapsed().as_millis() as u64;
            warn!("[ProxyHealth] {} failed: {}", proxy.name, e);

            ProxyHealthResult {
                id: proxy.id.clone(),
                url: proxy.url.clone(),
                name: proxy.name.clone(),
                region: proxy.region.clone(),
                is_healthy: false,
                latency_ms: Some(latency), // Include latency even on failure for timeout detection
                error: Some(e.to_string()),
                checked_at,
            }
        }
    }
}

/// Check health of all bundled proxies and return the best one
pub async fn check_all_proxies() -> ProxyHealthCheckResponse {
    let start = Instant::now();
    let proxies = get_bundled_proxies();

    info!(
        "[ProxyHealth] Starting health check for {} proxies",
        proxies.proxies.len()
    );

    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    // Check all proxies concurrently
    let futures: Vec<_> = proxies
        .proxies
        .iter()
        .map(|p| check_proxy_health(&client, p))
        .collect();

    let results = futures::future::join_all(futures).await;

    let healthy_count = results.iter().filter(|r| r.is_healthy).count();
    let total_checked = results.len();

    // Find the best proxy (healthy + lowest latency)
    let best_proxy = results
        .iter()
        .filter(|r| r.is_healthy)
        .min_by(|a, b| {
            a.latency_ms
                .unwrap_or(u64::MAX)
                .cmp(&b.latency_ms.unwrap_or(u64::MAX))
        })
        .cloned();

    let check_duration_ms = start.elapsed().as_millis() as u64;

    info!(
        "[ProxyHealth] Check complete: {}/{} healthy, best: {:?} ({}ms total)",
        healthy_count,
        total_checked,
        best_proxy.as_ref().map(|p| &p.name),
        check_duration_ms
    );

    ProxyHealthCheckResponse {
        results,
        best_proxy,
        check_duration_ms,
        total_checked,
        healthy_count,
    }
}

/// Generate the streamlink proxy argument string from a list of proxy URLs
pub fn generate_proxy_args(proxy_urls: &[String], include_fallback: bool) -> String {
    if proxy_urls.is_empty() {
        return String::new();
    }

    let urls_str = proxy_urls.join(",");
    let mut args = format!("--twitch-proxy-playlist={}", urls_str);

    if include_fallback {
        args.push_str(" --twitch-proxy-playlist-fallback");
    }

    args
}

/// Generate proxy args using the best N healthy proxies
pub fn generate_best_proxy_args(results: &ProxyHealthCheckResponse, max_proxies: usize) -> String {
    let mut healthy: Vec<_> = results.results.iter().filter(|r| r.is_healthy).collect();

    // Sort by latency (lowest first)
    healthy.sort_by(|a, b| {
        a.latency_ms
            .unwrap_or(u64::MAX)
            .cmp(&b.latency_ms.unwrap_or(u64::MAX))
    });

    let urls: Vec<String> = healthy
        .into_iter()
        .take(max_proxies)
        .map(|r| r.url.clone())
        .collect();

    generate_proxy_args(&urls, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bundled_proxies_not_empty() {
        let proxies = get_bundled_proxies();
        assert!(!proxies.proxies.is_empty());
        assert!(proxies.proxies.len() >= 10);
    }

    #[test]
    fn test_generate_proxy_args() {
        let urls = vec![
            "https://proxy1.com".to_string(),
            "https://proxy2.com".to_string(),
        ];

        let args = generate_proxy_args(&urls, true);
        assert!(args.contains("--twitch-proxy-playlist="));
        assert!(args.contains("proxy1.com"));
        assert!(args.contains("proxy2.com"));
        assert!(args.contains("--twitch-proxy-playlist-fallback"));
    }
}
