// Kick global badge icons - Kick's ACTUAL chat badge SVG artwork, extracted
// verbatim from Kick's live site and mapped by badge type. Kick renders these as
// inline SVGs (no API/image endpoint), so we bundle them as assets and the
// renderer shows them as plain image URLs, exactly like every other badge.
//
// A channel's CUSTOM subscriber art (uploaded by Affiliate/Partner streamers)
// rides the message's image_url and takes precedence over anything here. When a
// channel has uploaded none, Kick still shows a default subscriber badge - its
// standard green "sparkle" design, rendered inline on the site - so we bundle
// that real art as the `subscriber` fallback. Badge types we don't yet have
// verified real art for (broadcaster / staff) return undefined - no badge -
// rather than wrong art.

import moderator from '../assets/kick-badges/moderator.svg?url';
import vip from '../assets/kick-badges/vip.svg?url';
import sub_gifter from '../assets/kick-badges/sub_gifter.svg?url';
import founder from '../assets/kick-badges/founder.svg?url';
import verified from '../assets/kick-badges/verified.svg?url';
import og from '../assets/kick-badges/og.svg?url';
import subscriber from '../assets/kick-badges/subscriber.svg?url';

const BADGES: Record<string, string> = {
  moderator,
  vip,
  sub_gifter,
  founder,
  verified,
  og,
  subscriber,
};

/** The bundled image URL for a Kick global badge type, or undefined if unknown. */
export function kickBadgeImage(type: string): string | undefined {
  return BADGES[type];
}
