import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { HypeTrainData } from '../../types';
import type { ProviderId } from '../../types/providers';
import { useActivityStore } from '../../stores/activityStore';
import { makeKey } from '../../utils/providerKey';
import { Logger } from '../../utils/logger';

// Blended-mode Hype Train poller — the equivalent of MultiChatPane's per-pane poll,
// but for ALL the blended Twitch channels at once (blended mounts no per-channel
// panes). Resolves each channel's broadcaster id (get_hype_train_status needs it),
// polls each, pushes start/level-up rows into the activity feed (so the panel shows
// them too), adapts cadence (3s while any train runs, 15s idle), and returns the
// active trains keyed by channel login for the banner.

interface HypeStatus {
  is_active: boolean;
  id?: string;
  level: number;
  progress: number;
  goal: number;
  total: number;
  started_at?: string;
  expires_at?: string;
  is_golden_kappa: boolean;
}

interface HypeSource {
  channel: string;
  provider?: ProviderId;
  channelName: string;
}

// A broadcaster id never changes, so resolve once and keep it process-wide.
const idCache = new Map<string, string>();

async function resolveChannelId(login: string): Promise<string | undefined> {
  const cached = idCache.get(login);
  if (cached) return cached;
  const info = await invoke<{ id?: string }>('get_user_by_login', { login }).catch(() => null);
  if (info?.id) {
    idCache.set(login, info.id);
    return info.id;
  }
  return undefined;
}

export function useBlendedHypeTrains(channels: HypeSource[]): Map<string, HypeTrainData> {
  const [trains, setTrains] = useState<Map<string, HypeTrainData>>(new Map());
  // Re-run only when the Twitch channel SET changes, not on every render.
  const sig = channels
    .filter((c) => (c.provider ?? 'twitch') === 'twitch')
    .map((c) => `${c.channel.toLowerCase()}|${c.channelName}`)
    .join(',');

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    // Per-channel level tracking so an activity row fires once per start / level-up.
    const prevLevel = new Map<string, number>();
    const wasActive = new Map<string, boolean>();

    const poll = async () => {
      if (cancelled) return;
      const twitch = channels.filter((c) => (c.provider ?? 'twitch') === 'twitch');
      let anyActive = false;
      const next = new Map<string, HypeTrainData>();
      await Promise.all(
        twitch.map(async (c) => {
          const login = c.channel.toLowerCase();
          const id = await resolveChannelId(login);
          if (!id || cancelled) return;
          try {
            const s = await invoke<HypeStatus>('get_hype_train_status', {
              channelId: id,
              channelLogin: login,
            });
            if (s.is_active && s.level >= 1) {
              anyActive = true;
              next.set(login, {
                id: s.id || '',
                broadcaster_user_id: id,
                broadcaster_user_login: login,
                broadcaster_user_name: c.channelName || login,
                level: s.level,
                total: s.total,
                progress: s.progress,
                goal: s.goal,
                top_contributions: [],
                started_at: s.started_at || '',
                expires_at: s.expires_at || '',
                is_golden_kappa: s.is_golden_kappa,
              });
              const pl = prevLevel.get(login) ?? 0;
              if (s.level > pl || !wasActive.get(login)) {
                prevLevel.set(login, s.level);
                useActivityStore.getState().addEvent({
                  id: `hype-${login}-${s.id ?? 'train'}-L${s.level}`,
                  timestamp: new Date().toISOString(),
                  provider: 'twitch',
                  channel: makeKey('twitch', login),
                  channel_display: c.channelName || login,
                  kind: 'hypetrain',
                  actor: { username: login, display_name: c.channelName || login },
                  system_text: s.is_golden_kappa ? `Level ${s.level} · Golden Kappa` : `Level ${s.level}`,
                });
              }
              wasActive.set(login, true);
            } else {
              wasActive.set(login, false);
              prevLevel.set(login, 0);
            }
          } catch (err) {
            Logger.warn('[BlendedHype] get_hype_train_status failed:', err);
          }
        }),
      );
      if (cancelled) return;
      setTrains(next);
      timer = setTimeout(poll, anyActive ? 3000 : 15000);
    };

    timer = setTimeout(poll, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  return trains;
}
