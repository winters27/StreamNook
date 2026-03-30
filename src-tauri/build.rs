use std::env;
use std::fs;
use std::path::Path;

fn main() {
    // Load .env file from project root to inject admin IDs at compile time
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let project_root = Path::new(&manifest_dir).parent().unwrap_or(Path::new("."));

    // Keys we want to extract from .env or environment variables
    let allowed_keys = vec![
        "VITE_ADMIN_USER_ID",
        "TWITCH_APP_CLIENT_ID",
        "TWITCH_APP_CLIENT_SECRET",
        "TWITCH_ANDROID_CLIENT_ID",
        "TWITCH_WEB_CLIENT_ID",
        "DISCORD_WEBHOOK_URL",
    ];

    // Try loading from project root .env file
    let env_path = project_root.join(".env");
    if env_path.exists() {
        if let Ok(contents) = fs::read_to_string(&env_path) {
            for line in contents.lines() {
                let line = line.trim();
                // Skip comments and empty lines
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }

                // Parse KEY=VALUE
                if let Some((key, value)) = line.split_once('=') {
                    let key = key.trim();
                    let value = value.trim().trim_matches('"').trim_matches('\'');

                    // Only pass through specific variables we need
                    if allowed_keys.contains(&key) {
                        println!("cargo:rustc-env={}={}", key, value);
                    }
                }
            }
        }
    }

    // Also check if env vars are already set (e.g., from CI)
    // This takes precedence over .env file
    for key in &allowed_keys {
        if let Ok(val) = env::var(key) {
            println!("cargo:rustc-env={}={}", key, val);
        }
    }

    // Tell Cargo to rerun this build script if .env changes
    println!("cargo:rerun-if-changed=../.env");
    for key in allowed_keys {
        println!("cargo:rerun-if-env-changed={}", key);
    }

    tauri_build::build()
}
