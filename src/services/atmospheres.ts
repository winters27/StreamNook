// StreamNook Atmospheres: our own line of profile backdrops. Each one is
// StreamNook IP (a designed gradient scene or a pre-rendered image), so it's
// clean to sell. An Atmosphere themes the profile background AND signs the
// member's chat messages with a matching wash, so the cosmetic follows them
// everywhere they show up.
//
// The catalog is SERVER-DRIVEN: definitions live in the Supabase `atmospheres`
// table and are fetched into an in-memory registry at startup (see
// supabaseService.ts). So a new atmosphere ships as a DB row + an R2 asset, live
// for every client with no desktop release, and a viewer on an older build can
// still render a newer atmosphere. `getAtmosphere` / `listAtmospheres` below just
// read that registry. This file owns only the shared `Atmosphere` shape.

import { getAtmosphereEntry, listAtmosphereEntries } from './supabaseService';

export interface Atmosphere {
  id: string;
  name: string;
  // Accent color as "r, g, b" for borders / tiles / the chat accent bar.
  accent: string;
  // A representative CSS background for the picker swatch (small preview).
  swatch: string;
  // Solid base color (fixed; the animated layer(s) / image sit over it).
  baseColor: string;
  // Optional fixed gradients painted over the base (e.g. a top glow) that do NOT
  // move, so the motion reads against a steady backdrop.
  baseLayers?: string;
  // A pre-rendered image (e.g. an animated webp) used as the whole backdrop in
  // place of the CSS gradient layers. When set, the renderer shows this image
  // (it carries its own motion) and ignores `layers` / `layers2`.
  image?: string;
  // When a landscape image should read PORTRAIT in the tall profile panel,
  // render the profile backdrop rotated 90deg. The chat-row wash always stays
  // landscape (rows are wide and short, so the image fits as-is there).
  imageProfilePortrait?: boolean;
  // The animated CSS layer (a nebula, or one set of aurora curtains). Optional:
  // image-backed atmospheres omit it.
  layers?: string;
  // Optional second layer (e.g. a second aurora curtain set flowing the other
  // way at a different speed, which is what sells the organic motion).
  layers2?: string;
  // Transform-only motion: 'drift' eases a nebula around; 'aurora' continuously
  // flows two curtain layers horizontally (seamless loop) with a gentle sway.
  motion: 'drift' | 'aurora';
  // A 1px gradient edge drawn down the left of the member's chat message row (in
  // place of a flat accent bar).
  chatEdge: string;
  // Frosted readability block (dark translucent fill + slight backdrop blur)
  // behind the member's chat text. Only for atmospheres whose wash is busy
  // enough to fight the text (typically image-backed ones); subtle gradient
  // washes leave it off.
  chatFrost?: boolean;
  // How this Atmosphere is unlocked. 'subscriber' = the paid subscriber tier
  // (the default for the house line). 'accolade' = earned by unlocking a
  // specific accolade, available to ANY member regardless of subscription.
  // Absent is treated as 'subscriber' by the gate, for safety.
  unlock?: { kind: 'subscriber' } | { kind: 'accolade'; accoladeId: string };
}

// Sync reads of the fetched catalog. Return null / empty until the registry has
// loaded (consumers re-render via the version subscription); see supabaseService.
export const getAtmosphere = (id: string | null | undefined): Atmosphere | null =>
  getAtmosphereEntry(id);

export const listAtmospheres = (): Atmosphere[] => listAtmosphereEntries();
