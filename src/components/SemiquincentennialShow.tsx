// Semiquincentennial launch celebration: on July 4, 2026 the first launch of
// the day plays a full-window fireworks show, then a "250 Years" card. The
// card's Continue watching leaves the show running until the corner exit (or
// Escape) closes it; a title-bar button reopens it any time that day.
// The show is the vendored Firework Simulator v2 (see fireworks/).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import type { FireworksHandle } from './fireworks/fireworkSimulator';
import {
  GRAND_FINALE_ACCOLADE_ID,
  GRAND_FINALE_GRANTED_KEY,
  GRAND_FINALE_THRESHOLD_MS,
  GRAND_FINALE_WATCH_MS_KEY,
  isSemiquincentennialShowDay,
  SEMIQUINCENTENNIAL_OPEN_EVENT,
  SEMIQUINCENTENNIAL_SHOWN_KEY,
} from '../services/semiquincentennialEvent';
import { grantAccolade } from '../services/supabaseService';
import { useAppStore } from '../stores/AppStore';

// Show timeline (ms): gentle opening shells, then finale mode; the first
// (automatic) showing follows the finale with the greeting card.
const FINALE_AT = 5000;
const FINALE_END = 13000;

const shouldAutoShow = (): boolean => {
  if (!isSemiquincentennialShowDay()) return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  try {
    return !localStorage.getItem(SEMIQUINCENTENNIAL_SHOWN_KEY);
  } catch {
    return false;
  }
};

