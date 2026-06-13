//! File-backed diagnostic recorder for low-latency playback analysis.
//!
//! The frontend streams structured JSON-line records here (buffer ranges per track,
//! per-fragment demuxed PTS/DTS, latency, errors) and they are appended to a single
//! JSONL file on disk that can be handed off for analysis. This exists so an A/V-sync
//! or drift question is answered from RECORDED FACTS of a live session, not inference.
//!
//! Files land in `<temp>/streamnook-lldiag/lldiag-<label>-<timestamp>.jsonl`.
//!
//! WRITE PATH IS DECOUPLED FROM CALLERS by design: recorders are called from the
//! origin reader, every relay request handler, and the player's hls.js mirror —
//! dozens of times per second across solo and MultiNook. The original
//! implementation did a synchronous open-append-close PER EVENT while holding a
//! global mutex on the async runtime; Windows Defender rescans the (growing)
//! capture on those opens, so one slow open serialized EVERY origin and EVERY
//! request handler in the process — observed live as whole-pipeline freezes that
//! grew with session age and hit all MultiNook tiles simultaneously (and that
//! the soak harness could never reproduce, because it records no session: the
//! instrument was the disease). Now: callers push into an in-memory queue
//! behind a microseconds-held lock; a dedicated writer thread owns ONE
//! persistent file handle and drains the queue on a short interval.

use once_cell::sync::Lazy;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, Once};
use std::time::Duration;

/// Hot-path gate; checked without any lock.
static ACTIVE: AtomicBool = AtomicBool::new(false);

struct Shared {
    /// The session file the writer should be appending to (None = no session).
    desired: Option<PathBuf>,
    /// Pending lines. Pushed by callers, drained by the writer thread.
    queue: Vec<String>,
}

static SHARED: Lazy<Mutex<Shared>> = Lazy::new(|| {
    Mutex::new(Shared {
        desired: None,
        queue: Vec::new(),
    })
});
static WRITER: Once = Once::new();

fn ensure_writer() {
    WRITER.call_once(|| {
        std::thread::Builder::new()
            .name("lldiag-writer".into())
            .spawn(|| {
                // The writer is the ONLY place file I/O happens, and it never
                // holds the shared lock across I/O.
                let mut current: Option<(PathBuf, File)> = None;
                loop {
                    std::thread::sleep(Duration::from_millis(300));
                    let (desired, batch) = {
                        let mut s = SHARED.lock().unwrap();
                        (s.desired.clone(), std::mem::take(&mut s.queue))
                    };
                    // Rotate / close as requested. Pending lines queued around a
                    // rotation go to the new file (or are dropped on stop) —
                    // acceptable for diagnostics.
                    match (&desired, &mut current) {
                        (None, c @ Some(_)) => *c = None,
                        (Some(want), c) if c.as_ref().map(|(p, _)| p) != Some(want) => {
                            *c = OpenOptions::new()
                                .append(true)
                                .open(want)
                                .ok()
                                .map(|f| (want.clone(), f));
                        }
                        _ => {}
                    }
                    if batch.is_empty() {
                        continue;
                    }
                    if let Some((_, f)) = current.as_mut() {
                        let mut out = String::with_capacity(batch.iter().map(|l| l.len() + 1).sum());
                        for l in &batch {
                            out.push_str(l);
                            out.push('\n');
                        }
                        let _ = f.write_all(out.as_bytes());
                    }
                }
            })
            .expect("spawn lldiag writer");
    });
}

fn diag_dir() -> PathBuf {
    let mut d = std::env::temp_dir();
    d.push("streamnook-lldiag");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Start a fresh diagnostic session (one file). Returns the full path so the
/// frontend can surface it. A new call rotates to a new file.
pub fn start_session(label: &str) -> std::io::Result<PathBuf> {
    ensure_writer();
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
    {
        let mut s = SHARED.lock().unwrap();
        s.desired = Some(path.clone());
        s.queue.clear();
    }
    ACTIVE.store(true, Ordering::Relaxed);
    Ok(path)
}

/// Append already-serialized JSON lines to the active session file, but only
/// when the caller's `session_path` IS the active session. Multiple webview
/// windows (solo, popouts, MultiNook) each run their own recorder against this
/// single backend session; without the path check a recorder that lost the
/// rotation race kept flushing its idle player's ticks into the newest capture,
/// which is what polluted the 2026-06-11 captures with phantom paused-player
/// records. Best-effort: diagnostics can never break playback.
pub fn append_lines(lines: &[String], session_path: &str) {
    if !ACTIVE.load(Ordering::Relaxed) {
        return;
    }
    let mut s = SHARED.lock().unwrap();
    let Some(path) = s.desired.as_ref() else { return };
    if path.to_string_lossy() != session_path {
        return;
    }
    s.queue.extend(lines.iter().cloned());
}

/// End the session, but only if the caller still owns it (same race as
/// `append_lines`: a stale recorder's teardown must not kill a newer capture).
pub fn stop_session(session_path: &str) {
    let mut s = SHARED.lock().unwrap();
    if s.desired.as_ref().is_some_and(|p| p.to_string_lossy() == session_path) {
        s.desired = None;
        ACTIVE.store(false, Ordering::Relaxed);
    }
}

/// Whether a session is active (callers check this to skip formatting work on the
/// hot path when not recording). Lock-free.
pub fn is_active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
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
/// timeline. No-op when no session is active. Unlike frontend appends, origin
/// events are not path-scoped: they describe the live stream and belong to
/// whichever capture is current. Never blocks on I/O.
pub fn event(body: &str) {
    if !ACTIVE.load(Ordering::Relaxed) {
        return;
    }
    let line = format!("{{\"t\":{},{}}}", chrono::Utc::now().timestamp_millis(), body);
    SHARED.lock().unwrap().queue.push(line);
}
