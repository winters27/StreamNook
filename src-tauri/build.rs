use std::env;
use std::fs;
use std::path::Path;

fn main() {
    // Load .env file from project root to inject admin IDs at compile time
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let project_root = Path::new(&manifest_dir).parent().unwrap_or(Path::new("."));

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
                    let value = value.trim();

                    // Only pass through specific variables we need
                    if key == "VITE_ADMIN_USER_ID" {
                        println!("cargo:rustc-env={}={}", key, value);
                        println!("cargo:warning=Loaded {} from .env", key);
                    }
                }
            }
        }
    }

    // Also check if env var is already set (e.g., from CI)
    // This takes precedence over .env file
    if let Ok(admin_id) = env::var("VITE_ADMIN_USER_ID") {
        println!("cargo:rustc-env=VITE_ADMIN_USER_ID={}", admin_id);
        println!("cargo:warning=Using VITE_ADMIN_USER_ID from environment");
    }

    // Tell Cargo to rerun this build script if .env changes
    println!("cargo:rerun-if-changed=../.env");
    println!("cargo:rerun-if-env-changed=VITE_ADMIN_USER_ID");

    tauri_build::build()
}
