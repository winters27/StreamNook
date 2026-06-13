import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/AppStore';
import { Logger } from '../utils/logger';

/** Mirrors the Rust `ResumeSnapshot` struct (commands/session.rs). */
interface ResumeSnapshot {
  stream_login?: string | null;
  media_type?: string | null;
  original_media_url?: string | null;
  was_mining: boolean;
  mining_campaign_id?: string | null;
}

/**
 * Snapshot what the user is doing so the next launch can restore it. Called
 * right before the app restarts to apply an update. Only live streams are
 * captured today (the common case); clips/VODs are skipped.
 */
export async function captureResumeSnapshot(): Promise<void> {
  const s = useAppStore.getState();
  const login = s.currentStream?.user_login;
  if (!login || s.currentMediaType !== 'live') return;

  const snapshot: ResumeSnapshot = {
    stream_login: login,
    media_type: s.currentMediaType,
    original_media_url: s.originalMediaUrl ?? null,
    was_mining: s.isMiningActive,
    mining_campaign_id: s.liveMiningStatus?.current_campaign ?? null,
  };

  try {
    await invoke('save_resume_snapshot', { snapshot });
  } catch (e) {
    Logger.error('[resume] Failed to save snapshot:', e);
  }
}

/**
 * Consume the resume snapshot (if any) and put the user back. Reopening the
 * stream via startStream also re-arms chat and the built-in watched-channel
 * drops monitor, so only the opt-in plugin miner needs an explicit replay.
 * Best-effort throughout — a failure here must never block app boot.
 */
export async function resumePreviousSession(): Promise<void> {
  let snap: ResumeSnapshot | null = null;
  try {
    snap = await invoke<ResumeSnapshot | null>('take_resume_snapshot');
  } catch (e) {
    Logger.error('[resume] Failed to read snapshot:', e);
    return;
  }
  if (!snap?.stream_login) return;

  Logger.info(`[resume] Restoring stream: ${snap.stream_login}`);
  try {
    await useAppStore.getState().startStream(snap.stream_login);
  } catch (e) {
    Logger.error('[resume] Failed to reopen stream:', e);
    return;
  }

  if (snap.was_mining) {
    void replayMining(snap.mining_campaign_id ?? null);
  }
}

/**
 * Re-arm the opt-in plugin miner. The plugin host launches enabled plugins on
 * startup, but the drops-mining provider may not be registered the instant we
 * get here, so poll briefly for it before replaying the action.
 */
async function replayMining(campaignId: string | null): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const providerId = await invoke<string | null>('plugins_provides', {
        feature: 'drops.mining',
      });
      if (providerId) {
        if (campaignId) {
          await invoke('plugins_invoke_action', {
            action: 'drops.mine',
            args: { campaign_id: campaignId },
          });
        } else {
          await invoke('plugins_invoke_action', { action: 'drops.mine-auto', args: {} });
        }
        Logger.info('[resume] Mining resumed.');
        return;
      }
    } catch (e) {
      Logger.error('[resume] Mining replay attempt failed:', e);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  Logger.warn('[resume] No drops.mining provider became available; skipped mining resume.');
}
