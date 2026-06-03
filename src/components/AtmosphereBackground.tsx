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
    // Explicit overhang (not a % inset): wide enough left/right to cover the
    // 320px translate without revealing an edge, but only a little top/bottom so
    // the per-message layer texture stays small (chat can show many at once).
    const layerBox = { top: -28, bottom: -28, left: -360, right: -360 } as const;
    return (
      <>
        {/* Fills the WHOLE message row (the aurora as a backdrop, same as the
            profile), animated faster than the profile so the drift is legible at
            this small size. */}
        <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
          <div
            className="absolute inset-0"
            style={{ backgroundColor: atm.baseColor, backgroundImage: atm.baseLayers, opacity: 0.85 }}
          />
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
        </div>
        {/* 1px aurora-gradient edge down the left (replaces the flat accent bar). */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 w-px"
          style={{ background: atm.chatEdge }}
        />
      </>
    );
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