export const SemiquincentennialShow: React.FC = () => {
  const [phase, setPhase] = useState<'idle' | 'show' | 'modal'>(() => (shouldAutoShow() ? 'show' : 'idle'));
  const skyRef = useRef<HTMLDivElement | null>(null);
  const trailsRef = useRef<HTMLCanvasElement | null>(null);
  const mainRef = useRef<HTMLCanvasElement | null>(null);
  const handleRef = useRef<FireworksHandle | null>(null);
  const timersRef = useRef<number[]>([]);
  // The greeting card shows once per overlay opening, only on the auto showing.
  const greetRef = useRef(shouldAutoShow());

  // Latch the auto-play so later launches on the day skip straight past it.
  // Only on the day itself: a rehearsal before the 4th must not spend it.
  useEffect(() => {
    if (phase === 'idle' || !isSemiquincentennialShowDay()) return;
    try {
      localStorage.setItem(SEMIQUINCENTENNIAL_SHOWN_KEY, new Date().toISOString());
    } catch {
      // best effort
    }
  }, [phase]);

  const clearTimers = () => {
    timersRef.current.forEach((t) => window.clearTimeout(t));
    timersRef.current = [];
  };

  // One arc of the show: finale after the opening, then either the greeting
  // card (first automatic showing) or an open-ended show that keeps playing.
  const runTimeline = useCallback(() => {
    clearTimers();
    handleRef.current?.setFinale(false);
    timersRef.current.push(
      window.setTimeout(() => handleRef.current?.setFinale(true), FINALE_AT),
      window.setTimeout(() => {
        handleRef.current?.setFinale(false);
        if (greetRef.current) {
          greetRef.current = false;
          setPhase('modal');
        }
      }, FINALE_END),
    );
  }, []);

  // Ignite the simulator once the overlay's canvases exist.
  useEffect(() => {
    if (phase === 'idle') return;
    let cancelled = false;
    if (!handleRef.current) {
      void import('./fireworks/fireworkSimulator').then(({ igniteFireworks }) => {
        if (cancelled || !trailsRef.current || !mainRef.current || !skyRef.current) return;
        handleRef.current = igniteFireworks({
          trailsCanvas: trailsRef.current,
          mainCanvas: mainRef.current,
          container: skyRef.current,
          skyGlow: 3.5,
        });
        runTimeline();
      });
    }
    return () => {
      cancelled = true;
    };
  }, [phase, runTimeline]);

  const close = useCallback(() => {
    clearTimers();
    handleRef.current?.pause();
    handleRef.current = null;
    setPhase('idle');
  }, []);

  const continueWatching = useCallback(() => {
    clearTimers();
    setPhase('show');
  }, []);

  // Reopen from the UI (title bar) or devtools while the day is active.
  const open = useCallback(() => {
    if (handleRef.current) {
      handleRef.current.resume();
      runTimeline();
    }
    setPhase('show');
  }, [runTimeline]);

  useEffect(() => {
    const onOpen = () => open();
    window.addEventListener(SEMIQUINCENTENNIAL_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(SEMIQUINCENTENNIAL_OPEN_EVENT, onOpen);
  }, [open]);

  // Devtools trigger: __snShow250() plays the FULL first-launch experience on
  // any date (show, finale, greeting card), for verifying before the day.
  useEffect(() => {
    const w = window as unknown as { __snShow250?: () => void };
    w.__snShow250 = () => {
      greetRef.current = true;
      open();
    };
    return () => {
      delete w.__snShow250;
    };
  }, [open]);

  useEffect(() => {
    if (phase === 'idle') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, close]);

  // Secret accolade: total show watch time adds up across viewings; a full
  // minute earns Grand Finale. Persisted per tick so partial views count.
  useEffect(() => {
    if (phase === 'idle') return;
    const tick = window.setInterval(() => {
      if (document.hidden) return;
      let total = 0;
      try {
        total = (parseInt(localStorage.getItem(GRAND_FINALE_WATCH_MS_KEY) ?? '0', 10) || 0) + 1000;
        localStorage.setItem(GRAND_FINALE_WATCH_MS_KEY, String(total));
        if (total < GRAND_FINALE_THRESHOLD_MS || localStorage.getItem(GRAND_FINALE_GRANTED_KEY)) return;
      } catch {
        return;
      }
      const userId = useAppStore.getState().currentUser?.user_id;
      if (!userId) return;
      try {
        localStorage.setItem(GRAND_FINALE_GRANTED_KEY, '1');
      } catch {
        // still grant; the server upsert is idempotent
      }
      void grantAccolade(userId, GRAND_FINALE_ACCOLADE_ID).then(() => {
        useAppStore.getState().addToast('Achievement unlocked: Grand Finale', 'success', undefined, { alwaysShow: true });
      });
    }, 1000);
    return () => window.clearInterval(tick);
  }, [phase]);

  return (
    <AnimatePresence>
      {phase !== 'idle' && (
        <motion.div
          className="fixed inset-0 z-[65]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.6 }}
        >
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => phase === 'show' && greetRef.current && setPhase('modal')} />
          <div ref={skyRef} className="pointer-events-none absolute inset-0" />
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <canvas ref={trailsRef} className="absolute left-0 top-0" />
            <canvas ref={mainRef} className="absolute left-0 top-0" />
          </div>
          <button
            type="button"
            aria-label="Close the fireworks show"
            className="glass-button absolute right-4 top-10 z-10 flex h-9 w-9 items-center justify-center rounded-full text-white/80 hover:text-white"
            onClick={close}
          >
            <X size={18} />
          </button>
          <AnimatePresence>
            {phase === 'modal' && (
              <motion.div
                className="absolute inset-0 flex items-center justify-center"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.45 }}
              >
                <div className="liquid-glass-panel w-[440px] max-w-[90vw] rounded-xl border border-white/10 p-8 text-center">
                  <div className="text-[13px] uppercase tracking-[0.3em] text-white/50">1776 to 2026</div>
                  <div className="mt-2 text-4xl font-semibold text-white">250 Years</div>
                  <p className="mt-4 text-sm leading-relaxed text-white/75">
                    Thank you for being part of StreamNook. Have a happy and safe Fourth of July.
                  </p>
                  <div className="mt-7 flex items-center justify-center">
                    <button type="button" className="glass-button px-5 py-2 text-sm font-medium text-white" onClick={continueWatching}>
                      Continue watching
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default SemiquincentennialShow;
