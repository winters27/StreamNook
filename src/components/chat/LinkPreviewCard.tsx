import React, { useEffect, useRef, useState, memo } from 'react';
import { Play, ExternalLink, Eye } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { Logger } from '../../utils/logger';
import { useAppStore } from '../../stores/AppStore';
import { playTwitchMediaInMain } from '../../utils/playTwitchMediaInMain';
import {
  fetchLinkPreview,
  prettyUrlLabel,
  type LinkPreview,
} from '../../services/linkPreviewService';

async function openExternal(url: string) {
  try {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } catch (err) {
    Logger.error('[LinkPreviewCard] Failed to open URL:', err);
  }
}

// Twitch clips and VODs deep-link into the in-app player (the user's stated
// preference) rather than opening the browser. start_stream (via playMedia)
// resolves either URL form through the same pipeline a live channel uses. Any
// failure surfaces a toast inside playMedia; the catch here is just a belt-and-
// suspenders fallback to the browser so the link is never dead.
function playTwitchMedia(p: LinkPreview): void {
  const info = {
    id: p.video_id ?? undefined,
    broadcaster_name: p.author ?? undefined,
    user_name: p.author ?? undefined,
    title: p.title ?? undefined,
    view_count: p.view_count ?? undefined,
    thumbnail_url: p.image ?? undefined,
  };
  if (p.kind === 'clip') {
    // A clip opens in the centered overlay modal in THIS window (a clip is a
    // direct MP4, no streaming server), so the current stream/chat stays put
    // underneath and the viewer returns to it on close.
    useAppStore.getState().openClipModal(p.url, info);
  } else {
    // A VOD needs the shared streaming pipeline → the in-app player (routed to
    // the main window when clicked from a popout, which has no player).
    void playTwitchMediaInMain('video', p.url, info);
  }
}

// The official YouTube glyph (red rounded rect + white play triangle), shown on
// YouTube cards the way the X glyph marks tweet cards.
function YouTubeGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="flex-shrink-0">
      <path
        fill="#FF0000"
        d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z"
      />
      <path fill="#fff" d="M9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}

