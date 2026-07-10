import { useEffect, useRef, useState } from 'react';

// The member's Atmosphere wash behind a chat row — the SINGLE implementation used
// by BOTH the in-app chat (AtmosphereBackground) and the overlay renderer, so the
// two are guaranteed identical: no reproduction, no drift. Extracted verbatim from
// the app's former ChatAtmosphere, with the Tailwind utilities rewritten as inline
// styles so it runs on the hosted overlay page too (no Tailwind dependency). The
// animation classes `sn-aurora-1/2` are provided by globals.css in-app and injected
// by OverlayChat's own <style> on the overlay page — identical keyframes either way.

// Only the fields the wash actually reads. Both the app's full Atmosphere and the
// overlay's OverlayAtmosphere satisfy this, so either can be passed unchanged.
export interface AtmosphereWashData {
  baseColor: string;
  baseLayers?: string;
  image?: string;
  layers?: string;
  layers2?: string;
  chatEdge: string;
}

// Explicit overhang (not a % inset): wide enough left/right to cover the translate
// without revealing an edge, but only a little top/bottom so the per-message layer
// texture stays small.
const LAYER_BOX = { top: -28, bottom: -28, left: -360, right: -360 } as const;

export const AtmosphereChatWash = ({
  atm,
  observe = true,
}: {
  atm: AtmosphereWashData;
  // In-app chat has a long scrollback, so it mounts the heavy composited curtains
  // only while the row is near the viewport (frees GPU backing stores off-screen).
  // The overlay has no scrollback — off-screen rows are unmounted — so it always
  // renders; pass observe={false}.
  observe?: boolean;
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  // Default ON so a freshly-arrived message paints its full wash immediately; the
  // observer (when enabled) trims it to false if it mounts off-screen.
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (!observe) return;
    const el = hostRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => setActive(entries[entries.length - 1].isIntersecting),
      { rootMargin: '300px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [observe]);

  return (
    <>
      {/* Fills the whole message row (the aurora as a backdrop), animated faster
          than the profile so the drift is legible at this small size. */}
      <div ref={hostRef} style={{ pointerEvents: 'none', position: 'absolute', inset: 0, zIndex: -10, overflow: 'hidden' }}>
        {/* Static base — a normal (non-composited) paint, cheap to keep mounted
            always so the row's tint never flickers as the curtains come and go. */}
        <div style={{ position: 'absolute', inset: 0, backgroundColor: atm.baseColor, backgroundImage: atm.baseLayers, opacity: 0.85 }} />
        {active &&
          (atm.image ? (
            <div style={{ position: 'absolute', inset: 0, backgroundImage: `url(${atm.image})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
          ) : (
            <>
              <div className="sn-aurora-1" style={{ position: 'absolute', ...LAYER_BOX, backgroundImage: atm.layers, backgroundRepeat: 'repeat', animationDuration: '9s' }} />
              {atm.layers2 && (
                <div className="sn-aurora-2" style={{ position: 'absolute', ...LAYER_BOX, backgroundImage: atm.layers2, backgroundRepeat: 'repeat', animationDuration: '12s' }} />
              )}
            </>
          ))}
      </div>
      {/* 1px aurora-gradient edge down the left of the row. */}
      <div style={{ pointerEvents: 'none', position: 'absolute', top: 0, bottom: 0, left: 0, width: '1px', background: atm.chatEdge }} />
    </>
  );
};
