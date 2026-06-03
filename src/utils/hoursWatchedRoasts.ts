// Hours-watched "roast generator".
//
// A hardcoded pool of one-liners that translate a user's lifetime watch hours
// into something absurd. Re-rolled every time the profile Overview opens (and
// on tap), never repeating the line just shown. Lines come in three tones and
// the picker weights them ~60% roast / 30% neutral / 10% cute.
//
// Two kinds of line:
//   - templated: references exactly one derived unit token ({days}, {weeks},
//     {movies}, {seasons}, {flights}). The line is only eligible when that unit
//     rounds to >= 1, so we never print "0 full days".
//   - flavor: no token, always eligible.
//
// Comparisons are kept brand-free and timeless on purpose (no show or movie
// names) so they don't age or step on trademarks.

export type RoastTone = 'roast' | 'neutral' | 'cute';

type Unit = 'days' | 'weeks' | 'movies' | 'seasons' | 'flights';

interface RoastLine {
  tone: RoastTone;
  text: string;
  // The single unit token this line interpolates. Omitted for flavor lines.
  requires?: Unit;
}

export interface PickedRoast {
  text: string;
  tone: RoastTone;
}

// Derived-unit divisors (hours / divisor, rounded):
//   days  = a full 24-hour day
//   weeks = a full-time 40-hour work week
//   movies = a ~2-hour feature film
//   seasons = a ~9-hour season of television (~22 episodes)
//   flights = a ~5-hour cross-country flight
const DIVISORS: Record<Unit, number> = {
  days: 24,
  weeks: 40,
  movies: 2,
  seasons: 9,
  flights: 5,
};

const POOL: RoastLine[] = [
  // ── Roast (the house style) ──────────────────────────────────────────────
  { tone: 'roast', requires: 'days', text: "That's about {days} full days. Grass is still out there, by the way." },
  { tone: 'roast', requires: 'days', text: '{days} full days parked in that chair. Your spine is keeping receipts.' },
  { tone: 'roast', requires: 'days', text: 'You could have touched grass for {days} straight days. You chose violence.' },
  { tone: 'roast', requires: 'weeks', text: '{weeks} unpaid 40-hour work weeks. The streamers say thanks.' },
  { tone: 'roast', requires: 'days', text: "{days} days of 'just one more stream.' We both know that was a lie." },
  { tone: 'roast', text: 'Somewhere your vitamin D is filing a missing persons report.' },
  { tone: 'roast', text: 'Long enough that the sun has stopped expecting you.' },
  { tone: 'roast', requires: 'days', text: 'You handed Twitch {days} days and it handed you nothing. Iconic.' },
  { tone: 'roast', text: "Your 'I'll go to bed after this' has aged like warm milk." },
  { tone: 'roast', requires: 'days', text: '{days} days. People have hiked entire countries in less.' },
  { tone: 'roast', requires: 'weeks', text: '{weeks} work weeks of watching other people do things. Inspiring.' },
  { tone: 'roast', text: 'The chair has fully memorized your shape. Congratulations?' },
  { tone: 'roast', requires: 'days', text: '{days} days indoors. Bats keep a healthier schedule than you.' },
  { tone: 'roast', text: "You've said 'last one' more times than you've said your own name." },
  { tone: 'roast', requires: 'movies', text: 'Enough time for {movies} movies, and somehow you watched none of them.' },
  { tone: 'roast', requires: 'days', text: '{days} days. That is a respectable prison sentence, served voluntarily.' },
  { tone: 'roast', text: 'Hydration is a concept you have heard about, allegedly.' },
  { tone: 'roast', requires: 'seasons', text: '{seasons} whole seasons of television, traded for scrolling chat. Bold.' },
  { tone: 'roast', text: "Touch grass? You don't even remember what grass tastes like." },
  { tone: 'roast', requires: 'days', text: '{days} days in. Your step count is a rounding error.' },
  { tone: 'roast', text: "The 'are you still watching' prompt is scared of you." },
  { tone: 'roast', requires: 'movies', text: '{movies} movies of potential, spent on a loading screen and chat.' },
  { tone: 'roast', requires: 'weeks', text: '{weeks} work weeks. You could have been employed. By yourself. Doing this.' },

  // ── Neutral absurd ───────────────────────────────────────────────────────
  { tone: 'neutral', requires: 'movies', text: "That's {movies} movies back-to-back, no bathroom breaks." },
  { tone: 'neutral', requires: 'seasons', text: "Roughly {seasons} full seasons, if you'd watched literally anything else." },
  { tone: 'neutral', requires: 'flights', text: 'Enough hours for {flights} cross-country flights. You did not move an inch.' },
  { tone: 'neutral', requires: 'days', text: '{days} days. Long enough to drive across the country and back. Twice.' },
  { tone: 'neutral', requires: 'days', text: "About {days} days, which is a solid chunk of a sourdough starter's entire life." },
  { tone: 'neutral', requires: 'weeks', text: '{weeks} work weeks. Somewhere an HR department is quietly confused.' },
  { tone: 'neutral', requires: 'movies', text: '{movies} feature films worth of runtime. The popcorn budget would be wild.' },
  { tone: 'neutral', requires: 'days', text: '{days} days is about how long it takes to grow a decent tomato. Just saying.' },
  { tone: 'neutral', requires: 'flights', text: "That's {flights} flights you could have slept through. Instead, chat." },
  { tone: 'neutral', requires: 'seasons', text: '{seasons} seasons. A streaming service would flag you as a heavy user.' },
  { tone: 'neutral', requires: 'days', text: '{days} days. The space station lapped the planet a few hundred times while you sat still.' },
  { tone: 'neutral', text: 'That is a genuinely unreasonable number of hours and we respect the commitment.' },

  // ── Cute (rationed, but present) ─────────────────────────────────────────
  { tone: 'cute', requires: 'days', text: 'A cozy little {days}-day pile of comfort streams. No notes.' },
  { tone: 'cute', text: 'Look at you, loyal to the bit. Adorable, honestly.' },
  { tone: 'cute', requires: 'days', text: "{days} days of showing up for your favorite people. That's kind of sweet." },
  { tone: 'cute', text: 'Background noise for your whole life, and we think that is lovely.' },
  { tone: 'cute', requires: 'days', text: '{days} days of good vibes and worse sleep. Worth it, probably.' },
  { tone: 'cute', requires: 'weeks', text: '{weeks} weeks of hanging out in your favorite corners of the internet.' },
  { tone: 'cute', text: 'Comfort streams hit different and you clearly agree.' },
  { tone: 'cute', text: 'You found your people and you stuck around. Cute, actually.' },
];

