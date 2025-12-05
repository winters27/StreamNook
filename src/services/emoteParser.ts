import { Emote, EmoteSet, getCachedEmoteUrl } from './emoteService';
import { parseEmojis } from './emojiService';

export interface EmoteSegment {
  type: 'text' | 'emote' | 'emoji';
  content: string;
  emoteId?: string;
  emoteUrl?: string;
  emojiUrl?: string;
}

// Parse Twitch native emotes from the emotes tag
export function parseEmotes(text: string, emotesTag: string): EmoteSegment[] {
  if (!emotesTag || !text) {
    return [{ type: 'text', content: text }];
  }

  const segments: EmoteSegment[] = [];
  const emotePositions: Array<{ start: number; end: number; id: string }> = [];

  // Parse emotes tag format: "25:0-4,6-10/1902:12-17"
  const emoteGroups = emotesTag.split('/');
  for (const group of emoteGroups) {
    const [emoteId, positions] = group.split(':');
    if (!positions) continue;

    const ranges = positions.split(',');
    for (const range of ranges) {
      const [start, end] = range.split('-').map(Number);
      emotePositions.push({ start, end, id: emoteId });
    }
  }

  // Sort by start position
  emotePositions.sort((a, b) => a.start - b.start);

  let lastIndex = 0;
  for (const pos of emotePositions) {
    // Add text before emote
    if (pos.start > lastIndex) {
      segments.push({
        type: 'text',
        content: text.substring(lastIndex, pos.start),
      });
    }

    // Add emote
    const emoteName = text.substring(pos.start, pos.end + 1);
    segments.push({
      type: 'emote',
      content: emoteName,
      emoteId: pos.id,
      emoteUrl: `https://static-cdn.jtvnw.net/emoticons/v2/${pos.id}/default/dark/1.0`,
    });

    lastIndex = pos.end + 1;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    segments.push({
      type: 'text',
      content: text.substring(lastIndex),
    });
  }

  return segments.length > 0 ? segments : [{ type: 'text', content: text }];
}

// Enhanced parser that includes BTTV, 7TV, and FFZ emotes
export function parseEmotesWithThirdParty(
  text: string,
  emotesTag: string,
  emoteSet?: EmoteSet
): EmoteSegment[] {
  // First parse Twitch native emotes
  let segments = parseEmotes(text, emotesTag);

  // Build a map of all third-party emotes by name
  const thirdPartyEmotes = new Map<string, Emote>();
  // Build a map of Twitch emotes by ID for cache lookup
  const twitchEmotesMap = new Map<string, Emote>();

  if (emoteSet) {
    [...emoteSet.bttv, ...emoteSet['7tv'], ...emoteSet.ffz].forEach(emote => {
      thirdPartyEmotes.set(emote.name, emote);
    });

    // Index Twitch emotes
    if (emoteSet.twitch) {
      emoteSet.twitch.forEach(emote => {
        twitchEmotesMap.set(emote.id, emote);
      });
    }
  }

  // Process each text segment to find third-party emotes
  const finalSegments: EmoteSegment[] = [];

  for (const segment of segments) {
    if (segment.type === 'emote') {
      // Check if we have a cached version of this Twitch emote
      if (segment.emoteId) {
        // First check the provided emoteSet map if available
        if (twitchEmotesMap.has(segment.emoteId)) {
          const cachedEmote = twitchEmotesMap.get(segment.emoteId);
          if (cachedEmote?.localUrl) {
            segment.emoteUrl = cachedEmote.localUrl;
          }
        }

        // If not found in map (or map not provided), check the global reactive cache registry
        // This handles emotes that were cached reactively after being seen in chat
        // If not found in map (or map not provided), check the global reactive cache registry
        // This handles emotes that were cached reactively after being seen in chat
        if (!segment.emoteUrl || !segment.emoteUrl.startsWith('asset://')) {
          const localUrl = getCachedEmoteUrl(segment.emoteId);
          if (localUrl) {
            segment.emoteUrl = localUrl;
          }
        }
      }

      // Keep Twitch emotes as-is (with potentially updated URL)
      finalSegments.push(segment);
    } else {
      // Split text by spaces and check each word
      const words = segment.content.split(' ');

      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const emote = thirdPartyEmotes.get(word);

        if (emote) {
          // Found a third-party emote
          finalSegments.push({
            type: 'emote',
            content: word,
            emoteUrl: emote.localUrl || emote.url,
          });
        } else {
          // Regular text - parse for emojis
          const emojiSegments = parseEmojis(word);

          for (const emojiSeg of emojiSegments) {
            if (emojiSeg.type === 'emoji') {
              finalSegments.push({
                type: 'emoji',
                content: emojiSeg.content,
                emojiUrl: emojiSeg.emojiUrl,
              });
            } else {
              finalSegments.push({
                type: 'text',
                content: emojiSeg.content,
              });
            }
          }
        }

        // Add space between words (except after last word)
        if (i < words.length - 1) {
          finalSegments.push({
            type: 'text',
            content: ' ',
          });
        }
      }
    }
  }

  return finalSegments;
}
