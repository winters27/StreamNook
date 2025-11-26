use crate::models::settings::AppState;
use crate::services::twitch_service::TwitchService;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;
use tokio::time::{Duration, interval};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveNotification {
    pub streamer_name: String,
    pub streamer_login: String,
    pub streamer_avatar: Option<String>,
    pub game_name: Option<String>,
    pub game_image: Option<String>,
    pub stream_title: Option<String>,
    pub stream_url: String,
}

pub struct LiveNotificationService {
    currently_live: Arc<RwLock<HashSet<String>>>,
    running: Arc<RwLock<bool>>,
}

impl LiveNotificationService {
    pub fn new() -> Self {
        Self {
            currently_live: Arc::new(RwLock::new(HashSet::new())),
            running: Arc::new(RwLock::new(false)),
        }
    }

    pub async fn start(&self, app_handle: AppHandle, app_state: AppState) -> Result<()> {
        // Check if already running
        {
            let mut running = self.running.write().await;
            if *running {
                return Ok(());
            }
            *running = true;
        }

        let currently_live = self.currently_live.clone();
        let running = self.running.clone();

        tokio::spawn(async move {
            let mut check_interval = interval(Duration::from_secs(60)); // Check every minute
            let mut first_run = true;

            loop {
                check_interval.tick().await;

                // Check if we should stop
                {
                    let is_running = running.read().await;
                    if !*is_running {
                        break;
                    }
                }

                // Check if notifications are enabled
                let notifications_enabled = {
                    let settings = app_state.settings.lock().unwrap();
                    settings.live_notifications.enabled
                };

                if !notifications_enabled {
                    continue;
                }

                // Get followed streams
                match TwitchService::get_followed_streams(&app_state).await {
                    Ok(streams) => {
                        let mut live_set = currently_live.write().await;

                        // On first run, just populate the set without sending notifications
                        if first_run {
                            for stream in streams {
                                live_set.insert(stream.user_login.clone());
                            }
                            first_run = false;
                            continue;
                        }

                        let mut new_live_streamers = Vec::new();

                        for stream in &streams {
                            // Check if this is a new live stream
                            if !live_set.contains(&stream.user_login) {
                                live_set.insert(stream.user_login.clone());
                                new_live_streamers.push(stream.clone());
                            }
                        }

                        // Remove streamers who are no longer live
                        let current_live_logins: HashSet<String> =
                            streams.iter().map(|s| s.user_login.clone()).collect();

                        live_set.retain(|login| current_live_logins.contains(login));

                        // Send notifications for new live streamers
                        for stream in new_live_streamers {
                            if let Err(e) =
                                Self::send_notification(&app_handle, &app_state, &stream).await
                            {
                                eprintln!("Failed to send live notification: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("Failed to fetch followed streams: {}", e);
                    }
                }
            }

            println!("Live notification service stopped");
        });

        Ok(())
    }

    pub async fn stop(&self) -> Result<()> {
        let mut running = self.running.write().await;
        *running = false;
        Ok(())
    }

    async fn send_notification(
        app_handle: &AppHandle,
        app_state: &AppState,
        stream: &crate::models::stream::TwitchStream,
    ) -> Result<()> {
        let settings = app_state.settings.lock().unwrap().clone();
        let notification_settings = &settings.live_notifications;

        // Fetch streamer avatar if needed
        let streamer_avatar = if notification_settings.show_streamer_avatar {
            match TwitchService::get_user_by_login(&stream.user_login).await {
                Ok(user) => user.profile_image_url,
                Err(_) => None,
            }
        } else {
            None
        };

        // Get game image if needed
        let game_image = if notification_settings.show_game_image && !stream.game_name.is_empty() {
            Self::get_game_box_art(&stream.game_name).await.ok()
        } else {
            None
        };

        let notification = LiveNotification {
            streamer_name: if notification_settings.show_streamer_name {
                stream.user_name.clone()
            } else {
                "A streamer".to_string()
            },
            streamer_login: stream.user_login.clone(),
            streamer_avatar,
            game_name: if notification_settings.show_game_details {
                Some(stream.game_name.clone())
            } else {
                None
            },
            game_image,
            stream_title: if notification_settings.show_game_details {
                Some(stream.title.clone())
            } else {
                None
            },
            stream_url: format!("https://twitch.tv/{}", stream.user_login),
        };

        // Emit event to frontend
        app_handle.emit("streamer-went-live", &notification)?;

        Ok(())
    }

    async fn get_game_box_art(game_name: &str) -> Result<String> {
        let token = TwitchService::get_token().await?;
        let client = reqwest::Client::new();

        // Search for the game
        let url = format!(
            "https://api.twitch.tv/helix/games?name={}",
            urlencoding::encode(game_name)
        );

        let response = client
            .get(&url)
            .header("Client-Id", "1qgws7yzcp21g5ledlzffw3lmqdvie")
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await?
            .json::<serde_json::Value>()
            .await?;

        if let Some(data) = response.get("data").and_then(|d| d.as_array()) {
            if let Some(game) = data.first() {
                if let Some(box_art_url) = game.get("box_art_url").and_then(|u| u.as_str()) {
                    // Replace template variables with actual dimensions
                    let image_url = box_art_url
                        .replace("{width}", "285")
                        .replace("{height}", "380");
                    return Ok(image_url);
                }
            }
        }

        Err(anyhow::anyhow!("Game box art not found"))
    }
}
