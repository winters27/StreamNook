#!/usr/bin/env node
/**
 * HLS Segment Diagnostic Tool
 *
 * Usage: node scripts/hls-diag.mjs <channel_name> [segment_count]
 *
 * Fetches a live Twitch HLS stream via Streamlink, parses the playlist,
 * downloads segments, and measures real timing data. Results are written
 * to scripts/hls-report.txt
 */

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(__dirname, 'hls-report.txt');

const channel = process.argv[2];
const segmentCount = parseInt(process.argv[3] || '10', 10);

if (!channel) {
  console.error('Usage: node scripts/hls-diag.mjs <channel_name> [segment_count]');
  process.exit(1);
}

const lines = [];
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  lines.push(line);
}

function flush() {
  writeFileSync(REPORT_PATH, lines.join('\n'), 'utf8');
  console.log(`\n>>> Report written to: ${REPORT_PATH}`);
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchTimed(url) {
  const start = performance.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const elapsed = performance.now() - start;
  return { size: buf.byteLength, timeMs: elapsed };
}

// ─── Step 1: Get stream URL ───
log(`=== HLS Segment Diagnostic: ${channel} ===`);
log(`Segments to download: ${segmentCount}`);
log('');

log('Step 1: Getting stream URL via Streamlink...');
let streamUrl;
try {
  const streamlinkPath = join(__dirname, '..', 'streamlink', 'bin', 'streamlink.exe');
  streamUrl = execSync(
    `"${streamlinkPath}" --stream-url https://twitch.tv/${channel} best`,
    { encoding: 'utf8', timeout: 15000 }
  ).trim();
  log(`Got URL (${streamUrl.length} chars)`);
} catch (e) {
  log(`ERROR: Streamlink failed. Is ${channel} live?`);
  flush();
  process.exit(1);
}

// ─── Step 2: Fetch playlist ───
log('');
log('Step 2: Fetching playlist...');
let playlistText;
try {
  playlistText = await fetchText(streamUrl);
} catch (e) {
  log(`ERROR: Failed to fetch playlist: ${e.message}`);
  flush();
  process.exit(1);
}

// Determine if this is a master or media playlist
const isMaster = playlistText.includes('#EXT-X-STREAM-INF');
let mediaPlaylistUrl = streamUrl;
let mediaPlaylist = playlistText;

if (isMaster) {
  log('Got master playlist — selecting best variant...');
  const mLines = playlistText.split('\n');
  let bestUrl = null;
  for (let i = 0; i < mLines.length; i++) {
    if (mLines[i].trim().startsWith('#EXT-X-STREAM-INF:')) {
      const url = mLines[i + 1]?.trim();
      if (url && !url.startsWith('#')) {
        bestUrl = url.startsWith('http') ? url : new URL(url, streamUrl).href;
        break; // First variant is usually best quality
      }
    }
  }
  if (!bestUrl) {
    log('ERROR: No variant URL found in master playlist');
    log('Raw playlist:');
    playlistText.split('\n').slice(0, 20).forEach(l => log(`  ${l}`));
    flush();
    process.exit(1);
  }
  mediaPlaylistUrl = bestUrl;
  mediaPlaylist = await fetchText(bestUrl);
  log('Fetched media playlist');
} else {
  log('Got media playlist directly');
}

// ─── Step 3: Parse playlist ───
log('');
log('Step 3: Parsing playlist...');

const pLines = mediaPlaylist.split('\n');
let targetDuration = null;
let mediaSequence = 0;
const segments = [];

for (let i = 0; i < pLines.length; i++) {
  const line = pLines[i].trim();

  if (line.startsWith('#EXT-X-TARGETDURATION:')) {
    targetDuration = parseFloat(line.split(':')[1]);
  }
  if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
    mediaSequence = parseInt(line.split(':')[1]);
  }
  if (line.startsWith('#EXTINF:')) {
    const duration = parseFloat(line.split(':')[1].replace(',', ''));
    const segUrl = pLines[i + 1]?.trim();
    if (segUrl && !segUrl.startsWith('#')) {
      segments.push({
        sn: mediaSequence + segments.length,
        duration,
        url: segUrl.startsWith('http') ? segUrl : new URL(segUrl, mediaPlaylistUrl).href,
      });
    }
  }
}

log(`EXT-X-TARGETDURATION: ${targetDuration}s`);
log(`EXT-X-MEDIA-SEQUENCE: ${mediaSequence}`);
log(`Segments in playlist: ${segments.length}`);
log('');
log('Segment durations (from EXTINF tags):');
segments.forEach((s, i) => {
  log(`  [${i}] sn=${s.sn}  EXTINF=${s.duration.toFixed(3)}s`);
});

const totalPlaylistDuration = segments.reduce((a, s) => a + s.duration, 0);
log(`Total playlist span: ${totalPlaylistDuration.toFixed(2)}s`);

