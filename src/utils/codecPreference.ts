import { invoke } from '@tauri-apps/api/core';

/// Probe what this machine can actually decode and tell the Rust resolver which
/// video codecs it may select, most-preferred first. StreamNook resolves to a
/// SINGLE variant (there's no in-player codec fallback like a browser doing ABR
/// across the master), so resolving to a codec the GPU/OS can't decode would be a
/// black screen. We therefore only allow a codec the player reports as supported,
/// gated behind the user's `enhanced_codecs` setting, and always keep H.264 as the
/// universal fallback.
///
/// AV1 and HEVC variants also happen to ship as CMAF, so preferring them routes
/// low-latency channels through the LL-HLS origin (true ~2s) in addition to the
/// bandwidth saving the setting promises.
function canDecode(codec: string): boolean {
  try {
    return (
      typeof MediaSource !== 'undefined' &&
      MediaSource.isTypeSupported(`video/mp4; codecs="${codec}"`)
    );
  } catch {
    return false;
  }
}

export function reportCodecPreference(enhancedCodecs: boolean): void {
  const prefs: string[] = [];
  if (enhancedCodecs) {
    // AV1: Chromium/WebView2 bundles a software decoder (dav1d), so it is almost
    // always playable. Probe a couple of common profiles/levels to be safe.
    if (canDecode('av01.0.08M.08') || canDecode('av01.0.05M.08')) {
      prefs.push('av1');
    }
    // HEVC/H.265: needs hardware support plus the Windows "HEVC Video Extensions";
    // frequently absent, which is exactly why it is probed rather than assumed.
    if (canDecode('hev1.1.6.L93.B0') || canDecode('hvc1.1.6.L93.B0')) {
      prefs.push('hevc');
    }
  }
  prefs.push('h264'); // universal fallback, always last-resort decodable
  invoke('set_codec_preference', { prefs }).catch(() => {
    /* non-critical: resolver keeps its current (H.264-safe) preference */
  });
}
