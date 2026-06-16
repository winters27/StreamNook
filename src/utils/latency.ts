// Shared live-latency constants for the parts-based low-latency path.

// On that path, hls.latency measures playhead-to-edge, which sits about a second above
// the glass-to-glass "latency to broadcaster" figure Twitch reports. The stats overlay
// subtracts this so the displayed "behind live" is comparable to Twitch's number, and
// the player adds it back when turning the user's chosen DISPLAYED target into the real
// cushion + governor target.
export const LL_DISPLAY_CALIBRATION = 1.0;

// Default live-edge gap (displayed seconds behind live) when the user hasn't set their
// own. Applies on every path, so the default has to stay smooth even with the
// low-latency engine off: ~6s rides a bit closer than the old fixed 8 while keeping
// ample buffer for normal-channel delivery jitter. Lower it (and turn on Low Latency)
// to ride near the edge.
export const LL_TARGET_DEFAULT = 6.0;
