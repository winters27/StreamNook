import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { motion, AnimatePresence, useDragControls } from 'framer-motion';
import { X, User } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/AppStore';
import { Logger } from '../utils/logger';
import ProfileOverview from './settings/ProfileOverview';
import { StreamNookTierCard, StreamNookBadge, getTierAccent } from './StreamNookBadge';
import { ProfileAccentContext, ProfileCompactContext } from './settings/profileAccentContext';
import { getFullProfileWithFallback } from '../services/cosmeticsCache';
import { computePaintStyle, getBadgeImageUrls, getBadgeFallbackUrls } from '../services/seventvService';
import { getAtmosphere, type Atmosphere } from '../services/atmospheres';
import { AtmosphereBackground } from './AtmosphereBackground';
import { getResolvedIdentity, getIdentityWithCache } from '../services/identityService';
import { resolveBttvProUrl, BTTV_PRO_LOADOUT_KEY } from '../services/bttvProBadge';
import { FallbackImage } from './FallbackImage';
import { Tooltip } from './ui/Tooltip';
import {
  getStreamNookUserNumber,
  getOwnedCosmeticSlugs,
  getActiveCosmeticSlug,
  getCosmeticBySlug,
  getProfilePrefs,
  subscribeStreamNookRegistryVersion,
  getStreamNookRegistryVersion,
  subscribeCosmeticsVersion,
  getCosmeticsVersion,
  whenAtmospheresReady,
  getProfileSnapshot,
  upsertProfileSnapshot,
  getUserIdentity,
  type ProfileSnapshot,
} from '../services/supabaseService';

// "#rrggbb" -> "r, g, b" for use inside rgba(...).
const hexToRgb = (hex: string): string | null => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
};

// Resolve a global Twitch badge "set/version" key to an image. Global badges are
// universal, so this resolves for any member regardless of the viewer. Warms the
// Rust global-badge cache if it's cold.
const resolveGlobalTwitchBadge = async (
  setVer: string,
): Promise<{ src: string; title: string } | null> => {
  const slash = setVer.indexOf('/');
  if (slash < 0) return null;
  const setId = setVer.slice(0, slash);
  const version = setVer.slice(slash + 1);
  try {
    let global = await invoke<any>('get_cached_global_badges');
    if (!global?.data) {
      await invoke('prefetch_global_badges').catch(() => {});
      global = await invoke<any>('get_cached_global_badges');
    }
    const set = global?.data?.find((s: any) => s.set_id === setId);
    const v = set?.versions?.find((ver: any) => ver.id === version);
    if (v) {
      return { src: v.image_url_4x || v.image_url_2x || v.image_url_1x, title: v.title || 'Twitch' };
    }
  } catch { /* cache cold / offline — badge just won't resolve */ }
  return null;
};

interface TargetInfo {
  login: string;
  displayName: string;
  avatar: string;
}

type ResolvedTheme = { accentRgb: string | null; paintAura?: CSSProperties; atmosphere?: Atmosphere };

