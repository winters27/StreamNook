// Dev-only atmosphere slots. A cosmetic normally ships as a Supabase row plus
// an R2 asset, which means the first time anyone sees it in the REAL app is
// after it is already live for every user. These entries merge into the
// catalog on dev builds only (import.meta.env.DEV), so a candidate asset can be
// picked in Profile > Customize and judged in real chat rows, the real profile
// panel, and the real hover card before a row is ever inserted. Production
// builds never see this file's contents.
//
// The asset is served by the Vite dev server from the untracked dev-preview/
// folder at the repo root, so nothing here reaches a bundle either.
import type { Atmosphere } from './atmospheres';

// Live on the CDN since 2026-09-02, so the dev slot renders the shipped asset.
const DISPERSION_ASSET = 'https://cdn.streamnook.app/atmospheres/dispersion.webp';

// "Dispersion": the Subscriber atmosphere of the Prism set. One diagonal
// streak of refracted light on black, static. Values mirror the intended
// `atmospheres` row; when it ships, the row is this object with the CDN URL.
export const DEV_ATMOSPHERES: Atmosphere[] = [
  {
    id: 'dispersion',
    name: 'Dispersion',
    accent: '246, 240, 225',
    swatch: `url(${DISPERSION_ASSET}) center / cover`,
    baseColor: '#050507',
    image: DISPERSION_ASSET,
    imageProfilePortrait: true,
    motion: 'aurora',
    // The streak is its own signature; no bar beside it.
    chatEdge: 'none',
    chatFrost: false,
    // Dispersed, not cropped: the row shows defocused light, not a picture.
    chatBlur: 14,
    // The streak caught on the row's glass edge: cool at the leading corner,
    // the ivory core, warm trailing off. A 1px ring, not a bar.
    chatRim:
      'linear-gradient(112deg, rgba(110,215,245,0.04) 0%, rgba(110,215,245,0.26) 28%, rgba(246,240,225,0.46) 46%, rgba(245,216,110,0.30) 58%, rgba(240,170,70,0.18) 70%, rgba(246,240,225,0.04) 100%)',
    unlock: { kind: 'subscriber' },
  },
];

const DEV_IDS = new Set(DEV_ATMOSPHERES.map((a) => a.id));

/** True for a dev-only slot, so the picker can show it unlocked on dev builds. */
export const isDevAtmosphere = (id: string | null | undefined): boolean =>
  !!import.meta.env.DEV && !!id && DEV_IDS.has(id);
