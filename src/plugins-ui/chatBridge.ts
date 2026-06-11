// Chat-surface helpers exposed to ui plugins through api.chat. Generic: any
// plugin that offers an "insert into chat" affordance uses these instead of
// reaching into the compose box itself.

import { useAppStore } from '../stores/AppStore';
import { usemultiNookStore } from '../stores/multiNookStore';

/** React hook: true when a chat compose box exists in this window (a stream
 *  is watched or the multi-stream grid is up). Popout windows resolve to
 *  false because their per-window stores are empty. */
export function useHasChatTarget(): boolean {
  const watching = useAppStore((s) => !!s.currentStream);
  const multiNookActive = usemultiNookStore((s) => s.isMultiNookActive);
  return watching || multiNookActive;
}

/** Insert text into the main chat compose box at the caret. Uses the native
 *  value setter + a synthetic input event so the controlled textarea picks the
 *  change up. Returns false when no compose box is mounted. */
export function insertIntoChatInput(text: string): boolean {
  const el = document.getElementById('chat-compose-input');
  if (!(el instanceof HTMLTextAreaElement)) return false;
  el.focus();
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  if (!setter) return false;
  setter.call(el, el.value.slice(0, start) + text + el.value.slice(end));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.setSelectionRange(start + text.length, start + text.length);
  return true;
}
