// Sample chat lines + a few live 7TV global emotes for the cosmetics-preview's
// mock chat message. Pure flavor so the preview reads like real chat rather than
// one canned line. Tones: sarcastic, trash-talk, and love for 7TV / Twitch (the
// platforms StreamNook rides on, not competitors). Kept light and impersonal.

// Lines run long on purpose so the preview wraps to about two lines at a real
// chat column width, giving the atmosphere vertical presence instead of one thin
// line.
export const PREVIEW_MESSAGES: string[] = [
  // sarcastic
  'oh wow, groundbreaking gameplay, truly never seen anything like it before honestly',
  'sure buddy, whatever you say, that was definitely the play of the entire year',
  'incredible stuff, someone write a book about that one because i am speechless',
  // trash talk
  'absolute dogwater out there, hardstuck for a reason and still typing the most in chat',
  'that was a diff so hard it should honestly be studied, throw of the century right there',
  'you got carried that whole game and somehow you are the one talking the loudest, wild',
  // 7TV love
  '7TV genuinely carries this entire chat, the emotes are elite and i could never go back',
  'chatting without my 7TV emotes could never be me, this is peak internet culture honestly',
  // Twitch love
  'best stream on twitch no cap, the chat never misses and this is exactly why i love it here',
  'twitch chat being unhinged as always and somehow it is still the best part of the stream',
];

export interface PreviewEmote {
  id: string;
  name: string;
}

let cached: PreviewEmote[] | null = null;
let inflight: Promise<PreviewEmote[]> | null = null;

// Fetch the 7TV GLOBAL emote set once (cached) so the preview uses real, current
// emotes instead of hardcoded ids that go stale. Graceful: returns [] on failure.
export const getPreviewEmotes = async (): Promise<PreviewEmote[]> => {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('https://7tv.io/v3/emote-sets/global');
      const data = await res.json();
      const emotes: PreviewEmote[] = (data?.emotes ?? [])
        .filter((e: { id?: string; name?: string }) => e?.id && e?.name)
        .map((e: { id: string; name: string }) => ({ id: e.id, name: e.name }));
      cached = emotes;
      return emotes;
    } catch {
      cached = [];
      return cached;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
};

export const previewEmoteUrl = (id: string) => `https://cdn.7tv.app/emote/${id}/1x.webp`;

// Pick a random sample line + 0-2 random emotes (appended, like end-of-message
// emotes in real chat).
export const rollPreviewChat = (
  emotes: PreviewEmote[],
): { text: string; emotes: PreviewEmote[] } => {
  const text = PREVIEW_MESSAGES[Math.floor(Math.random() * PREVIEW_MESSAGES.length)];
  const picked: PreviewEmote[] = [];
  if (emotes.length) {
    const count = Math.floor(Math.random() * 3); // 0, 1 or 2
    for (let i = 0; i < count; i++) {
      picked.push(emotes[Math.floor(Math.random() * emotes.length)]);
    }
  }
  return { text, emotes: picked };
};
