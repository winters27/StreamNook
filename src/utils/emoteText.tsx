import type { Emote, EmoteSet } from '../services/emoteService';
import { Tooltip } from '../components/ui/Tooltip';

// Flatten an EmoteSet into a single name -> emote lookup. Insertion order is
// reverse priority (twitch, ffz, bttv, 7tv) so 7TV overrides the others, which
// matches the precedence the chat renderer uses.
export function buildEmoteNameMap(emotes: EmoteSet | null | undefined): Map<string, Emote> {
  const map = new Map<string, Emote>();
  if (!emotes) return map;
  for (const list of [emotes.twitch, emotes.ffz, emotes.bttv, emotes['7tv']]) {
    for (const e of list) map.set(e.name, e);
  }
  return map;
}

interface EmoteTextProps {
  text: string;
  emoteMap: Map<string, Emote>;
  keyPrefix?: string;
  imgClassName?: string;
}

// Render plain text, swapping whitespace-delimited words that match an emote
// name for inline emote images. For surfaces that arrive as plain text with no
// IRC emote ranges, such as prediction outcomes and pinned messages.
export function EmoteText({
  text,
  emoteMap,
  keyPrefix = 'et',
  imgClassName = 'inline-block align-middle object-contain h-5 max-h-5',
}: EmoteTextProps) {
  const tokens = text.split(/(\s+)/);
  return (
    <>
      {tokens.map((tok, i) => {
        const emote = emoteMap.get(tok);
        if (!emote) return <span key={`${keyPrefix}-${i}`}>{tok}</span>;
        return (
          <Tooltip key={`${keyPrefix}-${i}`} content={emote.name}>
            <img
              src={emote.url}
              alt={emote.name}
              className={imgClassName}
              loading="lazy"
              draggable={false}
            />
          </Tooltip>
        );
      })}
    </>
  );
}