// Inline -webkit clamp so we don't depend on the Tailwind line-clamp utility
// being enabled in this project's config.
const clamp = (lines: number): React.CSSProperties => ({
  display: '-webkit-box',
  WebkitLineClamp: lines,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
});

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Media length (seconds) -> "0:30" for clips, "1:02:45" for long VODs.
function formatMediaDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Compact view count: 1234 -> "1.2K", 3_400_000 -> "3.4M".
function formatViews(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${n}`;
}

/**
 * A single inline link-preview card. Resolves lazily (only fetches once the row
 * scrolls near the viewport) and renders a fixed-height skeleton while loading.
 * Card chrome reuses `.glass-panel` (subtle inset bevel, no outer glow).
 *
 * `showChip` controls the no-preview fallback: in "clean" mode (inline link
 * suppressed) it's true, so a failed/empty preview falls back to a compact link
 * chip and the link is never lost. In "keep link" mode it's false — the inline
 * link is still in the message, so a failed preview renders nothing.
 */
export const LinkPreviewCard = memo(function LinkPreviewCard({
  url,
  showChip = true,
  trusted = true,
}: {
  url: string;
  showChip?: boolean;
  trusted?: boolean;
}) {
  // undefined = unresolved, null = no preview, object = card. Nothing is cached
  // (chat links are ephemeral), so every card starts unresolved and fetches once.
  const [preview, setPreview] = useState<LinkPreview | null | undefined>(undefined);
  const [imageFailed, setImageFailed] = useState(false);
  // Trusted links fetch automatically; untrusted links wait for an explicit
  // click (the click-to-load chip below) so an arbitrary pasted link is never
  // fetched passively — that would reveal the user's IP to the linked host.
  const [loadRequested, setLoadRequested] = useState(trusted);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const requested = useRef(false);

  useEffect(() => {
    // Untrusted links don't auto-fetch; loadPreview() drives them on click.
    if (!trusted) return;
    if (requested.current) return;
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;

    const request = () => {
      if (requested.current) return;
      requested.current = true;
      fetchLinkPreview(url).then((p) => {
        if (!cancelled) setPreview(p ?? null);
      });
    };

    // Defer until near the viewport: a fast chat scrolls links past before the
    // eye lands on them, and there's no point fetching those.
    if (typeof IntersectionObserver === 'undefined') {
      request();
      return () => {
        cancelled = true;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          request();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [url, trusted]);

  // Fetch on demand (untrusted links, when the user clicks the load chip).
  const loadPreview = () => {
    setLoadRequested(true);
    if (requested.current) return;
    requested.current = true;
    fetchLinkPreview(url).then((p) => setPreview(p ?? null));
  };

  // Twitch clips/VODs open in the in-app player; everything else opens the
  // browser. Reads the resolved `preview` so the right action fires regardless
  // of which card variant rendered (incl. the no-thumbnail generic fallback).
  const activate = () => {
    if (preview && (preview.kind === 'clip' || preview.kind === 'vod')) {
      playTwitchMedia(preview);
    } else {
      void openExternal(url);
    }
  };

  const cardProps = {
    role: 'button' as const,
    tabIndex: 0,
    onClick: activate,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    },
  };

  // The card IS the link now: the inline URL in the message body is suppressed
  // once a card represents it, so every resolved card opens the link on click
  // and reveals the full URL on hover.
  const wrap = (node: React.ReactElement) => (
    <Tooltip content={url} side="top">
      {node}
    </Tooltip>
  );

  // Fallback when a link resolves to no usable preview. In "clean" mode
  // (showChip) the inline link was suppressed, so show a compact link chip and
  // never lose the link. In "keep link" mode the inline link is still present,
  // so render nothing.
  const fallback = showChip
    ? wrap(
        <div
          {...cardProps}
          className="glass-panel mt-1 inline-flex max-w-md cursor-pointer items-center gap-1.5 px-2.5 py-1.5 align-middle transition-colors hover:bg-white/[0.03]"
        >
          <ExternalLink size={13} className="flex-shrink-0 text-textSecondary" />
          <span className="truncate text-xs text-blue-400">{prettyUrlLabel(url)}</span>
        </div>,
      )
    : null;

  // Untrusted link, not yet loaded: a click-to-load chip (no passive fetch). The
  // inline link stays in the message body, so this is purely an opt-in preview —
  // clicking loads it, it doesn't navigate. Hover still reveals the full URL.
  if (!trusted && !loadRequested) {
    return (
      <Tooltip content={url} side="top">
        <div
          role="button"
          tabIndex={0}
          onClick={loadPreview}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              loadPreview();
            }
          }}
          className="glass-panel mt-1 inline-flex max-w-md cursor-pointer items-center gap-1.5 px-2.5 py-1.5 align-middle transition-colors hover:bg-white/[0.03]"
        >
          <Eye size={13} className="flex-shrink-0 text-textSecondary" />
          <span className="truncate text-xs text-textSecondary">Load preview · {hostOf(url)}</span>
        </div>
      </Tooltip>
    );
  }

  // Not resolved yet: a low-profile skeleton that doubles as the observe target.
  if (preview === undefined) {
    return (
      <div
        ref={containerRef}
        className="glass-panel mt-1 w-full max-w-md overflow-hidden"
        style={{ height: 56, opacity: 0.5 }}
        aria-hidden
      >
        <div className="flex h-full items-center gap-3 px-3">
          <div className="h-10 w-10 flex-shrink-0 rounded bg-white/5" />
          <div className="flex-1 space-y-2">
            <div className="h-2.5 w-1/3 rounded bg-white/5" />
            <div className="h-2.5 w-2/3 rounded bg-white/5" />
          </div>
        </div>
      </div>
    );
  }

  if (preview === null) {
    // An untrusted link the user explicitly asked to load resolved to nothing —
    // give a clear, non-vanishing result (the inline link is still in the
    // message) instead of the chip silently disappearing.
    if (!trusted) {
      return (
        <Tooltip content={url} side="top">
          <div className="glass-panel mt-1 inline-flex max-w-md items-center gap-1.5 px-2.5 py-1.5 align-middle text-xs text-textSecondary">
            <Eye size={13} className="flex-shrink-0 opacity-50" />
            <span className="truncate">No preview available · {hostOf(url)}</span>
          </div>
        </Tooltip>
      );
    }
    return fallback;
  }

  const site = preview.site_name || hostOf(url);

  // --- YouTube: thumbnail with a play affordance + title/author -------------
  if (preview.kind === 'youtube' && preview.image && !imageFailed) {
    return wrap(
      <div
        {...cardProps}
        className="glass-panel mt-1 block w-full max-w-md cursor-pointer overflow-hidden text-left transition-colors hover:bg-white/[0.03]"
      >
        <div className="relative w-full bg-black/40" style={{ aspectRatio: '16 / 9' }}>
          <img
            src={preview.image}
            alt={preview.title ?? 'YouTube video'}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
            onError={() => setImageFailed(true)}
          />
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/60">
              <Play size={22} className="ml-0.5 text-white" fill="currentColor" />
            </span>
          </span>
        </div>
        <div className="px-3 py-2">
          <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-textSecondary">
            <YouTubeGlyph size={13} />
            <span className="font-semibold text-textPrimary">YouTube</span>
            {preview.author && <span className="truncate">· {preview.author}</span>}
          </div>
          {preview.title && (
            <div className="text-sm font-medium text-textPrimary" style={clamp(2)}>
              {preview.title}
            </div>
          )}
        </div>
      </div>,
    );
  }

  // --- YouTube channel / profile: circular avatar + name + bio + glyph ------
  // (Dedicated card so the square avatar renders as a centered circle instead of
  // the generic card's top-pinned left thumbnail.) Opens in the browser.
  if (preview.kind === 'youtube_channel') {
    return wrap(
      <div
        {...cardProps}
        className="glass-panel mt-1 block w-full max-w-md cursor-pointer overflow-hidden p-3 text-left transition-colors hover:bg-white/[0.03]"
      >
        <div className="flex items-center gap-2.5">
          {preview.author_avatar && !imageFailed && (
            <img
              src={preview.author_avatar}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="h-11 w-11 flex-shrink-0 rounded-full object-cover"
              onError={() => setImageFailed(true)}
            />
          )}
          <div className="min-w-0 flex-1 leading-tight">
            <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-textSecondary">
              <YouTubeGlyph size={13} />
              <span className="font-semibold">YouTube</span>
            </div>
            {preview.title && (
              <div className="truncate text-sm font-semibold text-textPrimary">{preview.title}</div>
            )}
          </div>
        </div>
        {preview.description && (
          <div className="mt-2 text-xs text-textSecondary" style={clamp(3)}>
            {preview.description}
          </div>
        )}
      </div>,
    );
  }

  // --- Twitch clip / VOD: 16:9 thumbnail + duration badge + channel/views ----
  // Opens in the in-app player (see activate()).
  if ((preview.kind === 'clip' || preview.kind === 'vod') && preview.image && !imageFailed) {
    const hasMeta = !!preview.description || typeof preview.view_count === 'number';
    return wrap(
      <div
        {...cardProps}
        className="glass-panel mt-1 block w-full max-w-md cursor-pointer overflow-hidden text-left transition-colors hover:bg-white/[0.03]"
      >
        <div className="relative w-full bg-black/40" style={{ aspectRatio: '16 / 9' }}>
          <img
            src={preview.image}
            alt={preview.title ?? (preview.kind === 'vod' ? 'Twitch VOD' : 'Twitch clip')}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
            onError={() => setImageFailed(true)}
          />
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/60">
              <Play size={22} className="ml-0.5 text-white" fill="currentColor" />
            </span>
          </span>
          {typeof preview.duration === 'number' && preview.duration > 0 && (
            <span className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white">
              {formatMediaDuration(preview.duration)}
            </span>
          )}
        </div>
        <div className="px-3 py-2">
          <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-textSecondary">
            <span className="font-semibold" style={{ color: '#9146FF' }}>
              Twitch
            </span>
            {preview.author && <span className="truncate">· {preview.author}</span>}
          </div>
          {preview.title && (
            <div className="text-sm font-medium text-textPrimary" style={clamp(2)}>
              {preview.title}
            </div>
          )}
          {hasMeta && (
            <div className="mt-0.5 truncate text-[11px] text-textSecondary">
              {preview.description}
              {preview.description && typeof preview.view_count === 'number' ? ' · ' : ''}
              {typeof preview.view_count === 'number' ? `${formatViews(preview.view_count)} views` : ''}
            </div>
          )}
        </div>
      </div>,
    );
  }

  // --- Direct image ---------------------------------------------------------
  if (preview.kind === 'image' && preview.image && !imageFailed) {
    return wrap(
      <div
        {...cardProps}
        className="glass-panel mt-1 inline-block max-w-md cursor-pointer overflow-hidden transition-colors hover:bg-white/[0.03]"
      >
        <img
          src={preview.image}
          alt="Linked image"
          loading="lazy"
          referrerPolicy="no-referrer"
          className="max-h-72 w-auto object-contain"
          onError={() => setImageFailed(true)}
        />
      </div>,
    );
  }

  // --- Tweet / X post ------------------------------------------------------
  if (preview.kind === 'tweet') {
    const showImage = !!preview.image && !imageFailed;
    return wrap(
      <div
        {...cardProps}
        className="glass-panel mt-1 block w-full max-w-md cursor-pointer overflow-hidden p-3 text-left transition-colors hover:bg-white/[0.03]"
      >
        <div className="flex items-center gap-2">
          {preview.author_avatar && (
            <img
              src={preview.author_avatar}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="h-9 w-9 flex-shrink-0 rounded-full object-cover"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          )}
          <div className="min-w-0 flex-1 leading-tight">
            {preview.title && (
              <div className="truncate text-sm font-semibold text-textPrimary">{preview.title}</div>
            )}
            {preview.author && (
              <div className="truncate text-xs text-textSecondary">{preview.author}</div>
            )}
          </div>
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4 flex-shrink-0 text-textSecondary"
            fill="currentColor"
            aria-hidden
          >
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
        </div>
        {preview.description && (
          <div
            className="mt-2 whitespace-pre-wrap break-words text-sm text-textPrimary"
            style={clamp(8)}
          >
            {preview.description}
          </div>
        )}
        {showImage && (
          <img
            src={preview.image as string}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="mt-2 max-h-72 w-full rounded-lg object-cover"
            onError={() => setImageFailed(true)}
          />
        )}
      </div>,
    );
  }

  // --- Image-led "media" card (imgur galleries, etc.): big image + title ----
  if (preview.kind === 'media') {
    const showImage = !!preview.image && !imageFailed;
    if (!showImage && !preview.title) return fallback;
    return wrap(
      <div
        {...cardProps}
        className="glass-panel mt-1 block w-full max-w-md cursor-pointer overflow-hidden text-left transition-colors hover:bg-white/[0.03]"
      >
        {showImage && (
          <img
            src={preview.image as string}
            alt={preview.title ?? ''}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="max-h-80 w-full object-cover"
            onError={() => setImageFailed(true)}
          />
        )}
        {(preview.title || site) && (
          <div className="px-3 py-2">
            {site && <div className="truncate text-[11px] text-textSecondary">{site}</div>}
            {preview.title && (
              <div className="text-sm font-medium text-textPrimary" style={clamp(2)}>
                {preview.title}
              </div>
            )}
          </div>
        )}
      </div>,
    );
  }

  // --- Generic OpenGraph card ----------------------------------------------
  const hasText = !!(preview.title || preview.description || site);
  const showImage = !!preview.image && !imageFailed;
  if (!hasText && !showImage) return fallback;

  return wrap(
    <div
      {...cardProps}
      className="glass-panel mt-1 flex w-full max-w-md cursor-pointer items-center overflow-hidden text-left transition-colors hover:bg-white/[0.03]"
    >
      {showImage && (
        <img
          src={preview.image as string}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="h-20 w-20 flex-shrink-0 object-cover"
          onError={() => setImageFailed(true)}
        />
      )}
      <div className="min-w-0 flex-1 px-3 py-2">
        {site && <div className="truncate text-[11px] text-textSecondary">{site}</div>}
        {preview.title && (
          <div className="text-sm font-medium text-textPrimary" style={clamp(2)}>
            {preview.title}
          </div>
        )}
        {preview.description && (
          <div className="mt-0.5 text-xs text-textSecondary" style={clamp(2)}>
            {preview.description}
          </div>
        )}
      </div>
    </div>,
  );
});

export default LinkPreviewCard;
