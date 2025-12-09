use crate::services::whisper_storage_service::{
    StoredConversation, StoredWhisper, WhisperStorage, WhisperStorageService,
};
use std::collections::HashMap;
use tauri::AppHandle;

/// Load all whisper conversations from disk
#[tauri::command]
pub async fn load_whisper_storage(app_handle: AppHandle) -> Result<WhisperStorage, String> {
    WhisperStorageService::load_whispers(&app_handle)
}

/// Save all whisper conversations to disk
#[tauri::command]
pub async fn save_whisper_storage(
    app_handle: AppHandle,
    conversations: HashMap<String, StoredConversation>,
) -> Result<(), String> {
    let storage = WhisperStorage {
        conversations,
        version: 1,
    };
    WhisperStorageService::save_whispers(&app_handle, &storage)
}

/// Save a single conversation to disk (incremental update)
#[tauri::command]
pub async fn save_whisper_conversation(
    app_handle: AppHandle,
    user_id: String,
    conversation: StoredConversation,
) -> Result<(), String> {
    WhisperStorageService::save_conversation(&app_handle, &user_id, &conversation)
}

/// Append a single message to an existing conversation
#[tauri::command]
pub async fn append_whisper_message(
    app_handle: AppHandle,
    user_id: String,
    message: StoredWhisper,
) -> Result<(), String> {
    WhisperStorageService::append_message(&app_handle, &user_id, message)
}

/// Delete a conversation from disk
#[tauri::command]
pub async fn delete_whisper_conversation(
    app_handle: AppHandle,
    user_id: String,
) -> Result<(), String> {
    WhisperStorageService::delete_conversation(&app_handle, &user_id)
}

/// Get the path to the whispers storage file (for debugging)
#[tauri::command]
pub async fn get_whisper_storage_path(app_handle: AppHandle) -> Result<String, String> {
    WhisperStorageService::get_storage_file_path(&app_handle)
}

/// Migrate data from localStorage format to disk storage
/// This command accepts the data already parsed from localStorage on the frontend
#[tauri::command]
pub async fn migrate_whispers_from_localstorage(
    app_handle: AppHandle,
    conversations: HashMap<String, StoredConversation>,
) -> Result<(), String> {
    // Check if we already have data on disk
    let existing = WhisperStorageService::load_whispers(&app_handle)?;

    if !existing.conversations.is_empty() {
        println!(
            "[WhisperStorage] Migration: Found {} existing conversations on disk, merging...",
            existing.conversations.len()
        );

        // Merge localStorage data with existing disk data
        let mut merged = existing.conversations;

        for (user_id, conv) in conversations {
            if let Some(existing_conv) = merged.get_mut(&user_id) {
                // Merge messages, avoiding duplicates
                let existing_ids: std::collections::HashSet<_> = existing_conv
                    .messages
                    .iter()
                    .map(|m| m.id.clone())
                    .collect();

                for msg in conv.messages {
                    if !existing_ids.contains(&msg.id) {
                        existing_conv.messages.push(msg);
                    }
                }

                // Sort by timestamp after merging
                existing_conv
                    .messages
                    .sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

                // Update last_message_timestamp
                if let Some(last) = existing_conv.messages.last() {
                    existing_conv.last_message_timestamp = last.timestamp;
                }

                // Update profile image if we didn't have one
                if existing_conv.profile_image_url.is_none() {
                    existing_conv.profile_image_url = conv.profile_image_url;
                }
            } else {
                // New conversation, add it
                merged.insert(user_id, conv);
            }
        }

        let storage = WhisperStorage {
            conversations: merged,
            version: 1,
        };
        WhisperStorageService::save_whispers(&app_handle, &storage)?;
    } else {
        // No existing data, just save the localStorage data
        println!(
            "[WhisperStorage] Migration: No existing data on disk, importing {} conversations from localStorage",
            conversations.len()
        );

        let storage = WhisperStorage {
            conversations,
            version: 1,
        };
        WhisperStorageService::save_whispers(&app_handle, &storage)?;
    }

    Ok(())
}
