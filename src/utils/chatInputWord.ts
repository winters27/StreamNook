/**
 * Find the start/end indices of the word at the cursor position in a string.
 * A word is a contiguous run of non-space characters.
 *
 * Examples (cursor marked with |):
 *   "hello| world"        -> [0, 5]   ("hello")
 *   "hello |world"        -> [6, 11]  ("world")
 *   "Kappa| HeyGuys"      -> [0, 5]   ("Kappa")
 *   "abc def gh|ij klm"   -> [8, 12]  ("ghij")
 */
export function getWordRange(text: string, position: number): [number, number] {
  let start = 0;
  let end = text.length;

  for (let i = position; i >= 0; i--) {
    if (i === 0 || text.charAt(i - 1) === ' ') {
      start = i;
      break;
    }
  }

  for (let i = position; i <= text.length; i++) {
    if (i === text.length || text.charAt(i) === ' ') {
      end = i;
      break;
    }
  }

  return [start, end];
}

export type EmoteTabMatchMode = 'starts_with' | 'includes';

export interface EmoteTabCandidate {
  name: string;
  priority: number;
  emote?: {
    id: string;
    name: string;
    url: string;
    localUrl?: string;
    provider: 'twitch' | 'bttv' | '7tv' | 'ffz' | 'kick';
    isZeroWidth?: boolean;
  };
  /** Set for chatter completions; the value is prefixed with @ if user typed @-prefix */
  chatter?: { username: string; displayName: string };
}
