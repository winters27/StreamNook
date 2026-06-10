import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type Hls from 'hls.js';
import { Activity, Radio, X } from 'lucide-react';

// Live playback telemetry overlay (the "behind live" + FPS readout). Reads hls.js
// and the <video> element directly each second while open, so it costs nothing
// when collapsed. "Behind live" is wall-clock end-to-end: local time minus the
// PROGRAM-DATE-TIME of the frame on screen (the same metric as Twitch's own
// "Latency To Broadcaster" stat, so the two players read comparably). The
// playlist-edge distance (hls.latency) is only a fallback: when the relay promotes
// prefetch hints, the playlist edge is declared ahead of what the encoder has
// produced, so edge distance over-reads by the ~2-4s of future nobody is behind.
// PDT instead trusts the local clock, and NTP keeps that within ~0.5s.

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
    // Wall-clock end-to-end first: now minus the PDT timestamp of the playing
    // frame (Twitch playlists always carry PROGRAM-DATE-TIME and both relay paths
    // pass it through). Edge-based fallbacks only for streams without PDT.
    let lat: number | null = null;
    const playingDate = hls.playingDate;
    if (playingDate) {
      lat = Math.max(0, (Date.now() - playingDate.getTime()) / 1000);
    } else if (typeof hls.latency === 'number' && hls.latency > 0) {
      lat = hls.latency;
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
        : `Proxy${adSource.region ? ` ${adSource.region}` : ''}`
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
