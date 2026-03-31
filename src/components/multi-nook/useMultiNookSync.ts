import { useEffect } from 'react';
import Hls from 'hls.js';
// Global non-reactive registry for HLS instances to prevent Zustand re-render storms
export const multiNookHlsRegistry = new Map<string, Hls>();

export const useMultiNookSync = () => {
  useEffect(() => {
    // Auto-sync nudging has been disabled per user preference.
    // We now rely entirely on parallel concurrent starting (via the Resync button) 
    // rather than continuously adjusting playback rates which can cause audio/video drift glitches.
  }, []);
};
