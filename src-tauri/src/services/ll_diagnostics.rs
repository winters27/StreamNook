//! File-backed diagnostic recorder for low-latency playback analysis.
//!
//! The frontend streams structured JSON-line records here (buffer ranges per track,
//! per-fragment demuxed PTS/DTS, latency, errors) and they are appended to a single
//! JSONL file on disk that can be handed off for analysis. This exists so an A/V-sync
//! or drift question is answered from RECORDED FACTS of a live session, not inference.
//!
//! Files land in `<temp>/streamnook-lldiag/lldiag-<label>-<timestamp>.jsonl`.

use once_cell::sync::Lazy;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

static SESSION: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

fn diag_dir() -> PathBuf {
    let mut d = std::env::temp_dir();
    d.push("streamnook-lldiag");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Start a fresh diagnostic session (one file). Returns the full path so the
/// frontend can surface it. A new call rotates to a new file.
pub fn start_session(label: &str) -> std::io::Result<PathBuf> {
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let safe: String = label
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .take(40)
        .collect();
    let safe = if safe.is_empty() { "session".to_string() } else { safe };
    let mut path = diag_dir();
    path.push(format!("lldiag-{safe}-{ts}.jsonl"));
    File::create(&path)?; // create/truncate
    *SESSION.lock().unwrap() = Some(path.clone());
    Ok(path)
}

/// Append already-serialized JSON lines to the active session file (no-op if no
/// session is active). Best-effort: a write error is swallowed so diagnostics can
/// never break playback.
pub fn append_lines(lines: &[String]) {
    let guard = SESSION.lock().unwrap();
    if let Some(path) = guard.as_ref() {
        if let Ok(mut f) = OpenOptions::new().append(true).open(path) {
            for l in lines {
                let _ = writeln!(f, "{l}");
            }
        }
    }
}

/// End the session (subsequent appends no-op until a new session starts).
pub fn stop_session() {
    *SESSION.lock().unwrap() = None;
}

/// Whether a session is active (callers check this to skip formatting work on the
/// hot path when not recording).
pub fn is_active() -> bool {
    SESSION.lock().unwrap().is_some()
}

/// Cheap content fingerprint (FNV-1a) to tell whether two served part payloads are
/// the same bytes. Only computed when a session is active (it's O(n)).
pub fn quick_hash(b: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &x in b {
        h ^= x as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Record one backend event. `body` is the JSON object body WITHOUT braces or the
/// leading `t` field (e.g. `"ev":"o_seg","sn":42`); a wall-clock millisecond
/// timestamp is prepended so origin events share the frontend's `Date.now()`
/// timeline. No-op when no session is active.
pub fn event(body: &str) {
    if !is_active() {
        return;
    }
    let line = format!("{{\"t\":{},{}}}", chrono::Utc::now().timestamp_millis(), body);
    append_lines(std::slice::from_ref(&line));
}
