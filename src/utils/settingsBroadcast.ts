// Tauri cross-window settings sync.
//
// Each WebviewWindow loads settings into its own zustand store at mount, then
// only writes to disk on `updateSettings`. Without a broadcast step, a save in
// the main app never reaches an open MultiChat window (and vice versa). This
// module bridges that gap with a single Tauri event that every window
// subscribes to and refreshes its store on.

import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Logger } from './logger';

export const SETTINGS_UPDATED_EVENT = 'streamnook-settings-updated';

// A per-window-load random id. Stamped onto every emitted update so the
// originating window can ignore its own broadcast (no need to re-read the
// settings it just wrote).
export const SENDER_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export interface SettingsUpdatedPayload {
  source: string;
}

// Fire-and-forget broadcast. Never throws — emit may legitimately fail in
// non-Tauri contexts (e.g. unit tests).
export async function emitSettingsUpdated(): Promise<void> {
  try {
    await emit(SETTINGS_UPDATED_EVENT, { source: SENDER_ID } satisfies SettingsUpdatedPayload);
  } catch (err) {
    Logger.warn('[SettingsBroadcast] emit failed (non-fatal):', err);
  }
}

// Subscribe a callback to settings-updated events from OTHER windows. Returns
// an unlisten function — call it on component unmount to detach.
export async function listenForSettingsUpdates(
  onUpdate: () => void,
): Promise<UnlistenFn> {
  return listen<SettingsUpdatedPayload>(SETTINGS_UPDATED_EVENT, (event) => {
    if (event.payload?.source === SENDER_ID) return;
    try {
      onUpdate();
    } catch (err) {
      Logger.warn('[SettingsBroadcast] onUpdate handler threw:', err);
    }
  });
}
