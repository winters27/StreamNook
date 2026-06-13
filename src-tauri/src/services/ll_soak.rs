//! Headless soak harness for the LL-HLS origin pipeline.
//!
//! Runs the REAL production path — anonymous playback token, usher master,
//! `LlOrigin` reader + transmuxer + blocking playlist — against a live channel
//! for N minutes, with a simulated player consuming it and watchdogs on every
//! invariant. Replaces watch-and-paste-console debugging with unattended
//! measurement.
//!
//! Run (network, long): from src-tauri:
//!   SOAK_CHANNEL=ohnepixel SOAK_MINUTES=10 cargo test soak_origin -- --ignored --nocapture
//!
//! Watchdogs:
//!  - timeline continuity per track: each part's `tfdt` must equal the
//!    previous part's `tfdt + sum(trun durations)` (the no-holes invariant);
//!  - part-production famine: wall-clock gaps between newly published parts;
//!  - blocking-reload hold times (must stay under hls.js's 1.6s budget);
//!  - playlist anomalies: MEDIA-SEQUENCE jumps (rebuilds), short EXTINF
//!    (abandoned tails);
//!  - a virtual playhead consuming real time from a 1.5s cushion: stall count
//!    and durations.

#![allow(clippy::print_stdout)]

use std::time::{Duration, Instant};

use super::ll_origin::LlOrigin;

#[derive(Default)]
struct TrackClock {
    /// Expected next tfdt (previous tfdt + sum of previous trun durations).
    next: Option<u64>,
}

#[derive(Default)]
struct Report {
    parts: u64,
    segments: u64,
    famines: Vec<f64>,
    holds_ms: Vec<u128>,
    seam_errors: Vec<String>,
    media_seq_jumps: u64,
    short_extinf: u64,
    stalls: Vec<f64>,
    bridged_note: u64,
}

/// Minimal fMP4 walker: per traf, return (track_id, tfdt, sum_of_durations).
fn parse_fragment_tracks(data: &[u8]) -> Vec<(u32, u64, u64)> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 8 <= data.len() {
        let size = u32::from_be_bytes(data[i..i + 4].try_into().unwrap()) as usize;
        if size < 8 || i + size > data.len() {
            break;
        }
        if &data[i + 4..i + 8] == b"moof" {
            let moof = &data[i + 8..i + size];
            let mut j = 0usize;
            while j + 8 <= moof.len() {
                let bsz = u32::from_be_bytes(moof[j..j + 4].try_into().unwrap()) as usize;
                if bsz < 8 || j + bsz > moof.len() {
                    break;
                }
                if &moof[j + 4..j + 8] == b"traf" {
                    let traf = &moof[j + 8..j + bsz];
                    let mut track_id = 0u32;
                    let mut tfdt = 0u64;
                    let mut dur_sum = 0u64;
                    let mut k = 0usize;
                    while k + 8 <= traf.len() {
                        let csz = u32::from_be_bytes(traf[k..k + 4].try_into().unwrap()) as usize;
                        if csz < 8 || k + csz > traf.len() {
                            break;
                        }
                        let kind = &traf[k + 4..k + 8];
                        let body = &traf[k + 8..k + csz];
                        match kind {
                            b"tfhd" => {
                                if body.len() >= 8 {
                                    track_id = u32::from_be_bytes(body[4..8].try_into().unwrap());
                                }
                            }
                            b"tfdt" => {
                                if body.first() == Some(&1) && body.len() >= 12 {
                                    tfdt = u64::from_be_bytes(body[4..12].try_into().unwrap());
                                } else if body.len() >= 8 {
                                    tfdt =
                                        u32::from_be_bytes(body[4..8].try_into().unwrap()) as u64;
                                }
                            }
                            b"trun" => {
                                if body.len() >= 8 {
                                    let flags = u32::from_be_bytes(body[0..4].try_into().unwrap())
                                        & 0x00FF_FFFF;
                                    let count =
                                        u32::from_be_bytes(body[4..8].try_into().unwrap());
                                    let mut off = 8usize;
                                    if flags & 0x1 != 0 {
                                        off += 4; // data_offset
                                    }
                                    if flags & 0x4 != 0 {
                                        off += 4; // first_sample_flags
                                    }
                                    let per = [0x100u32, 0x200, 0x400, 0x800]
                                        .iter()
                                        .filter(|&&f| flags & f != 0)
                                        .count()
                                        * 4;
                                    for _ in 0..count {
                                        if flags & 0x100 != 0 {
                                            if body.len() >= off + 4 {
                                                dur_sum += u32::from_be_bytes(
                                                    body[off..off + 4].try_into().unwrap(),
                                                )
                                                    as u64;
                                            }
                                        }
                                        off += per;
                                    }
                                }
                            }
                            _ => {}
                        }
                        k += csz;
                    }
                    out.push((track_id, tfdt, dur_sum));
                }
                j += bsz;
            }
        }
        i += size;
    }
    out
}

