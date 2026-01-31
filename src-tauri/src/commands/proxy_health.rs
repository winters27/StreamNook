// Proxy health check commands
use crate::services::proxy_health::{
    check_all_proxies, generate_best_proxy_args, get_bundled_proxies, ProxyHealthCheckResponse,
    ProxyList,
};
use log::info;

/// Get the bundled list of proxy servers
#[tauri::command]
pub fn get_proxy_list() -> ProxyList {
    info!("[ProxyCmd] Getting bundled proxy list");
    get_bundled_proxies()
}

/// Check health of all proxies and return results with best proxy recommendation
#[tauri::command]
pub async fn check_proxy_health() -> Result<ProxyHealthCheckResponse, String> {
    info!("[ProxyCmd] Starting proxy health check");
    Ok(check_all_proxies().await)
}

/// Generate streamlink proxy args from health check results
/// Uses the top N fastest proxies
#[tauri::command]
pub fn generate_optimal_proxy_args(
    results: ProxyHealthCheckResponse,
    max_proxies: Option<usize>,
) -> String {
    let max = max_proxies.unwrap_or(3);
    info!("[ProxyCmd] Generating optimal proxy args (max: {})", max);
    generate_best_proxy_args(&results, max)
}
