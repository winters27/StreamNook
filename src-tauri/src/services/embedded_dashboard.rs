use rust_embed::RustEmbed;
use std::sync::atomic::{AtomicBool, Ordering};
use warp::Filter;

// Embed the analytics-dashboard/dist folder at compile time
// The folder must exist at build time, otherwise it embeds nothing
#[derive(RustEmbed)]
#[folder = "../analytics-dashboard/dist"]
#[prefix = ""]
pub struct AnalyticsDashboardAssets;

static DASHBOARD_RUNNING: AtomicBool = AtomicBool::new(false);

/// Check if the embedded dashboard has any files
pub fn has_embedded_dashboard() -> bool {
    AnalyticsDashboardAssets::iter().next().is_some()
}

/// Start the embedded dashboard server on port 5173
pub async fn start_embedded_dashboard() -> Result<(), String> {
    // Check if already running
    if DASHBOARD_RUNNING.load(Ordering::SeqCst) {
        return Ok(());
    }

    // Check if we have embedded files
    if !has_embedded_dashboard() {
        return Err("No embedded dashboard files found. Build the dashboard first with 'npm run build' in analytics-dashboard folder.".to_string());
    }

    // Mark as running
    DASHBOARD_RUNNING.store(true, Ordering::SeqCst);

    // Create warp filter to serve embedded files
    let static_files = warp::path::tail().and_then(serve_embedded_file);

    // Spawn the server in a background task
    tokio::spawn(async move {
        println!("[Dashboard] Starting embedded dashboard server on port 5173");
        warp::serve(static_files).run(([127, 0, 0, 1], 5173)).await;
    });

    // Give the server a moment to start
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    Ok(())
}

async fn serve_embedded_file(path: warp::path::Tail) -> Result<impl warp::Reply, warp::Rejection> {
    let path_str = path.as_str();

    // For root path or empty path, serve index.html
    let file_path = if path_str.is_empty() || path_str == "/" {
        "index.html"
    } else {
        path_str
    };

    // Try to get the file from embedded assets
    if let Some(file) = AnalyticsDashboardAssets::get(file_path) {
        let mime = mime_guess::from_path(file_path)
            .first_or_octet_stream()
            .to_string();

        return Ok(warp::reply::with_header(
            file.data.into_owned(),
            "Content-Type",
            mime,
        ));
    }

    // For SPA routing: if file not found, serve index.html
    // This handles client-side routing
    if let Some(index) = AnalyticsDashboardAssets::get("index.html") {
        return Ok(warp::reply::with_header(
            index.data.into_owned(),
            "Content-Type",
            "text/html",
        ));
    }

    Err(warp::reject::not_found())
}

/// Stop the dashboard server (not really possible with warp, but we can mark it as stopped)
pub fn stop_dashboard() {
    DASHBOARD_RUNNING.store(false, Ordering::SeqCst);
}

/// Check if the dashboard server is marked as running
pub fn is_dashboard_running() -> bool {
    DASHBOARD_RUNNING.load(Ordering::SeqCst)
}
