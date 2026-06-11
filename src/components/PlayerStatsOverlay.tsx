import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type Hls from 'hls.js';
import { Activity, Radio, X } from 'lucide-react';

// Live playback telemetry overlay (the "behind live" + FPS readout). Reads hls.js
// and the <video> element directly each second while open, so it costs nothing
// when collapsed. "Behind live" is the playhead's distance from the live edge. On the
// LL-HLS-origin path it's `hls.latency` (the gap to the newest real part the origin
// serves — honest because only parts with bytes are listed, no phantom-future edge).
// PROGRAM-DATE-TIME is deliberately NOT the primary source: Twitch's PDT base is not
// reliable wall-clock and varies per stream, so `now - PDT` could read ~0 (clamped) or
// wildly high. PDT/edge remain fallbacks for non-LL streams without a usable latency.

interface AdSourceLike {
  mode?: string;
  entitled?: boolean;
  region?: string | null;
}

interface Metrics {
  latency: number | null;
  /** Configured live-sync cushion (seconds behind the frontier the path is DESIGNED to ride). */
  syncTarget: number | null;
  resolution: string | null;
  fps: number | null;
  bitrateMbps: number | null;
  bandwidthMbps: number | null;
  bufferSec: number | null;
  dropped: number;
  droppedPct: number | null;
}

const EMPTY: Metrics = {
  latency: null,
  syncTarget: null,
  resolution: null,
  fps: null,
  bitrateMbps: null,
  bandwidthMbps: null,
  bufferSec: null,
  dropped: 0,
  droppedPct: null,
};

function readMetrics(hls: Hls | null, video: HTMLVideoElement | null): Metrics {
  const m: Metrics = { ...EMPTY };

  if (video) {
    try {
      const b = video.buffered;
      if (b.length > 0) m.bufferSec = Math.max(0, b.end(b.length - 1) - video.currentTime);
    } catch {
      /* buffered can throw if the element is mid-teardown */
    }
    try {
      const q = video.getVideoPlaybackQuality?.();
      if (q) {
        m.dropped = q.droppedVideoFrames;
        if (q.totalVideoFrames > 0) {
          m.droppedPct = (q.droppedVideoFrames / q.totalVideoFrames) * 100;
        }
      }
    } catch {
      /* not all engines expose playback quality */
    }
  }

  if (hls) {
    const lvlIndex = hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel;
    const lvl = lvlIndex >= 0 ? hls.levels?.[lvlIndex] : undefined;
    if (lvl) {
      if (lvl.height) m.resolution = `${lvl.height}p`;
      if (lvl.bitrate) m.bitrateMbps = lvl.bitrate / 1_000_000;
      const fr = (lvl.attrs as Record<string, string> | undefined)?.['FRAME-RATE'];
      const frn = fr ? parseFloat(fr) : NaN;
      if (Number.isFinite(frn)) m.fps = Math.round(frn);
    }
    if (typeof hls.bandwidthEstimate === 'number' && hls.bandwidthEstimate > 0) {
      m.bandwidthMbps = hls.bandwidthEstimate / 1_000_000;
    }
    // "Behind live" = distance from the playhead to the live edge.
    //
    // On the LL-HLS-origin path (lowLatencyMode), `hls.latency` is the honest metric:
    // it's the gap from the playhead to the newest REAL part the origin serves (the
    // origin only lists parts whose bytes exist, so there's no phantom-future
    // over-read). We deliberately do NOT use PROGRAM-DATE-TIME here: Twitch's PDT is
    // not guaranteed real wall-clock and its base varies per stream (observed reading
    // anywhere from a correct ~2s to 90s+), and when it runs slightly ahead of the
    // local clock the old `max(0, now - PDT)` clamped to 0 — the "shows 0s when really
    // ~2s" bug. PDT/edge stay as fallbacks for non-LL streams that have no usable
    // hls.latency.
    let lat: number | null = null;
    const hlsLat = typeof hls.latency === 'number' && hls.latency > 0 ? hls.latency : null;
    const isLowLatency = hls.config?.lowLatencyMode === true;
    const playingDate = hls.playingDate;
    const pdtLat = playingDate ? (Date.now() - playingDate.getTime()) / 1000 : null;
    if (isLowLatency && hlsLat != null) {
      lat = hlsLat;
    } else if (pdtLat != null && pdtLat > 0.2 && pdtLat < 60) {
      lat = pdtLat; // sane PDT (non-LL streams)
    } else if (hlsLat != null) {
      lat = hlsLat;
    } else if (lvl?.details && video) {
      const edge = lvl.details.edge;
      if (Number.isFinite(edge)) lat = Math.max(0, edge - video.currentTime);
    }
    m.latency = lat;
    const sync = hls.config.liveSyncDuration;
    if (typeof sync === 'number' && Number.isFinite(sync)) m.syncTarget = sync;
  }

  return m;
}

