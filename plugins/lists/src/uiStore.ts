// Open/closed state of the floating Lists panel in this window. Plugin-local:
// the title bar button, hotkey, palette rows, and the panel itself all read
// and write here.

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
