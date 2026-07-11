// The overlay chat renderer — the "faithful twin" of the multichat row, built
// to run anywhere (in the in-app builder preview now, on the hosted OBS overlay
// page later) with no Tauri/store dependencies. It reuses the shared leaf pieces
// the real chat uses (StyledChatName, computePaintStyle) so it stays visually
// true, but drops all app-only machinery (moderation, disk cache, tooltips,
// click handlers). Both the preview and the live overlay mount THIS component,
// so what a streamer sees while editing is exactly what viewers get.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, HTMLAttributeReferrerPolicy, ReactNode } from 'react';
import { Gift, Star, Users, Megaphone, DollarSign, Flame, Heart } from 'lucide-react';
import { computePaintStyle } from '../../services/paintStyle';
import { PROVIDERS, type ProviderId } from '../../types/providers';
import type { MessageSegment } from '../../services/twitchChat';
import { clampOverlayStyle, type OverlayStyle, type EventCategory } from './overlayConfig';
import type { OverlayMessage } from './sampleMessages';
import { ProviderIcon } from './ProviderIcon';
import { AtmosphereChatWash } from './AtmosphereChatWash';
import { convertMoneyInText, loadRates, ratesReady } from './currency';

// The StreamNook identity badge on the overlay is just the member's equipped
// cosmetic image (the app's rich hover card doesn't belong on a broadcast). The
// asset URL is resolved per host — the app store in-app, the identity API on the
// hosted page — and carried on the message; this is the fallback when a member has
// no equipped cosmetic. Absolute so it loads both in-app and on the overlay page.
const SN_DEFAULT_LOGO = 'https://streamnook.app/cosmetics/streamnook-logo.png';

// Prefer a raster (webp/gif) emote URL over AVIF: OBS's embedded Chromium can be
// old and may not decode AVIF, leaving emotes blank. 7TV serves both.
const preferRasterEmote = (url: string): string =>
  (url || '').includes('cdn.7tv.app') ? url.replace(/\.avif(\b|$)/i, '.webp') : url;

// Reconstruct an emote's URL from its id — the same resolution the in-app chat row
// does (ChatMessage builds `.../emoticons/v2/{id}/...` when the tokenized URL is
// absent). This is why a Twitch/7TV emote never renders broken just because its
// baked URL wasn't accessible: we resolve it, we don't just hide it. 7TV ids are
// 24/26 chars; everything else is a numeric Twitch id.
const is7tvId = (id: string): boolean => id.length === 24 || id.length === 26;
const emoteUrlFromId = (id: string): string =>
  is7tvId(id)
    ? `https://cdn.7tv.app/emote/${id}/3x.webp`
    : `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/3.0`;

// Resolve an emote to a display URL: the baked URL if present, else rebuilt from the
// id. On a load failure, retry the id-rebuilt URL once before falling back to the
// text code — so a stale/wrong baked URL still resolves to a working image.
const EmoteImg = ({ segment, emoteScale }: { segment: Extract<MessageSegment, { type: 'emote' }>; emoteScale: number }) => {
  const rebuilt = segment.emote_id ? emoteUrlFromId(segment.emote_id) : '';
  const primary = preferRasterEmote(segment.emote_url) || rebuilt;
  const [src, setSrc] = useState(primary);
  const [failed, setFailed] = useState(!primary);
  if (failed) return <span>{segment.content}</span>;
  return (
    <img
      src={src}
      alt={segment.content}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="inline-block w-auto align-middle"
      style={{ height: `calc(2em * ${emoteScale})`, maxWidth: `calc(9em * ${emoteScale})`, margin: '0 0.125rem', verticalAlign: '-0.35em' }}
      onError={() => {
        if (rebuilt && src !== rebuilt) setSrc(rebuilt);
        else setFailed(true);
      }}
    />
  );
};

// A plainly-typed image for badges/avatars/emoji/cheermotes (no id to rebuild from):
// if the src is missing or fails to load, it renders `fallback` (a unicode char, or
// nothing) rather than a broken-image icon. React owns the swap, so it can't flicker.
interface FallbackImgProps {
  src?: string;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  loading?: 'lazy' | 'eager';
  referrerPolicy?: HTMLAttributeReferrerPolicy;
  fallback?: ReactNode;
}
const FallbackImg = ({ fallback = null, ...props }: FallbackImgProps) => {
  const [failed, setFailed] = useState(false);
  if (failed || !props.src) return <>{fallback}</>;
  return <img {...props} onError={() => setFailed(true)} />;
};

const badgeUrl = (b: OverlayMessage['badges'][number]): string | undefined =>
  b.image_url_4x || b.image_url_2x || b.image_url_1x;

// YouTube/TikTok author photos arrive as tiny thumbnails; bump the `=sNN` size
// param so the avatar renders crisply. Leaves URLs without the param untouched.
const hiResAvatar = (url: string): string => url.replace(/=s\d+(-|$)/, '=s160$1');