// Thresholds are for the END-TO-END number: ~2-3s is the LL-HLS path, ~7-8s is the
// natural floor of the conservative non-LL cushion (6s cushion + ~2s encode+CDN
// pipeline), so red starts only past what any healthy mode can sit at.
function latencyClass(latency: number | null): string {
  if (latency == null) return 'text-textPrimary';
  if (latency <= 4) return 'text-emerald-400';
  if (latency <= 9) return 'text-amber-400';
  return 'text-red-400';
}

function Row({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-textSecondary">{label}</span>
      <span className={`font-medium tabular-nums ${valueClass ?? 'text-textPrimary'}`}>{value}</span>
    </div>
  );
}

interface Props {
  hlsRef: RefObject<Hls | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Whether the panel is open. Toggled from the Plyr settings menu's "Stats" item. */
  open: boolean;
  onToggle: () => void;
  onGoLive: () => void;
  adSource?: AdSourceLike | null;
}

const PlayerStatsOverlay = ({ hlsRef, videoRef, open, onToggle, onGoLive, adSource }: Props) => {
  const [metrics, setMetrics] = useState<Metrics>(EMPTY);

  useEffect(() => {
    if (!open) return;
    const tick = () => setMetrics(readMetrics(hlsRef.current, videoRef.current));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [open, hlsRef, videoRef]);

  // Opened from the Plyr settings menu ("Stats"); closed via the panel's X.
  if (!open) return null;

  const sourceLabel = adSource
    ? adSource.entitled
      ? adSource.mode === 'turbo'
        ? 'Turbo (direct)'
        : 'Sub (direct)'
      : adSource.mode === 'auth-only'
        ? 'Direct (ads)'
        : `Plugin${adSource.region ? ` ${adSource.region}` : ''}`
    : null;

  // Go Live is for genuine drift (a scrub-back or latency creep), not the path's
  // natural floor: every mode rides ~syncTarget behind the download frontier plus
  // ~2s of encode+CDN pipeline it can never recover, so "behind live" cannot go
  // below roughly syncTarget + 2 by design. Only offer the button well past that.
  const goLiveFloor = (metrics.syncTarget ?? 4) + 4;
  const showGoLive = metrics.latency != null && metrics.latency > goLiveFloor;

  return (
    <div className="absolute bottom-16 left-4 z-50 w-52 pointer-events-auto">
      <div className="glass-panel rounded-lg border border-white/10 bg-background/95 backdrop-blur-md px-3 py-2.5 text-xs">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <Activity size={13} className="text-accent" />
            <span className="text-textPrimary font-semibold tracking-wide">Stream Stats</span>
          </div>
          <button onClick={onToggle} aria-label="Close stats" className="text-textSecondary hover:text-textPrimary transition-colors">
            <X size={13} />
          </button>
        </div>

        <div className="space-y-1">
          <Row
            label="Behind live"
            value={metrics.latency != null ? `${metrics.latency.toFixed(1)}s` : '-'}
            valueClass={latencyClass(metrics.latency)}
          />
          <Row
            label="Resolution"
            value={metrics.resolution ? `${metrics.resolution}${metrics.fps ? metrics.fps : ''}` : '-'}
          />
          <Row label="Dropped" value={`${metrics.dropped}${metrics.droppedPct != null ? ` (${metrics.droppedPct.toFixed(2)}%)` : ''}`} />
          <Row label="Video bitrate" value={metrics.bitrateMbps != null ? `${metrics.bitrateMbps.toFixed(1)} Mbps` : '-'} />
          <Row label="Bandwidth" value={metrics.bandwidthMbps != null ? `${metrics.bandwidthMbps.toFixed(1)} Mbps` : '-'} />
          <Row label="Buffer" value={metrics.bufferSec != null ? `${metrics.bufferSec.toFixed(1)}s` : '-'} />
          {sourceLabel && <Row label="Source" value={sourceLabel} />}
        </div>

        {showGoLive && (
          <button
            onClick={onGoLive}
            className="mt-2.5 w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md glass-button text-white font-medium hover:bg-white/10 transition-colors"
            style={{ backdropFilter: 'blur(16px)' }}
          >
            <Radio size={13} className="text-red-400" />
            Go Live
          </button>
        )}
      </div>
    </div>
  );
};

export default PlayerStatsOverlay;
