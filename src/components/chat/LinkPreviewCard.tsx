import React, { useEffect, useRef, useState, memo } from 'react';
import { Play, ExternalLink } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { Logger } from '../../utils/logger';
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
}: {
  url: string;
  showChip?: boolean;
}) {
  // undefined = unresolved, null = no preview, object = card. Nothing is cached
  // (chat links are ephemeral), so every card starts unresolved and fetches once.
  const [preview, setPreview] = useState<LinkPreview | null | undefined>(undefined);
  const [imageFailed, setImageFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const requested = useRef(false);

  useEffect(() => {
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
  }, [url]);

  const cardProps = {
    role: 'button' as const,
    tabIndex: 0,
    onClick: () => openExternal(url),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openExternal(url);
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

  if (preview === null) return fallback;

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
            <span className="font-semibold text-red-500">YouTube</span>
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
      className="glass-panel mt-1 flex w-full max-w-md cursor-pointer overflow-hidden text-left transition-colors hover:bg-white/[0.03]"
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