// For accounts with almost no watch time, the unit math reads silly, so use a
// dedicated low-hours set instead.
const LOW_HOURS: string[] = [
  'Barely any hours on the board. New here, or just suspiciously well-adjusted?',
  'Almost no watch time logged. Touching grass already? Show-off.',
  'Numbers too small to roast. Come back once you have made some questionable choices.',
];

// Module-level so consecutive rolls (even across remounts within a session)
// avoid repeating the exact line just shown.
let lastShown: string | null = null;

const computeUnits = (hours: number): Record<Unit, number> => ({
  days: Math.round(hours / DIVISORS.days),
  weeks: Math.round(hours / DIVISORS.weeks),
  movies: Math.round(hours / DIVISORS.movies),
  seasons: Math.round(hours / DIVISORS.seasons),
  flights: Math.round(hours / DIVISORS.flights),
});

const interpolate = (line: RoastLine, units: Record<Unit, number>): string => {
  if (!line.requires) return line.text;
  const value = units[line.requires] ?? 0;
  return line.text.replace(`{${line.requires}}`, value.toLocaleString());
};

const sample = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

/**
 * Pick a roast line for the given lifetime watch hours. Weights tone
 * ~60/30/10 (roast/neutral/cute), only offers templated lines whose unit
 * rounds to >= 1, and avoids repeating the line returned last time.
 */
export const pickHoursRoast = (hours: number): PickedRoast => {
  if (!hours || hours < 2) {
    const fresh = LOW_HOURS.filter((t) => t !== lastShown);
    const text = sample(fresh.length ? fresh : LOW_HOURS);
    lastShown = text;
    return { text, tone: 'roast' };
  }

  const units = computeUnits(hours);
  const eligible = POOL.filter((l) => !l.requires || (units[l.requires] ?? 0) >= 1);

  const r = Math.random();
  const tone: RoastTone = r < 0.6 ? 'roast' : r < 0.9 ? 'neutral' : 'cute';

  // Prefer the weighted tone, but never get stuck: fall back to any eligible
  // line, then ignore the no-repeat guard only as a last resort.
  let candidates = eligible.filter((l) => l.tone === tone && interpolate(l, units) !== lastShown);
  if (!candidates.length) candidates = eligible.filter((l) => interpolate(l, units) !== lastShown);
  if (!candidates.length) candidates = eligible;

  const line = sample(candidates);
  const text = interpolate(line, units);
  lastShown = text;
  return { text, tone: line.tone };
};
