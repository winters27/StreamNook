import { useEffect } from 'react';
import Hls from 'hls.js';
import { Logger } from '../../utils/logger';

// Global non-reactive registry for HLS instances to prevent Zustand re-render storms
export const multiNookHlsRegistry = new Map<string, Hls>();

export const useMultiNookSync = () => {
  useEffect(() => {
    const streamJoinTimes = new Map<string, number>();

    // Sync loop runs every 2 seconds
    const interval = setInterval(() => {
      if (multiNookHlsRegistry.size < 2) return;

      const now = Date.now();
      const syncableStreams = new Map<string, Hls>();

      // 1. Filter streams and update join times
      for (const [id, hls] of multiNookHlsRegistry.entries()) {
        if (!streamJoinTimes.has(id)) {
          streamJoinTimes.set(id, now);
        }

        // Give new streams a 10s grace period to establish a stable buffer and live edge.
        // During this time, they won't force other streams to seek, nor will they be forcibly seeked.
        if (now - streamJoinTimes.get(id)! > 10000) {
          syncableStreams.set(id, hls);
        }
      }

      // Clean up orphaned join times
      for (const id of streamJoinTimes.keys()) {
        if (!multiNookHlsRegistry.has(id)) {
          streamJoinTimes.delete(id);
        }
      }

      // Need at least 2 stable streams to perform sync
      if (syncableStreams.size < 2) return;

      let oldestDateMs = Infinity;
      let masterId = '';

      // 2. Find the "master" stream (the one furthest behind physically in real-time)
      //    We find the smallest playingDate (oldest wall-clock time)
      for (const [id, hls] of syncableStreams.entries()) {
        const date = hls.playingDate;
        if (date && !hls.media?.paused) {
          const time = date.getTime();
          if (time < oldestDateMs) {
            oldestDateMs = time;
            masterId = id;
          }
        }
      }

      // If no valid playing streams found, exit early
      if (oldestDateMs === Infinity) return;

      // 3. Nudge all other streams to match the master
      for (const [id, hls] of syncableStreams.entries()) {
        if (!hls.media || hls.media.paused) continue;

        if (id === masterId) {
          // Master always plays at normal speed once it becomes the anchor
          if (hls.media.playbackRate !== 1.0) {
            hls.media.playbackRate = 1.0;
          }
          continue;
        }

        const date = hls.playingDate;
        if (!date) continue;

        const driftMs = date.getTime() - oldestDateMs;

        // Safety limit: if they are wildly out of sync (> 15s), ignore them.
        // It means they are likely not watching a co-stream, but unrelated streams entirely.
        if (driftMs > 15000 || driftMs < -15000) {
           if (hls.media.playbackRate !== 1.0) hls.media.playbackRate = 1.0;
           continue;
        }

        // Action thresholds for real-time syncing
        if (driftMs > 2500) {
          // Extremely far ahead (> 2.5s gap): Skip backward instantly
          Logger.debug(`[Sync] Stream ${id} is ${driftMs}ms ahead of master. Forcing precision seek.`);
          hls.media.currentTime = hls.media.currentTime - (driftMs / 1000);
          hls.media.playbackRate = 1.0;
        } else if (driftMs > 800) {
          // Slightly ahead (0.8s - 2.5s gap): Slow down to 0.95x to invisibly drift back
          if (hls.media.playbackRate !== 0.95) {
             Logger.debug(`[Sync] Stream ${id} is ${driftMs}ms ahead. Applying 0.95x slowdown nudge.`);
             hls.media.playbackRate = 0.95;
          }
        } else {
          // Within functional parity (< 800ms gap) - restore normal playback
          if (hls.media.playbackRate !== 1.0) {
             Logger.debug(`[Sync] Stream ${id} achieved parity. Restoring 1.0x standard speed.`);
             hls.media.playbackRate = 1.0;
          }
        }
      }
    }, 2000);

    return () => clearInterval(interval);
  }, []);
};
