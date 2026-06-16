// Turns a Twitch category into the activity line shown in live notifications.
// Games read naturally as "Playing <game>", but Twitch's non-game categories
// (Just Chatting, IRL, Music, ASMR, ...) don't, so those get a fitting verb.
// Keyed by the exact Twitch category display name; to add or reword one, edit
// this map. Anything not listed is assumed to be a game and uses "Playing".
const CATEGORY_ACTIVITY: Record<string, string> = {
  'Just Chatting': 'Just chatting',
  IRL: 'Streaming IRL',
  'Pools, Hot Tubs, and Beaches': 'Streaming IRL',
  'Travel & Outdoors': 'Out and about',
  Music: 'Making music',
  ASMR: 'Doing ASMR',
  Art: 'Making art',
  'Makers & Crafting': 'Making and crafting',
  'Food & Drink': 'Eating and drinking',
  'Beauty & Body Art': 'Doing beauty and body art',
  'Fitness & Health': 'Working out',
  'Talk Shows & Podcasts': 'On the mic',
  'Special Events': 'Streaming a special event',
  'Watch Party': 'Hosting a watch party',
  Sports: 'Watching sports',
  'Science & Technology': 'Talking tech',
  'Software and Game Development': 'Coding',
  'Co-working & Studying': 'Co-working',
  Politics: 'Talking politics',
  'Animals, Aquariums, and Zoos': 'Hanging with the animals',
};

// The activity line for a live category, or null when no category is set (the
// caller then falls back to the stream title or a generic line).
export function liveActivityText(category?: string | null): string | null {
  const name = category?.trim();
  if (!name) return null;
  return CATEGORY_ACTIVITY[name] ?? `Playing ${name}`;
}
