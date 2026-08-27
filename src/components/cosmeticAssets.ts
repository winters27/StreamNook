// Slug -> Vite-resolved asset URL for cosmetic badges.
//
// The Supabase `cosmetics.asset_path` column is the source of truth for which
// file goes with which slug, but the actual bundling of the image into the
// build happens here so Vite can fingerprint the URL. When a new cosmetic is
// added to the catalog, drop the asset under src/assets and add a line here.

import defaultBadge from '../assets/streamnook-logo-128.webp';
import supporterBadge from '../assets/streamnook-badge-gold-128.webp';
import subscriberBadge from '../assets/streamnook-badge-gold-animated.webp';
import { resolveManifestAsset, type AssetManifest } from '../services/cosmetics/types';

export const COSMETIC_ASSET_BY_SLUG: Record<string, string> = {
  'streamnook-default': defaultBadge,
  'streamnook-supporter': supporterBadge,
  'streamnook-subscriber': subscriberBadge,
};

/**
 * Resolve a cosmetic's displayable image URL. Order: the bundled asset if we
 * ship one for this slug (so the gold trio renders identically), then the
 * asset manifest (when a definition carries one), then the catalog's cloud
 * `asset_path` (an R2 URL on cdn.streamnook.app). Returns null when none is
 * usable, so callers can skip a cosmetic they can't render. This is what lets a
 * cloud-served badge (a DB row + an upload, no desktop release) show in chat.
 */
export function resolveCosmeticAsset(
  cosmetic:
    | { slug: string; asset_path?: string | null; asset_manifest?: AssetManifest | null }
    | null
    | undefined,
  opts: { reducedMotion?: boolean } = {},
): string | null {
  if (!cosmetic) return null;
  const bundled = COSMETIC_ASSET_BY_SLUG[cosmetic.slug];
  if (bundled) return bundled;
  const fromManifest = resolveManifestAsset(cosmetic.asset_manifest, opts);
  if (fromManifest) return fromManifest;
  const path = cosmetic.asset_path;
  return path && /^https?:\/\//.test(path) ? path : null;
}
