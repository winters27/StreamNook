// StreamNook Atmospheres: our own line of subscriber profile backdrops. Each one
// is StreamNook IP (a designed gradient scene), unlike the 7TV paint pass-through,
// so it's clean to sell. An Atmosphere themes the profile background AND (next
// phase) signs the member's chat messages with a matching subtle wash, so the
// cosmetic follows them everywhere they show up.
//
// House look = depth + slow motion, no neon / harsh glow. Kept LIGHT on purpose:
// pure CSS gradients animated with TRANSFORM only (GPU-composited, no per-frame
// repaint, no WebGL, no dependencies), so an Atmosphere is recolorable, crisp at
// any size, and cheap enough to live anywhere. Richer pre-rendered (webp)
// atmospheres can be added later as a separate asset-backed kind.

export interface Atmosphere {
  id: string;
  name: string;
  // Accent color as "r, g, b" for borders / tiles / the chat accent bar.
  accent: string;
  // A representative CSS background for the picker swatch (small preview).
  swatch: string;
  // Solid base color (fixed; the animated layer(s) move over it).
  baseColor: string;
  // Optional fixed gradients painted over the base (e.g. a top glow) that do NOT
  // move, so the motion reads against a steady backdrop.
  baseLayers?: string;
  // The animated layer (a nebula, or one set of aurora curtains).
  layers: string;
  // Optional second layer (e.g. a second aurora curtain set flowing the other
  // way at a different speed, which is what sells the organic motion).
  layers2?: string;
  // Transform-only motion: 'drift' eases a nebula around; 'aurora' continuously
  // flows two curtain layers horizontally (seamless loop) with a gentle sway.
  motion: 'drift' | 'aurora';
  // A 1px gradient edge drawn down the left of the member's chat message row (in
  // place of a flat accent bar).
  chatEdge: string;
}

export const ATMOSPHERES: Record<string, Atmosphere> = {
  aurora: {
    id: 'aurora',
    name: 'Aurora',
    accent: '45, 212, 191',
    swatch: 'linear-gradient(135deg, #10b981, #2dd4bf 40%, #22d3ee 70%, #8b5cf6)',
    baseColor: '#04070c',
    // Faint glow up top so the curtains read as light high in the sky.
    baseLayers: 'radial-gradient(ellipse 120% 60% at 50% 0%, rgba(45,212,191,0.10), transparent 65%)',
    // Two soft curtain sets that flow horizontally at different speeds (one each
    // direction) for organic, never-quite-repeating motion. Each repeating
    // gradient's period (its last stop, in px) MUST match the translate distance
    // the renderer uses for that layer (320 for `layers`, 240 for `layers2`) so
    // the loop is seamless. Soft stops do the blurring, so no filter:blur needed.
    layers:
      'repeating-linear-gradient(95deg, rgba(16,185,129,0) 0px, rgba(45,212,191,0.18) 120px, rgba(34,211,238,0.10) 200px, rgba(16,185,129,0) 320px)',
    layers2:
      'repeating-linear-gradient(88deg, rgba(34,211,238,0) 0px, rgba(34,211,238,0.12) 90px, rgba(139,92,246,0.10) 160px, rgba(34,211,238,0) 240px)',
    motion: 'aurora',
    chatEdge:
      'linear-gradient(to bottom, transparent, rgba(45,212,191,0.85) 22%, rgba(34,211,238,0.75) 52%, rgba(139,92,246,0.6) 80%, transparent)',
  },
};

export const getAtmosphere = (id: string | null | undefined): Atmosphere | null =>
  id ? ATMOSPHERES[id] ?? null : null;

export const listAtmospheres = (): Atmosphere[] => Object.values(ATMOSPHERES);
