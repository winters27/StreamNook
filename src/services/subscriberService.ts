// Subscriber gate. "Premium" features ARE subscriber features (the Stripe-backed
// support flow). There is no separate premium tier: subscribing is the one thing
// that unlocks them.
//
// Real status comes from the `stripe_subscriptions` Supabase table (read via
// `isStripeSubscriber`), keyed by twitch_user_id, so any client resolves whether
// a member is subscribed. A dev-only self override stays so the gated features can
// be previewed without a real subscription (in devtools:
// `localStorage.setItem('sn_subscriber','1')`). Centralized here so every gated
// feature goes through one check.

import { useAppStore } from '../stores/AppStore';
import { isStripeSubscriber } from './supabaseService';

// Short cache so repeated checks (e.g. re-opening settings) don't re-query.
const cache = new Map<string, { value: boolean; ts: number }>();
const TTL = 5 * 60 * 1000;

export const isSubscriber = async (userId: string): Promise<boolean> => {
  if (!userId) return false;

  // Dev-only self override: preview subscriber features without billing.
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

  const hit = cache.get(userId);
  if (hit && Date.now() - hit.ts < TTL) return hit.value;

  const value = await isStripeSubscriber(userId).catch(() => false);
  cache.set(userId, { value, ts: Date.now() });
  return value;
};

// Drop the cached subscriber status for a user (e.g. right after they subscribe),
// so the next check re-reads it.
export const clearSubscriberCache = (userId?: string): void => {
  if (userId) cache.delete(userId);
  else cache.clear();
};