/// Prefer the chunked (source) variant; fall back to the highest-bandwidth one
/// (HEVC/AV1 "enhanced broadcasting" channels name their source differently).
fn chunked_url(master: &str) -> Option<String> {
    let lines: Vec<&str> = master.lines().collect();
    let mut best: Option<(u64, String)> = None;
    for (i, l) in lines.iter().enumerate() {
        if !l.starts_with("#EXT-X-STREAM-INF") {
            continue;
        }
        let Some(url) = lines.get(i + 1).filter(|u| u.starts_with("http")) else { continue };
        if l.contains("VIDEO=\"chunked\"") {
            return Some(url.to_string());
        }
        let bw = l
            .split("BANDWIDTH=")
            .nth(1)
            .and_then(|v| v.split(',').next())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        if best.as_ref().is_none_or(|(b, _)| bw > *b) {
            best = Some((bw, url.to_string()));
        }
    }
    best.map(|(_, u)| u)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "network soak; run explicitly with SOAK_CHANNEL/SOAK_MINUTES"]
async fn soak_origin() {
    let channel = std::env::var("SOAK_CHANNEL").unwrap_or_else(|_| "ohnepixel".into());
    let minutes: u64 = std::env::var("SOAK_MINUTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);
    println!("[soak] channel={channel} minutes={minutes}");
    // SOAK_DIAG=1 records a real diagnostics session during the soak. The
    // recorder's old sync-write path caused whole-pipeline freezes that soaks
    // never reproduced BECAUSE they ran without a session (the instrument was
    // the disease); diag-on soaks keep that class testable.
    if std::env::var("SOAK_DIAG").is_ok_and(|v| v == "1") {
        match super::ll_diagnostics::start_session("soak") {
            Ok(p) => println!("[soak] diagnostics session: {}", p.display()),
            Err(e) => println!("[soak] diagnostics session failed: {e}"),
        }
    }

    let master = match super::auth_proxy::fetch_auth_master(&channel, None).await {
        Ok(m) => m,
        Err(e) => {
            println!("[soak] ABORT: master fetch failed: {e}");
            return;
        }
    };
    let Some(upstream) = chunked_url(&master) else {
        println!("[soak] ABORT: no chunked variant (channel offline or transcode-only)");
        return;
    };

    let origin = LlOrigin::new(6);
    let outcome = origin.clone().start(upstream).await;
    if !outcome.active {
        println!("[soak] ABORT: origin declined activation (not an LL-capable stream)");
        return;
    }
    println!("[soak] origin active; running…");

    let mut report = Report::default();
    let mut clocks: std::collections::HashMap<u32, TrackClock> = Default::default();
    let mut seen_newest: Option<(u64, usize)> = None;
    let mut last_part_wall = Instant::now();
    let mut last_media_seq: Option<u64> = None;

    // Virtual playhead: media seconds of content consumed vs published.
    let mut published_media: f64 = 0.0;
    let mut playhead: f64 = -1.0; // armed once 1.5s of media exists
    let mut stall_started: Option<Instant> = None;
    let mut last_tick = Instant::now();

    let deadline = Instant::now() + Duration::from_secs(minutes * 60);
    while Instant::now() < deadline {
        // Blocking reload exactly like the player would issue it.
        let (msn, part) = match seen_newest {
            Some((sn, k)) => (Some(sn), Some((k + 1) as u64)),
            None => (None, None),
        };
        let t0 = Instant::now();
        let Some(pl) = origin.serve_playlist(msn, part).await else {
            println!("[soak] origin went inactive; stopping");
            break;
        };
        report.holds_ms.push(t0.elapsed().as_millis());

        // Playlist anomaly watchdogs.
        for line in pl.lines() {
            if let Some(ms) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
                if let Ok(seq) = ms.parse::<u64>() {
                    if let Some(prev) = last_media_seq {
                        if seq > prev + 3 {
                            report.media_seq_jumps += 1;
                            println!("[soak][watchdog] MEDIA-SEQUENCE jump {prev} -> {seq} (rebuild)");
                        }
                    }
                    last_media_seq = Some(seq);
                }
            }
            if let Some(rest) = line.strip_prefix("#EXTINF:") {
                if let Some(d) = rest.split(',').next().and_then(|v| v.parse::<f64>().ok()) {
                    if d < 1.0 {
                        report.short_extinf += 1;
                    }
                }
            }
        }

        // Discover and consume new parts in playlist order.
        let mut new_parts: Vec<(u64, usize, f64)> = Vec::new();
        for line in pl.lines() {
            if let Some(attrs) = line.strip_prefix("#EXT-X-PART:") {
                let dur = attrs
                    .split("DURATION=")
                    .nth(1)
                    .and_then(|v| v.split([',', '"']).next())
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(0.0);
                if let Some(uri) = attrs.split("URI=\"part/").nth(1) {
                    let path = uri.split('"').next().unwrap_or("");
                    let path = path.split('.').next().unwrap_or("");
                    let mut it = path.split('/');
                    if let (Some(sn), Some(k)) = (
                        it.next().and_then(|v| v.parse::<u64>().ok()),
                        it.next().and_then(|v| v.parse::<usize>().ok()),
                    ) {
                        let newer = match seen_newest {
                            Some((nsn, nk)) => sn > nsn || (sn == nsn && k > nk),
                            None => true,
                        };
                        if newer {
                            new_parts.push((sn, k, dur));
                        }
                    }
                }
            }
        }
        for (sn, k, dur) in new_parts {
            let wall_gap = last_part_wall.elapsed().as_secs_f64();
            if wall_gap > 1.2 {
                report.famines.push(wall_gap);
                println!("[soak][watchdog] famine {wall_gap:.2}s before part {sn}/{k}");
            }
            last_part_wall = Instant::now();
            seen_newest = Some((sn, k));
            report.parts += 1;
            if k == 0 {
                report.segments += 1;
            }
            published_media += dur;

            if let Some(bytes) = origin.get_part(sn, k) {
                for (track, tfdt, dsum) in parse_fragment_tracks(&bytes) {
                    let clock = clocks.entry(track).or_default();
                    if let Some(expected) = clock.next {
                        let delta = tfdt as i128 - expected as i128;
                        // 90 kHz video / sample-rate audio: 0.02s tolerance either way.
                        let tol = if track == 1 { 1800 } else { 960 };
                        if delta.unsigned_abs() > tol {
                            let msg = format!(
                                "track {track} seam at part {sn}/{k}: expected {expected}, tfdt {tfdt} (delta {delta})"
                            );
                            println!("[soak][watchdog] HOLE/OVERLAP {msg}");
                            report.seam_errors.push(msg);
                            clock.next = Some(tfdt + dsum);
                        } else {
                            report.bridged_note += u64::from(delta != 0);
                            clock.next = Some(expected.saturating_add_signed(delta as i64) + dsum);
                        }
                    } else {
                        clock.next = Some(tfdt + dsum);
                    }
                }
            }
        }

        // Advance the virtual playhead on wall time.
        let dt = last_tick.elapsed().as_secs_f64();
        last_tick = Instant::now();
        if playhead < 0.0 {
            if published_media >= 1.5 {
                playhead = published_media - 1.5;
            }
        } else {
            playhead = (playhead + dt).min(published_media);
            if published_media - playhead < 0.005 {
                if stall_started.is_none() {
                    stall_started = Some(Instant::now());
                }
            } else if let Some(s) = stall_started.take() {
                let len = s.elapsed().as_secs_f64();
                report.stalls.push(len);
                println!("[soak][watchdog] STALL {len:.2}s (playhead caught the edge)");
            }
        }
    }
    origin.stop();

    println!("\n========== SOAK REPORT: {channel} ({minutes} min) ==========");
    println!("segments: {}  parts: {}", report.segments, report.parts);
    let max_hold = report.holds_ms.iter().max().copied().unwrap_or(0);
    let over = report.holds_ms.iter().filter(|&&h| h > 1100).count();
    println!("playlist holds: {} (max {max_hold}ms, {over} over 1.1s)", report.holds_ms.len());
    println!(
        "famines >1.2s: {} {:?}",
        report.famines.len(),
        report
            .famines
            .iter()
            .map(|f| (f * 100.0).round() / 100.0)
            .collect::<Vec<_>>()
    );
    println!(
        "stalls: {} {:?}",
        report.stalls.len(),
        report.stalls.iter().map(|f| (f * 100.0).round() / 100.0).collect::<Vec<_>>()
    );
    println!(
        "timeline seam errors: {}  (sub-tolerance corrections seen: {})",
        report.seam_errors.len(),
        report.bridged_note
    );
    println!(
        "rebuilds (media-seq jumps): {}  short EXTINF (abandons): {}",
        report.media_seq_jumps, report.short_extinf
    );
    for e in report.seam_errors.iter().take(10) {
        println!("  seam: {e}");
    }
    assert!(
        report.seam_errors.is_empty(),
        "served timeline contained holes/overlaps"
    );
}
