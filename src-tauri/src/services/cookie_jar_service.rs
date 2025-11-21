use anyhow::Result;
use cookie_store::{CookieStore, RawCookie};
use reqwest::{Client, ClientBuilder};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use url::Url;

/// Cookie jar paths for different auth contexts
const MAIN_COOKIES_FILE: &str = "cookies.json";
const DROPS_COOKIES_FILE: &str = "cookies_drops.json";

/// A service for managing persistent HTTP cookies similar to TwitchDropsMiner's cookies.jar
pub struct CookieJarService {
    store: Arc<Mutex<CookieStore>>,
    file_path: PathBuf,
}

impl CookieJarService {
    /// Create a new cookie jar service for the main app authentication
    pub fn new_main() -> Result<Self> {
        let file_path = Self::get_cookies_path(MAIN_COOKIES_FILE)?;
        Self::new_with_path(file_path)
    }

    /// Create a new cookie jar service for drops authentication
    pub fn new_drops() -> Result<Self> {
        let file_path = Self::get_cookies_path(DROPS_COOKIES_FILE)?;
        Self::new_with_path(file_path)
    }

    /// Create a cookie jar with a specific path
    fn new_with_path(file_path: PathBuf) -> Result<Self> {
        let store = if file_path.exists() {
            // Load existing cookies
            println!("[COOKIE_JAR] Loading cookies from: {:?}", file_path);
            match Self::load_from_file(&file_path) {
                Ok(store) => {
                    println!("[COOKIE_JAR] ✅ Loaded {} cookies", store.iter_any().count());
                    store
                }
                Err(e) => {
                    eprintln!("[COOKIE_JAR] ⚠️ Failed to load cookies: {:?}", e);
                    eprintln!("[COOKIE_JAR] Creating new cookie store");
                    CookieStore::default()
                }
            }
        } else {
            println!("[COOKIE_JAR] Creating new cookie store at: {:?}", file_path);
            CookieStore::default()
        };

        Ok(Self {
            store: Arc::new(Mutex::new(store)),
            file_path,
        })
    }

    /// Get the path for cookies file
    fn get_cookies_path(filename: &str) -> Result<PathBuf> {
        let mut path = dirs::config_dir()
            .ok_or_else(|| anyhow::anyhow!("Could not find config directory"))?;
        path.push("StreamNook");

        if !path.exists() {
            fs::create_dir_all(&path)?;
        }

        path.push(filename);
        Ok(path)
    }

    /// Load cookies from a JSON file
    fn load_from_file(path: &PathBuf) -> Result<CookieStore> {
        let file = File::open(path)?;
        let reader = BufReader::new(file);
        let store = CookieStore::load_json(reader)
            .map_err(|e| anyhow::anyhow!("Failed to parse cookie store: {:?}", e))?;
        Ok(store)
    }

    /// Save cookies to disk
    pub async fn save(&self) -> Result<()> {
        let store = self.store.lock().await;
        
        // Create parent directory if it doesn't exist
        if let Some(parent) = self.file_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let file = File::create(&self.file_path)?;
        let mut writer = BufWriter::new(file);
        
        store.save_json(&mut writer)
            .map_err(|e| anyhow::anyhow!("Failed to save cookies: {:?}", e))?;
        
        println!("[COOKIE_JAR] ✅ Saved {} cookies to {:?}", 
            store.iter_any().count(), self.file_path);
        
        Ok(())
    }

    /// Clear all cookies and delete the file
    pub async fn clear(&self) -> Result<()> {
        let mut store = self.store.lock().await;
        *store = CookieStore::default();
        drop(store);

        if self.file_path.exists() {
            fs::remove_file(&self.file_path)?;
            println!("[COOKIE_JAR] ✅ Cleared cookies and deleted file: {:?}", self.file_path);
        }

        Ok(())
    }

    /// Add a cookie to the store
    pub async fn add_cookie(&self, url: &str, name: &str, value: &str) -> Result<()> {
        let url = Url::parse(url)?;
        let cookie = RawCookie::build((name.to_string(), value.to_string()))
            .domain(url.domain().unwrap_or("twitch.tv"))
            .path("/")
            .finish();

        let mut store = self.store.lock().await;
        store.insert_raw(&cookie, &url)
            .map_err(|e| anyhow::anyhow!("Failed to insert cookie: {:?}", e))?;
        
        Ok(())
    }

    /// Get a cookie value
    pub async fn get_cookie(&self, url: &str, name: &str) -> Option<String> {
        let url = Url::parse(url).ok()?;
        let store = self.store.lock().await;
        
        store.get(&url.domain()?, "/", name)
            .map(|cookie| cookie.value().to_string())
    }

    /// Create an HTTP client with this cookie jar
    pub async fn create_client(&self) -> Result<Client> {
        let store = self.store.lock().await;
        let cookie_provider = reqwest::cookie::Jar::default();
        
        // Copy cookies into the reqwest jar
        for cookie in store.iter_any() {
            let url = format!("https://{}{}", 
                cookie.domain().unwrap_or("twitch.tv"),
                cookie.path().unwrap_or("/"));
            
            if let Ok(url) = Url::parse(&url) {
                let cookie_str = format!("{}={}", cookie.name(), cookie.value());
                cookie_provider.add_cookie_str(&cookie_str, &url);
            }
        }
        drop(store);

        let client = ClientBuilder::new()
            .cookie_provider(Arc::new(cookie_provider))
            .build()?;

        Ok(client)
    }

    /// Update cookies from a response
    pub async fn update_from_response(&self, url: &str, headers: &reqwest::header::HeaderMap) -> Result<()> {
        let url = Url::parse(url)?;
        let mut store = self.store.lock().await;

        // Extract Set-Cookie headers
        for cookie_str in headers.get_all(reqwest::header::SET_COOKIE) {
            if let Ok(cookie_str) = cookie_str.to_str() {
                if let Ok(cookie) = RawCookie::parse(cookie_str) {
                    let _ = store.insert_raw(&cookie, &url);
                }
            }
        }

        Ok(())
    }

    /// Check if we have an auth token cookie
    pub async fn has_auth_token(&self) -> bool {
        self.get_cookie("https://twitch.tv", "auth-token").await.is_some()
    }

    /// Get the auth token from cookies
    pub async fn get_auth_token(&self) -> Option<String> {
        self.get_cookie("https://twitch.tv", "auth-token").await
    }

    /// Set the auth token cookie
    pub async fn set_auth_token(&self, token: &str) -> Result<()> {
        self.add_cookie("https://twitch.tv", "auth-token", token).await?;
        self.save().await
    }

    /// Get the device ID (unique_id) from cookies
    pub async fn get_device_id(&self) -> Option<String> {
        self.get_cookie("https://twitch.tv", "unique_id").await
    }

    /// Set the device ID cookie
    pub async fn set_device_id(&self, device_id: &str) -> Result<()> {
        self.add_cookie("https://twitch.tv", "unique_id", device_id).await?;
        self.save().await
    }

    /// Get the persistent user ID from cookies
    pub async fn get_persistent_user_id(&self) -> Option<String> {
        self.get_cookie("https://twitch.tv", "persistent").await
    }

    /// Set the persistent user ID cookie
    pub async fn set_persistent_user_id(&self, user_id: &str) -> Result<()> {
        self.add_cookie("https://twitch.tv", "persistent", user_id).await?;
        self.save().await
    }

    /// Check if cookies are valid and contain required data
    pub async fn is_valid(&self) -> bool {
        self.has_auth_token().await && self.get_device_id().await.is_some()
    }
}
