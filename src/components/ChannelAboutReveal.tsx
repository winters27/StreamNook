import { useState, useRef, useEffect, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ChevronUp, ChevronDown, Heart, HeartCrack, Loader2, Star } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../stores/AppStore';
import { useChannelSocial } from '../hooks/useChannelSocial';
import StreamerAboutPanel from './StreamerAboutPanel';

interface ChannelAboutRevealProps {
  /** Reveal is available (a real stream is playing, not MultiNook). */
  enabled: boolean;
  /** Channel to show About for; also resets the reveal when it changes. */
  channelLogin?: string;
  /** The video player area. */
  children: ReactNode;
}

// A smooth tween (not a spring) for the two-state swap. Both layers run the SAME
// tween, so they stay frame-synced with no overshoot — the seam between video and
// About never flickers. It still reads as a single snap: the wheel/click flips
// the state and this just animates cleanly to it.
const SNAP = { type: 'tween', duration: 0.4, ease: [0.4, 0, 0.2, 1] } as const;
// Minimum wheel delta to flip states — keeps a stray nudge from triggering.
const WHEEL_THRESHOLD = 24;

/**
 * Twitch-style channel reveal. Scrolling down over the player snaps an About
 * drawer up from below, pushing the video up and out of view; scrolling up at
 * the top of the About snaps back to the video. It is a magnetized two-state
 * swap (no partial scroll), and the stream KEEPS PLAYING the whole time — the
 * video element is only translated by a CSS transform, never unmounted.
 */