// Kick puts emotes into the reply PARENT body as literal `[emote:id:name]` tokens
// (the main message body is pre-tokenized into segments; the reply body is only a
// raw string). Render those tokens as Kick emote images so a Kick reply doesn't
// show raw `[emote:...]` markup. No-op for Twitch/YouTube/TikTok reply bodies,
// which never contain the token.
const KICK_EMOTE_TOKEN = /\[emote:(\d+):([^\]]*)\]/g;
const renderReplyBody = (text: string): ReactNode => {
  if (!text || !text.includes('[emote:')) return text;
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  KICK_EMOTE_TOKEN.lastIndex = 0;
  while ((m = KICK_EMOTE_TOKEN.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const name = m[2] || 'emote';
    out.push(
      <FallbackImg
        key={`re-${key++}`}
        src={`https://files.kick.com/emotes/${m[1]}/fullsize`}
        alt={name}
        fallback={name}
        referrerPolicy="no-referrer"
        className="inline-block align-middle"
        style={{ height: '1.4em', margin: '0 0.1em', verticalAlign: '-0.3em' }}
      />,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
};

// Map each platform's msg-id/msg_type to its event category (EventCategory + the
// filter list live in overlayConfig; the icon map + text helpers stay here with
// the renderer). Mirrors the app's own split (ChatMessage isSubscription vs
// isViewerMilestone), so a watch streak is a Milestone, never a Subscription.
const CATEGORY_OF: Record<string, EventCategory> = {
  sub: 'subscription', resub: 'subscription', primepaidupgrade: 'subscription',
  giftpaidupgrade: 'subscription', anongiftpaidupgrade: 'subscription',
  standardpayforward: 'subscription', communitypayforward: 'subscription',
  membership: 'subscription', sharedchatnotice: 'subscription',
  subgift: 'gift', submysterygift: 'gift', anonsubgift: 'gift', anonsubmysterygift: 'gift',
  membergift: 'gift', giftedsub: 'gift', tiktok_gift: 'gift', kick_gift: 'gift', kick_gifted: 'gift',
  raid: 'raid', unraid: 'raid',
  announcement: 'announcement', ritual: 'announcement',
  viewermilestone: 'milestone', watchstreak: 'milestone', bitsbadgetier: 'milestone',
  charitydonation: 'cheer', cheer: 'cheer', bits: 'cheer', superchat: 'cheer', superticker: 'cheer', supersticker: 'cheer',
  tiktok_follow: 'follow', tiktok_share: 'follow', follow: 'follow', kick_follow: 'follow',
};

const categoryOf = (msgType?: string): EventCategory =>
  (msgType && CATEGORY_OF[msgType]) || 'announcement';

const CATEGORY_ICON: Record<EventCategory, typeof Gift> = {
  subscription: Star, gift: Gift, raid: Users, cheer: DollarSign,
  milestone: Flame, follow: Heart, announcement: Megaphone,
};

// StreamNook event style — each category gets the app's own signature wash, so a
// watch-streak milestone reads as fire (orange), a cheer as bits (purple/blue), a
// sub as the iridescent multi-color, etc. — never all the same sub gradient. The
// four app classes (subscription/watchstreak/bits/donation) map 1:1 to ChatMessage's
// isSubscription/isWatchStreak/bits/isDonation paths; raid/follow/announcement have
// no dedicated app class, so they take a category-tinted wash of the same shape.
const CATEGORY_GRADIENT: Record<EventCategory, string> = {
  subscription: 'sn-ev-subscription',
  gift: 'sn-ev-subscription', // gifts render on the sub card in-app
  milestone: 'sn-ev-watchstreak',
  cheer: 'sn-ev-bits',
  raid: 'sn-ev-raid',
  follow: 'sn-ev-follow',
  announcement: 'sn-ev-announcement',
};

// Fallback text only when the platform sent no system-msg (rare — every provider
// event carries one). Category-appropriate, so it never mislabels a type.
const eventFallback = (category: EventCategory, name: string): string => {
  switch (category) {
    case 'subscription': return `${name} subscribed!`;
    case 'gift': return `${name} gifted a subscription!`;
    case 'raid': return `${name} is raiding!`;
    case 'cheer': return `${name} cheered!`;
    case 'milestone': return `${name} hit a milestone!`;
    case 'follow': return `${name} followed!`;
    default: return `${name} — event`;
  }
};

// ── Unicode emoji → one consistent style ────────────────────────────────────
// Platforms disagree: some tokenize emoji into image segments, others leave them
// as raw unicode (drawn by the streamer's OS font). To make a merged overlay
// consistent, a chosen vendor style re-renders EVERY emoji as that style's image.
// FE0F is KEPT in the codepoint (emoji-datasource filenames include it, e.g.
// 2764-fe0f.png) for wider coverage. Portable copy of the app's emojiService idea.
const EMOJI_REGEX = /\p{Regional_Indicator}{2}|(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(?:\p{Emoji_Modifier})?(?:\u200D(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(?:\p{Emoji_Modifier})?)*/gu;
const EMOJI_CDN: Record<string, string> = {
  apple: 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64',
  google: 'https://cdn.jsdelivr.net/npm/emoji-datasource-google@15.1.2/img/google/64',
  facebook: 'https://cdn.jsdelivr.net/npm/emoji-datasource-facebook@15.1.2/img/facebook/64',
};
const emojiImageUrl = (emoji: string, style: string): string | null => {
  const cps = [...emoji].map((c) => c.codePointAt(0)!);
  // Twitter renders from Twemoji SVG — vector, so it's sharp at any size (no 64px
  // ceiling). Twemoji strips FE0F from filenames. The other vendors are proprietary
  // raster; emoji-datasource's 64px (keeps FE0F) is the best the open CDNs offer.
  if (style === 'twitter') {
    const cp = cps.filter((c) => c !== 0xfe0f).map((c) => c.toString(16)).join('-');
    return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/${cp}.svg`;
  }
  const base = EMOJI_CDN[style];
  if (!base) return null;
  const cp = cps.map((c) => c.toString(16)).join('-');
  return `${base}/${cp}.png`;
};
const isUnicodeEmoji = (s: string): boolean => { EMOJI_REGEX.lastIndex = 0; return EMOJI_REGEX.test(s); };
const emojiImg = (emoji: string, url?: string, key?: string | number): ReactNode => (
  <FallbackImg
    key={key}
    src={url}
    alt={emoji}
    loading="lazy"
    className="inline-block align-middle"
    style={{ height: '1.25em', margin: '0 0.05em', verticalAlign: '-0.2em' }}
    fallback={<span>{emoji}</span>}
  />
);
// Split a text run into text + emoji-image nodes for a non-system emoji style.
const renderTextWithEmoji = (text: string, style: string): ReactNode => {
  if (!text) return text;
  EMOJI_REGEX.lastIndex = 0;
  if (!EMOJI_REGEX.test(text)) return text;
  EMOJI_REGEX.lastIndex = 0;
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = EMOJI_REGEX.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const emoji = m[0];
    const url = emojiImageUrl(emoji, style);
    out.push(url ? emojiImg(emoji, url, `e-${key++}`) : emoji);
    last = m.index + emoji.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
};

const OverlaySegment = ({ segment, emoteScale, emojiStyle = 'apple' }: { segment: MessageSegment; emoteScale: number; emojiStyle?: string }) => {
  if (segment.type === 'emote') {
    return <EmoteImg segment={segment} emoteScale={emoteScale} />;
  }
  if (segment.type === 'emoji') {
    const uni = isUnicodeEmoji(segment.content);
    // A unicode emoji under System style renders as the OS glyph.
    if (uni && emojiStyle === 'system') return <span>{segment.content}</span>;
    // Unicode emoji in a vendor style → re-image it; a custom (non-unicode) emoji
    // keeps its own platform image. Falls back to the literal char if the CDN 404s.
    const url = (uni ? emojiImageUrl(segment.content, emojiStyle) : null) || segment.emoji_url;
    return emojiImg(segment.content, url);
  }
  if (segment.type === 'cheermote') {
    return (
      <span className="inline-flex items-center align-middle" style={{ margin: '0 0.125rem' }}>
        <FallbackImg src={segment.cheermote_url} alt={segment.content} className="inline-block align-middle" style={{ height: `calc(1.75em * ${emoteScale})` }} />
        <span style={{ color: segment.color, fontWeight: 700, marginLeft: 2 }}>{segment.bits}</span>
      </span>
    );
  }
  if (segment.type === 'link') {
    return <span style={{ color: '#8ab4ff', textDecoration: 'underline' }}>{segment.content}</span>;
  }
  // Plain text: under a vendor style, image any unicode emoji sitting in the text.
  return <span>{emojiStyle === 'system' ? segment.content : renderTextWithEmoji(segment.content, emojiStyle)}</span>;
};

const SourceTag = ({ provider, mode }: { provider: ProviderId; mode: OverlayStyle['sourceTag'] }) => {
  if (mode === 'none') return null;
  const meta = PROVIDERS[provider] ?? PROVIDERS.twitch;
  if (mode === 'dot') {
    return (
      <span
        aria-hidden="true"
        className="inline-block flex-shrink-0"
        style={{ width: '0.5em', height: '0.5em', borderRadius: '9999px', backgroundColor: meta.color, marginRight: '0.4em', verticalAlign: '0.05em' }}
      />
    );
  }
  if (mode === 'icon') {
    // An inline-flex SVG defaults to the text baseline, which floats the logo high
    // above the line. Nudge it down so its center sits with the badges/name cluster.
    return (
      <span className="inline-flex items-center flex-shrink-0" style={{ marginRight: '0.4em', verticalAlign: '-0.1em' }}>
        <ProviderIcon provider={provider} size="1em" />
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center flex-shrink-0"
      style={{
        fontSize: '0.72em', fontWeight: 700, lineHeight: 1, letterSpacing: '0.02em',
        color: meta.color, marginRight: '0.45em', padding: '0.12em 0.4em', borderRadius: '0.4em',
        backgroundColor: `color-mix(in srgb, ${meta.color} 16%, transparent)`,
      }}
    >
      {meta.label}
    </span>
  );
};

// Known chat bots (lowercased logins), hidden when "Hide bots" is on. The bot
// BADGE below catches the rest — this list only needs the well-known bots that
// don't carry one.
const KNOWN_BOTS = new Set([
  'nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'wizebot',
  'sery_bot', 'commanderroot', 'soundtrackbot', 'streamlootsbot', 'pretzelrocks',
  'tangiabot', 'blerp', 'kofistreambot', 'own3d', 'botrixoficial', 'coebot',
  'phantombot', 'thepositivebot', 'streamstickers', 'lattemotte',
  'restreambot', 'supibot', 'anotherttvviewer', 'streamdatabase', 'streamdbbot',
  // Command/utility bots that carry NO bot badge in the chat data (their "Chat Bot"
  // badge is Twitch web-client chrome, not sent over IRC), so only a name catches them.
  'potatbotat', 'pajbot', 'titlechange_bot', 'buttsbot', 'snusbot', 'deepbot',
  'ankhbot', 'vivbot', 'revlobot', 'dixperbro', 'botisimo', 'mikuia', 'wzbot',
  'own3dpro_bot', 'playwithviewersbot', 'thepixelbot', 'cloudbot', '9gag',
]);

// A bot badge. FrankerFaceZ (badge id 2), Chatterino, and Homies all label bot
// accounts with a badge titled exactly "Bot"; some Twitch/other sets say "Chat
// Bot". Match either, exact (not substring) so cosmetics like "Robot" or "Botany"
// don't trip it. This is the signal that catches channel-specific custom bots that
// aren't in KNOWN_BOTS above — the same badge the app resolves, so the hosted
// overlay and the in-app preview filter identically.
const isChatBotBadge = (s?: string): boolean => {
  const v = (s || '').trim().toLowerCase();
  return v === 'bot' || v === 'chat bot';
};

const isBotMessage = (m: OverlayMessage): boolean => {
  if (KNOWN_BOTS.has((m.username || '').toLowerCase())) return true;
  // The "Chat Bot" badge — from either the Twitch badge set or a resolved
  // third-party badge — flags the account as a bot.
  if ((m.badges ?? []).some((b) => isChatBotBadge(b.title) || isChatBotBadge(b.name))) return true;
  if ((m.extraBadges ?? []).some((b) => isChatBotBadge(b.title))) return true;
  return false;
};

// A community gift bomb is a `submysterygift` ("X is gifting N subs") plus N
// individual `subgift`s that share an origin id. Keep the announcement, drop the
// individual gifts, so the overlay shows ONE row instead of N. Order-independent
// (matches how the app's activity feed collapses them).
const originIdOf = (m: OverlayMessage): string | undefined =>
  m.tags?.['msg-param-origin-id'] || m.tags?.['msg-param-community-gift-id'];

const collapseGiftBombs = (messages: OverlayMessage[]): OverlayMessage[] => {
  const bombs = new Set<string>();
  for (const m of messages) {
    const mt = m.metadata?.msg_type || m.tags?.['msg-id'];
    if (mt === 'submysterygift' || mt === 'anonsubmysterygift') {
      const o = originIdOf(m);
      if (o) bombs.add(o);
    }
  }
  if (bombs.size === 0) return messages;
  return messages.filter((m) => {
    const mt = m.metadata?.msg_type || m.tags?.['msg-id'];
    if (mt === 'subgift' || mt === 'anonsubgift') {
      const o = originIdOf(m);
      if (o && bombs.has(o)) return false;
    }
    return true;
  });
};

// Drop a leading "<name> " from an event's system message so the decorated style
// can show the paint-decorated name itself without duplicating it.
const stripLeadingName = (text: string, names: (string | undefined)[]): string => {
  for (const n of names) {
    if (n && text.toLowerCase().startsWith(`${n.toLowerCase()} `)) return text.slice(n.length).trimStart();
  }
  return text;
};

const OverlayRow = ({ message, style }: { message: OverlayMessage; style: OverlayStyle }) => {
  const provider = (message.provider ?? 'twitch') as ProviderId;
  const color = message.color || '#9147ff';
  // The overlay renders paints at full fidelity ('all' shadows) so the hosted page
  // and the builder preview always match, independent of any personal chat setting.
  // 7TV paint on the name, unless the streamer turned paints off.
  const paintOn = style.showPaints !== false && !!message.paint;
  const nameTextStyle = useMemo<CSSProperties>(
    () => (paintOn && message.paint ? computePaintStyle(message.paint, color, 'all') : { color }),
    [paintOn, message.paint, color],
  );

  const badgeSize = `calc(1.35em * ${style.badgeScale})`;
  // Native platform badges (+ StreamNook identity) obey showBadges. Third-party
  // badges obey showThirdPartyBadges AND a per-provider allowlist — 7TV, FFZ,
  // Chatterino, and the rest each toggle independently by the badge's `source`.
  const hiddenBadgeProviders = style.hiddenBadgeProviders ?? [];
  const badgeSourceHidden = (src?: string) => hiddenBadgeProviders.includes((src || '').toLowerCase());
  const nativeBadgesOn = style.showBadges;
  const thirdPartyOn = style.showThirdPartyBadges !== false;
  const showNativeBadges = nativeBadgesOn && (message.badges?.length ?? 0) > 0;
  const showSnBadge = nativeBadgesOn && message.streamNookUserNumber != null;
  const showSeventvBadge = thirdPartyOn && !!message.seventvBadgeUrl && !badgeSourceHidden('7tv');
  const visibleExtraBadges = thirdPartyOn ? (message.extraBadges ?? []).filter((b) => !badgeSourceHidden(b.source)) : [];
  const showExtraBadges = visibleExtraBadges.length > 0;
  const anyBadge = showNativeBadges || showSnBadge || showSeventvBadge || showExtraBadges;
  const reply = message.metadata?.reply_info;
  const avatar = (provider === 'youtube' || provider === 'tiktok') ? message.tags?.avatar : undefined;

  const atmosphere = style.showAtmospheres === false ? null : (message.atmosphere ?? null);
  const atmosphereFrost = !!atmosphere?.chatFrost;

  const rowStyle: CSSProperties = {
    position: 'relative',
    // Rows must keep their natural height. Without this, a fixed-height flex
    // column shrinks each item to cram them all in, so messages overlap/stack.
    // Older messages instead overflow off the top and are clipped (see container
    // overflow:hidden) — the fixed-viewport overlay model.
    flexShrink: 0,
    // Contain the atmosphere's -z-10 wash to this row and clip its oversized
    // animated layers. `isolation: isolate` makes a stacking context so the wash
    // sits behind this row's text but not behind the whole overlay.
    isolation: 'isolate',
    overflow: 'hidden',
    lineHeight: style.lineHeight,
    textShadow: style.textShadow ? '0 1px 2px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.55)' : undefined,
    ...(atmosphere ? { padding: '2px 6px', borderRadius: 6 } : null),
  };
  const entranceClass =
    style.entrance === 'fade' ? 'sn-ov-fade'
      : style.entrance === 'slide' ? 'sn-ov-slide'
        : style.entrance === 'pop' ? 'sn-ov-pop'
          : '';

  // Reusable pieces so events (decorated style) render the sender exactly like a
  // normal chat row: their badges + paint-decorated name.
  const badgesNode = anyBadge ? (
    <span className="inline-flex items-center" style={{ gap: '0.2em', marginRight: '0.4em', verticalAlign: '-0.18em' }}>
      {/* StreamNook identity badge leads the row, mirroring the real chat row. */}
      {showSnBadge && (
        <FallbackImg
          src={message.streamNookBadgeUrl || SN_DEFAULT_LOGO}
          alt="StreamNook"
          loading="lazy"
          className="inline-block align-middle"
          style={{ height: badgeSize, width: badgeSize, objectFit: 'contain' }}
        />
      )}
      {showNativeBadges && (message.badges ?? []).map((b, i) => {
        const url = badgeUrl(b);
        if (!url) return null;
        return (
          <FallbackImg key={`tw-${b.name}-${i}`} src={url} alt={b.title || b.name} className="inline-block align-middle" style={{ height: badgeSize, width: badgeSize }} />
        );
      })}
      {showSeventvBadge && (
        <FallbackImg key="seventv" src={message.seventvBadgeUrl} alt={message.seventvBadgeTitle || '7TV badge'} className="inline-block align-middle" style={{ height: badgeSize, width: badgeSize }} />
      )}
      {showExtraBadges && visibleExtraBadges.map((b, i) => (
        <FallbackImg key={`tp-${i}`} src={b.url} alt={b.title || 'badge'} className="inline-block align-middle" style={{ height: badgeSize, width: badgeSize }} />
      ))}
    </span>
  ) : null;

  const avatarNode = avatar ? (
    <FallbackImg src={hiResAvatar(avatar)} alt="" loading="lazy" referrerPolicy="no-referrer" className="inline-block rounded-full align-middle" style={{ width: '1.5em', height: '1.5em', minWidth: '1.5em', objectFit: 'cover', marginRight: '0.4em', verticalAlign: '-0.32em' }} />
  ) : null;

  // Paint (or flat color) on a plain inline-block span so background-clip:text
  // clips to the glyphs, not the box (a flex display makes it clip to the box).
  const nameNode = (
    <span style={{ ...nameTextStyle, fontWeight: 700, display: 'inline-block', verticalAlign: 'baseline', textShadow: paintOn ? 'none' : undefined }}>
      {message.display_name || message.username}
    </span>
  );

  // Event rows (subs, resubs, gifts, raids, announcements): render an icon + the
  // system message like the main app, with the user's message below if present —
  // never a blank normal message.
  const msgType = message.metadata?.msg_type || message.tags?.['msg-id'];
  const systemMessage = message.metadata?.system_message || message.tags?.['system-msg']?.replace(/\\s/g, ' ');
  if (systemMessage || (msgType && !!CATEGORY_OF[msgType])) {
    const category = categoryOf(msgType);
    const rawEventText = systemMessage || eventFallback(category, message.display_name || message.username);
    // Convert the amount in a YouTube Super Chat / Super Sticker to the chosen target
    // currency (no-op unless a target is set + rates are loaded).
    const text = style.superchatCurrency && (msgType === 'superchat' || msgType === 'supersticker')
      ? convertMoneyInText(rawEventText, style.superchatCurrency)
      : rawEventText;
    // TikTok stamps the action itself as the message body (e.g. "sent Team Power",
    // "followed"), which just duplicates the event line — so skip it. Twitch resubs
    // and YouTube Super Chats carry a real separate message, so those keep it.
    const hasBody = !!message.content && (message.segments?.length ?? 0) > 0 && provider !== 'tiktok';
    // Each event reflects its actual type (the icon) AND its source (the provider's
    // brand color), so a watch-streak Milestone never looks like a Subscription.
    const meta = PROVIDERS[provider] ?? PROVIDERS.twitch;
    const isPrime = category === 'subscription' && message.tags?.['msg-param-sub-plan'] === 'Prime';
    const EventIcon = CATEGORY_ICON[category];
    const isStreamNook = style.eventStyle === 'streamnook';
    // Charity donations get collapsed into the 'cheer' category for the icon, but
    // in-app they wear the green donation wash — honor that here.
    const gradientClass = msgType === 'charitydonation' ? 'sn-ev-donation' : CATEGORY_GRADIENT[category];
    const action = stripLeadingName(text, [message.display_name, message.username]);
    // Subscriptions: collapse Twitch's two sentences ("subscribed at Tier 1." +
    // "They've subscribed for N months!") into ONE — "subscribed at Tier 1 for N
    // months" (or "with Prime for N months"). Prefer the tags; fall back to folding
    // the month count out of the 2nd sentence for samples / providers without them.
    const shownAction = (() => {
      if (category !== 'subscription') return action;
      const plan = message.tags?.['msg-param-sub-plan'];
      const cumulative = message.tags?.['msg-param-cumulative-months'] || message.tags?.['msg-param-months'];
      const months = cumulative ? parseInt(cumulative, 10) : 0;
      if (plan) {
        const planStr = /prime/i.test(plan) ? 'with Prime' : `at Tier ${plan.charAt(0)}`;
        return `subscribed ${planStr}${months > 1 ? ` for ${months} months` : ''}`;
      }
      const first = action.split(/\.\s+/)[0];
      const m = action.match(/(\d+)\s*months?/i);
      return m && !first.includes(`${m[1]} month`) ? `${first} for ${m[1]} months` : first;
    })();
    // TikTok gifts carry the gift's own (often animated) image as an emote segment.
    // We drop TikTok's redundant TEXT body, but keep that image — it's the gift's
    // design — and render it inline on the event line.
    const giftSegments = provider === 'tiktok'
      ? (message.segments ?? []).filter((s) => s.type === 'emote' || s.type === 'emoji')
      : [];
    return (
      <div className={`sn-ov-row ${entranceClass}`} style={{ flexShrink: 0, lineHeight: style.lineHeight, textShadow: style.textShadow ? '0 1px 2px rgba(0,0,0,0.85)' : undefined, display: 'flex', alignItems: 'flex-start', gap: '0.35em' }} data-provider={provider} data-ov-row="">
        {/* Source tag lives OUTSIDE the event highlight — it's its own thing, so
            the platform indicator is consistent with normal messages. */}
        {style.sourceTag !== 'none' && (
          <span style={{ flexShrink: 0, paddingTop: '0.25em' }}>
            <SourceTag provider={provider} mode={style.sourceTag} />
          </span>
        )}
        <div
          className={isStreamNook ? gradientClass : undefined}
          style={{
            flex: 1, minWidth: 0, display: 'flex', alignItems: 'flex-start', gap: '0.5em',
            padding: '3px 8px', borderRadius: 6,
            ...(isStreamNook
              ? { border: '1px solid rgba(255,255,255,0.08)' }
              : { borderLeft: `2px solid ${meta.color}`, background: `linear-gradient(90deg, color-mix(in srgb, ${meta.color} 20%, transparent), transparent)` }),
          }}
        >
          <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', height: '1.5em' }}>
            {isPrime ? (
              <svg width="1em" height="1em" viewBox="0 0 20 20" fill="#60a5fa" aria-hidden="true">
                <path fillRule="evenodd" clipRule="evenodd" d="M18 5v8a2 2 0 0 1-2 2H4a2.002 2.002 0 0 1-2-2V5l4 3 4-4 4 4 4-3z" />
              </svg>
            ) : (
              <span style={{ color: meta.color, display: 'inline-flex' }}><EventIcon size="1em" /></span>
            )}
          </span>
          <div style={{ minWidth: 0, color: style.bodyTextColor }}>
            {/* Both styles render the sender decorated (badges + paint name) + the
                event action; StreamNook style adds the signature multi-color wash. */}
            <div className="min-w-0">
              {badgesNode}
              {nameNode}
              <span style={{ fontWeight: 400 }}> {shownAction}</span>
              {giftSegments.map((seg, i) => (
                <OverlaySegment key={`gift-${i}`} segment={seg} emoteScale={Math.max(style.emoteScale, 1)} emojiStyle={style.emojiStyle} />
              ))}
            </div>
            {hasBody && (
              // The message the subscriber typed WITH the event — a "drop" line: the
              // accent bar is pinned to the FAR LEFT (not flush against the text), with
              // a gap, so the chat clearly reads as dropping under the announcement.
              // The bar stretches to the chat's height (grows if the message wraps).
              <div style={{ display: 'flex', gap: '0.5em', marginTop: '0.2em', fontWeight: 400, opacity: 0.95 }}>
                <span aria-hidden="true" style={{ flexShrink: 0, width: '2px', borderRadius: '1px', background: 'color-mix(in srgb, currentColor 45%, transparent)' }} />
                <span style={{ minWidth: 0 }}>
                  {message.segments!.map((seg, i) => (
                    <OverlaySegment key={i} segment={seg} emoteScale={style.emoteScale} emojiStyle={style.emojiStyle} />
                  ))}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Inline flow (NOT flex) so the 7TV paint's background-clip:text renders like
  // the real chat row, and wrapped lines start at the left edge.
  const line = (
    <div className="min-w-0" style={{ color: style.bodyTextColor }}>
      <SourceTag provider={provider} mode={style.sourceTag} />
      {style.showTimestamps && message.metadata?.formatted_timestamp && (
        <span style={{ fontSize: '0.78em', opacity: 0.55, marginRight: '0.45em', verticalAlign: 'middle' }}>
          {message.metadata.formatted_timestamp}
        </span>
      )}
      {avatarNode}
      {badgesNode}
      {nameNode}
      {/* /me actions drop the colon and render the body in the sender's color,
          italic — the Twitch convention. */}
      {message.metadata?.is_action ? ' ' : <><span style={{ color, fontWeight: 700 }}>:</span>{' '}</>}
      <span style={{ fontWeight: 400, ...(message.metadata?.is_action ? { color, fontStyle: 'italic' } : null) }}>
        {(message.segments ?? [{ type: 'text', content: message.content }]).map((seg, i) => (
          <OverlaySegment key={i} segment={seg} emoteScale={style.emoteScale} emojiStyle={style.emojiStyle} />
        ))}
      </span>
    </div>
  );

  return (
    <div className={`sn-ov-row ${entranceClass}`} style={rowStyle} data-provider={provider} data-ov-row="">
      {atmosphere && <AtmosphereChatWash atm={atmosphere} observe={false} />}
      <div style={{ position: 'relative' }}>
        {reply && (
          <div style={{ fontSize: '0.82em', opacity: 0.7, marginBottom: '0.1em' }}>
            <span aria-hidden="true" style={{ marginRight: '0.3em' }}>↳</span>
            Replying to <span style={{ fontWeight: 700 }}>@{reply.parent_display_name}</span>: {renderReplyBody(reply.parent_msg_body)}
          </div>
        )}
        {atmosphereFrost ? (
          <span style={{ display: 'inline-block', maxWidth: '100%', borderRadius: 6, backgroundColor: 'rgba(5,6,13,0.22)', padding: '0.5px 6px', backdropFilter: 'blur(4px)' }}>
            {line}
          </span>
        ) : (
          line
        )}
      </div>
    </div>
  );
};

// Vertical padding of the container (8px top + 8px bottom) — subtracted from the
// measured height so the fit calc uses the real content area.
const CONTAINER_PAD_Y = 16;
// Hard ceiling on mounted rows (raid safety). The fit calc keeps far fewer; this
// only bounds a pathological burst before the measure pass narrows it.
const MAX_ROWS = 200;

// Generic CSS family keywords that never need a webfont load.
const GENERIC_FAMILIES = new Set([
  'system-ui', 'ui-sans-serif', 'ui-monospace', 'ui-serif', 'sans-serif', 'serif',
  'monospace', 'cursive', 'fantasy', '-apple-system', 'blinkmacsystemfont',
  'inherit', 'initial', 'unset',
]);
// First family in a font-family string, unquoted.
const primaryFamily = (ff: string): string =>
  (ff || '').split(',')[0].trim().replace(/^["']|["']$/g, '');

/**
 * Renders the overlay chat. Filters by selected sources, orders by direction, and
 * mounts ONLY the messages that currently fit the canvas — an overlay is not a
 * scrollback, so a message that scrolls off the edge is unmounted, not retained.
 * Self-contained styling (no app chat CSS) so it is portable to the hosted
 * overlay page unchanged.
 */
export const OverlayChat = ({ messages, style: rawStyle, superSample = 1 }: { messages: OverlayMessage[]; style: OverlayStyle; superSample?: number }) => {
  const style = clampOverlayStyle(rawStyle);
  // Supersampling for crisp text in OBS. OBS's browser renders at devicePixelRatio
  // 1, so text is softer than on a HiDPI monitor (which the design site shows at
  // 2×). We render the whole chat at `ss`× the pixel size — font, gap, padding all
  // multiplied — then scale the container back down by 1/ss with a transform. The
  // glyphs rasterize at ss× density and downsample to the canvas, so the captured
  // frame is supersampled. Layout is IDENTICAL (same rows, same wrapping) — only the
  // raster density changes — so it stays 1:1 with the builder preview.
  const ss = Math.max(1, Math.min(4, Math.round(superSample) || 1));
  const fontPx = style.fontSize * ss;
  const gapPx = style.messageGap * ss;
  const padY = CONTAINER_PAD_Y * ss;
  const padXpx = 10 * ss;
  const padYpx = 8 * ss;
  const sourcesKey = style.sources.join(',');
  // Load the chosen font from Google Fonts when it isn't a generic/system family,
  // so a custom font (or a preset that isn't installed locally) renders in OBS and
  // on the hosted page. If the name isn't a real Google Font the request just
  // no-ops and the browser falls back to the family stack.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const fam = primaryFamily(style.fontFamily);
    if (!fam || GENERIC_FAMILIES.has(fam.toLowerCase())) return;
    const id = 'sn-ov-font-' + fam.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam).replace(/%20/g, '+')}:wght@400;600;700&display=swap`;
    document.head.appendChild(link);
  }, [style.fontFamily]);
  const containerRef = useRef<HTMLDivElement>(null);
  // How many of the newest messages to mount. Driven by measurement below, not a
  // fixed cap: it grows to fill the canvas and shrinks so nothing off-screen stays
  // mounted. Direction only flips the render order/anchor — either way we keep the
  // newest and drop the oldest.
  const [count, setCount] = useState(24);
  const [, forceMeasure] = useState(0);
  const hiddenKey = (style.hiddenEvents ?? []).join(',');
  const hiddenProviderKey = (style.hiddenProviderEvents ?? []).join(',');
  // Manual per-source username blocklist. Stored keyed `provider:channel`, but we
  // union it per PROVIDER so a name the streamer blocked reliably disappears from
  // that platform regardless of channel-string drift — the whole point is that a
  // bot the auto-hider misses actually gets hidden.
  const blockedKey = JSON.stringify(style.blockedUsers ?? {});
  const blockedByProvider = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const bu = style.blockedUsers ?? {};
    for (const key of Object.keys(bu)) {
      const provider = (key.split(':')[0] || 'twitch').toLowerCase();
      const set = map.get(provider) ?? new Set<string>();
      for (const name of bu[key] ?? []) {
        const n = name.trim().toLowerCase().replace(/^@+/, '');
        if (n) set.add(n);
      }
      if (set.size) map.set(provider, set);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockedKey]);
  const isBlockedUser = (m: OverlayMessage): boolean => {
    const set = blockedByProvider.get((m.provider ?? 'twitch').toLowerCase());
    if (!set || set.size === 0) return false;
    const u = (m.username || '').trim().toLowerCase().replace(/^@+/, '');
    const d = (m.display_name || '').trim().toLowerCase().replace(/^@+/, '');
    return (!!u && set.has(u)) || (!!d && set.has(d));
  };
  // Load FX rates when a Super Chat target currency is set, then re-render so the
  // converted amounts appear once rates land (convertMoneyInText reads the cache).
  const [, bumpRates] = useState(0);
  useEffect(() => {
    if (!style.superchatCurrency || ratesReady()) return;
    let cancelled = false;
    void loadRates().then(() => { if (!cancelled) bumpRates((v) => v + 1); });
    return () => { cancelled = true; };
  }, [style.superchatCurrency]);
  // Safety valve: bound how many times the measure pass may adjust `count` within one
  // message-count epoch. Convergence normally takes a handful of steps; if some future
  // row ever renders untagged (breaking the 1:1 row↔message mapping) this stops the
  // renderer from thrashing into React's "max update depth" crash — the overlay just
  // ends up slightly mis-sized instead of taking down the whole settings dialog.
  const settleRef = useRef({ epoch: -1, tries: 0 });

  // Chronological (oldest → newest), fully filtered: gift-bomb dedup, source
  // platform, hidden bots, and hidden event categories. ALL exclusions happen here
  // (not by an OverlayRow returning null) so every mounted message is exactly one
  // DOM row — the measure pass below relies on that 1:1 mapping to stay stable. No
  // cap here; the measure pass decides how many actually render.
  // Command filters. Each entry is either a PREFIX (all-symbol, e.g. '!' / '#' →
  // matches the message start) or a SPECIFIC command (has letters/digits, e.g.
  // '!title' → matches the first word exactly), so a streamer can nuke all commands
  // or hide just a few.
  const cmdFilterKey = (style.commandFilters ?? []).map((f) => `${f.mode}:${f.value}`).join('|');
  const cmdFilters = useMemo(
    () =>
      (style.commandFilters ?? [])
        .map((f) => ({ value: (f.value ?? '').trim().toLowerCase(), mode: f.mode }))
        .filter((f) => f.value),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cmdFilterKey],
  );

  const ordered = useMemo(() => {
    const allowed = new Set(style.sources);
    return collapseGiftBombs(messages).filter((m) => {
      if (!allowed.has((m.provider ?? 'twitch') as ProviderId)) return false;
      if (style.hideBots && isBotMessage(m)) return false;
      if (isBlockedUser(m)) return false;
      const mt = m.metadata?.msg_type || m.tags?.['msg-id'];
      const isEvent = !!(m.metadata?.system_message || m.tags?.['system-msg']) || (mt ? !!CATEGORY_OF[mt] : false);
      // Hide command messages (never events): prefix entries match the message
      // start; specific entries match the first word exactly.
      if (!isEvent && style.hideCommands && cmdFilters.length) {
        const body = (m.content ?? '').replace(/^\s+/, '').toLowerCase();
        if (body) {
          const firstWord = body.split(/\s+/)[0];
          for (const f of cmdFilters) {
            if (f.mode === 'prefix' ? body.startsWith(f.value) : firstWord === f.value) return false;
          }
        }
      }
      if (isEvent) {
        const cat = categoryOf(mt);
        if (style.hiddenEvents?.includes(cat)) return false;
        // Per-platform hide: e.g. 'tiktok:follow' hides follows on TikTok only.
        const prov = m.provider ?? 'twitch';
        if (style.hiddenProviderEvents?.includes(`${prov}:${cat}`)) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, sourcesKey, style.hideBots, hiddenKey, hiddenProviderKey, blockedKey, style.hideCommands, cmdFilterKey]);

  const windowMsgs = ordered.slice(-count);
  const rendered = style.direction === 'newTop' ? windowMsgs.slice().reverse() : windowMsgs;

  // After every render, measure real row heights (offsetHeight, so entrance
  // transforms/opacity don't corrupt the reading) from the anchored edge and keep
  // only the rows that touch the canvas. Converges in a frame (before paint) and
  // stops once `count` matches what fits, so there's no visible reflow.
  // Intentionally runs every render (no dep array): row heights change for reasons
  // beyond the obvious style props — emote/badge images loading, font swaps, text
  // wrapping at a new width — and re-measuring every render catches them all. The
  // `target !== count` guard makes it converge and stop, so it can't loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const avail = el.clientHeight - padY;
    if (avail <= 0) return;
    const gap = gapPx;
    const domRows = Array.from(el.querySelectorAll<HTMLElement>('[data-ov-row]'));
    if (domRows.length === 0) return;
    // Reset the adjust-budget whenever the message count changes (a new epoch); bail
    // if we've already adjusted too many times this epoch without settling.
    const settle = settleRef.current;
    if (settle.epoch !== ordered.length) { settle.epoch = ordered.length; settle.tries = 0; }
    if (settle.tries > 30) return;
    // Newest → older, so we count from the anchored edge outward. `fit` = rows up to
    // and including the first that crosses the edge; `overflowed` = we mounted enough
    // to actually reach the edge.
    const seq = style.direction === 'newTop' ? domRows : domRows.slice().reverse();
    let acc = 0;
    let fit = 0;
    let overflowed = false;
    for (const r of seq) {
      acc += r.offsetHeight + (fit > 0 ? gap : 0);
      fit++;
      if (acc >= avail) { overflowed = true; break; }
    }
    if (!overflowed && count < ordered.length) {
      // Mounted rows don't fill the canvas and older messages exist: we can't know
      // the true fit without mounting more. Grow by DOUBLING (bounded, ~log2 steps to
      // MAX_ROWS) so it reaches the edge fast instead of creeping row-by-row.
      const next = Math.min(ordered.length, Math.max(count + 4, count * 2), MAX_ROWS);
      if (next !== count) { settle.tries++; setCount(next); }
      return;
    }
    // Enough mounted (edge reached, or showing every message): keep exactly the rows
    // that touch the canvas. `fit` rows overflow by construction, so re-measuring
    // this same set yields `fit` again — a stable fixed point, no oscillation.
    const target = Math.min(fit, ordered.length, MAX_ROWS);
    if (target !== count) { settle.tries++; setCount(target); }
  });

  // Re-measure when the canvas itself resizes (height slider, window resize) even
  // if no new message arrived.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => forceMeasure((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Soft exit edge: a message reaching the edge where old ones age out should
  // DISSOLVE, never show a hard half-row. This gradient mask fades the last ~1.5
  // lines at that edge to transparent (top for newBottom, bottom for newTop);
  // combined with the measure pass unmounting fully-off rows, an old message
  // fades out and then vanishes — it's never sliced in half.
  const fadePx = Math.round(fontPx * 2.4);
  const maskImage =
    style.direction === 'newTop'
      ? `linear-gradient(to top, transparent 0, #000 ${fadePx}px, #000 100%)`
      : `linear-gradient(to bottom, transparent 0, #000 ${fadePx}px, #000 100%)`;

  const containerStyle: CSSProperties = {
    fontFamily: style.fontFamily,
    fontSize: `${fontPx}px`,
    color: style.bodyTextColor,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: style.direction === 'newBottom' ? 'flex-end' : 'flex-start',
    gap: `${gapPx}px`,
    // At ss=1 the container fills its parent. When supersampling, it renders at ss×
    // the canvas in px (so glyphs rasterize dense) and is scaled back to fit below.
    height: ss === 1 ? '100%' : `${style.height * ss}px`,
    width: ss === 1 ? '100%' : `${style.width * ss}px`,
    // NB: deliberately NO will-change/backface hints here — those let the compositor
    // pick a post-transform raster scale (rasterizing at the small size = no gain).
    // A plain transform rasterizes the layer at its true ss× size, then the compositor
    // downsamples → genuine supersampling.
    ...(ss === 1 ? null : { transform: `scale(${1 / ss})`, transformOrigin: 'top left' }),
    padding: `${padYpx}px ${padXpx}px`,
    overflow: 'hidden',
    maskImage,
    WebkitMaskImage: maskImage,
    background:
      style.background === 'solid'
        ? `color-mix(in srgb, ${style.backgroundColor} ${Math.round(style.backgroundOpacity * 100)}%, transparent)`
        : 'transparent',
  };

  const inner = (
    <div ref={containerRef} style={containerStyle}>
      <style>{`
        @keyframes snOvFade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes snOvSlide { from { opacity: 0; transform: translateX(-26px) } to { opacity: 1; transform: none } }
        @keyframes snOvPop { 0% { opacity: 0; transform: scale(0.8) } 60% { transform: scale(1.03) } 100% { opacity: 1; transform: scale(1) } }
        .sn-ov-row { word-break: break-word; overflow-wrap: anywhere; }
        .sn-ov-fade { animation: snOvFade 300ms ease both; }
        .sn-ov-slide { animation: snOvSlide 300ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        .sn-ov-pop { animation: snOvPop 320ms cubic-bezier(0.34, 1.56, 0.64, 1) both; transform-origin: left center; }
        /* StreamNook event style — per-category washes baked from globals.css's
           event gradients (highlight colors resolved to hex) so they render
           self-contained on the hosted overlay, no theme vars needed. Each category
           gets its own signature so a watch streak (fire), cheer (bits), sub
           (iridescent), etc. never look alike. */
        .sn-ev-subscription { background-color: #0c0c0d; background-size: 100% 100%;
          background-image: linear-gradient(90deg,
            color-mix(in srgb, #ff6b9d 15%, transparent) 0%,
            color-mix(in srgb, #c06bff 12%, transparent) 20%,
            color-mix(in srgb, #6b9dff 10%, transparent) 40%,
            color-mix(in srgb, #6bffc0 8%, transparent) 60%,
            color-mix(in srgb, #ffc06b 10%, transparent) 80%,
            color-mix(in srgb, #ff6b9d 15%, transparent) 100%); }
        .sn-ev-watchstreak { background-color: #0c0c0d; background-size: 100% 100%;
          background-image: linear-gradient(90deg,
            color-mix(in srgb, #ff9d6b 18%, transparent) 0%,
            color-mix(in srgb, #ffc06b 15%, transparent) 20%,
            color-mix(in srgb, #ff6b6b 12%, transparent) 40%,
            color-mix(in srgb, #ff9d6b 12%, transparent) 60%,
            color-mix(in srgb, #ffc06b 15%, transparent) 80%,
            color-mix(in srgb, #ff9d6b 18%, transparent) 100%); }
        .sn-ev-bits { background-color: #0c0c0d; background-size: 100% 100%;
          background-image: linear-gradient(90deg,
            color-mix(in srgb, #c06bff 18%, transparent) 0%,
            color-mix(in srgb, #6b9dff 15%, transparent) 20%,
            color-mix(in srgb, #6bffc0 12%, transparent) 40%,
            color-mix(in srgb, #6b9dff 12%, transparent) 60%,
            color-mix(in srgb, #c06bff 15%, transparent) 80%,
            color-mix(in srgb, #c06bff 18%, transparent) 100%); }
        .sn-ev-donation { background-color: #0c0c0d; background-size: 100% 100%;
          background-image: linear-gradient(90deg,
            color-mix(in srgb, #6bff9d 15%, transparent) 0%,
            color-mix(in srgb, #6bff9d 12%, transparent) 25%,
            color-mix(in srgb, #6bff9d 10%, transparent) 50%,
            color-mix(in srgb, #6bff9d 12%, transparent) 75%,
            color-mix(in srgb, #6bff9d 15%, transparent) 100%); }
        .sn-ev-raid { background-color: #0c0c0d; background-size: 100% 100%;
          background-image: linear-gradient(90deg,
            color-mix(in srgb, #6b9dff 16%, transparent) 0%,
            color-mix(in srgb, #c06bff 13%, transparent) 33%,
            color-mix(in srgb, #6b9dff 11%, transparent) 66%,
            color-mix(in srgb, #6b9dff 16%, transparent) 100%); }
        .sn-ev-follow { background-color: #0c0c0d; background-size: 100% 100%;
          background-image: linear-gradient(90deg,
            color-mix(in srgb, #ff6b9d 16%, transparent) 0%,
            color-mix(in srgb, #ff6b6b 13%, transparent) 33%,
            color-mix(in srgb, #ff6b9d 11%, transparent) 66%,
            color-mix(in srgb, #ff6b9d 16%, transparent) 100%); }
        .sn-ev-announcement { background-color: #0c0c0d; background-size: 100% 100%;
          background-image: linear-gradient(90deg,
            color-mix(in srgb, #ffc06b 16%, transparent) 0%,
            color-mix(in srgb, #ff9d6b 13%, transparent) 33%,
            color-mix(in srgb, #ffc06b 11%, transparent) 66%,
            color-mix(in srgb, #ffc06b 16%, transparent) 100%); }
        /* Exact match to globals.css so the shared AtmosphereChatWash animates
           identically on the hosted overlay (the component overrides the 16s/20s
           base to 9s/12s inline, same as in-app chat). */
        @keyframes sn-aurora-1 { 0% { transform: translate3d(0, 0, 0); opacity: 0.78 } 50% { transform: translate3d(-160px, -12px, 0); opacity: 1 } 100% { transform: translate3d(-320px, 0, 0); opacity: 0.78 } }
        @keyframes sn-aurora-2 { 0% { transform: translate3d(0, 0, 0); opacity: 0.6 } 50% { transform: translate3d(120px, 12px, 0); opacity: 0.92 } 100% { transform: translate3d(240px, 0, 0); opacity: 0.6 } }
        .sn-aurora-1 { animation: sn-aurora-1 16s linear infinite; will-change: transform, opacity; }
        .sn-aurora-2 { animation: sn-aurora-2 20s linear infinite; will-change: transform, opacity; }
      `}</style>
      {rendered.map((m) => (
        <OverlayRow key={m.id} message={m} style={style} />
      ))}
    </div>
  );

  // When supersampling, the container is rendered at ss× and transform-scaled back
  // down; a clipping box at the true canvas size keeps it composited correctly.
  return ss === 1 ? inner : (
    <div style={{ width: '100%', height: '100%', overflow: 'hidden' }}>{inner}</div>
  );
};

export default OverlayChat;
