use log::debug;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

const WHISPERS_FILE: &str = "whispers.json";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StoredWhisper {
    pub id: String,
    pub from_user_id: String,
    pub from_user_login: String,
    pub from_user_name: String,
    pub to_user_id: String,
    pub to_user_login: String,
    pub to_user_name: String,
    pub message: String,
    pub timestamp: i64,
    pub is_sent: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StoredConversation {
    pub user_id: String,
    pub user_login: String,
    pub user_name: String,
    pub profile_image_url: Option<String>,
    pub messages: Vec<StoredWhisper>,
    pub last_message_timestamp: i64,
    pub unread_count: i32,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct WhisperStorage {
    pub conversations: HashMap<String, StoredConversation>,
    pub version: i32,
}

pub struct WhisperStorageService;

impl WhisperStorageService {
    /// Get the path to the whispers storage file
    fn get_storage_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
        let app_data_dir = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data directory: {}", e))?;

        // Create directory if it doesn't exist
        if !app_data_dir.exists() {
            fs::create_dir_all(&app_data_dir)
                .map_err(|e| format!("Failed to create app data directory: {}", e))?;
        }

        Ok(app_data_dir.join(WHISPERS_FILE))
    }

    /// Load all whispers from disk
    pub fn load_whispers(app_handle: &AppHandle) -> Result<WhisperStorage, String> {
        let path = Self::get_storage_path(app_handle)?;

        if !path.exists() {
            debug!("[WhisperStorage] No whispers file found, returning empty storage");
            return Ok(WhisperStorage {
                conversations: HashMap::new(),
                version: 1,
            });
        }

        let contents = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read whispers file: {}", e))?;

        let storage: WhisperStorage = serde_json::from_str(&contents)
            .map_err(|e| format!("Failed to parse whispers file: {}", e))?;

        debug!(
            "[WhisperStorage] Loaded {} conversations from disk",
            storage.conversations.len()
        );

        Ok(storage)
    }

    /// Save all whispers to disk
    pub fn save_whispers(app_handle: &AppHandle, storage: &WhisperStorage) -> Result<(), String> {
        let path = Self::get_storage_path(app_handle)?;

        let contents = serde_json::to_string_pretty(storage)
            .map_err(|e| format!("Failed to serialize whispers: {}", e))?;

        fs::write(&path, contents).map_err(|e| format!("Failed to write whispers file: {}", e))?;

        debug!(
            "[WhisperStorage] Saved {} conversations to disk",
            storage.conversations.len()
        );

        Ok(())
    }

    /// Save a single conversation (more efficient for incremental updates)
    pub fn save_conversation(
        app_handle: &AppHandle,
        user_id: &str,
        conversation: &StoredConversation,
    ) -> Result<(), String> {
        let mut storage = Self::load_whispers(app_handle)?;
        storage
            .conversations
            .insert(user_id.to_string(), conversation.clone());
        Self::save_whispers(app_handle, &storage)
    }

    /// Append a single message to a conversation
    pub fn append_message(
        app_handle: &AppHandle,
        user_id: &str,
        message: StoredWhisper,
    ) -> Result<(), String> {
        let mut storage = Self::load_whispers(app_handle)?;

        if let Some(conversation) = storage.conversations.get_mut(user_id) {
            // Check for duplicate
            if !conversation.messages.iter().any(|m| m.id == message.id) {
                conversation.messages.push(message.clone());
                conversation.last_message_timestamp = message.timestamp;
            }
        } else {
            // Conversation doesn't exist, create it
            return Err(format!("Conversation with user {} does not exist", user_id));
        }

        Self::save_whispers(app_handle, &storage)
    }

    /// Delete a conversation
    pub fn delete_conversation(app_handle: &AppHandle, user_id: &str) -> Result<(), String> {
        let mut storage = Self::load_whispers(app_handle)?;
        storage.conversations.remove(user_id);
        Self::save_whispers(app_handle, &storage)
    }

    /// Get storage file path (for debugging/export)
    pub fn get_storage_file_path(app_handle: &AppHandle) -> Result<String, String> {
        let path = Self::get_storage_path(app_handle)?;
        Ok(path.to_string_lossy().to_string())
    }
}
