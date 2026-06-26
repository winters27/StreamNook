// Connections — the one place to manage platform accounts for MultiChat.
//
// Lists every provider with its connection status and a connect/disconnect
// action. Twitch is the app's native account (managed in the main app), Kick is
// wired to the OAuth flow, and the rest show as "coming soon" until their adapters
// ship. This scales as platforms light up — no more per-composer connect chips
// being the only way in.

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ProviderLogo } from '../ProviderLogo';
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from '../../types/providers';
import { useAppStore } from '../../stores/AppStore';
import { Logger } from '../../utils/logger';

type Status = 'native' | 'connected' | 'disconnected' | 'soon';

const DOT: Record<Status, string> = {
  native: '#53fc18',
  connected: '#53fc18',
  disconnected: 'rgba(255,255,255,0.25)',
  soon: 'rgba(245,158,11,0.7)',
};

const LABEL: Record<Status, string> = {
  native: 'Connected · managed in the main app',
  connected: 'Connected',
  disconnected: 'Not connected',
  soon: 'Coming soon',
};

export default function ConnectionsSettings() {
  const currentUser = useAppStore((s) => s.currentUser);
  const [kickConnected, setKickConnected] = useState(false);
  const [kickName, setKickName] = useState<string | null>(null);
  const [kickBusy, setKickBusy] = useState(false);
  const [youtubeConnected, setYoutubeConnected] = useState(false);
  const [youtubeName, setYoutubeName] = useState<string | null>(null);
  const [youtubeBusy, setYoutubeBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const c = await invoke<boolean>('kick_is_connected');
        if (!active) return;
        setKickConnected(c);
        if (c) {
          const n = await invoke<string | null>('kick_account_name');
          if (active) setKickName(n);
        } else {
          setKickName(null);
        }
      } catch {
        /* ignore */
      }
      try {
        const y = await invoke<boolean>('youtube_is_connected');
        if (!active) return;
        setYoutubeConnected(y);
        if (y) {
          const n = await invoke<string | null>('youtube_account_name');
          if (active) setYoutubeName(n);
        } else {
          setYoutubeName(null);
        }
      } catch {
        /* ignore */
      }
    };
    void check();
    const t = setInterval(() => void check(), 5000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);

  const connectKick = useCallback(() => {
    setKickBusy(true);
    void invoke('kick_connect')
      .then(() => setKickConnected(true))
      .catch((e) => Logger.warn('[Kick] connect failed:', e))
      .finally(() => setKickBusy(false));
  }, []);

  const disconnectKick = useCallback(() => {
    void invoke('kick_disconnect')
      .then(() => setKickConnected(false))
      .catch(() => {});
  }, []);

  const connectYoutube = useCallback(() => {
    setYoutubeBusy(true);
    void invoke('youtube_connect')
      .then(() => setYoutubeConnected(true))
      .catch((e) => Logger.warn('[YouTube] connect failed:', e))
      .finally(() => setYoutubeBusy(false));
  }, []);

  const disconnectYoutube = useCallback(() => {
    void invoke('youtube_disconnect')
      .then(() => setYoutubeConnected(false))
      .catch(() => {});
  }, []);

  const statusFor = (p: ProviderId): Status => {
    if (p === 'twitch') return 'native';
    if (p === 'kick') return kickConnected ? 'connected' : 'disconnected';
    if (p === 'youtube') return youtubeConnected ? 'connected' : 'disconnected';
    return PROVIDERS[p].enabled ? 'disconnected' : 'soon';
  };

  // Subtitle, naming the connected account where we know it.
  const subtitleFor = (p: ProviderId, status: Status): string => {
    if (p === 'twitch') {
      return currentUser?.display_name ? `Connected as ${currentUser.display_name}` : LABEL.native;
    }
    if (p === 'kick' && status === 'connected') {
      return kickName ? `Connected as ${kickName}` : 'Connected';
    }
    if (p === 'youtube' && status === 'connected') {
      return youtubeName ? `Connected as ${youtubeName}` : 'Connected';
    }
    return LABEL[status];
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-textSecondary">
        Connect your platform accounts to read and send chat across MultiChat. More platforms unlock as their
        integrations ship.
      </p>

      <div className="divide-y divide-white/5 overflow-hidden rounded-lg border border-white/10">
        {PROVIDER_IDS.map((p) => {
          const meta = PROVIDERS[p];
          const status = statusFor(p);
          return (
            <div
              key={p}
              className="flex items-center gap-3 px-3 py-3"
              style={{ opacity: status === 'soon' ? 0.6 : 1 }}
            >
              <ProviderLogo provider={p} size={22} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-textPrimary">{meta.label}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-textSecondary">
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: DOT[status] }}
                  />
                  {subtitleFor(p, status)}
                </div>
              </div>

              {/* Action — Kick + YouTube connect through here. */}
              {p === 'kick' &&
                (kickConnected ? (
                  <button
                    type="button"
                    onClick={disconnectKick}
                    className="shrink-0 rounded-md border border-white/15 px-3 py-1 text-xs font-medium text-textSecondary transition-colors hover:border-red-500/50 hover:text-red-400"
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={connectKick}
                    disabled={kickBusy}
                    className="shrink-0 rounded-md border px-3 py-1 text-xs font-semibold transition-colors hover:bg-white/5 disabled:opacity-60"
                    style={{ borderColor: 'rgba(83,252,24,0.45)', color: '#53fc18' }}
                  >
                    {kickBusy ? 'Connecting…' : 'Connect'}
                  </button>
                ))}
              {p === 'youtube' &&
                (youtubeConnected ? (
                  <button
                    type="button"
                    onClick={disconnectYoutube}
                    className="shrink-0 rounded-md border border-white/15 px-3 py-1 text-xs font-medium text-textSecondary transition-colors hover:border-red-500/50 hover:text-red-400"
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={connectYoutube}
                    disabled={youtubeBusy}
                    className="shrink-0 rounded-md border px-3 py-1 text-xs font-semibold transition-colors hover:bg-white/5 disabled:opacity-60"
                    style={{ borderColor: 'rgba(255,0,0,0.45)', color: '#ff4d4d' }}
                  >
                    {youtubeBusy ? 'Connecting…' : 'Connect'}
                  </button>
                ))}

              {status === 'soon' && (
                <span className="shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-500/80">
                  Soon
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
