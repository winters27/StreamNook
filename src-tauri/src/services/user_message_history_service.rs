use crate::models::chat_layout::ChatMessage;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;
use tokio::sync::Mutex;

/// Maximum number of users to track
const MAX_USERS: usize = 1000;

/// Maximum messages per user
const MAX_MESSAGES_PER_USER: usize = 50;

/// LRU entry with access tracking
#[derive(Clone)]
struct LruEntry {
    messages: Vec<ChatMessage>,
    last_access: u64,
}

/// User message history service with LRU cache
///
/// This service stores recent messages per user for:
/// - User profile card message history
/// - Mod tools (seeing user's recent messages)
/// - Quick lookup without frontend storage
pub struct UserMessageHistoryService {
    /// Map of user_id -> messages
    cache: Mutex<HashMap<String, LruEntry>>,
    /// Monotonic counter for LRU tracking
    access_counter: Mutex<u64>,
}

static INSTANCE: OnceLock<UserMessageHistoryService> = OnceLock::new();

impl UserMessageHistoryService {
    pub fn global() -> &'static UserMessageHistoryService {
        INSTANCE.get_or_init(|| UserMessageHistoryService {
            cache: Mutex::new(HashMap::with_capacity(MAX_USERS)),
            access_counter: Mutex::new(0),
        })
    }

    /// Add a message to a user's history
    pub async fn add_message(&self, user_id: &str, message: ChatMessage) {
        let mut cache = self.cache.lock().await;
        let mut counter = self.access_counter.lock().await;
        *counter += 1;
        let current_access = *counter;
        drop(counter);

        // Get or create entry for user
        let entry = cache
            .entry(user_id.to_string())
            .or_insert_with(|| LruEntry {
                messages: Vec::with_capacity(MAX_MESSAGES_PER_USER),
                last_access: current_access,
            });

        // Update access time
        entry.last_access = current_access;

        // Add message, removing oldest if at capacity
        if entry.messages.len() >= MAX_MESSAGES_PER_USER {
            entry.messages.remove(0);
        }
        entry.messages.push(message);

        // Evict LRU entries if cache is too large
        if cache.len() > MAX_USERS {
            self.evict_lru(&mut cache);
        }
    }

    /// Get message history for a user
    pub async fn get_history(&self, user_id: &str) -> Vec<ChatMessage> {
        let mut cache = self.cache.lock().await;
        let mut counter = self.access_counter.lock().await;
        *counter += 1;
        let current_access = *counter;
        drop(counter);

        if let Some(entry) = cache.get_mut(user_id) {
            entry.last_access = current_access;
            entry.messages.clone()
        } else {
            Vec::new()
        }
    }

    /// Get message history for a user with a limit
    pub async fn get_history_limited(&self, user_id: &str, limit: usize) -> Vec<ChatMessage> {
        let history = self.get_history(user_id).await;
        if history.len() > limit {
            history.into_iter().rev().take(limit).rev().collect()
        } else {
            history
        }
    }

    /// Clear history for a specific user
    pub async fn clear_user(&self, user_id: &str) {
        let mut cache = self.cache.lock().await;
        cache.remove(user_id);
    }

    /// Clear all history (e.g., when switching channels)
    pub async fn clear_all(&self) {
        let mut cache = self.cache.lock().await;
        cache.clear();
    }

    /// Get the number of tracked users
    pub async fn user_count(&self) -> usize {
        self.cache.lock().await.len()
    }

    /// Evict least recently used entries
    fn evict_lru(&self, cache: &mut HashMap<String, LruEntry>) {
        // Find entries to evict (oldest 10%)
        let evict_count = cache.len() / 10;
        if evict_count == 0 {
            return;
        }

        // Collect user_ids (cloned) sorted by access time
        let mut entries: Vec<(String, u64)> = cache
            .iter()
            .map(|(k, v)| (k.clone(), v.last_access))
            .collect();
        entries.sort_by_key(|(_, access)| *access);

        // Evict oldest entries (now we own the keys)
        for (user_id, _) in entries.into_iter().take(evict_count) {
            cache.remove(&user_id);
        }
    }
}

/// Simplified message data for frontend (avoiding full ChatMessage overhead)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UserMessageSummary {
    pub id: String,
    pub content: String,
    pub timestamp: String,
    pub color: Option<String>,
}

impl From<&ChatMessage> for UserMessageSummary {
    fn from(msg: &ChatMessage) -> Self {
        UserMessageSummary {
            id: msg.id.clone(),
            content: msg.content.clone(),
            timestamp: msg.timestamp.clone(),
            color: msg.color.clone(),
        }
    }
}