// Build the resolved background theme from a member's profile_theme id + their
// resolved 7TV paint style (ps). Shared by the live resolve AND the snapshot
// hydrate so both paint identically (no flicker when the revalidate lands).
// Assumes the atmosphere catalog is loaded (getAtmosphere is a sync registry read).
const resolveProfileTheme = (
  profileTheme: string,
  ps: CSSProperties | null,
): ResolvedTheme | null => {
  if (profileTheme === 'paint' && ps) {
    // Blur the paint into a soft colored ambiance (not a pixelated stretch);
    // animated paints still shimmer through.
    const hexes =
      typeof ps.backgroundImage === 'string' ? ps.backgroundImage.match(/#[0-9a-fA-F]{6}/g) : null;
    const repHex = hexes && hexes.length ? hexes[Math.floor(hexes.length / 2)] : null;
    return {
      accentRgb: repHex ? hexToRgb(repHex) : null,
      paintAura: {
        backgroundImage: ps.backgroundImage,
        backgroundColor:
          typeof ps.backgroundColor === 'string' && !ps.backgroundColor.startsWith('var')
            ? ps.backgroundColor
            : undefined,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        filter: 'blur(40px) saturate(1.3)',
      },
    };
  }
  const atm = getAtmosphere(profileTheme);
  if (atm) return { accentRgb: atm.accent, atmosphere: atm };
  return null;
};

const PublicProfileOverlay = () => {
  const userId = useAppStore((s) => s.profileViewerUserId);
  const close = useAppStore((s) => s.closeProfileViewer);
  const dragControls = useDragControls();

  const [info, setInfo] = useState<TargetInfo | null>(null);
  const [counts, setCounts] = useState({ paints: 0, badges: 0, sn: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // The viewed member's active 7TV paint paints their NAME (free, like chat).
  const [namePaint, setNamePaint] = useState<CSSProperties | null>(null);
  // The resolved premium profile background theme (7TV paint or a StreamNook
  // Atmosphere). null = the free tier aura.
  const [theme, setTheme] = useState<{
    accentRgb: string | null;
    paintAura?: CSSProperties; // when the source is the 7TV paint
    atmosphere?: Atmosphere; // when the source is a StreamNook Atmosphere
  } | null>(null);
  // Sections the viewed member hid from their public profile.
  const [hiddenSections, setHiddenSections] = useState<string[]>([]);
  // The identity badges the member is wearing (active 7TV badge + chosen
  // third-party loadout). The StreamNook badge is rendered from the registry.
  const [wornBadges, setWornBadges] = useState<{
    seventv: any | null;
    twitch: { src: string; title: string } | null;
    thirdParty: any[];
    bttvPro: { src: string; title: string } | null;
  }>({ seventv: null, twitch: null, thirdParty: [], bttvPro: null });

  // Re-render when the StreamNook member / cosmetics registries update so the
  // tier card and counts resolve for the viewed user once loaded.
  useSyncExternalStore(subscribeStreamNookRegistryVersion, getStreamNookRegistryVersion, getStreamNookRegistryVersion);
  useSyncExternalStore(subscribeCosmeticsVersion, getCosmeticsVersion, getCosmeticsVersion);

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    setLoading(true);
    setError(false);
    setInfo(null);
    setCounts({ paints: 0, badges: 0, sn: 0 });
    setNamePaint(null);
    setTheme(null);
    setHiddenSections([]);
    setWornBadges({ seventv: null, twitch: null, thirdParty: [], bttvPro: null });

    (async () => {
      try {
        // Instant paint from the cached snapshot (if any): hydrate everything the
        // overlay renders from ONE read, before the live sources resolve. The live
        // chain below revalidates and rewrites the cache (stale-while-revalidate).
        const snapPromise = getProfileSnapshot(userId);
        void (async () => {
          const s = await snapPromise;
          if (!s || !alive) return;
          const snap = s.snapshot;
          setInfo(snap.identity);
          setCounts(snap.counts);
          setNamePaint((snap.namePaint as CSSProperties) ?? null);
          setHiddenSections(snap.hiddenSections);
          setWornBadges({
            seventv: snap.seventvBadge,
            twitch: snap.wornBadges.twitch,
            thirdParty: snap.wornBadges.thirdParty,
            bttvPro: snap.wornBadges.bttvPro,
          });
          await whenAtmospheresReady();
          if (alive) {
            setTheme(resolveProfileTheme(snap.profileTheme, (snap.namePaint as CSSProperties) ?? null));
            setLoading(false);
          }
        })();
        // No snapshot yet → read our own `users` table for instant identity
        // (faster than the Twitch Helix call below, which then revalidates it).
        void (async () => {
          const s = await snapPromise;
          if (s || !alive) return;
          const id = await getUserIdentity(userId);
          if (id && alive) {
            setInfo(id);
            setLoading(false);
          }
        })();

        // Kick off the profile-theme prefs IMMEDIATELY (only needs userId) so the
        // backdrop resolves in parallel with the cosmetic + badge fetches below.
        // An Atmosphere needs only these prefs + the startup-loaded catalog, so it
        // paints right away instead of waiting on the whole cosmetic chain (which
        // was making the backdrop appear seconds late). Paint themes still finish
        // in the main chain since they need the 7TV paint data.
        const prefsPromise = getProfilePrefs(userId).catch(
          () => ({ profileTheme: 'tier', hiddenSections: [] as string[] }),
        );
        void (async () => {
          const prefs = await prefsPromise;
          if (!alive) return;
          setHiddenSections(prefs.hiddenSections ?? []);
          if (prefs.profileTheme !== 'paint') {
            await whenAtmospheresReady();
            if (alive) setTheme(resolveProfileTheme(prefs.profileTheme, null));
          }
        })();

        // Resolve the viewed user's login + avatar + name from their id (the
        // badge only carries the id). One Helix lookup with the viewer's creds.
        const [clientId, token] = await invoke<[string, string]>('get_twitch_credentials');
        const res = await fetch(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(userId)}`, {
          headers: { 'Client-ID': clientId, Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        const u = data?.data?.[0];
        if (!u?.login) {
          if (alive) { setError(true); setLoading(false); }
          return;
        }
        if (!alive) return;
        setInfo({ login: u.login, displayName: u.display_name || u.login, avatar: u.profile_image_url || '' });
        setLoading(false);

        // Cosmetic counts + optional 7TV paint theme (best effort).
        try {
          const profile = await getFullProfileWithFallback(userId, u.login, userId, u.login);
          if (alive) {
            setCounts({
              paints: profile.seventvCosmetics?.paints?.length ?? 0,
              badges: profile.seventvCosmetics?.badges?.length ?? 0,
              sn: getOwnedCosmeticSlugs(userId).size,
            });
          }

          // Worn identity badges, resolved the same way chat does so the overlay
          // shows the member's full customization combination cross-client:
          //  - third-party (BTTV/FFZ/Chatterino/...) from the server-resolved,
          //    ownership-checked bundle;
          //  - BTTV Pro from the socket (the server drops that key, can't resolve);
          //  - the Twitch global badge from the universal global-badge cache (the
          //    loadout carries it as `twitch:<set>/<ver>`);
          //  - the active 7TV badge (live) + the StreamNook badge (member number).
          const sevenTvBadge =
            (profile.seventvCosmetics?.badges as any[] | undefined)?.find((b) => b?.selected) ?? null;
          let twitch: { src: string; title: string } | null = null;
          let thirdParty: any[] = [];
          let bttvPro: { src: string; title: string } | null = null;
          try {
            const [resolved, rawLoadout] = await Promise.all([
              getResolvedIdentity(userId).catch(() => null),
              getIdentityWithCache(userId).catch(() => null),
            ]);
            thirdParty = (resolved?.badges ?? [])
              .filter((b: any) => b.provider !== 'twitch')
              .map((b: any) => ({ key: b.key, provider: b.provider, title: b.title, src: b.image_url }));
            const keys: string[] = rawLoadout?.badges ?? [];
            const twitchKey = keys.find((k) => k.startsWith('twitch:'));
            if (twitchKey) {
              const v = twitchKey.slice('twitch:'.length);
              if (v.includes('/')) {
                // Legacy set/version key — resolve via the global-badge cache.
                twitch = await resolveGlobalTwitchBadge(v);
              } else if (v) {
                // Image-id key — the universal Twitch badge CDN URL renders the
                // same badge for any viewer (global or channel-scoped), no cache.
                twitch = { src: `https://static-cdn.jtvnw.net/badges/v1/${v}/3`, title: 'Twitch' };
              }
            }
            if (keys.includes(BTTV_PRO_LOADOUT_KEY)) {
              const url = await resolveBttvProUrl(userId).catch(() => null);
              if (url) bttvPro = { src: url, title: 'BTTV Pro' };
            }
          } catch { /* badges optional */ }
          if (alive) setWornBadges({ seventv: sevenTvBadge, twitch, thirdParty, bttvPro });

          // The member's active 7TV paint always paints their NAME (free, like
          // chat). The profile BACKGROUND theme is premium: their 7TV paint or a
          // StreamNook Atmosphere. Free / non-premium falls back to the tier aura.
          const paints = profile.seventvCosmetics?.paints as Array<{ selected?: boolean }> | undefined;
          const activePaint = paints?.find((p) => p?.selected);
          const ps = activePaint ? computePaintStyle(activePaint as never, '#9146FF') : null;
          if (alive) setNamePaint(ps);

          // The profile-theme prefs were kicked off at the TOP of this block (in
          // parallel with the cosmetic/badge fetches), and hiddenSections + any
          // Atmosphere/tier backdrop are already applied. Here we only finish the
          // PAINT theme — the one case that needs the 7TV paint data (`ps`).
          const prefs = await prefsPromise;
          if (prefs.profileTheme === 'paint' && ps && alive) {
            setTheme(resolveProfileTheme('paint', ps));
          }

          // Refresh the cache (cache-aside) from the freshly-resolved values, so the
          // next open of this member (by anyone) paints instantly. Throttled: only
          // write when the snapshot is missing, older than 60s, or a key field
          // changed — so popular profiles aren't rewritten on every view.
          const existing = await snapPromise;
          const freshSnap: ProfileSnapshot = {
            v: 1,
            identity: {
              login: u.login,
              displayName: u.display_name || u.login,
              avatar: u.profile_image_url || '',
            },
            profileTheme: prefs.profileTheme,
            hiddenSections: prefs.hiddenSections ?? [],
            memberNumber: getStreamNookUserNumber(userId) ?? null,
            cosmeticSlug: getActiveCosmeticSlug(userId) ?? null,
            namePaint: ps ? (ps as Record<string, unknown>) : null,
            seventvBadge: (sevenTvBadge as Record<string, unknown> | null) ?? null,
            wornBadges: { twitch, thirdParty, bttvPro },
            counts: {
              paints: profile.seventvCosmetics?.paints?.length ?? 0,
              badges: profile.seventvCosmetics?.badges?.length ?? 0,
              sn: getOwnedCosmeticSlugs(userId).size,
            },
            stats: null,
            accolades: [],
            favoriteChannel: null,
            ivr: null,
          };
          const stale =
            !existing ||
            Date.now() - new Date(existing.updatedAt).getTime() > 60_000 ||
            existing.snapshot.profileTheme !== freshSnap.profileTheme ||
            existing.snapshot.cosmeticSlug !== freshSnap.cosmeticSlug ||
            existing.snapshot.identity.avatar !== freshSnap.identity.avatar;
          if (stale) void upsertProfileSnapshot(userId, freshSnap);
        } catch { /* counts + theme stay at defaults */ }
      } catch (e) {
        Logger.error('[ProfileViewer] failed to load:', e);
        if (alive) { setError(true); setLoading(false); }
      }
    })();

    return () => { alive = false; };
  }, [userId]);

  const memberNumber = userId ? getStreamNookUserNumber(userId) : null;
  const cosmeticSlug = userId ? getActiveCosmeticSlug(userId) : null;
  const cosmeticName = cosmeticSlug ? getCosmeticBySlug(cosmeticSlug)?.name ?? null : null;

  // The overlay background is the member's premium theme (7TV paint or a
  // StreamNook Atmosphere) when set, else the free tier aura. The premium theme
  // also drives the border/accent color; the painted name is free regardless.
  const tierAccent = memberNumber !== null ? getTierAccent(memberNumber) : null;
  const themeRgb = theme?.accentRgb ?? tierAccent?.rgb ?? null;
  const panelBorder = themeRgb ? `rgba(${themeRgb}, 0.22)` : undefined;
  const headerBorder = themeRgb ? `rgba(${themeRgb}, 0.14)` : undefined;
  const tierAura = tierAccent
    ? `radial-gradient(ellipse 90% 55% at 50% 0%, rgba(${tierAccent.rgb}, ${tierAccent.auraAlpha}), transparent 70%)`
    : undefined;

  // A paint or Atmosphere backdrop is busy, so frost the header + the inner glass
  // panels harder (override the app's --glass-strength lower = more opaque) so the
  // content sits ON the glass instead of letting the background bleed through. The
  // subtle tier aura keeps the normal, more see-through glass.
  const busyBg = !!theme;
  const panelStyle = { borderColor: panelBorder } as CSSProperties & Record<string, string>;
  if (busyBg) panelStyle['--glass-strength'] = '0.4';

  return (
    <AnimatePresence>
      {userId && (
        <motion.div
          key="profile-viewer"
          drag
          dragControls={dragControls}
          dragListener={false}
          dragMomentum={false}
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          className="fixed left-[calc(50%-260px)] top-12 z-[60] flex max-h-[86vh] w-[520px] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-white/10 bg-[rgba(14,14,18,0.96)] shadow-[0_24px_60px_-15px_rgba(0,0,0,0.8)] backdrop-blur-2xl"
          style={panelStyle}
        >
          {/* Ambient theme behind the whole panel: a StreamNook Atmosphere
              (transform-animated), the 7TV paint (blurred), or the tier color. */}
          {theme?.atmosphere ? (
            <AtmosphereBackground atm={theme.atmosphere} variant="profile" />
          ) : theme?.paintAura ? (
            // A 7TV paint is an ACCENT, not a full backdrop: a soft glow banded
            // across the top that fades down, so it stays subtler than a full
            // StreamNook Atmosphere.
            <motion.div
              className="pointer-events-none absolute inset-x-0 top-0 h-2/5"
              style={{
                ...theme.paintAura,
                WebkitMaskImage: 'linear-gradient(to bottom, black, transparent)',
                maskImage: 'linear-gradient(to bottom, black, transparent)',
              }}
              animate={{ opacity: [0.16, 0.26, 0.16] }}
              transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut' }}
            />
          ) : tierAura ? (
            <motion.div
              className="pointer-events-none absolute -inset-10"
              style={{ background: tierAura }}
              animate={{ opacity: [0.7, 1, 0.7] }}
              transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut' }}
            />
          ) : null}

          {/* Header / drag handle */}
          <div
            onPointerDown={(e) => dragControls.start(e)}
            style={{ borderBottomColor: headerBorder }}
            className={`relative flex cursor-grab items-center gap-3 border-b border-white/[0.06] p-3 active:cursor-grabbing ${
              busyBg ? 'bg-[rgba(12,13,18,0.5)] backdrop-blur-md' : ''
            }`}
          >
            <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/[0.04] ring-1 ring-inset ring-white/10">
              {info?.avatar ? (
                <img src={info.avatar} alt="" className="h-full w-full object-cover" draggable={false} />
              ) : (
                <User size={20} className="text-textSecondary" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div
                className="truncate text-sm font-semibold text-textPrimary"
                style={namePaint ?? undefined}
              >
                {info?.displayName ?? 'StreamNook member'}
              </div>
              {info?.login && <div className="truncate text-[11px] text-textMuted">@{info.login}</div>}
              {/* The identity badges this member is rocking (active 7TV badge +
                  their chosen third-party loadout). StreamNook is the rank card. */}
              {(() => {
                const { seventv, twitch, thirdParty, bttvPro } = wornBadges;
                const hasAny =
                  !!twitch || !!seventv || memberNumber !== null || thirdParty.length > 0 || !!bttvPro;
                if (!hasAny) return null;
                const imgBadge = (src: string, title: string, key: string) => (
                  <Tooltip key={key} content={title} side="bottom">
                    <img
                      src={src}
                      alt={title}
                      draggable={false}
                      className="h-[18px] w-[18px] flex-shrink-0 object-contain"
                    />
                  </Tooltip>
                );
                return (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    {twitch && imgBadge(twitch.src, `Twitch: ${twitch.title}`, 'tw')}
                    {seventv && (() => {
                      const urls = getBadgeImageUrls(seventv as any);
                      return urls.url4x ? (
                        <Tooltip content={`7TV: ${seventv.tooltip || seventv.name}`} side="bottom">
                          <FallbackImage
                            src={urls.url4x}
                            fallbackUrls={getBadgeFallbackUrls(seventv.id).slice(1)}
                            alt={seventv.tooltip || seventv.name}
                            className="h-[18px] w-[18px] flex-shrink-0"
                          />
                        </Tooltip>
                      ) : null;
                    })()}
                    {memberNumber !== null && userId && (
                      <StreamNookBadge userId={userId} userNumber={memberNumber} side="bottom" />
                    )}
                    {thirdParty.map((b: any) =>
                      imgBadge(b.src, `${b.title} (${b.provider.toUpperCase()})`, b.key || b.title),
                    )}
                    {bttvPro && imgBadge(bttvPro.src, 'BTTV Pro', 'bttvpro')}
                  </div>
                );
              })()}
            </div>
            <button
              onClick={close}
              aria-label="Close"
              className="rounded p-1.5 text-textMuted transition-colors hover:bg-white/[0.06] hover:text-textPrimary"
            >
              <X size={16} />
            </button>
          </div>

          {/* Scrollable content */}
          <div className="scrollbar-thin relative flex-1 overflow-y-auto p-3">
            {loading ? (
              <div className="flex h-32 items-center justify-center">
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
              </div>
            ) : error || !info ? (
              <p className="py-8 text-center text-sm text-textSecondary">Couldn't load this profile.</p>
            ) : (
              <ProfileCompactContext.Provider value={true}>
              <ProfileAccentContext.Provider value={themeRgb}>
                <div className="space-y-4">
                  {memberNumber !== null && (
                    <div className="flex justify-center">
                      <StreamNookTierCard userNumber={memberNumber} cosmeticName={cosmeticName} />
                    </div>
                  )}
                  <ProfileOverview
                    isOwnProfile={false}
                    userId={userId}
                    login={info.login}
                    broadcasterType=""
                    streamNookUserNumber={memberNumber}
                    seventvPaintCount={counts.paints}
                    seventvBadgeCount={counts.badges}
                    ownedCosmeticsCount={counts.sn}
                    hiddenSections={hiddenSections}
                  />
                </div>
              </ProfileAccentContext.Provider>
              </ProfileCompactContext.Provider>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default PublicProfileOverlay;
