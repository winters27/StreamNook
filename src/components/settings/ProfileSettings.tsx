import { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useAppStore } from '../../stores/AppStore';
import { openBadgesWithPaintInMain, openBadgesOnStreamNookInMain } from '../../utils/openBadgesInMain';
import streamNookLogo from '../../assets/streamnook-logo.png';
import { User, Link, Unlink, Image as ImageIcon, Film, Heart } from 'lucide-react';
import {
  computePaintStyle,
  getBadgeImageUrls,
  getBadgeFallbackUrls,
  queueCosmeticForCaching,
  clearUserCache as clear7TVCache,
} from '../../services/seventvService';
import { FallbackImage } from '../FallbackImage';
import { Tooltip } from '../ui/Tooltip';
import { TwitchBadge } from '../../services/badgeService';
import { ThirdPartyBadge } from '../../services/thirdPartyBadges';
import { SevenTVBadge, SevenTVPaint } from '../../types';
import {
  getProfileFromMemoryCache,
  getFullProfileWithFallback,
  CachedProfile,
} from '../../services/cosmeticsCache';
import {
  getStreamNookUserNumber,
  subscribeStreamNookRegistryVersion,
  getStreamNookRegistryVersion,
  subscribeCosmeticsVersion,
  getCosmeticsVersion,
  getAllCosmetics,
  getOwnedCosmeticSlugs,
  getActiveCosmeticSlug,
  setActiveCosmetic,
} from '../../services/supabaseService';
import type { CosmeticCatalogEntry } from '../../services/supabaseService';
import { getTier, StreamNookBadge } from '../StreamNookBadge';
import { COSMETIC_ASSET_BY_SLUG } from '../cosmeticAssets';
import {
  captureProfileCard,
  copyImageToClipboard,
  downloadBlob,
  estimateCaptureDurationMs,
  detectAnimatedPaint,
  pauseCardAnimations,
  type CaptureMode,
} from '../../utils/shareProfile';
import { clearCosmeticsMemoryCache, invalidateUserCosmetics, getCosmeticsWithFallback } from '../../services/cosmeticsCache';
import { invoke } from '@tauri-apps/api/core';
import { Logger } from '../../utils/logger';

export interface ChatIdentityCache {
  badges: ChatIdentityBadge[];
  lastFetched: number;
  userId: string;
}

export let chatIdentityCache: ChatIdentityCache | null = null;
export const CHAT_IDENTITY_CACHE_TTL = 10 * 60 * 1000;
export const CHAT_IDENTITY_BACKGROUND_REFRESH_TTL = 2 * 60 * 1000;

export const setChatIdentityCache = (cache: ChatIdentityCache | null) => {
  chatIdentityCache = cache;
};

interface ChatIdentityBadge {
  id: string;
  version: string;
  title: string;
  image_url: string;
  is_selected: boolean;
}

