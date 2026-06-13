//! Runtime stall detector. Answers "did the backend freeze, which layer, and
//! for how long" with measured numbers instead of inference.
//!
//! Two heartbeats run forever, each measuring its own scheduling lag:
//!
//!  - a TOKIO TASK: if it asks to sleep 250ms but is polled back 2s late, a
//!    tokio worker thread was BLOCKED (sync I/O on the async runtime, a mutex
//!    held across `.await`, a long CPU loop). This is the exact class the
//!    diagnostics-recorder freeze belonged to; if others remain in chat /
//!    badges / emotes / irc, this catches them.
//!  - an OS THREAD: same measurement on a real thread tokio can't starve. If
//!    BOTH lag, the whole PROCESS stalled (GC pause in a linked lib, swap, CPU
//!    saturation); if only the tokio one lags, it's tokio-specific blocking.
//!
//! Stalls are written to the active ll_diagnostics capture as `rt_stall`
//! events, so they line up on one timeline with the player's ticks and the
//! frontend's `jsblock` events — a freeze becomes one labelled row naming the
//! side and the duration. No console noise; the file is read after the fact.

use std::time::{Duration, Instant};

/// Heartbeat cadence. Short enough to localize a stall, long enough to be free.
const TICK: Duration = Duration::from_millis(250);
/// Lag past the cadence before it counts as a stall worth recording (filters
/// ordinary scheduler jitter; a real freeze is hundreds of ms to seconds).
const STALL_THRESHOLD: Duration = Duration::from_millis(300);

fn record(side: &str, lag_ms: u128) {
    log::warn!("[Watchdog] {side} runtime stalled ~{lag_ms}ms");
    crate::services::ll_diagnostics::event(&format!(
        "\"ev\":\"rt_stall\",\"side\":\"{side}\",\"ms\":{lag_ms}"
    ));
}

/// Master switch. OFF now that the freeze investigation is done — the
/// heartbeats only produce output when an lldiag session is active anyway (and
/// that's off by default too), but this also skips spawning the two loops so
/// nothing runs at all. Flip to `true` + rebuild to re-arm for an investigation
/// (pair with `__snDiag(true)` on the frontend so there's a capture to write to).
const WATCHDOG_ENABLED: bool = false;

/// Start both heartbeats. Call once from Tauri `setup`. The setup closure runs
/// OUTSIDE the tokio runtime context, so the tokio heartbeat is spawned via
/// `tauri::async_runtime::spawn` (Tauri's managed runtime — the same one every
/// command and `ll_origin` task runs on, which is exactly what we want to
/// measure), NOT bare `tokio::spawn` (panics: "no reactor running").
pub fn start() {
    if !WATCHDOG_ENABLED {
        return;
    }
    // Tokio-scheduling heartbeat. If the runtime is fully jammed it cannot run
    // to measure in real time, but the sleep returns late once unjammed, so the
    // stall is reported retroactively with its true duration.
    tauri::async_runtime::spawn(async {
        loop {
            let t0 = Instant::now();
            tokio::time::sleep(TICK).await;
            let lag = t0.elapsed().saturating_sub(TICK);
            if lag >= STALL_THRESHOLD {
                record("tokio", lag.as_millis());
            }
        }
    });

    // Whole-process heartbeat on a dedicated OS thread.
    std::thread::Builder::new()
        .name("rt-watchdog".into())
        .spawn(|| loop {
            let t0 = Instant::now();
            std::thread::sleep(TICK);
            let lag = t0.elapsed().saturating_sub(TICK);
            if lag >= STALL_THRESHOLD {
                record("process", lag.as_millis());
            }
        })
        .expect("spawn rt-watchdog thread");
}
