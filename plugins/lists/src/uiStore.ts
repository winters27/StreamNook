// Open/closed state of the floating Lists panel in this window, plus the
// plugin's own settings. Plugin-local: the title bar button, hotkey, palette
// rows, and the panel itself all read and write here.

import { create } from 'zustand';

interface ListsUiState {
  panelOpen: boolean;
  /** Switch to this list when the panel opens (palette "Open list: X" rows). */
  initialListId: string | null;
}

export const useListsUi = create<ListsUiState>(() => ({
  panelOpen: false,
  initialListId: null,
}));

export function openListsPanel(listId?: string): void {
  useListsUi.setState({ panelOpen: true, initialListId: listId ?? null });
}

export function closeListsPanel(): void {
  useListsUi.setState({ panelOpen: false, initialListId: null });
}

export function toggleListsPanel(): void {
  if (useListsUi.getState().panelOpen) closeListsPanel();
  else openListsPanel();
}

// ---- Plugin settings -------------------------------------------------------
// Persisted in localStorage so the choice survives restarts and is shared
// across this app's windows.

const SETTING_TITLEBAR = 'streamnook.lists.titlebarButton';

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

interface ListsSettingsState {
  /** Whether the Lists button appears in the app's title bar. */
  titleBarButton: boolean;
}

export const useListsSettings = create<ListsSettingsState>(() => ({
  titleBarButton: loadBool(SETTING_TITLEBAR, true),
}));

export function setTitleBarButton(on: boolean): void {
  try {
    localStorage.setItem(SETTING_TITLEBAR, on ? '1' : '0');
  } catch {
    // best effort
  }
  useListsSettings.setState({ titleBarButton: on });
}