const ProfileSettings = () => {
  const { isAuthenticated, currentUser, loginToTwitch, logoutFromTwitch, currentStream, closeSettings, addToast } = useAppStore();
  const profileCardRef = useRef<HTMLDivElement>(null);
  const [isSharing, setIsSharing] = useState(false);
  // Capture-progress UI state. `captureStage` drives which sub-component
  // shows: 'recording' = determinate bar tied to elapsed/estimated; one
  // 'finalizing' = indeterminate spinner once the wall-clock has caught
  // up to the source-animation duration (encode phase). null = idle.
  const [captureStage, setCaptureStage] = useState<'recording' | 'finalizing' | null>(
    null,
  );
  const [captureProgress, setCaptureProgress] = useState(0);
  // Tracks whether the rendered profile card contains anything that
  // would actually benefit from an animated capture (CSS animations on
  // the StreamNook tier glow, animated 7TV paints, animated badges or
  // emotes). Drives whether the "animated" share button is enabled.
  // Detection re-runs whenever the inputs that affect card rendering
  // change — see the useEffect further down.
  const [hasAnimatedElements, setHasAnimatedElements] = useState(false);
  // Portal target inside SettingsDialog's hero row (the right-side slot
  // alongside the "Profile" title). We render the share buttons into that
  // slot instead of inline above the card, so the controls sit at the
  // same vertical level as the hero text and don't push any layout down.
  // Looked up after mount because the dialog hero renders before this
  // child does — null until the effect runs.
  const [heroActionsTarget, setHeroActionsTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHeroActionsTarget(document.getElementById('settings-hero-actions'));
  }, []);

  useSyncExternalStore(subscribeStreamNookRegistryVersion, getStreamNookRegistryVersion, getStreamNookRegistryVersion);
  const streamNookUserNumber = currentUser?.user_id ? getStreamNookUserNumber(currentUser.user_id) : null;

  useSyncExternalStore(subscribeCosmeticsVersion, getCosmeticsVersion, getCosmeticsVersion);
  const cosmeticsCatalog: CosmeticCatalogEntry[] = getAllCosmetics();
  const ownedCosmeticSlugs = currentUser?.user_id
    ? getOwnedCosmeticSlugs(currentUser.user_id)
    : new Set<string>();
  const ownedCosmetics = cosmeticsCatalog.filter((c) => ownedCosmeticSlugs.has(c.slug));
  const activeCosmeticSlug = currentUser?.user_id
    ? getActiveCosmeticSlug(currentUser.user_id)
    : null;

  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [twitchBadges, setTwitchBadges] = useState<TwitchBadge[]>([]);
  void twitchBadges;
  const [thirdPartyBadges, setThirdPartyBadges] = useState<ThirdPartyBadge[]>([]);
  const [seventvBadges, setSeventvBadges] = useState<SevenTVBadge[]>([]);
  const [seventvPaint, setSeventvPaint] = useState<SevenTVPaint | null>(null);
  const [allSeventvPaints, setAllSeventvPaints] = useState<SevenTVPaint[]>([]);
  const [seventvUserId, setSeventvUserId] = useState<string | null>(null);
  const [, setHas7TVAccountChecked] = useState(false);
  const [, setIsLoadingBadges] = useState(false);
  const [seventvAuthConnected, setSeventvAuthConnected] = useState(false);
  const [updatingSeventvPaintId, setUpdatingSeventvPaintId] = useState<string | null>(null);
  const [updatingSeventvBadgeId, setUpdatingSeventvBadgeId] = useState<string | null>(null);
  const [isConnecting7TV, setIsConnecting7TV] = useState(false);
  const [chatIdentityBadges, setChatIdentityBadges] = useState<ChatIdentityBadge[]>([]);
  const [isFetchingIdentity, setIsFetchingIdentity] = useState(false);
  const [updatingBadgeId, setUpdatingBadgeId] = useState<string | null>(null);

  // Mounted gate so async resolvers don't setState on a dead component when
  // the user navigates away from the Profile tab mid-fetch. Important: set
  // true at the *start* of the effect so React.StrictMode's double-invoke
  // (mount → cleanup → mount) restores the gate on the second mount; refs
  // persist across StrictMode's fake unmount, so setting only on teardown
  // leaves the ref permanently false.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let isMounted = true;
    let unlistenFound: (() => void) | undefined;
    let unlistenUpdate: (() => void) | undefined;
    let unlisten7TV: (() => void) | undefined;

    const setupListeners = async () => {
      const { listen } = await import('@tauri-apps/api/event');

      const unlistenFoundFn = await listen('chat-identity-badges-found', (event: any) => {
        if (!mountedRef.current) return;
        const result = event.payload;
        if (result.success) {
          // Dedupe by (id, version). Belt-and-braces against any path
          // that emits duplicates — seen in the wild as every badge
          // appearing twice in the grid until a hard refresh.
          const seen = new Set<string>();
          const deduped = (result.badges as ChatIdentityBadge[]).filter((b) => {
            const key = `${b.id}-${b.version}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          setChatIdentityBadges(deduped);
        }
        setIsFetchingIdentity(false);
      });
      if (isMounted) unlistenFound = unlistenFoundFn; else unlistenFoundFn();

      const unlistenUpdateFn = await listen('chat-identity-update-result', (event: any) => {
        if (!mountedRef.current) return;
        const result = event.payload;
        if (result.success) {
          setChatIdentityBadges((prev) => prev.map((b) => ({
            ...b,
            is_selected: b.id === result.badge_id,
          })));
        }
        setUpdatingBadgeId(null);
      });
      if (isMounted) unlistenUpdate = unlistenUpdateFn; else unlistenUpdateFn();

      const unlisten7TVFn = await listen('seventv-connected', () => {
        if (!mountedRef.current) return;
        setSeventvAuthConnected(true);
        setIsConnecting7TV(false);
      });
      if (isMounted) unlisten7TV = unlisten7TVFn; else unlisten7TVFn();
    };

    setupListeners();

    return () => {
      isMounted = false;
      if (unlistenFound) unlistenFound();
      if (unlistenUpdate) unlistenUpdate();
      if (unlisten7TV) unlisten7TV();
    };
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !currentUser) return;

    const loadProfile = async () => {
      setIsLoadingBadges(true);

      try {
        const status = (await invoke('get_seventv_auth_status')) as { is_authenticated: boolean };
        if (mountedRef.current) setSeventvAuthConnected(status.is_authenticated);
      } catch {
        if (mountedRef.current) setSeventvAuthConnected(false);
      }

      const cachedProfile = getProfileFromMemoryCache(currentUser.user_id);
      if (cachedProfile && mountedRef.current) applyProfileData(cachedProfile);

      const channelId = currentStream?.user_id || currentUser.user_id;
      const channelName = currentStream?.user_login || currentUser.login || currentUser.username;

      try {
        const profile = await getFullProfileWithFallback(
          currentUser.user_id,
          currentUser.login || currentUser.username,
          channelId,
          channelName,
        );
        if (mountedRef.current) applyProfileData(profile);
      } catch (e) {
        Logger.error('[ProfileSettings] Failed to load profile:', e);
      }

      if (mountedRef.current) setIsLoadingBadges(false);
    };

    loadProfile();
  }, [isAuthenticated, currentUser]);

  const applyProfileData = (profile: CachedProfile) => {
    setTwitchBadges(profile.twitchBadges);
    setThirdPartyBadges(profile.thirdPartyBadges);
    setSeventvBadges(profile.seventvCosmetics.badges);
    setSeventvUserId(profile.seventvCosmetics.seventvUserId || null);
    setHas7TVAccountChecked(true);
    setAllSeventvPaints(profile.seventvCosmetics.paints as SevenTVPaint[]);

    const selectedPaint = profile.seventvCosmetics.paints.find((p: any) => p.selected);
    if (selectedPaint) {
      setSeventvPaint(selectedPaint as SevenTVPaint);
    }
  };

  // Re-evaluate whether the card has anything worth animating. Runs
  // after each render that updates the card's content (paint, badges,
  // tier change). rAF defers until React has committed the new DOM so
  // detectAnimatedPaint sees current pixels, not stale ones. Without
  // this the Animated button could stay disabled after a user just
  // applied an animated paint.
  useEffect(() => {
    if (!profileCardRef.current) return;
    const raf = requestAnimationFrame(() => {
      if (profileCardRef.current && mountedRef.current) {
        setHasAnimatedElements(detectAnimatedPaint(profileCardRef.current));
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [
    currentUser?.user_id,
    seventvPaint,
    chatIdentityBadges,
    seventvBadges,
    streamNookUserNumber,
    activeCosmeticSlug,
  ]);

  useEffect(() => {
    seventvBadges.forEach((badge: any) => {
      if (badge?.id && !badge.localUrl) {
        const badgeUrl = `https://cdn.7tv.app/badge/${badge.id}/4x.webp`;
        queueCosmeticForCaching(badge.id, badgeUrl);
      }
    });

    if ((seventvPaint as any)?.data?.layers) {
      ((seventvPaint as any).data.layers as any[]).forEach((layer: any) => {
        if (layer.ty?.__typename === 'PaintLayerTypeImage' && layer.ty.images) {
          const img = layer.ty.images.find((i: any) => i.scale === 1) || layer.ty.images[0];
          if (img && !img.localUrl) {
            queueCosmeticForCaching(layer.id, img.url);
          }
        }
      });
    }
  }, [seventvBadges, seventvPaint]);

  const fetchChatIdentity = async (showSpinner = true) => {
    if (!currentUser?.login) return;
    if (showSpinner) setIsFetchingIdentity(true);
    try {
      await invoke('fetch_chat_identity_badges', { channelName: currentUser.login });
    } catch {
      if (mountedRef.current) setIsFetchingIdentity(false);
    }
  };

  useEffect(() => {
    if (!currentUser?.user_id) return;

    if (chatIdentityCache &&
        chatIdentityCache.userId === currentUser.user_id &&
        chatIdentityCache.badges.length > 0) {
      Logger.debug('[ProfileSettings] Loading chat identity badges from shared cache:', chatIdentityCache.badges.length);
      setChatIdentityBadges(chatIdentityCache.badges);

      const cacheAge = Date.now() - chatIdentityCache.lastFetched;

      if (cacheAge < CHAT_IDENTITY_BACKGROUND_REFRESH_TTL) return;
      if (cacheAge < CHAT_IDENTITY_CACHE_TTL) {
        fetchChatIdentity(false);
        return;
      }
      fetchChatIdentity(true);
      return;
    }

    fetchChatIdentity(true);
  }, [currentUser?.user_id]);

  const updateChatIdentity = async (badge: ChatIdentityBadge) => {
    if (!currentUser?.login || updatingBadgeId) return;
    setUpdatingBadgeId(badge.id);
    try {
      await invoke('update_chat_identity', {
        channelName: currentUser.login,
        badgeId: badge.id,
        badgeVersion: badge.version,
      });
    } catch {
      if (mountedRef.current) setUpdatingBadgeId(null);
    }
  };

  const handleSelectSeventvPaint = async (paint: SevenTVPaint | null) => {
    if (!seventvUserId || updatingSeventvPaintId) return;

    const paintId = paint?.id || null;
    setUpdatingSeventvPaintId(paintId || 'none');

    try {
      const result = (await invoke('set_seventv_paint', { userId: seventvUserId, paintId })) as { success: boolean };
      if (result.success && mountedRef.current) {
        setSeventvPaint(paint);
        setAllSeventvPaints((prev) => prev.map((p) => ({ ...p, selected: p.id === paintId })));
        // Drop both layers of cached cosmetics for this user, then trigger a
        // fresh fetch so the cosmetics-cache subscription notifies chat rows
        // with the new selection immediately.
        clear7TVCache();
        if (currentUser?.user_id) {
          invalidateUserCosmetics(currentUser.user_id);
          void getCosmeticsWithFallback(currentUser.user_id).catch(() => {});
        }
      }
    } catch (e: unknown) {
      Logger.error('[ProfileSettings] Failed to update paint:', e);
      const errMsg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
      if (errMsg.includes('SESSION_EXPIRED') && mountedRef.current) {
        setSeventvAuthConnected(false);
        setSeventvUserId(null);
      }
    } finally {
      if (mountedRef.current) setUpdatingSeventvPaintId(null);
    }
  };

  const handleSelectSeventvBadge = async (badge: SevenTVBadge | null) => {
    if (!seventvUserId || updatingSeventvBadgeId) return;

    const badgeId = badge?.id || null;
    setUpdatingSeventvBadgeId(badgeId || 'none');

    try {
      const result = (await invoke('set_seventv_badge', { userId: seventvUserId, badgeId })) as { success: boolean };
      if (result.success && mountedRef.current) {
        setSeventvBadges((prev) => prev.map((b) => ({ ...b, selected: b.id === badgeId })));
        clear7TVCache();
        if (currentUser?.user_id) {
          invalidateUserCosmetics(currentUser.user_id);
          void getCosmeticsWithFallback(currentUser.user_id).catch(() => {});
        }
      }
    } catch (e: unknown) {
      Logger.error('[ProfileSettings] Failed to update badge:', e);
      const errMsg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
      if (errMsg.includes('SESSION_EXPIRED') && mountedRef.current) {
        setSeventvAuthConnected(false);
        setSeventvUserId(null);
      }
    } finally {
      if (mountedRef.current) setUpdatingSeventvBadgeId(null);
    }
  };

  const handleOpen7TVCosmetics = async () => {
    if (!seventvUserId) return;
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(`https://7tv.app/users/${seventvUserId}/cosmetics`);
  };

  const handleOpenTwitchProfile = async () => {
    if (!currentUser?.login) return;
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(`https://twitch.tv/${currentUser.login}`);
  };

  const handleShareProfile = async (mode: CaptureMode) => {
    if (!profileCardRef.current || isSharing) return;
    setIsSharing(true);
    setCaptureStage('recording');
    setCaptureProgress(0);

    // Fresh pull before capture: clear the cosmetics memory cache and
    // re-fetch so the card reflects current backend state, not whatever
    // was cached from an earlier session. Cheap if data hasn't actually
    // changed (network round-trips, but no DOM work if results match).
    if (currentUser?.user_id) {
      try {
        clearCosmeticsMemoryCache();
        const channelId = currentStream?.user_id || currentUser.user_id;
        const channelName =
          currentStream?.user_login || currentUser.login || currentUser.username;
        const fresh = await getFullProfileWithFallback(
          currentUser.user_id,
          currentUser.login || currentUser.username,
          channelId,
          channelName,
        );
        if (mountedRef.current) applyProfileData(fresh);
      } catch (e) {
        // Non-fatal — proceed with whatever's already rendered.
        Logger.warn('[ProfileSettings] Profile refresh before share failed:', e);
      }
    }

    // For static (PNG) captures, freeze CSS animations on the card so
    // the screenshot lands on a stable frame instead of an in-between
    // moment that can look like the paint is torn or glitching. Animated
    // captures want the animation running, so skip the pause there.
    let restoreAnimations: (() => void) | null = null;
    if (mode === 'static' && profileCardRef.current) {
      restoreAnimations = pauseCardAnimations(profileCardRef.current);
    }

    // Double-RAF so React commits the hidden-button state to the DOM AND
    // the compositor repaints before we ask Rust to grab the screen
    // pixels. Also gives the paused animation-play-state above time to
    // commit. Without this, the Share buttons show up in the capture
    // because the visibility change hasn't reached the screen buffer yet.
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );

    // Subscribe to the diagnostic stats event so we can include actual
    // achieved frame count / fps in the success toast.
    type CaptureStats = {
      frame_count: number;
      capture_ms: number;
      encode_ms: number;
      duration_ms: number;
    };
    let captureStats: CaptureStats | null = null;
    const { listen } = await import('@tauri-apps/api/event');
    const unlistenStats = await listen<CaptureStats>(
      'profile-capture-stats',
      (e) => {
        captureStats = e.payload;
      },
    );

    // Progress UI driver. We know the recording phase runs for
    // `expectedDuration` (the source animation cycle, capped at the WebP
    // max). Past that, capture is done and the encode phase starts — we
    // flip to the indeterminate 'finalizing' spinner so the user knows
    // something is still happening but doesn't see a stalled progress
    // bar.
    const expectedDuration = estimateCaptureDurationMs(profileCardRef.current);
    const progressStart = Date.now();
    const progressInterval = window.setInterval(() => {
      if (!mountedRef.current) return;
      const elapsed = Date.now() - progressStart;
      if (elapsed < expectedDuration) {
        const pct = Math.min(99, Math.round((elapsed / expectedDuration) * 100));
        setCaptureProgress(pct);
      } else {
        setCaptureStage((s) => (s === 'recording' ? 'finalizing' : s));
      }
    }, 50);

    try {
      const result = await captureProfileCard(profileCardRef.current, { mode });
      const label = result.mime === 'image/gif' ? 'GIF' : 'image';
      const statsSuffix = (() => {
        if (!captureStats || result.mime !== 'image/webp') return '';
        const { frame_count, capture_ms } = captureStats as CaptureStats;
        const fps =
          capture_ms > 0 ? Math.round((frame_count * 1000) / capture_ms) : 0;
        return ` (${frame_count} frames, ${fps}fps)`;
      })();
      const copied = await copyImageToClipboard(result.blob, result.mime);
      if (copied) {
        addToast(`Profile ${label} copied to clipboard${statsSuffix}`, 'success');
      } else {
        // Clipboard rejected the MIME (common for image/gif on some platforms).
        // Fall back to triggering a download so the user can drag the file
        // into Discord instead.
        downloadBlob(result.blob, result.filename);
        addToast(
          `Profile ${label} saved to downloads${statsSuffix}`,
          'success',
        );
      }
    } catch (e) {
      Logger.error('[ProfileSettings] Share profile failed:', e);
      addToast('Failed to capture profile', 'error');
    } finally {
      restoreAnimations?.();
      window.clearInterval(progressInterval);
      unlistenStats();
      if (mountedRef.current) {
        setIsSharing(false);
        setCaptureStage(null);
        setCaptureProgress(0);
      }
    }
  };

  const selectedGlobalBadge = chatIdentityBadges.find((b) => b.is_selected);
  const selected7TVBadge = seventvBadges.find((b: any) => b.selected);
  const tier = streamNookUserNumber !== null ? getTier(streamNookUserNumber) : null;

  if (!isAuthenticated || !currentUser) {
    return (
      <div className="flex h-full min-h-[420px] items-center justify-center">
        <div className="glass-panel rounded-xl p-8 max-w-sm w-full text-center">
          <p className="text-sm text-textSecondary mb-6 leading-relaxed">
            Sign in to manage your Twitch badges, 7TV cosmetics, and StreamNook identity.
          </p>
          <button
            onClick={loginToTwitch}
            className="w-full px-5 py-2.5 bg-[#9146FF] hover:bg-[#772CE8] text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            <svg fill="currentColor" viewBox="0 0 512 512" className="w-4 h-4">
              <path d="M80,32,48,112V416h96v64h64l64-64h80L464,304V32ZM416,288l-64,64H256l-64,64V352H112V80H416Z" />
              <rect x="320" y="143" width="48" height="129" />
              <rect x="208" y="143" width="48" height="129" />
            </svg>
            Sign in with Twitch
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Share controls rendered into the dialog hero's actions slot
          (#settings-hero-actions). Same vertical row as the "Profile"
          title/description, on the right side. Zero impact on the layout
          below — the card stays at the top of the content area as if
          no share controls existed. Tooltips side="bottom" so they
          render below the hero (into the empty space above the card,
          which is OUTSIDE DXGI's capture rect on the card). */}
      {heroActionsTarget &&
        createPortal(
          <>
            {/* Small "Share" label before the icons so the affordance is
                obvious to users who don't recognize the icons alone.
                Same uppercase / tracking treatment as the StreamNook tier
                labels and other dialog accents — reads as a section tag
                rather than body copy. */}
            <span className="mr-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-textMuted">
              Share
            </span>
            <Tooltip
              content="Copy as still image"
              side="bottom"
              disabled={isSharing}
            >
              <button
                type="button"
                onClick={() => handleShareProfile('static')}
                disabled={isSharing}
                aria-label="Copy as still image"
                className="p-1.5 text-textMuted hover:text-textPrimary hover:bg-white/[0.05] rounded-md transition-colors disabled:cursor-wait"
              >
                <ImageIcon size={16} />
              </button>
            </Tooltip>
            <Tooltip
              content={
                hasAnimatedElements
                  ? 'Copy as animated WebP'
                  : 'Nothing animated on this card'
              }
              side="bottom"
              disabled={isSharing}
            >
              <button
                type="button"
                onClick={() => handleShareProfile('animated')}
                disabled={isSharing || !hasAnimatedElements}
                aria-label="Copy as animated WebP"
                className="p-1.5 text-textMuted hover:text-textPrimary hover:bg-white/[0.05] rounded-md transition-colors disabled:cursor-not-allowed disabled:text-textMuted/30 disabled:hover:bg-transparent disabled:hover:text-textMuted/30"
              >
                <Film size={16} />
              </button>
            </Tooltip>
          </>,
          heroActionsTarget,
        )}

      <div ref={profileCardRef} className="relative overflow-hidden flex items-center gap-8 p-6 glass-panel rounded-xl">
        {/* Tier aura backdrop — Ethereal gets violet, Mythic gets amber.
            Other tiers don't define one; the card stays neutral glass. */}
        {tier?.auraClassName && <div className={tier.auraClassName} />}
        <div className="relative w-32 h-32 rounded-full bg-white/[0.04] flex-shrink-0 flex items-center justify-center overflow-hidden ring-1 ring-inset ring-white/10 shadow-[0_6px_20px_rgba(0,0,0,0.45)]">
          {currentUser.profile_image_url ? (
            <img src={currentUser.profile_image_url} alt="Profile" className="w-full h-full object-cover" />
          ) : (
            <User size={56} className="text-textSecondary" />
          )}
        </div>

        <div className="relative flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            {selectedGlobalBadge && (
              <Tooltip content={`Twitch: ${selectedGlobalBadge.title}`} side="top">
                <img src={selectedGlobalBadge.image_url} alt={selectedGlobalBadge.title} className="w-6 h-6" />
              </Tooltip>
            )}
            {selected7TVBadge && (() => {
              const urls = getBadgeImageUrls(selected7TVBadge as any);
              return urls.url4x ? (
                <Tooltip content={`7TV: ${selected7TVBadge.tooltip || selected7TVBadge.name}`} side="top">
                  <FallbackImage
                    src={urls.url4x}
                    fallbackUrls={getBadgeFallbackUrls(selected7TVBadge.id).slice(1)}
                    alt={selected7TVBadge.tooltip || selected7TVBadge.name}
                    className="w-6 h-6"
                  />
                </Tooltip>
              ) : null;
            })()}
            {streamNookUserNumber !== null && currentUser?.user_id && (
              <StreamNookBadge userId={currentUser.user_id} userNumber={streamNookUserNumber} side="bottom" />
            )}
            <h3
              className="text-3xl font-bold"
              style={seventvPaint ? computePaintStyle(seventvPaint as any, '#9146FF') : { color: 'var(--text-primary)' }}
            >
              {currentUser.display_name || currentUser.login}
            </h3>
            {currentUser.broadcaster_type === 'partner' && (
              <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 16 16" fill="#9146FF">
                <path fillRule="evenodd" d="M12.5 3.5 8 2 3.5 3.5 2 8l1.5 4.5L8 14l4.5-1.5L14 8l-1.5-4.5ZM7 11l4.5-4.5L10 5 7 8 5.5 6.5 4 8l3 3Z" clipRule="evenodd" />
              </svg>
            )}
            {seventvPaint && (
              <Tooltip content={`Paint: ${seventvPaint.name}`} side="top">
                <button
                  type="button"
                  onClick={() => openBadgesWithPaintInMain(seventvPaint.id)}
                  className="px-2 py-0.5 rounded-md text-[11px] font-bold inline-block relative overflow-hidden cursor-pointer hover:ring-1 hover:ring-accent/50 transition-all border border-white/10"
                  style={{
                    ...computePaintStyle(seventvPaint as any, '#9146FF'),
                    WebkitBackgroundClip: 'padding-box',
                    backgroundClip: 'padding-box',
                  }}
                >
                  <span
                    style={{
                      ...computePaintStyle(seventvPaint as any, '#9146FF'),
                      filter: 'invert(1) contrast(1.5)',
                      WebkitBackgroundClip: 'text',
                      backgroundClip: 'text',
                    }}
                  >
                    {seventvPaint.name}
                  </span>
                </button>
              </Tooltip>
            )}
          </div>
          <p className="text-textSecondary text-base">@{currentUser.login}</p>
        </div>

        {tier && streamNookUserNumber !== null && (
          <div className="relative flex-shrink-0 flex flex-col items-center pt-1 pb-2 min-w-[120px]">
            <div className="text-[9px] uppercase tracking-[0.36em] font-medium text-white/35 mb-3">
              StreamNook
            </div>
            <div className="flex items-baseline justify-center gap-1.5 mb-3">
              <span className="text-[11px] text-white/30 font-light leading-none">Nº</span>
              <span className={tier.numberClassName}>{streamNookUserNumber}</span>
              <span className="text-[11px] font-light leading-none invisible" aria-hidden="true">
                Nº
              </span>
            </div>
            <div className={`w-12 h-px ${tier.hairlineClassName} mb-2`} />
            {tier.label && <div className={tier.labelClassName}>{tier.label}</div>}
          </div>
        )}
        </div>

      {/* Capture-progress card. Renders BELOW the profile card so it
          stays outside DXGI's capture rect — anything painted over the
          card area would land in the recorded WebP, so this UI lives in
          the row immediately under it. Two stages: determinate progress
          bar while elapsed < expectedDuration (the active recording
          phase), then indeterminate spinner during the encode tail. */}
      <AnimatePresence>
        {captureStage && (
          <motion.div
            key="capture-progress"
            initial={{ opacity: 0, y: -8, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 'auto' }}
            exit={{ opacity: 0, y: -8, height: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="glass-panel rounded-xl p-4 flex items-center gap-4">
              {captureStage === 'recording' ? (
                <span
                  className="flex-shrink-0 w-2 h-2 rounded-full bg-red-500 animate-pulse"
                  aria-hidden
                />
              ) : (
                <span
                  className="flex-shrink-0 w-3 h-3 border-2 border-white/20 border-t-white/70 rounded-full animate-spin"
                  aria-hidden
                />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between mb-1.5">
                  <span className="text-sm font-medium text-textPrimary">
                    {captureStage === 'recording'
                      ? 'Recording your profile…'
                      : 'Finalizing…'}
                  </span>
                  {captureStage === 'recording' && (
                    <span className="text-xs tabular-nums text-textMuted">
                      {captureProgress}%
                    </span>
                  )}
                </div>
                <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden mb-2">
                  <div
                    className={`h-full transition-[width] duration-100 ease-linear ${
                      captureStage === 'recording'
                        ? 'bg-red-500/80'
                        : 'bg-white/60'
                    }`}
                    style={{
                      width: captureStage === 'recording' ? `${captureProgress}%` : '100%',
                    }}
                  />
                </div>
                <p className="text-[11px] text-textMuted leading-snug">
                  Keep this window visible — switching apps or covering the card
                  will appear in the capture.
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {streamNookUserNumber !== null && currentUser?.user_id && ownedCosmetics.length > 0 && (
        <div className="glass-panel rounded-xl p-5">
          <div className="flex items-center gap-1.5 mb-4">
            <Tooltip content="Open StreamNook badges" side="top">
              <button
                onClick={openBadgesOnStreamNookInMain}
                className="cursor-pointer hover:scale-110 transition-transform"
                aria-label="Open StreamNook badges"
              >
                <img
                  src={streamNookLogo}
                  alt=""
                  className="w-4 h-4 object-contain"
                  draggable={false}
                />
              </button>
            </Tooltip>
            <h4 className="text-sm font-semibold text-textPrimary uppercase tracking-wide">
              Cosmetics
            </h4>
          </div>
          <div className="flex flex-wrap gap-2">
            {ownedCosmetics.map((cosmetic) => {
              const asset = COSMETIC_ASSET_BY_SLUG[cosmetic.slug];
              if (!asset) return null;
              const isActive = activeCosmeticSlug === cosmetic.slug;
              return (
                <Tooltip key={cosmetic.slug} content={cosmetic.name} side="top">
                  <div
                    onClick={() => setActiveCosmetic(currentUser.user_id, isActive ? null : cosmetic.slug)}
                    className={`
                      relative p-2 rounded-lg cursor-pointer transition-all
                      ${isActive
                        ? 'glass-input border-accent/50 ring-1 ring-accent/30'
                        : 'border border-transparent hover:bg-glass hover:border-borderLight'}
                    `}
                  >
                    <img
                      src={asset}
                      alt={cosmetic.name}
                      className="w-8 h-8 object-contain"
                      draggable={false}
                    />
                    {isActive && (
                      <div className="absolute -top-1 -right-1 w-3 h-3 bg-accent rounded-full border-2 border-background" />
                    )}
                  </div>
                </Tooltip>
              );
            })}
          </div>
          {cosmeticsCatalog.some((c) => c.is_active && !ownedCosmeticSlugs.has(c.slug)) && (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-[11px] text-textSecondary">
              <span>Enjoy collecting badges or flexing status?</span>
              <button
                type="button"
                onClick={openBadgesOnStreamNookInMain}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium text-textPrimary bg-white/[0.06] hover:bg-white/[0.10] transition-colors cursor-pointer"
              >
                <Heart size={10} className="text-rose-400/80" aria-hidden />
                Fund the chaos
              </button>
            </div>
          )}
        </div>
      )}

      <div className="glass-panel rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-1.5">
            <Tooltip content="Open your Twitch profile" side="top">
              <button
                onClick={handleOpenTwitchProfile}
                className="cursor-pointer hover:scale-110 transition-transform"
                aria-label="Open your Twitch profile"
              >
                <svg fill="currentColor" viewBox="0 0 512 512" className="w-4 h-4 text-[#9146FF]">
                  <path d="M80,32,48,112V416h96v64h64l64-64h80L464,304V32ZM416,288l-64,64H256l-64,64V352H112V80H416Z" />
                  <rect x="320" y="143" width="48" height="129" />
                  <rect x="208" y="143" width="48" height="129" />
                </svg>
              </button>
            </Tooltip>
            <h4 className="text-sm font-semibold text-textPrimary uppercase tracking-wide">
              Global Badges
            </h4>
          </div>
          <button
            onClick={() => fetchChatIdentity(true)}
            disabled={isFetchingIdentity}
            className="p-1.5 text-textSecondary hover:text-accent hover:bg-glass rounded transition-all"
          >
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={isFetchingIdentity ? 'animate-spin' : ''}
            >
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
              <path d="M16 21h5v-5" />
            </svg>
          </button>
        </div>

        {chatIdentityBadges.length > 0 ? (
          <div className="grid grid-cols-8 gap-2">
            {chatIdentityBadges.map((badge) => (
              <Tooltip key={`${badge.id}-${badge.version}`} content={badge.title} side="top">
                <div
                  className={`
                    relative p-2 rounded-lg cursor-pointer transition-all flex items-center justify-center
                    ${badge.is_selected ? 'glass-input border-accent/50 ring-1 ring-accent/30' : 'border border-transparent hover:bg-glass hover:border-borderLight'}
                    ${updatingBadgeId === badge.id ? 'opacity-50 cursor-wait' : ''}
                  `}
                  onClick={() => !updatingBadgeId && updateChatIdentity(badge)}
                >
                  <img src={badge.image_url} alt={badge.title} className="w-8 h-8" />
                  {badge.is_selected && (
                    <div className="absolute -top-1 -right-1 w-3 h-3 bg-accent rounded-full border-2 border-background" />
                  )}
                </div>
              </Tooltip>
            ))}
          </div>
        ) : (
          <p className="text-textSecondary text-sm italic">
            {isFetchingIdentity ? 'Loading badges...' : 'No badges available'}
          </p>
        )}
      </div>

      {(allSeventvPaints.length > 0 || seventvBadges.length > 0) && (
        <div className="glass-panel rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <Tooltip content="Edit your 7TV cosmetics" side="top">
                  <button
                    onClick={handleOpen7TVCosmetics}
                    className="cursor-pointer hover:scale-110 transition-transform"
                    aria-label="Edit your 7TV cosmetics"
                  >
                    <svg className="w-4 h-4 text-[#29b6f6]" viewBox="0 0 28 21" fill="currentColor">
                      <path d="M20.7465 5.48825L21.9799 3.33745L22.646 2.20024L21.4125 0.0494437V0H14.8259L17.2928 4.3016L17.9836 5.48825H20.7465Z" />
                      <path d="M7.15395 19.9258L14.5546 7.02104L15.4673 5.43884L13.0004 1.13724L12.3097 0.0247596H1.8995L0.666057 2.17556L0 3.31276L1.23344 5.46356V5.51301H9.12745L2.96025 16.267L2.09685 17.7998L3.33029 19.9506V20H7.15395" />
                      <path d="M17.4655 19.9257H21.2398L26.1736 11.3225L27.037 9.83924L25.8036 7.68844V7.63899H22.0046L19.5377 11.9406L19.365 12.262L16.8981 7.96038L16.7255 7.63899L14.2586 11.9406L13.5679 13.1272L17.2682 19.5796L17.4655 19.9257Z" />
                    </svg>
                  </button>
                </Tooltip>
                <h4 className="text-sm font-semibold text-textPrimary uppercase tracking-wide">
                  Cosmetics
                </h4>
              </div>
              {seventvAuthConnected && (
                <span className="px-2 py-0.5 text-[10px] font-medium bg-green-500/20 text-green-400 rounded-full">
                  Connected
                </span>
              )}
            </div>

            {seventvUserId && (
              seventvAuthConnected ? (
                <button
                  onClick={async () => {
                    await invoke('logout_seventv');
                    if (mountedRef.current) setSeventvAuthConnected(false);
                  }}
                  className="px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 rounded-lg transition-all flex items-center gap-1.5"
                >
                  <Unlink size={14} />
                  Disconnect
                </button>
              ) : (
                <button
                  onClick={async () => {
                    setIsConnecting7TV(true);
                    await invoke('open_seventv_login_window');
                  }}
                  disabled={isConnecting7TV}
                  className="px-3 py-1.5 text-xs font-medium text-[#29b6f6] hover:bg-[#29b6f6]/10 rounded-lg transition-all flex items-center gap-1.5"
                >
                  <Link size={14} />
                  {isConnecting7TV ? 'Connecting...' : 'Connect to Edit'}
                </button>
              )
            )}
          </div>

          {allSeventvPaints.length > 0 && (
            <div className="mb-4">
              <p className="text-xs text-textSecondary mb-2 font-medium">Paints</p>
              <div className="flex flex-wrap gap-2">
                {allSeventvPaints.map((paint) => {
                  const isSelected = seventvPaint?.id === paint.id;
                  const isUpdating = updatingSeventvPaintId === paint.id;
                  return (
                    <Tooltip key={paint.id} content={seventvAuthConnected ? paint.name : `${paint.name} - Connect to edit`} side="top">
                      <div
                        className={`
                          relative px-3 py-1.5 rounded-lg cursor-pointer transition-all text-sm font-bold
                          ${isSelected ? 'glass-input border-[#29b6f6]/50 ring-1 ring-[#29b6f6]/30' : 'border border-transparent hover:bg-glass hover:border-borderLight'}
                          ${isUpdating ? 'opacity-50' : ''}
                          ${!seventvAuthConnected ? 'cursor-default' : ''}
                        `}
                        onClick={() => seventvAuthConnected && !isUpdating && handleSelectSeventvPaint(isSelected ? null : paint)}
                      >
                        <span style={computePaintStyle(paint as any, '#29b6f6')}>{paint.name}</span>
                        {isSelected && (
                          <div className="absolute -top-1 -right-1 w-3 h-3 bg-[#29b6f6] rounded-full border-2 border-background" />
                        )}
                      </div>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
          )}

          {seventvBadges.length > 0 && (
            <div>
              <p className="text-xs text-textSecondary mb-2 font-medium">Badges</p>
              <div className="flex flex-wrap gap-2">
                {seventvBadges.map((badge, idx) => {
                  const urls = getBadgeImageUrls(badge as any);
                  const isSelected = (badge as any).selected;
                  const isUpdating = updatingSeventvBadgeId === badge.id;
                  return urls.url4x ? (
                    <Tooltip key={`${badge.id}-${idx}`} content={badge.tooltip || badge.name} side="top">
                      <div
                        className={`
                          relative p-2 rounded-lg cursor-pointer transition-all
                          ${isSelected ? 'glass-input border-[#29b6f6]/50 ring-1 ring-[#29b6f6]/30' : 'border border-transparent hover:bg-glass hover:border-borderLight'}
                          ${isUpdating ? 'opacity-50' : ''}
                          ${!seventvAuthConnected ? 'cursor-default' : ''}
                        `}
                        onClick={() => seventvAuthConnected && !isUpdating && handleSelectSeventvBadge(isSelected ? null : badge)}
                      >
                        <FallbackImage
                          src={urls.url4x}
                          fallbackUrls={getBadgeFallbackUrls(badge.id).slice(1)}
                          alt={badge.tooltip || badge.name}
                          className="w-8 h-8"
                        />
                        {isSelected && (
                          <div className="absolute -top-1 -right-1 w-3 h-3 bg-[#29b6f6] rounded-full border-2 border-background" />
                        )}
                      </div>
                    </Tooltip>
                  ) : null;
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {thirdPartyBadges.length > 0 && (
        <div className="glass-panel rounded-xl p-5">
          <h4 className="text-sm font-semibold text-textPrimary uppercase tracking-wide mb-4">
            Other Badges
          </h4>
          <div className="flex flex-wrap gap-2">
            {thirdPartyBadges.map((badge: any, idx) => (
              <Tooltip key={`${badge.provider}-${badge.id}-${idx}`} content={`${badge.title} (${badge.provider.toUpperCase()})`} side="top">
                <div
                  className="p-2 rounded-lg hover:bg-glass transition-all cursor-pointer"
                  onClick={async () => {
                    if (badge.link) {
                      const { open } = await import('@tauri-apps/plugin-shell');
                      await open(badge.link);
                    }
                  }}
                >
                  <img src={badge.image4x || badge.imageUrl} alt={badge.title} className="w-8 h-8" />
                </div>
              </Tooltip>
            ))}
          </div>
        </div>
      )}

      <div className="glass-panel rounded-xl p-4 flex items-center justify-between">
        <p className="text-xs text-textSecondary">
          Signed in as <span className="text-textPrimary font-medium">@{currentUser.login}</span>
        </p>
        {!showLogoutConfirm ? (
          <button
            onClick={() => setShowLogoutConfirm(true)}
            className="px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 rounded-lg transition-all"
          >
            Sign out
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm text-textSecondary">Sign out?</span>
            <button
              onClick={() => setShowLogoutConfirm(false)}
              className="px-3 py-1.5 text-sm font-medium glass-button"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                logoutFromTwitch();
                setShowLogoutConfirm(false);
                closeSettings();
              }}
              className="px-3 py-1.5 text-sm font-medium bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/30 transition-all"
            >
              Confirm
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ProfileSettings;
