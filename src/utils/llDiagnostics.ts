// Low-latency playback diagnostic recorder.
//
// Streams structured JSON-line records to a backend file (via start_ll_diag /
// append_ll_diag) so a live drift or A/V-desync session can be analyzed from
// RECORDED FACTS instead of inference. The decisive signals it captures:
//   - per-track buffered ends (audio vs video) over time, plus whether the buffer is
//     muxed ("audiovideo") or split — this alone confirms or refutes "video trails
//     audio";
//   - each fragment/part's DEMUXED PTS/DTS vs its declared duration (real seams?);
//   - currentTime, playbackRate, hls.latency, dropped/total frames, PDT, and errors.
//
// Cheap: a handful of property reads per second + a batched IPC every 2s. Active only
// while explicitly started (the LL path), stopped on teardown.

import { invoke } from '@tauri-apps/api/core';
import Hls from 'hls.js';

type AnyHls = Hls & Record<string, unknown>;

let pending: string[] = [];
let tickTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let teardown: Array<() => void> = [];
let active = false;
// Latest per-source-buffer end seen on BUFFER_APPENDED, carried into each tick so we
// always have audio-end and video-end sampled at the same moment.
let lastTrackEnds: Record<string, number> = {};
let sbKinds = ''; // "audiovideo" (muxed) or "audio+video" (split) — recorded once

function rec(obj: Record<string, unknown>): void {
  // Round floats to ms/3-dp so the file stays readable; never throw.
  try {
    pending.push(JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

function rangesToArr(tr: TimeRanges | null | undefined): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!tr) return out;
  for (let i = 0; i < tr.length; i++) out.push([+tr.start(i).toFixed(3), +tr.end(i).toFixed(3)]);
  return out;
}

function endOf(tr: TimeRanges | null | undefined): number | null {
  return tr && tr.length ? +tr.end(tr.length - 1).toFixed(3) : null;
}

async function flush(): Promise<void> {
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  try {
    await invoke('append_ll_diag', { lines: batch });
  } catch {
    /* drop on failure; never affect playback */
  }
}

export async function startLLDiagnostics(
  hls: Hls,
  video: HTMLVideoElement,
  label: string,
): Promise<void> {
  stopLLDiagnostics();
  let path = '';
  try {
    path = await invoke<string>('start_ll_diag', { label });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[LLDIAG] could not start session', e);
    return;
  }
  active = true;
  lastTrackEnds = {};
  sbKinds = '';
  // eslint-disable-next-line no-console
  console.log(`%c[LLDIAG] recording playback diagnostics to:\n${path}`, 'color:#1a9c4a;font-weight:bold');
  rec({ ev: 'session', t: Date.now(), path, label, ua: navigator.userAgent });

  const h = hls as AnyHls;

  const onAppended = (_e: unknown, data: { type?: string; timeRanges?: Record<string, TimeRanges> }) => {
    const ranges = data?.timeRanges ?? {};
    const keys = Object.keys(ranges);
    if (!sbKinds && keys.length) {
      sbKinds = keys.slice().sort().join('+');
      rec({ ev: 'sbkind', t: Date.now(), kinds: sbKinds });
    }
    const ends: Record<string, number | null> = {};
    for (const k of keys) {
      const e = endOf(ranges[k]);
      ends[k] = e;
      if (e != null) lastTrackEnds[k] = e;
    }
    rec({ ev: 'appended', t: Date.now(), type: data?.type ?? null, ends });
  };

  const onFragBuffered = (_e: unknown, data: { frag?: Record<string, number>; part?: { index?: number } }) => {
    const f = data?.frag;
    if (!f) return;
    rec({
      ev: 'frag',
      t: Date.now(),
      sn: f.sn,
      type: f.type,
      level: f.level,
      start: round(f.start),
      dur: round(f.duration),
      sPTS: round(f.startPTS),
      ePTS: round(f.endPTS),
      sDTS: round(f.startDTS),
      eDTS: round(f.endDTS),
      // measured PTS span vs the duration the playlist declared (seam check)
      ptsSpan: f.startPTS != null && f.endPTS != null ? round(f.endPTS - f.startPTS) : null,
      part: data?.part?.index ?? -1,
    });
  };

  const onError = (_e: unknown, data: { type?: string; details?: string; fatal?: boolean; error?: { message?: string } }) => {
    rec({ ev: 'err', t: Date.now(), type: data?.type, details: data?.details, fatal: data?.fatal, msg: data?.error?.message });
  };

  hls.on(Hls.Events.BUFFER_APPENDED, onAppended as never);
  hls.on(Hls.Events.FRAG_BUFFERED, onFragBuffered as never);
  hls.on(Hls.Events.ERROR, onError as never);
  teardown.push(() => hls.off(Hls.Events.BUFFER_APPENDED, onAppended as never));
  teardown.push(() => hls.off(Hls.Events.FRAG_BUFFERED, onFragBuffered as never));
  teardown.push(() => hls.off(Hls.Events.ERROR, onError as never));

  tickTimer = setInterval(() => {
    if (!active) return;
    // Always read the element hls.js is CURRENTLY attached to (`hls.media`), not a
    // captured `video` ref that can go stale across channel switches and then read
    // currentTime=0 while a different element is actually playing. Fall back to the
    // passed video only if hls.media is gone.
    const v = ((h.media as HTMLVideoElement | null) ?? video);
    let q: VideoPlaybackQuality | null = null;
    try {
      q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    } catch {
      q = null;
    }
    const mediaEnd = endOf(v.buffered);
    const ct = +v.currentTime.toFixed(3);
    let pdt: number | null = null;
    try {
      const d = h.playingDate as Date | null | undefined;
      pdt = d ? d.getTime() : null;
    } catch {
      pdt = null;
    }
    rec({
      ev: 'tick',
      t: Date.now(),
      ct,
      rate: v.playbackRate,
      paused: v.paused,
      mediaEnd,
      fwd: mediaEnd != null ? +(mediaEnd - ct).toFixed(3) : null, // forward buffer
      ranges: rangesToArr(v.buffered),
      // per-track ends carried from the last appends — the audio-vs-video answer
      vEnd: lastTrackEnds.video ?? null,
      aEnd: lastTrackEnds.audio ?? null,
      avEnd: lastTrackEnds.audiovideo ?? null,
      avGap:
        lastTrackEnds.audio != null && lastTrackEnds.video != null
          ? +(lastTrackEnds.audio - lastTrackEnds.video).toFixed(3) // >0 ⇒ video trails audio
          : null,
      lat: numOrNull(h.latency),
      sync: numOrNull(h.liveSyncPosition),
      drift: numOrNull(h.drift),
      pdt,
      wallLat: pdt != null ? +((Date.now() - pdt) / 1000).toFixed(3) : null, // true behind-broadcast
      dropped: q?.droppedVideoFrames ?? null,
      totalFrames: q?.totalVideoFrames ?? null,
    });
  }, 1000);

  flushTimer = setInterval(() => {
    void flush();
  }, 2000);
}

export function stopLLDiagnostics(): void {
  active = false;
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  for (const fn of teardown) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
  teardown = [];
  if (pending.length) {
    void flush();
  }
  void invoke('stop_ll_diag').catch(() => {
    /* ignore */
  });
}

function round(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? +n.toFixed(3) : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? +v.toFixed(3) : null;
}
