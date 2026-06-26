//! Gift streak tracker — computes per-event deltas from TikTok's running totals.
//!
//! TikTok combo gifts fire multiple events during a streak, each carrying a
//! running total in `repeat_count` (2, 4, 7, 7). This helper tracks active
//! streaks by `group_id` and computes the delta per event.
//!
//! ```no_run
//! use piratetok_live_rs::helpers::gift_streak::GiftStreakTracker;
//! use piratetok_live_rs::structs::TikTokLiveEvent;
//!
//! # async fn example(stream: &mut piratetok_live_rs::TikTokLiveStream) {
//! let mut tracker = GiftStreakTracker::new();
//! while let Some(event) = stream.next_event().await {
//!     if let TikTokLiveEvent::Gift(ref gift) = event {
//!         let e = tracker.process(gift);
//!         println!("streak {} — +{} gifts", e.streak_id, e.event_gift_count);
//!     }
//! }
//! # }
//! ```

use std::collections::HashMap;
use std::time::Instant;

use crate::structs::proto::messages::WebcastGiftMessage;

const STALE_SECS: u64 = 60;

#[derive(Clone, Debug)]
pub struct GiftStreakEvent {
    pub streak_id: u64,
    pub is_active: bool,
    pub is_final: bool,
    pub event_gift_count: i32,
    pub total_gift_count: i32,
    pub event_diamond_count: i64,
    pub total_diamond_count: i64,
}

pub struct GiftStreakTracker {
    streaks: HashMap<u64, (i32, Instant)>,
}

impl GiftStreakTracker {
    pub fn new() -> Self {
        Self { streaks: HashMap::new() }
    }

    pub fn process(&mut self, msg: &WebcastGiftMessage) -> GiftStreakEvent {
        let is_combo = msg.is_combo_gift();
        let is_final = msg.is_streak_over();
        let diamond_per = match &msg.gift_details {
            Some(g) => g.diamond_count as i64,
            None => 0,
        };

        if !is_combo {
            return GiftStreakEvent {
                streak_id: msg.group_id,
                is_active: false,
                is_final: true,
                event_gift_count: 1,
                total_gift_count: 1,
                event_diamond_count: diamond_per,
                total_diamond_count: diamond_per,
            };
        }

        let now = Instant::now();
        self.evict_stale(now);

        let prev_count = match self.streaks.get(&msg.group_id) {
            Some((count, _)) => *count,
            None => 0,
        };
        let delta = (msg.repeat_count - prev_count).max(0);

        if is_final {
            self.streaks.remove(&msg.group_id);
        } else {
            self.streaks.insert(msg.group_id, (msg.repeat_count, now));
        }

        let total_diamonds = diamond_per * (msg.repeat_count as i64).max(1);
        let event_diamonds = diamond_per * delta as i64;

        GiftStreakEvent {
            streak_id: msg.group_id,
            is_active: !is_final,
            is_final,
            event_gift_count: delta,
            total_gift_count: msg.repeat_count,
            event_diamond_count: event_diamonds,
            total_diamond_count: total_diamonds,
        }
    }

    pub fn active_streaks(&self) -> usize {
        self.streaks.len()
    }

    pub fn reset(&mut self) {
        self.streaks.clear();
    }

    fn evict_stale(&mut self, now: Instant) {
        let cutoff = std::time::Duration::from_secs(STALE_SECS);
        self.streaks.retain(|_, (_, ts)| now.duration_since(*ts) < cutoff);
    }
}

impl Default for GiftStreakTracker {
    fn default() -> Self {
        Self::new()
    }
}
