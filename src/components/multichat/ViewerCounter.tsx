import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { createPortal } from 'react-dom';
import { Eye } from 'lucide-react';
import { ProviderLogo } from '../ProviderLogo';
import type { ProviderId } from '../../types/providers';
import { useVisibleInterval } from '../../utils/useVisibleInterval';

// A clean, aggregate viewer counter for the MultiChat title bar: total live
// viewers across every open source, with a per-stream breakdown on hover. Polls
// at the WINDOW level (not per pane) so it works in every mode — including
// blended, where the per-channel panes aren't mounted.

interface ViewerSource {
  channel: string;
  channelName?: string;
  provider?: ProviderId;
}

interface ViewerStat {
  key: string;
  name: string;
  provider: ProviderId;
  count: number | null;
  isLive: boolean;
}

const VIEWER_POLL_MS = 45_000;

function metaCommandFor(provider: ProviderId): string | null {
  if (provider === 'kick') return 'get_kick_channel_meta';
  if (provider === 'youtube') return 'get_youtube_channel_meta';
  if (provider === 'tiktok') return 'get_tiktok_channel_meta';
  return null;
}

async function fetchStat(src: ViewerSource): Promise<ViewerStat> {
  const provider = src.provider ?? 'twitch';
  const slug = src.channel.toLowerCase();
  const base = { key: `${provider}:${slug}`, name: src.channelName || src.channel, provider };
  try {
    if (provider === 'twitch') {
      const s = await invoke<{ viewer_count?: number | null } | null>('check_stream_online', {
        userLogin: slug,
      });
      return { ...base, count: s?.viewer_count ?? null, isLive: s !== null };
    }
    const cmd = metaCommandFor(provider);
    if (cmd) {
      const m = await invoke<{ viewer_count?: number | null; is_live?: boolean } | null>(cmd, {
        slug,
      });
      return { ...base, count: m?.viewer_count ?? null, isLive: m?.is_live ?? false };
    }
  } catch {
    /* leave unknown */
  }
  return { ...base, count: null, isLive: false };
}

export default function ViewerCounter({ channels }: { channels: ViewerSource[] }) {
  const [stats, setStats] = useState<ViewerStat[]>([]);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);

  const poll = useCallback(async () => {
    if (channels.length === 0) return;
    setStats(await Promise.all(channels.map(fetchStat)));
  }, [channels]);

  // Initial fetch on mount / when the channel set changes. Inline async (setState
  // only AFTER the await, inside a callback) so it doesn't trip the cascading-
  // render guard the way a direct `void poll()` in the effect body would. When
  // channels empties the component returns null, so stale stats are never shown.
  useEffect(() => {
    let active = true;
    (async () => {
      if (channels.length === 0) return;
      const results = await Promise.all(channels.map(fetchStat));
      if (active) setStats(results);
    })();
    return () => {
      active = false;
    };
  }, [channels]);
  useVisibleInterval(poll, VIEWER_POLL_MS);

  const total = useMemo(
    () => stats.reduce((sum, s) => sum + (s.isLive && s.count ? s.count : 0), 0),
    [stats],
  );
  const liveCount = stats.filter((s) => s.isLive).length;

  if (channels.length === 0) return null;

  return (
    <>
      <button
        type="button"
        data-tauri-drag-region="false"
        onMouseEnter={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAnchor({ top: r.bottom + 6, left: r.left });
        }}
        onMouseLeave={() => setAnchor(null)}
        className="flex items-center gap-1.5 rounded px-2 py-0.5 text-xs text-textSecondary transition-colors hover:bg-white/5 hover:text-textPrimary"
      >
        <Eye size={13} />
        <span className="font-medium tabular-nums">{total.toLocaleString()}</span>
        {liveCount > 0 && (
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-500" />
          </span>
        )}
      </button>
      {anchor &&
        createPortal(
          <div
            className="glass-panel fixed z-[300] min-w-[190px] rounded-lg border border-borderLight p-1.5 shadow-xl"
            // Opaque themed surface (not the translucent glass default): over the
            // scrolling chat a live backdrop-blur flickers in WebView2.
            style={{ top: anchor.top, left: anchor.left, backgroundColor: 'var(--color-background-tertiary)' }}
          >
            <div className="px-1.5 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-textMuted">
              Viewers{liveCount > 0 ? ` · ${total.toLocaleString()} watching` : ''}
            </div>
            {stats.map((s) => (
              <div key={s.key} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs">
                <ProviderLogo provider={s.provider} size={13} />
                <span className="min-w-0 flex-1 truncate text-textSecondary">{s.name}</span>
                {s.isLive ? (
                  <span className="font-medium tabular-nums text-textPrimary">
                    {(s.count ?? 0).toLocaleString()}
                  </span>
                ) : (
                  <span className="text-[10px] uppercase tracking-wide text-textMuted">offline</span>
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
