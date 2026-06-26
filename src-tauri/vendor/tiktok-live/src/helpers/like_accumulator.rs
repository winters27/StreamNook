//! Like accumulator — monotonizes TikTok's inconsistent `total_like_count`.
//!
//! TikTok's `total` field on like events arrives from different server shards
//! with stale values, causing the counter to jump backwards. The `count` field
//! (per-event delta) is reliable.
//!
//! ```no_run
//! use piratetok_live_rs::helpers::like_accumulator::LikeAccumulator;
//! use piratetok_live_rs::structs::TikTokLiveEvent;
//!
//! # async fn example(stream: &mut piratetok_live_rs::TikTokLiveStream) {
//! let mut acc = LikeAccumulator::new();
//! while let Some(event) = stream.next_event().await {
//!     if let TikTokLiveEvent::Like(ref like) = event {
//!         let stats = acc.process(like);
//!         println!("+{} likes, total={}", stats.event_like_count, stats.total_like_count);
//!     }
//! }
//! # }
//! ```

use crate::structs::proto::messages::WebcastLikeMessage;

#[derive(Clone, Debug)]
pub struct LikeStats {
    pub event_like_count: i32,
    pub total_like_count: i64,
    pub accumulated_count: i64,
    pub went_backwards: bool,
}

pub struct LikeAccumulator {
    max_total: i64,
    accumulated: i64,
}

impl LikeAccumulator {
    pub fn new() -> Self {
        Self { max_total: 0, accumulated: 0 }
    }

    pub fn process(&mut self, msg: &WebcastLikeMessage) -> LikeStats {
        self.accumulated += msg.like_count as i64;
        let went_backwards = msg.total_like_count < self.max_total;
        if msg.total_like_count > self.max_total {
            self.max_total = msg.total_like_count;
        }

        LikeStats {
            event_like_count: msg.like_count,
            total_like_count: self.max_total,
            accumulated_count: self.accumulated,
            went_backwards,
        }
    }

    pub fn reset(&mut self) {
        self.max_total = 0;
        self.accumulated = 0;
    }
}

impl Default for LikeAccumulator {
    fn default() -> Self {
        Self::new()
    }
}
