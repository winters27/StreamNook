// Per-user chat overrides (nickname + color). Lookups are sync against the
// `chat_customization.user_overrides` Record on the global settings store, so
// callers can read inside render without effects. Writes go through
// `useAppStore.getState().updateSettings` so they persist via the same path
// every other setting uses.

import { useAppStore } from '../stores/AppStore';
import type { UserChatOverride } from '../types';

type OverrideMap = Record<string, UserChatOverride>;

export function getUserOverride(
  userId: string | null | undefined,
  overrides: OverrideMap | undefined,
): UserChatOverride | undefined {
  if (!userId || !overrides) return undefined;
  return overrides[userId];
}

// Returns the nickname when one is set, else falls back to the supplied
// display name (typically the Twitch display-name tag or username).
export function getDisplayedName(
  userId: string | null | undefined,
  fallback: string,
  overrides: OverrideMap | undefined,
): string {
  const override = getUserOverride(userId, overrides);
  if (override?.nickname && override.nickname.trim().length > 0) {
    return override.nickname;
  }
  return fallback;
}

// Returns the color override when one is set, else null (caller falls back).
export function getColorOverride(
  userId: string | null | undefined,
  overrides: OverrideMap | undefined,
): string | null {
  const override = getUserOverride(userId, overrides);
  return override?.color && override.color.trim().length > 0 ? override.color : null;
}

function readOverrides(): OverrideMap {
  const state = useAppStore.getState();
  return state.settings.chat_customization?.user_overrides ?? {};
}

// Snapshot of the current override map. Use sparingly — readers that
// re-render on changes should pull from `settings` via the AppStore hook,
// not from this getter (which is a one-shot read).
export function snapshotOverrides(): OverrideMap {
  return readOverrides();
}

function writeOverrides(next: OverrideMap): void {
  const state = useAppStore.getState();
  state.updateSettings({
    ...state.settings,
    chat_customization: {
      ...state.settings.chat_customization,
      user_overrides: next,
    },
  });
}

// Idempotent — writes nothing if the override would be unchanged. Captures the
// `username` field so the Settings UI can render "Bob → Robert" without an API
// roundtrip.
export function setUserNickname(
  userId: string,
  username: string,
  nickname: string | null,
): void {
  if (!userId) return;
  const overrides = readOverrides();
  const existing = overrides[userId];
  const trimmed = nickname && nickname.trim().length > 0 ? nickname.trim() : null;

  // If the only field that would change is nothing, bail.
  if (existing && existing.nickname === trimmed && existing.username === username) return;

  // If clearing the nickname AND there's no color, drop the whole entry.
  if (trimmed === null && !(existing?.color)) {
    if (!existing) return;
    const next = { ...overrides };
    delete next[userId];
    writeOverrides(next);
    return;
  }

  writeOverrides({
    ...overrides,
    [userId]: {
      ...existing,
      user_id: userId,
      username,
      nickname: trimmed,
    },
  });
}

// Item 4 will call this. Same shape as setUserNickname but for color.
export function setUserColor(
  userId: string,
  username: string,
  color: string | null,
): void {
  if (!userId) return;
  const overrides = readOverrides();
  const existing = overrides[userId];
  const trimmed = color && color.trim().length > 0 ? color.trim() : null;

  if (existing && existing.color === trimmed && existing.username === username) return;

  if (trimmed === null && !(existing?.nickname)) {
    if (!existing) return;
    const next = { ...overrides };
    delete next[userId];
    writeOverrides(next);
    return;
  }

  writeOverrides({
    ...overrides,
    [userId]: {
      ...existing,
      user_id: userId,
      username,
      color: trimmed,
    },
  });
}

// Drops the entire override entry for a user.
export function clearUserOverride(userId: string): void {
  if (!userId) return;
  const overrides = readOverrides();
  if (!overrides[userId]) return;
  const next = { ...overrides };
  delete next[userId];
  writeOverrides(next);
}
