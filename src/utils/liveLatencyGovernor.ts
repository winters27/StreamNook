import type Hls from 'hls.js';

/**
 * Continuous live-latency maintenance, shared by the solo player and MultiNook tiles.
 *
 * hls.js runs here with `lowLatencyMode:false` (the correct setting for Twitch over a
 * proxy: native LL-HLS chunk parsing causes cyclic starvation). A side effect is that
 * hls.js's OWN playback-rate catch-up is gated off, so nothing holds the playhead at
 * the configured cushion after the cold-start snap and latency drifts upward across a
 * session (the "10-20s behind live" bug).
 *
 * This governor restores that maintenance WITHOUT ever seeking (seeking a live hls.js
 * stream toward the edge mid-playback freezes it — a hard-won lesson). It nudges
 * `video.playbackRate` only.
 *
 * WHAT IT MEASURES — the FORWARD BUFFER (`bufferedEnd - currentTime`), NOT the
 * distance to the playlist's live edge. This distinction is load-bearing: on a
 * low-latency channel the relay promotes Twitch's in-progress PREFETCH segments, so
 * hls.js's reported live edge sits ahead of what is actually downloadable. Chasing
 * that edge makes the governor accelerate into the in-progress zone and starve the
 * buffer (constant stalls). The forward buffer is always reachable, so targeting it
 * is safe: the governor speeds up ONLY when there is EXCESS forward buffer (the
 * playhead has fallen behind and there is downloaded content to consume), and that
 * very act shrinks the excess back to the target — it can never drain the buffer
 * below the target, so it cannot cause a stall.
 *
 * User speed control is respected for free: every Plyr speed-up option is >= 1.25
 * (above any sane `ceiling`) and every slow-mo option is < 1.0, so if the current
 * playback rate sits outside (1.0 .. ceiling] the user has taken manual control and
 * the governor stands down until the rate returns to 1.0.
 */
export interface LatencyGovernorOptions {
  /** Target forward-buffer seconds. Defaults to reading `hls.config.liveSyncDuration` (the cushion). */
  getTarget?: () => number;
  /** Max rate the governor will use to catch up. Keep < 1.25 (Plyr's lowest speed-up) so user selections are never fought. */
  ceiling?: number;
  /** Seconds of forward buffer ABOVE target before the governor starts catching up. */
  band?: number;
  /** Poll interval (ms). */
  tickMs?: number;
  /** Forward buffer beyond `target + dvrSlack` is treated as a deliberate DVR scrub-back and left alone. */
  dvrSlack?: number;
  /** Optional label for logs. */
  label?: string;
  /** Optional debug logger (callers pass their own to avoid a logger dependency here). */
  log?: (msg: string) => void;
}

const DEFAULTS = {
  ceiling: 1.05,
  band: 1.5,
  tickMs: 2000,
  dvrSlack: 25,
};

function forwardBuffer(video: HTMLVideoElement): number {
  try {
    const b = video.buffered;
    return b.length > 0 ? Math.max(0, b.end(b.length - 1) - video.currentTime) : 0;
  } catch {
    // buffered can throw if the element is mid-teardown.
    return 0;
  }
}

/**
 * Start the governor against a live hls.js instance. Returns a stop function that
 * clears the loop and restores normal playback rate. Safe to call the stop function
 * more than once.
 */
export function startLatencyGovernor(
  hls: Hls,
  video: HTMLVideoElement,
  options: LatencyGovernorOptions = {},
): () => void {
  const ceiling = options.ceiling ?? DEFAULTS.ceiling;
  const band = options.band ?? DEFAULTS.band;
  const tickMs = options.tickMs ?? DEFAULTS.tickMs;
  const dvrSlack = options.dvrSlack ?? DEFAULTS.dvrSlack;
  const getTarget =
    options.getTarget ??
    (() => {
      const t = hls.config.liveSyncDuration;
      return typeof t === 'number' && Number.isFinite(t) ? t : 6;
    });

  const resetRate = () => {
    if (video.playbackRate > 1.0 && video.playbackRate <= ceiling) {
      video.playbackRate = 1.0;
    }
  };

  const tick = () => {
    if (video.paused || video.seeking) return;

    // Hand control back to the user if they've chosen a speed outside our band.
    const rate = video.playbackRate;
    if (rate < 1.0 || rate > ceiling) return;

    const target = getTarget();
    const fb = forwardBuffer(video);

    // A very large forward buffer means the user scrubbed back into the DVR window;
    // leave it to them (Go Live snaps back to live).
    if (fb > target + dvrSlack) {
      resetRate();
      return;
    }

    const excess = fb - target;
    if (excess > band) {
      // The playhead has fallen behind and there is downloaded content to consume.
      // Gently speed up; consuming the excess shrinks fb back toward target, so this
      // can never drain below target (no stall). Proportional, capped at the ceiling.
      const next = Math.max(1.0, Math.min(ceiling, 1 + 0.03 * (excess - band)));
      if (Math.abs(next - rate) > 0.005) {
        video.playbackRate = next;
        options.log?.(
          `[Latency${options.label ? ` ${options.label}` : ''}] forward buffer ${fb.toFixed(1)}s ` +
            `(target ${target}s) -> rate ${next.toFixed(2)}`,
        );
      }
    } else if (rate > 1.0) {
      // Back within the band: stop catching up.
      video.playbackRate = 1.0;
    }
  };

  const id = window.setInterval(tick, tickMs);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    window.clearInterval(id);
    try {
      resetRate();
    } catch {
      // element may already be gone
    }
  };
}
