import { useEffect, useRef, useState } from 'react';
import type { Atmosphere } from '../services/atmospheres';

// Renders a StreamNook Atmosphere. The motion is pure CSS (the `.sn-aurora-*`
// classes in globals.css), so it runs on the compositor off the main thread and
// stays cheap even when many chat messages each render one. Both variants use the
// SAME animation, so a member's chat wash matches their profile backdrop.
//   - 'profile' = full-panel backdrop (opaque base + drifting curtains).
//   - 'chat'    = a translucent, readability-masked wash behind a message row
//                 (no base, faded out toward the text) + a thin accent bar.
export const AtmosphereBackground = ({
  atm,
  variant,
}: {
  atm: Atmosphere;
  variant: 'profile' | 'chat';
}) => {
  if (variant === 'chat') {
    return <ChatAtmosphere atm={atm} />;
  }
  return (
    <div
      className="pointer-events-none absolute -inset-10 overflow-hidden"
      style={{ backgroundColor: atm.baseColor, backgroundImage: atm.baseLayers }}
    >
      <div
        className="sn-aurora-1 absolute -inset-[80%]"
        style={{ backgroundImage: atm.layers, backgroundRepeat: 'repeat' }}
      />
      {atm.layers2 && (
        <div
          className="sn-aurora-2 absolute -inset-[80%]"
          style={{ backgroundImage: atm.layers2, backgroundRepeat: 'repeat' }}
        />
      )}
    </div>
  );
};

// Chat-row wash. The animated curtains are oversized, perpetually-animating
// composited layers (each with its own GPU backing store via `will-change`).
// Rendering them for EVERY atmosphere message in the buffer — including the ones
// scrolled out of view — would pin a backing store + a running animation per
// row, so memory and compositing scale with the whole scrollback instead of
// what's on screen. We can't lean on `content-visibility: auto` to skip the
// off-screen ones: a composited layer inside a content-visibility subtree
// strands stale paint ghosts as the row scrolls (the bug this wash originally
// caused), so atmosphere rows are deliberately painted with content-visibility
// visible in ChatMessageList. This observer restores the missing bound: it
// mounts the heavy curtains only while the row is near the viewport, and drops
// them (freeing the backing stores and stopping the animation) once it scrolls
// away. The cheap static base + 1px edge always render, and a generous
// rootMargin pre-warms the curtains before the row is actually visible, so there
// is no pop-in and no visible animation restart.
const ChatAtmosphere = ({ atm }: { atm: Atmosphere }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  // Default ON so a freshly-arrived message at the live bottom paints its full
  // wash immediately; the observer trims it to false if it mounts off-screen.
  const [active, setActive] = useState(true);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        // Single observed target; the latest entry is the current state.
        setActive(entries[entries.length - 1].isIntersecting);
      },
      // root: null = viewport, but IntersectionObserver still clips against the
      // chat scroll container in between, so rows scrolled out of the list read
      // as not-intersecting. The 300px band keeps the curtains running just
      // outside the visible area so they are already in motion on entry.
      { rootMargin: '300px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Explicit overhang (not a % inset): wide enough left/right to cover the
  // 320px translate without revealing an edge, but only a little top/bottom so
  // the per-message layer texture stays small (chat can show many at once).
  const layerBox = { top: -28, bottom: -28, left: -360, right: -360 } as const;
  return (
    <>
      {/* Fills the WHOLE message row (the aurora as a backdrop, same as the
          profile), animated faster than the profile so the drift is legible at
          this small size. */}
      <div ref={hostRef} className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        {/* Static base — a normal (non-composited) paint, cheap to keep mounted
            always so the row's tint never flickers as the curtains come and go. */}
        <div
          className="absolute inset-0"
          style={{ backgroundColor: atm.baseColor, backgroundImage: atm.baseLayers, opacity: 0.85 }}
        />
        {/* Animated curtains — the heavy composited layers. Mounted only while
            the row is near the viewport (see the observer above). */}
        {active && (
          <>
            <div
              className="sn-aurora-1 absolute"
              style={{ ...layerBox, backgroundImage: atm.layers, backgroundRepeat: 'repeat', animationDuration: '9s' }}
            />
            {atm.layers2 && (
              <div
                className="sn-aurora-2 absolute"
                style={{ ...layerBox, backgroundImage: atm.layers2, backgroundRepeat: 'repeat', animationDuration: '12s' }}
              />
            )}
          </>
        )}
      </div>
      {/* 1px aurora-gradient edge down the left (replaces the flat accent bar). */}
      <div
        className="pointer-events-none absolute inset-y-0 left-0 w-px"
        style={{ background: atm.chatEdge }}
      />
    </>
  );
};
