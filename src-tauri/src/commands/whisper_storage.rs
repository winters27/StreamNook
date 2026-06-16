use crate::services::whisper_storage_service::{
    StoredConversation, StoredWhisper, WhisperStorage, WhisperStorageService,
};
use log::debug;
use std::collections::HashMap;
use tauri::AppHandle;

/// Load the active account's whisper conversations from disk. `owner_id` is the
/// signed-in user's id; an empty value (signed out) returns nothing.
#[tauri::command]
pub async fn load_whisper_storage(
    app_handle: AppHandle,
    owner_id: String,
) -> Result<WhisperStorage, String> {
    WhisperStorageService::load_whispers(&app_handle, &owner_id)
}

/// Save the active account's whisper conversations to disk.
#[tauri::command]
pub async fn save_whisper_storage(
    app_handle: AppHandle,
    owner_id: String,
    conversations: HashMap<String, StoredConversation>,
) -> Result<(), String> {
    let storage = WhisperStorage {
        conversations,
        version: 1,
    };
    WhisperStorageService::save_whispers(&app_handle, &owner_id, &storage)
}

/// Save a single conversation to disk (incremental update).
#[tauri::command]
pub async fn save_whisper_conversation(
    app_handle: AppHandle,
    owner_id: String,
    user_id: String,
    conversation: StoredConversation,
) -> Result<(), String> {
    WhisperStorageService::save_conversation(&app_handle, &owner_id, &user_id, &conversation)
}

/// Append a single message to an existing conversation.
#[tauri::command]
pub async fn append_whisper_message(
    app_handle: AppHandle,
    owner_id: String,
    user_id: String,
    message: StoredWhisper,
) -> Result<(), String> {
    WhisperStorageService::append_message(&app_handle, &owner_id, &user_id, message)
}

/// Delete a conversation from disk.
#[tauri::command]
pub async fn delete_whisper_conversation(
    app_handle: AppHandle,
    owner_id: String,
    user_id: String,
) -> Result<(), String> {
    WhisperStorageService::delete_conversation(&app_handle, &owner_id, &user_id)
}

/// Get the path to the active account's whispers storage file (for debugging).
#[tauri::command]
pub async fn get_whisper_storage_path(
    app_handle: AppHandle,
    owner_id: String,
) -> Result<String, String> {
    WhisperStorageService::get_storage_file_path(&app_handle, &owner_id)
}

/// Migrate data from the old localStorage format into the active account's
/// on-disk storage. The frontend passes the already-parsed conversations.
#[tauri::command]
pub async fn migrate_whispers_from_localstorage(
    app_handle: AppHandle,
    owner_id: String,
    conversations: HashMap<String, StoredConversation>,
) -> Result<(), String> {
    let existing = WhisperStorageService::load_whispers(&app_handle, &owner_id)?;

    if !existing.conversations.is_empty() {
        debug!(
            "[WhisperStorage] Migration: merging {} localStorage conversations into {} on disk",
            conversations.len(),
            existing.conversations.len()
        );

        let mut merged = existing.conversations;
        for (user_id, conv) in conversations {
            if let Some(existing_conv) = merged.get_mut(&user_id) {
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
                existing_conv
                    .messages
                    .sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
                if let Some(last) = existing_conv.messages.last() {
                    existing_conv.last_message_timestamp = last.timestamp;
                }
                if existing_conv.profile_image_url.is_none() {
                    existing_conv.profile_image_url = conv.profile_image_url;
                }
            } else {
                merged.insert(user_id, conv);
            }
        }

        let storage = WhisperStorage {
            conversations: merged,
            version: 1,
        };
        WhisperStorageService::save_whispers(&app_handle, &owner_id, &storage)?;
    } else {
        debug!(
            "[WhisperStorage] Migration: importing {} localStorage conversations (none on disk)",
            conversations.len()
        );
        let storage = WhisperStorage {
            conversations,
            version: 1,
        };
        WhisperStorageService::save_whispers(&app_handle, &owner_id, &storage)?;
    }

    Ok(())
}