export default function ChannelAboutReveal({ enabled, channelLogin, children }: ChannelAboutRevealProps) {
  const [showAbout, setShowAbout] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const aboutScrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // True when the player area is taller than the ~16:9 video, so there's a black
  // letterbox bar below it big enough to hold the About hint clear of the stream.
  const [hasBottomBar, setHasBottomBar] = useState(false);
  const currentStream = useAppStore((s) => s.currentStream);
  const openStreamerMedia = useAppStore((s) => s.openStreamerMedia);

  // Never reveal over a fullscreen stream. Best-effort via the Tauri window
  // fullscreen flag, refreshed on resize (which fires on fullscreen toggles).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    // Guards the async race: if the effect is torn down before onResized()
    // resolves, the cleanup ran with unlisten still undefined — so unlisten the
    // moment it resolves instead, and never setState after unmount.
    let cancelled = false;
    const w = getCurrentWindow();
    const refresh = () => {
      w.isFullscreen()
        .then((v) => {
          if (!cancelled) setIsFullscreen(v);
        })
        .catch(() => {});
    };
    refresh();
    w.onResized(refresh)
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const active = enabled && !!channelLogin && !isFullscreen;
  // Effective open state — never "open" when the reveal isn't active, so a stale
  // true can't push the video off-screen with nothing behind it.
  const open = active && showAbout;

  // Follow / subscribe state for the current channel — only looked up while the
  // About is open (enabled), so it doesn't duplicate the player overlay's checks.
  const {
    isFollowing,
    followLoading,
    checkingFollowStatus,
    handleFollowClick,
    isSubscribed,
    hasSubHistory,
    subscriberBadgeUrl,
    handleSubscribeClick,
  } = useChannelSocial({
    userId: currentStream?.user_id,
    userLogin: currentStream?.user_login,
    userName: currentStream?.user_name,
    enabled: open,
  });

  // Reset to the stream when the channel changes (render-phase, React's "adjust
  // state on prop change" pattern — not an effect, so it converges immediately
  // and avoids the synchronous-setState-in-effect cascade).
  const [shownFor, setShownFor] = useState(channelLogin);
  if (channelLogin !== shownFor) {
    setShownFor(channelLogin);
    if (showAbout) setShowAbout(false);
  }

  // Always open the About at the top.
  useEffect(() => {
    if (open && aboutScrollRef.current) aboutScrollRef.current.scrollTop = 0;
  }, [open]);

  // Track whether a bottom letterbox bar exists (player area taller than the
  // ~16:9 video). The hint only shows when the bar can hold it clear of the
  // stream, so it never sits over the actual video content.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      const bottomBar = (h - (w * 9) / 16) / 2;
      setHasBottomBar(bottomBar >= 30);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onWheel = (e: React.WheelEvent) => {
    if (!active) return;
    if (!open) {
      // On the video: a downward scroll reveals the About.
      if (e.deltaY > WHEEL_THRESHOLD) setShowAbout(true);
    } else {
      // On the About: it scrolls normally; an upward scroll AT THE TOP returns
      // to the stream.
      const el = aboutScrollRef.current;
      if (el && el.scrollTop <= 0 && e.deltaY < -WHEEL_THRESHOLD) setShowAbout(false);
    }
  };

  return (
    <div ref={rootRef} className="group/reveal flex-1 relative overflow-hidden bg-background" onWheel={active ? onWheel : undefined}>
      {/* Video layer — pushed fully up and out when the About is revealed. The
          stream keeps playing; this is only a transform. */}
      <motion.div className="absolute inset-0" animate={{ y: open ? '-100%' : '0%' }} transition={SNAP}>
        {children}
      </motion.div>

      {active && (
        <>
          {/* About drawer — rises from below to fully cover the area. Parked
              off-screen (pointer-events off) until revealed. */}
          <motion.div
            className="absolute inset-0 z-30 flex flex-col bg-background"
            style={{ pointerEvents: open ? 'auto' : 'none' }}
            animate={{ y: open ? '0%' : '100%' }}
            transition={SNAP}
          >
            <div className="flex flex-shrink-0 items-center gap-2 border-b border-borderSubtle bg-background px-4 py-2">
              <button
                type="button"
                onClick={() => setShowAbout(false)}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-textSecondary transition-colors hover:bg-glass-hover hover:text-textPrimary"
              >
                <ChevronUp className="h-3.5 w-3.5" />
                Back to stream
              </button>
              {/* Channel actions, mirrored from the player overlay so you can act
                  without leaving the About. */}
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleFollowClick}
                  disabled={followLoading || checkingFollowStatus}
                  className={`flex items-center gap-1.5 px-3 py-1.5 glass-button rounded-lg text-xs font-semibold text-textPrimary ${
                    followLoading || checkingFollowStatus ? 'cursor-wait opacity-60' : ''
                  }`}
                >
                  {followLoading || checkingFollowStatus ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-textSecondary" />
                  ) : isFollowing ? (
                    <HeartCrack className="h-3.5 w-3.5 text-red-400" />
                  ) : (
                    <Heart className="h-3.5 w-3.5 text-emerald-400" />
                  )}
                  {isFollowing ? 'Following' : 'Follow'}
                </button>
                <button
                  type="button"
                  onClick={handleSubscribeClick}
                  className="flex items-center gap-2 px-3 py-1.5 glass-button rounded-lg text-xs font-semibold text-textPrimary"
                >
                  {subscriberBadgeUrl ? (
                    <img src={subscriberBadgeUrl} alt="" className="h-4 w-4 object-contain" referrerPolicy="no-referrer" />
                  ) : (
                    <Star className="h-3.5 w-3.5 text-accent" />
                  )}
                  {isSubscribed ? 'Gift Subs' : hasSubHistory ? 'Resubscribe' : 'Subscribe'}
                </button>
                {currentStream?.user_id && (
                  <button
                    type="button"
                    onClick={() => currentStream && openStreamerMedia(currentStream)}
                    className="flex items-center px-3 py-1.5 glass-button rounded-lg text-xs font-semibold text-textPrimary"
                  >
                    Clips &amp; VODs
                  </button>
                )}
              </div>
            </div>
            {/* Single scroller: the panel's own overflow is the one that scrolls,
                and we read its scrollTop (aboutScrollRef) to decide when an upward
                scroll at the top should snap back to the stream. */}
            <div className="min-h-0 flex-1">
              {channelLogin && (
                <StreamerAboutPanel channelLogin={channelLogin} scrollRef={aboutScrollRef} />
              )}
            </div>
          </motion.div>

          {/* Scroll affordance, pinned to the bottom edge. Only shown when a bottom
              letterbox bar can hold it (so it never sits over the video). Mounted
              while the bar exists so it FADES (not pops) with the open/hover swap —
              opacity-0 while the About is open, and on hover so it never collides
              with the player's bottom controls (which only appear on hover). */}
          {hasBottomBar && (
            <button
              type="button"
              onClick={() => setShowAbout(true)}
              aria-hidden={open}
              className={`absolute bottom-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-black/40 px-2.5 py-0.5 text-[11px] font-medium text-white/60 backdrop-blur-sm transition-all duration-300 hover:bg-black/60 hover:text-white group-hover/reveal:pointer-events-none group-hover/reveal:opacity-0 ${open ? 'pointer-events-none opacity-0' : 'pointer-events-auto opacity-80'}`}
            >
              About
              <ChevronDown className="h-3 w-3" />
            </button>
          )}
        </>
      )}
    </div>
  );
}
