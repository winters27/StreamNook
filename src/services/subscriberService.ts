// Subscriber gate. "Premium" features ARE subscriber features (the Stripe-backed
// support flow). There is no separate premium tier: subscribing is the one thing
// that unlocks them. Real status will come from the billing system and must be
// server-authoritative and world-readable, so any viewer can resolve whether the
// member they're looking at is a subscriber. Until that's wired, nobody is a
// subscriber, with one exception: a local dev override for the signed-in user so
// the gated features can be previewed (in devtools:
// `localStorage.setItem('sn_subscriber','1')`). Centralized here so flipping it
// on for real is a one-place change.

import { useAppStore } from '../stores/AppStore';

export const isSubscriber = async (userId: string): Promise<boolean> => {
  if (!userId) return false;
  // Dev-only self override: lets the signed-in user preview subscriber features.
  try {
    if (
      typeof localStorage !== 'undefined' &&
      (localStorage.getItem('sn_subscriber') === '1' || localStorage.getItem('sn_premium') === '1')
    ) {
      const selfId = useAppStore.getState().currentUser?.user_id;
      if (selfId && userId === selfId) return true;
    }
  } catch {
    /* localStorage unavailable */
  }
  // TODO: resolve the member's real subscription status from the billing system.
  return false;
};
