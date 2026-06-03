// Tally the emotes in a message the member just sent, into their persisted
// per-account emote-usage counts. Best-effort and fire-and-forget: failures
// are swallowed so chat sending is never affected.

import { getEmoteByName } from '../services/emoteService';
import { incrementEmoteUsage } from '../services/supabaseService';
import { Logger } from './logger';

// Guard rails so a pathological message can't fan out to hundreds of lookups.
const MAX_UNIQUE_WORDS = 40;
const MAX_WORD_LEN = 40;

/**
 * Detect emotes in `message` (resolving against the current channel + globals)
 * and increment their usage counts for `userId`. Occurrences are counted, so
 * "KEKW KEKW KEKW" adds 3.
 */
export async function trackEmoteUsage(
  message: string,
  channelId: string | null,
  userId: string,
): Promise<void> {
  if (!message || !userId) return;
  try {
    const words = message.split(/\s+/).filter(Boolean);
    if (words.length === 0) return;

    const unique = [...new Set(words)]
      .filter((w) => w.length <= MAX_WORD_LEN)
      .slice(0, MAX_UNIQUE_WORDS);

    const lookups = await Promise.all(
      unique.map(
        async (w) => [w, await getEmoteByName(channelId, w).catch(() => null)] as const,
      ),
    );
    const byWord = new Map(lookups);

    // Tally occurrences per emote id.
    const tally = new Map<
      string,
      { name: string; provider: string; url: string; count: number }
    >();
    for (const w of words) {
      const e = byWord.get(w);
      if (!e) continue;
      const cur = tally.get(e.id);
      if (cur) cur.count += 1;
      else tally.set(e.id, { name: e.name, provider: e.provider, url: e.url, count: 1 });
    }

    for (const [id, t] of tally) {
      void incrementEmoteUsage(
        userId,
        { id, name: t.name, provider: t.provider, url: t.url },
        t.count,
      );
    }
  } catch (e) {
    Logger.warn('[EmoteUsage] tracking failed:', e);
  }
}
