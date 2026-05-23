// Route badge-overlay opens to the main window.
//
// Every Tauri WebView has its own JS context and its own AppStore instance,
// so calling `useAppStore.getState().openBadgesWithBadge(...)` inside a
// MultiChat popout flips state on the popout's own store — the overlay
// opens in the popout, not in the main app. That's not what we want for a
// chat-only popout: the badges/paints picker is a main-app surface and the
// popout is meant to stay slim. These helpers detect whether we're in a
// popout and either dispatch via a Tauri event (popout → main) or fall
// through to the local store (main → main).
//
// Main-window listeners live in `utils/multichatTrayBridge.ts` next to the
// other popout-to-main bridges, so anyone tracing the event flow can find
// every listener in one place.
//
// Caller contract: callers don't need to know whether they're in a popout.
// They just call the helper and the right thing happens.

import { useAppStore } from '../stores/AppStore';
import { Logger } from './logger';

function isPopoutWindow(): boolean {
  if (typeof window === 'undefined') return false;
  const hash = window.location.hash;
  return hash.startsWith('#/multichat') || hash.startsWith('#/profile');
}

async function emitToMain(eventName: string, payload?: unknown): Promise<void> {
  try {
    const { emit } = await import('@tauri-apps/api/event');
    Logger.debug(`[openBadgesInMain] emitting ${eventName}`, payload);
    await emit(eventName, payload ?? {});
    Logger.debug(`[openBadgesInMain] emit ${eventName} done`);
  } catch (err) {
    Logger.error(`[openBadgesInMain] emit ${eventName} failed:`, err);
  }
}

export function openBadgesWithBadgeInMain(badgeId: string): void {
  const popout = isPopoutWindow();
  Logger.debug(`[openBadgesInMain] openBadgesWithBadge popout=${popout} badgeId=${badgeId}`);
  if (popout) {
    void emitToMain('open-badges-with-badge', { badgeId });
    return;
  }
  useAppStore.getState().openBadgesWithBadge(badgeId);
}

export function openBadgesWithPaintInMain(paintId: string): void {
  const popout = isPopoutWindow();
  Logger.debug(`[openBadgesInMain] openBadgesWithPaint popout=${popout} paintId=${paintId}`);
  if (popout) {
    void emitToMain('open-badges-with-paint', { paintId });
    return;
  }
  useAppStore.getState().openBadgesWithPaint(paintId);
}

export function openBadgesOnStreamNookInMain(): void {
  const popout = isPopoutWindow();
  Logger.debug(`[openBadgesInMain] openBadgesOnStreamNook popout=${popout}`);
  if (popout) {
    void emitToMain('open-badges-on-streamnook');
    return;
  }
  useAppStore.getState().openBadgesOnStreamNook();
}