// With liveSyncDuration config
const liveSyncDuration = 4; // current low-latency config
log(`liveSyncDuration config: ${liveSyncDuration}s`);
log(`→ HLS.js would start playback at ~${liveSyncDuration}s behind live edge`);

// ─── Step 4: Download and measure ───
log('');
const toDownload = Math.min(segmentCount, segments.length);
log(`Step 4: Downloading ${toDownload} segments (sequentially, simulating player cold start)...`);
log('');

const hdr =
  '#'.padEnd(4) +
  'SN'.padEnd(10) +
  'EXTINF'.padEnd(10) +
  'SIZE_KB'.padEnd(10) +
  'DL_MS'.padEnd(10) +
  'BW_MBPS'.padEnd(10) +
  'CUM_BUF'.padEnd(12) +
  'CUM_DL_S'.padEnd(12) +
  'SURPLUS'.padEnd(10) +
  'RATIO';
log(hdr);
log('─'.repeat(hdr.length));

let cumBuf = 0;
let cumDl = 0;
const results = [];

for (let i = 0; i < toDownload; i++) {
  const seg = segments[i];
  try {
    const { size, timeMs } = await fetchTimed(seg.url);
    const sizeKB = size / 1024;
    const bwMbps = (size * 8) / timeMs / 1000;
    cumBuf += seg.duration;
    cumDl += timeMs;
    const cumDlSec = cumDl / 1000;
    const surplus = cumBuf - cumDlSec;
    const ratio = cumBuf / cumDlSec;

    results.push({ i, sn: seg.sn, duration: seg.duration, sizeKB, timeMs, bwMbps, cumBuf, cumDlSec, surplus, ratio });

    log(
      `${i}`.padEnd(4) +
      `${seg.sn}`.padEnd(10) +
      `${seg.duration.toFixed(3)}`.padEnd(10) +
      `${sizeKB.toFixed(0)}`.padEnd(10) +
      `${timeMs.toFixed(0)}`.padEnd(10) +
      `${bwMbps.toFixed(1)}`.padEnd(10) +
      `${cumBuf.toFixed(2)}s`.padEnd(12) +
      `${cumDlSec.toFixed(2)}s`.padEnd(12) +
      `${surplus.toFixed(2)}s`.padEnd(10) +
      `${ratio.toFixed(2)}x`
    );
  } catch (e) {
    log(`${i}  ERROR: ${e.message}`);
  }
}

// ─── Step 5: Summary ───
log('');
log('═'.repeat(80));
log('SUMMARY & RECOMMENDATION');
log('═'.repeat(80));

if (results.length > 0) {
  const durs = results.map(r => r.duration);
  const avgDur = durs.reduce((a, b) => a + b, 0) / durs.length;
  const minDur = Math.min(...durs);
  const maxDur = Math.max(...durs);
  const avgDl = results.map(r => r.timeMs).reduce((a, b) => a + b, 0) / results.length;
  const avgSize = results.map(r => r.sizeKB).reduce((a, b) => a + b, 0) / results.length;

  log(`TARGETDURATION = ${targetDuration}s`);
  log(`Segment dur:  avg=${avgDur.toFixed(3)}s  min=${minDur.toFixed(3)}s  max=${maxDur.toFixed(3)}s`);
  log(`Segment size: avg=${avgSize.toFixed(0)}KB`);
  log(`Download:     avg=${avgDl.toFixed(0)}ms per segment`);
  log('');

  // liveSyncDurationCount impact
  log(`If using liveSyncDurationCount=3 × TARGETDURATION=${targetDuration}s → ${3 * targetDuration}s behind live`);
  log(`If using liveSyncDuration=4 (absolute)                              → 4s behind live`);
  log('');

  // Find safe play point
  log('Buffer surplus timeline (surplus = buffered_time - wall_clock_time):');
  for (const r of results) {
    const bar = '█'.repeat(Math.max(0, Math.round(r.surplus * 5)));
    const sign = r.surplus >= 0 ? '+' : '';
    log(`  After seg ${r.i}: surplus=${sign}${r.surplus.toFixed(2)}s | cumBuf=${r.cumBuf.toFixed(2)}s in ${r.cumDlSec.toFixed(2)}s wall | ${bar}`);
  }

  // Find where surplus exceeds one segment duration (safe to play)
  const safeIdx = results.findIndex(r => r.surplus > maxDur);
  log('');
  if (safeIdx >= 0) {
    const safe = results[safeIdx];
    log(`✓ Safe to start playback after segment #${safeIdx}`);
    log(`  Buffer gate threshold: ${safe.cumBuf.toFixed(1)}s`);
    log(`  Expected load time:    ~${safe.cumDlSec.toFixed(1)}s`);
    log(`  Surplus at start:      ${safe.surplus.toFixed(1)}s (can survive ${(safe.surplus / maxDur).toFixed(1)}x segment downloads)`);
  } else {
    log('✗ Download speed is slower than playback — stalls are expected at any threshold.');
    log('  Consider testing with a lower quality or faster connection.');
  }
}

log('');
log('═'.repeat(80));
flush();
