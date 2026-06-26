// BlendedChatPane — one continuous, time-ordered feed merging EVERY open source
// in a MultiChat window (e.g. a streamer's Twitch chat + their Kick chat, or two
// Twitch channels). Each message keeps its own rendering (baked emote segments +
// native badges) and is prefixed with its source provider's logo (ChatMessageList
// `showSource`). Emotes are resolved at parse time in Rust, so a mixed-source
// array needs no per-message emote context — we pass `emotes={null}`.
//
// The composer sends to any subset of the blended sources, chosen from a themed
// checkbox picker grouped by provider: tick a whole provider or individual
// channels, then one send fans out to every ticked channel.

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import ChatMessageList from '../ChatMessageList';
import { ProviderLogo } from '../ProviderLogo';
import { useChatConnectionStore } from '../../stores/chatConnectionStore';
import { useChatUserStore } from '../../stores/chatUserStore';
import { parseKey } from '../../utils/providerKey';
import { openProfilePopup } from '../../utils/openProfilePopup';
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from '../../types/providers';
import { parseMessage, type BackendChatMessage } from '../../services/twitchChat';
import { initializeBadgeCache } from '../../services/twitchBadges';
import type { ModerationContext } from '../../hooks/useTwitchChat';
import type { HypeTrainData } from '../../types';
import { useBlendedHypeTrains } from './useBlendedHypeTrains';
import { Logger } from '../../utils/logger';
import { Tooltip } from '../ui/Tooltip';

interface BlendedChannel {
  channel: string;
  provider?: ProviderId;
  channelName: string;
}

const noop = () => {};

// Minimum spacing between pause/resume transitions (mirrors ChatWidget's
// PAUSE_SETTLE_MS): real gestures are hundreds of ms apart, so this is invisible,
// but it caps the machine-speed scroll/auto-scroll oscillation a fast chat produces.
// `force` transitions (Resume button, reply-jump) bypass it.
const PAUSE_SETTLE_MS = 120;

const provOf = (c: BlendedChannel): ProviderId => c.provider ?? 'twitch';
// Stable per-source key used by the picker, the merge match, and the send router.
const sourceKey = (c: BlendedChannel) => `${provOf(c)}::${c.channel.toLowerCase()}`;

// Common sortable epoch-ms from either a structured message (`timestamp`, which
// is ISO-UTC for Kick and an epoch for Twitch) or a raw IRC string (`tmi-sent-ts`).
function tsOf(m: string | BackendChatMessage): number {
  const t = typeof m === 'string' ? m.match(/tmi-sent-ts=(\d+)/)?.[1] ?? '' : m.timestamp ?? '';
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const d = Date.parse(t);
  return Number.isNaN(d) ? 0 : d;
}

// Send `text` to one source. With `reply`, route a reply through that provider's
// own mechanism: Twitch and Kick thread natively off the parent message id; YouTube
// has no threaded reply, so we @mention the recipient instead.
async function sendTo(
  c: BlendedChannel,
  text: string,
  reply?: { parentId: string; parentUser: string },
): Promise<void> {
  const prov = provOf(c);
  if (prov === 'twitch') {
    await invoke('send_chat_message', {
      message: text,
      replyParentMsgId: reply?.parentId ?? null,
      targetChannel: c.channel.toLowerCase(),
      broadcasterId: null,
      senderId: null,
      senderAccountId: null,
    });
  } else if (prov === 'youtube' && reply) {
    await invoke('provider_send_message', {
      provider: prov,
      channel: c.channel.toLowerCase(),
      text: `@${reply.parentUser} ${text}`,
      replyTo: null,
    });
  } else {
    await invoke('provider_send_message', {
      provider: prov,
      channel: c.channel.toLowerCase(),
      text,
      replyTo: reply?.parentId ?? null,
    });
  }
}

// Small themed checkbox (checked / indeterminate / empty).
function Check({ checked, indeterminate }: { checked: boolean; indeterminate?: boolean }) {
  const on = checked || indeterminate;
  return (
    <span
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors"
      style={{
        borderColor: on ? 'var(--color-accent)' : 'rgba(255,255,255,0.25)',
        backgroundColor: on ? 'var(--color-accent)' : 'transparent',
      }}
    >
      {checked ? (
        <svg className="h-3 w-3 text-black" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M16.7 5.3a1 1 0 010 1.42l-7.5 7.5a1 1 0 01-1.42 0L3.3 9.74a1 1 0 011.42-1.42l3.07 3.07 6.79-6.79a1 1 0 011.42 0z"
            clipRule="evenodd"
          />
        </svg>
      ) : indeterminate ? (
        <span className="h-[2px] w-2 rounded bg-black" />
      ) : null}
    </span>
  );
}

// Compact Hype Train banner for the blended feed (one per active Twitch train).
// Clean, no glow: a subtle accent/golden tint, the level, the channel, a progress
// bar. The full celebration UI stays in the single-pane player; this is the
// at-a-glance "a train is running" cue Brandon wanted in blended.
function HypeBanner({ train }: { train: HypeTrainData }) {
  const pct = train.goal > 0 ? Math.min(100, Math.round((train.progress / train.goal) * 100)) : 0;
  const golden = train.is_golden_kappa;
  return (
    <div
      className={`flex flex-shrink-0 items-center gap-2 border-b border-borderSubtle px-3 py-1.5 ${
        golden ? 'bg-yellow-500/10' : 'bg-accent/10'
      }`}
    >
      <svg
        width={13}
        height={13}
        viewBox="0 0 24 24"
        fill="currentColor"
        className={`flex-shrink-0 ${golden ? 'text-yellow-400' : 'text-accent'}`}
        aria-hidden
      >
        <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
      </svg>
      <span className={`text-xs font-semibold ${golden ? 'text-yellow-300' : 'text-textPrimary'}`}>
        {golden ? 'Golden Kappa Train' : 'Hype Train'} · Lvl {train.level}
      </span>
      <span className="min-w-0 truncate text-[11px] text-textMuted">{train.broadcaster_user_name}</span>
      <div className="ml-auto h-1.5 w-20 flex-shrink-0 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full ${golden ? 'bg-yellow-400' : 'bg-accent'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="flex-shrink-0 text-[10px] tabular-nums text-textMuted">{pct}%</span>
    </div>
  );
}

export function BlendedChatPane({ channels }: { channels: BlendedChannel[] }) {
  // Re-render on any chat update across all channels.
  const revision = useChatConnectionStore((s) => s.revision);
  // Twitch Hype Trains across the blended Twitch sources (blended mounts no per-pane
  // poller, so this drives both the banner here and the activity-feed rows).
  const hypeTrains = useBlendedHypeTrains(channels);

  // First-seen arrival order. We order the merged feed by when each message FIRST
  // appeared here, not by its send time — YouTube is polled, so its messages land a
  // few seconds after they were sent, and a send-time sort would slot them mid-feed
  // and thrash the scroll. A message's slot is frozen the first time we see it, so
  // nothing already on screen ever moves; new messages only ever append at the bottom.
  const seqRef = useRef<{ map: Map<string, number>; next: number }>({ map: new Map(), next: 0 });

  const { messages, deletedMessageIds, clearedUserContexts, idToChannel } = useMemo(() => {
    const store = useChatConnectionStore.getState();
    // Match by the STORE MAP KEY via parseKey (the source of truth): a Kick slice
    // is keyed `kick:slug` and its own `.channel` field holds that composite key,
    // not the bare slug — so matching on slice fields misses it. parseKey
    // normalizes both bare Twitch keys (`xqc`) and composite (`kick:slug`).
    const open = new Set(channels.map(sourceKey));
    const byKey = new Map(channels.map((c) => [sourceKey(c), c] as const));
    const keyOf = (m: string | BackendChatMessage) =>
      typeof m === 'string' ? m.match(/id=([^;]+)/)?.[1] ?? m : m.id;
    const all: (string | BackendChatMessage)[] = [];
    const deleted = new Set<string>();
    const cleared = new Map<string, { context: ModerationContext; affectedMessageIds: Set<string> }>();
    // messageId -> the source it came from, so a right-click reply routes to the
    // right channel/account (a raw Twitch IRC line doesn't carry its own slug).
    const idToChannel = new Map<string, BlendedChannel>();
    for (const [key, slice] of store.channels.entries()) {
      const pk = parseKey(key);
      const skey = `${pk.provider}::${pk.channel.toLowerCase()}`;
      if (!open.has(skey)) continue;
      const ch = byKey.get(skey);
      for (const m of slice.messages) {
        all.push(m);
        if (ch) {
          const id = keyOf(m);
          if (id) idToChannel.set(id, ch);
          // The username right-click reports the message's `id` TAG; for structured
          // (non-Twitch) messages that can differ from the top-level id, so alias both.
          const tagId = typeof m !== 'string' ? m.tags?.['id'] : undefined;
          if (tagId && tagId !== id) idToChannel.set(tagId, ch);
        }
      }
      slice.deletedMessageIds?.forEach((id: string) => deleted.add(id));
      slice.clearedUserContexts?.forEach(
        (v: { context: ModerationContext; affectedMessageIds: Set<string> }, k: string) => cleared.set(k, v),
      );
    }
    const seq = seqRef.current;
    const keyed = all.map((m) => ({ m, k: keyOf(m) }));
    // Assign a frozen sequence to any message we haven't seen yet. Seed the unseen
    // batch in send-time order first, so the initial backfill (and any multi-message
    // tick) stays chronological; from then on each message keeps that slot.
    const unseen = keyed.filter((x) => !seq.map.has(x.k));
    if (unseen.length) {
      unseen.sort((a, b) => tsOf(a.m) - tsOf(b.m));
      for (const x of unseen) seq.map.set(x.k, seq.next++);
    }
    // Bound the map to messages still present (slices are capped, so old ids drop).
    if (seq.map.size > keyed.length * 2 + 64) {
      const present = new Set(keyed.map((x) => x.k));
      for (const k of seq.map.keys()) if (!present.has(k)) seq.map.delete(k);
    }
    keyed.sort((a, b) => (seq.map.get(a.k) ?? 0) - (seq.map.get(b.k) ?? 0));
    return {
      messages: keyed.map((x) => x.m),
      deletedMessageIds: deleted,
      clearedUserContexts: cleared,
      idToChannel,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, revision]);

  const getMessageId = useCallback(
    (m: string | BackendChatMessage) => (typeof m === 'string' ? m.match(/id=([^;]+)/)?.[1] ?? null : m.id),
    [],
  );

  // The blended pane renders ChatMessage directly, bypassing ChatWidget — which is what
  // normally loads chatter cosmetics (7TV paint/badge + third-party badges) into
  // chatUserStore AND populates the Twitch badge metadata (global mod/staff/turbo +
  // per-channel subscriber/bits) that parseBadges reads. In its own popout window those
  // module caches start empty, so without doing it here the merged feed shows only
  // baked-URL badges (Kick/YouTube) and no Twitch native or 7TV badges/paints.
  //
  // Global Twitch badges load once up front (cheap, disk-cached). Channel badges +
  // chatter cosmetics resolve as each NEW message/chatter is first seen; addUser dedupes
  // and fetches once per user, with the same provider namespacing ChatWidget uses.
  useEffect(() => {
    void initializeBadgeCache();
  }, []);
  const cosmeticsSeenRef = useRef<Set<string>>(new Set());
  const badgeChannelsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const addUser = useChatUserStore.getState().addUser;
    const seen = cosmeticsSeenRef.current;
    for (const m of messages) {
      const mid = getMessageId(m);
      if (!mid || seen.has(mid)) continue;
      seen.add(mid);
      let userId: string | undefined;
      let username: string | undefined;
      let displayName: string | undefined;
      let color: string | undefined;
      let provider: ProviderId = 'twitch';
      let channelId: string | undefined;
      let channelName = '';
      if (typeof m === 'string') {
        const parsed = parseMessage(m);
        userId = parsed.tags.get('user-id');
        username = parsed.username;
        displayName = parsed.tags.get('display-name') || parsed.username;
        color = parsed.color;
        channelId = parsed.tags.get('source-room-id') || parsed.tags.get('room-id');
      } else {
        userId = m.tags?.['user-id'] || m.user_id;
        username = m.username;
        displayName = m.display_name || m.username;
        color = m.color;
        provider = (m.provider as ProviderId) || 'twitch';
        channelId = m.tags?.['source-room-id'] || m.tags?.['room-id'];
        channelName = m.channel ? parseKey(m.channel).channel : '';
      }
      // Load this Twitch channel's subscriber/bits badge set once (global set is
      // already warming from the mount effect above).
      if (provider === 'twitch' && channelId && !badgeChannelsRef.current.has(channelId)) {
        badgeChannelsRef.current.add(channelId);
        void initializeBadgeCache(channelId);
      }
      if (!userId || !username) continue;
      addUser(
        {
          userId: provider === 'twitch' ? userId : `${provider}:${userId}`,
          username,
          displayName: displayName || username,
          color: color || '#9147FF',
        },
        channelId ? { channelId, channelName } : undefined,
      );
    }
    // Bound the seen set to messages still present (slices are capped).
    if (seen.size > messages.length * 2 + 128) {
      const present = new Set(
        messages.map((m) => getMessageId(m)).filter((id): id is string => !!id),
      );
      for (const id of seen) if (!present.has(id)) seen.delete(id);
    }
  }, [messages, getMessageId]);

  const paneRef = useRef<HTMLDivElement>(null);

  // Pause, mirroring ChatWidget's stable implementation: one rate-limited mutator +
  // grace periods stop the rapid pause/resume flapping a fast chat would otherwise
  // produce. `pausedRef` mirrors the state for synchronous reads in the scroll
  // handlers; `pausedAtSeqRef` snapshots the arrival counter on the pause edge for the
  // exact "N new" count.
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const lastPauseToggleRef = useRef(0);
  const lastResumeTimeRef = useRef(0);
  const lastNavTimeRef = useRef(0);
  const mountTimeRef = useRef(0);
  const pausedAtSeqRef = useRef(0);
  useEffect(() => {
    mountTimeRef.current = Date.now();
  }, []);
  const scrollPaneToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const c = paneRef.current?.querySelector('.overflow-y-auto') as HTMLElement | null;
      if (c) c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
    });
  }, []);
  const setChatPaused = useCallback(
    (next: boolean, opts?: { force?: boolean; scrollToBottom?: boolean }) => {
      if (pausedRef.current === next) return;
      const now = Date.now();
      if (!opts?.force && now - lastPauseToggleRef.current < PAUSE_SETTLE_MS) return;
      lastPauseToggleRef.current = now;
      pausedRef.current = next;
      if (next) pausedAtSeqRef.current = seqRef.current.next;
      setPaused(next);
      if (!next && opts?.scrollToBottom) {
        lastResumeTimeRef.current = now;
        scrollPaneToBottom();
      }
    },
    [scrollPaneToBottom],
  );

  // Reply jump. Normal panes get this from ChatWidget; the blended pane wires its
  // own, scoped to its own container so it can't grab a same-id row in another
  // surface. Clicking a reply scrolls the merged feed to the quoted message + flashes
  // it (the same `data-message-id` + `.overflow-y-auto` scroll the main pane uses).
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(
    () => () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    },
    [],
  );
  const handleReplyClick = useCallback(
    (parentMsgId: string) => {
      if (!messages.some((m) => getMessageId(m) === parentMsgId)) return;
      // Hold the feed (force past the settle window) + mark a navigation so the scroll
      // handlers don't fight the jump; the resume pill takes you back to live.
      lastNavTimeRef.current = Date.now();
      setChatPaused(true, { force: true });
      setHighlightedMessageId(parentMsgId);
      requestAnimationFrame(() => {
        const el = paneRef.current?.querySelector(
          `[data-message-id="${CSS.escape(parentMsgId)}"]`,
        ) as HTMLElement | null;
        const container = el?.closest('.overflow-y-auto') as HTMLElement | null;
        if (el && container) {
          const target = el.offsetTop - container.clientHeight / 2 + el.offsetHeight / 2;
          container.scrollTo({
            top: Math.max(0, Math.min(target, container.scrollHeight - container.clientHeight)),
            behavior: 'smooth',
          });
        }
      });
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setHighlightedMessageId(null), 2000);
    },
    [messages, getMessageId, setChatPaused],
  );

  // ----- composer -----------------------------------------------------------
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [kickConnected, setKickConnected] = useState(false);
  const [youtubeConnected, setYoutubeConnected] = useState(false);
  // Right-click-a-name reply target. The send routes to THIS source + account,
  // overriding the multi-select for that one message.
  const [replyingTo, setReplyingTo] = useState<{ messageId: string; username: string; channel: BlendedChannel } | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  // Track DESELECTED sources (by sourceKey); everything else is on. New channels
  // are then on by default and closed channels drop out with no reconciliation.
  const [deselected, setDeselected] = useState<Set<string>>(() => new Set());

  const isOn = useCallback((c: BlendedChannel) => !deselected.has(sourceKey(c)), [deselected]);
  const selected = useMemo(() => channels.filter(isOn), [channels, isOn]);

  // Whether we can actually post to a source: Twitch always; Kick/YouTube once
  // their account is connected; TikTok (and other read-only providers) never.
  const canSendTo = useCallback(
    (c: BlendedChannel) => {
      const p = provOf(c);
      if (p === 'twitch') return true;
      if (p === 'kick') return kickConnected;
      if (p === 'youtube') return youtubeConnected;
      return false;
    },
    [kickConnected, youtubeConnected],
  );
  // The per-source picker badge: 'login' (connect to send), 'readonly' (no send
  // path at all), or null (good to go).
  const sendStatus = useCallback(
    (c: BlendedChannel): 'login' | 'readonly' | null => {
      const p = provOf(c);
      if (p === 'twitch') return null;
      if (p === 'kick') return kickConnected ? null : 'login';
      if (p === 'youtube') return youtubeConnected ? null : 'login';
      return 'readonly';
    },
    [kickConnected, youtubeConnected],
  );
  const sendableSelected = useMemo(() => selected.filter(canSendTo), [selected, canSendTo]);

  // Providers present, in canonical order, each with its channels.
  const groups = useMemo(() => {
    return PROVIDER_IDS.map((p) => ({ provider: p, chans: channels.filter((c) => provOf(c) === p) })).filter(
      (g) => g.chans.length > 0,
    );
  }, [channels]);

  const toggleChannel = useCallback((c: BlendedChannel) => {
    const k = sourceKey(c);
    setDeselected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  const toggleProvider = useCallback(
    (p: ProviderId) => {
      const chans = channels.filter((c) => provOf(c) === p);
      const allOn = chans.every(isOn);
      setDeselected((prev) => {
        const next = new Set(prev);
        // All on -> turn the whole provider off; otherwise turn it fully on.
        for (const c of chans) {
          if (allOn) next.add(sourceKey(c));
          else next.delete(sourceKey(c));
        }
        return next;
      });
    },
    [channels, isOn],
  );

  const hasKick = channels.some((c) => provOf(c) === 'kick');

  useEffect(() => {
    if (!hasKick) return;
    let active = true;
    const check = () =>
      invoke<boolean>('kick_is_connected')
        .then((c) => active && setKickConnected(c))
        .catch(() => {});
    check();
    const t = setInterval(check, 5000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [hasKick]);

  const hasYoutube = channels.some((c) => provOf(c) === 'youtube');
  useEffect(() => {
    if (!hasYoutube) return;
    let active = true;
    const check = () =>
      invoke<boolean>('youtube_is_connected')
        .then((c) => active && setYoutubeConnected(c))
        .catch(() => {});
    check();
    const t = setInterval(check, 5000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [hasYoutube]);

  // Route logins to the Account Connections settings instead of pushing a connect
  // button into the chat space (which shifted the feed). MultiChatWindow listens for
  // this and opens settings on the Connections tab.
  const openConnections = useCallback(() => {
    setPickerOpen(false);
    window.dispatchEvent(new Event('open-multichat-connections'));
  }, []);

  // Right-click a name -> reply to that person, routed to the source they posted in.
  const handleUsernameRightClick = useCallback(
    (messageId: string, username: string) => {
      const channel = idToChannel.get(messageId);
      if (!channel) return;
      setReplyingTo({ messageId, username, channel });
      requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    },
    [idToChannel],
  );

  // Click a badge on a message -> open its detail in the badges overlay, which lives
  // in the main app (opening main if Go Live closed it).
  const handleBadgeClick = useCallback(
    (badgeKey: string, badgeInfo: { url?: string; image_url_4x?: string }) => {
      const [setId] = badgeKey.split('/');
      void import('../../utils/openBadgesInMain').then(({ openBadgeDetailInMain }) =>
        openBadgeDetailInMain(badgeInfo, setId),
      );
    },
    [],
  );

  // Left-click a name -> open that user's profile card, scoped to the channel they
  // posted in (found via the row's data-message-id) so the card's data AND its
  // Moderator Actions target the right channel — where this mod actually has rights.
  // Twitch-only: the profile card is a Twitch surface. Without this, clicking a name
  // in the blended feed did nothing.
  const handleUsernameClick = useCallback(
    (
      userId: string,
      username: string,
      displayName: string,
      color: string,
      badges: Array<{ key: string; info: { url?: string; image_url_4x?: string } }>,
      event: ReactMouseEvent,
    ) => {
      const row = (event.target as HTMLElement | null)?.closest?.('[data-message-id]');
      const mid = row?.getAttribute('data-message-id') ?? undefined;
      const channel = mid ? idToChannel.get(mid) : undefined;
      if (channel && provOf(channel) !== 'twitch') return; // no profile/mod surface for other providers here
      const login = channel?.channel;
      // Am I a mod/broadcaster in that channel? My USERSTATE badges live on its slice.
      const badgesStr =
        (login && useChatConnectionStore.getState().channels.get(login.toLowerCase())?.userBadges) || '';
      const isMod = badgesStr.includes('moderator') || badgesStr.includes('broadcaster');
      void openProfilePopup({
        userId,
        username,
        displayName,
        color,
        badges,
        channelName: login,
        isModerator: isMod,
        clientX: event.clientX,
        clientY: event.clientY,
      });
    },
    [idToChannel],
  );

  // Drop a pending reply if its channel was removed from the blend.
  useEffect(() => {
    if (replyingTo && !channels.some((c) => sourceKey(c) === sourceKey(replyingTo.channel))) {
      setReplyingTo(null);
    }
  }, [channels, replyingTo]);

  const handleSend = useCallback(async () => {
    const body = text.trim();
    if (!body || sending) return;
    // A reply overrides the multi-select: it goes to just the one source the person
    // posted in, through that provider's reply path.
    if (replyingTo) {
      const { channel, messageId, username } = replyingTo;
      // Not logged in to that platform -> can't reply; the connect chip prompts.
      if (!canSendTo(channel)) return;
      setSending(true);
      setText('');
      setReplyingTo(null);
      await sendTo(channel, body, { parentId: messageId, parentUser: username }).catch((e) =>
        Logger.warn(`[Blended] reply to ${sourceKey(channel)} failed:`, e),
      );
      setSending(false);
      return;
    }
    // Only the chats we can actually post to (Twitch, or a connected Kick/YouTube).
    // A selected-but-not-logged-in (or read-only) source is skipped, never silently
    // "sent" — the picker badges + connect chips tell the user why.
    const targets = selected.filter(canSendTo);
    if (targets.length === 0) return;
    setSending(true);
    setText('');
    // Send to each target independently so one failure doesn't block the rest.
    await Promise.all(
      targets.map((c) => sendTo(c, body).catch((e) => Logger.warn(`[Blended] send to ${sourceKey(c)} failed:`, e))),
    );
    setSending(false);
  }, [text, sending, selected, replyingTo, canSendTo]);

  // Scroll-to-pause, mirroring ChatWidget: `onPauseIntent` is the primary pause (fires
  // on a real scroll-up gesture, before any threshold); `onScroll` adds distance-based
  // pause/resume with hysteresis (>150px to pause, <30px to auto-resume) so it can't
  // flap near a single threshold. Grace periods skip the initial layout settle,
  // post-resume inertia, and the reply-jump animation. The resume pill forces past the
  // settle window and glides to the live bottom.
  const inGrace = useCallback(() => {
    const now = Date.now();
    return (
      now - mountTimeRef.current < 2000 ||
      now - lastResumeTimeRef.current < 1000 ||
      now - lastNavTimeRef.current < 1000
    );
  }, []);
  const onPauseIntent = useCallback(() => {
    if (!inGrace()) setChatPaused(true);
  }, [inGrace, setChatPaused]);
  const onScroll = useCallback(
    (distanceToBottom: number, isUserScroll: boolean) => {
      if (inGrace()) return;
      if (isUserScroll && distanceToBottom > 150 && !pausedRef.current) {
        setChatPaused(true);
      } else if (pausedRef.current && distanceToBottom < 30) {
        setChatPaused(false, { scrollToBottom: true });
      }
    },
    [inGrace, setChatPaused],
  );
  const handleResume = useCallback(() => {
    setChatPaused(false, { scrollToBottom: true, force: true });
  }, [setChatPaused]);
  const newSincePause = paused ? Math.max(0, seqRef.current.next - pausedAtSeqRef.current) : 0;

  // Summary label for the picker button.
  const summary =
    selected.length === 0
      ? 'No chats selected'
      : selected.length === channels.length
      ? `All ${channels.length} chat${channels.length > 1 ? 's' : ''}`
      : selected.length === 1
      ? `${selected[0].channelName} · ${PROVIDERS[provOf(selected[0])]?.label ?? provOf(selected[0])}`
      : `${selected.length} of ${channels.length} chats`;

  return (
    <div ref={paneRef} className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-secondary">
      {[...hypeTrains.values()].map((t) => (
        <HypeBanner key={t.broadcaster_user_login} train={t} />
      ))}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <ChatMessageList
          messages={messages}
          isPaused={paused}
          onScroll={onScroll}
          onPauseIntent={onPauseIntent}
          onUsernameClick={handleUsernameClick}
          onReplyClick={handleReplyClick}
          onEmoteRightClick={noop}
          onUsernameRightClick={handleUsernameRightClick}
          onBadgeClick={handleBadgeClick}
          highlightedMessageId={highlightedMessageId}
          deletedMessageIds={deletedMessageIds}
          clearedUserContexts={clearedUserContexts}
          emotes={null}
          getMessageId={getMessageId}
          showSource
        />
        {/* Identical to the core app's paused indicator (ChatWidget) so the resume
            affordance reads the same everywhere. */}
        {paused && (
          <div className="pointer-events-auto absolute bottom-3 left-1/2 z-20 -translate-x-1/2 transform">
            <button
              type="button"
              onClick={handleResume}
              className="flex items-center gap-2 rounded-full bg-black/95 px-4 py-2 text-sm font-medium text-white shadow-lg glass-button"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
              <span>Chat Paused{newSincePause > 0 ? ` (${newSincePause} new)` : ''}</span>
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-white/5 p-2">
        {replyingTo && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5">
            <svg className="h-3.5 w-3.5 shrink-0 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
            <ProviderLogo provider={provOf(replyingTo.channel)} size={13} />
            <span className="min-w-0 flex-1 truncate text-xs text-textSecondary">
              Replying to <span className="font-semibold text-textPrimary">{replyingTo.username}</span>
              <span> on {replyingTo.channel.channelName}</span>
            </span>
            <Tooltip content="Cancel reply">
              <button
                type="button"
                onClick={() => setReplyingTo(null)}
                className="shrink-0 rounded p-0.5 text-textSecondary transition-colors hover:text-textPrimary"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </Tooltip>
          </div>
        )}
        <div className="relative flex items-center gap-2">
          {/* Target picker: themed, grouped-by-provider, multi-select. */}
          <div className="relative shrink-0">
            <Tooltip content="Choose which chats to send to">
              <button
                type="button"
                onClick={() => setPickerOpen((o) => !o)}
                className="glass-input flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs text-textPrimary"
                style={{ maxWidth: '12rem' }}
              >
                <span className="truncate">{summary}</span>
                <svg
                  className={`h-3 w-3 shrink-0 text-textSecondary transition-transform ${pickerOpen ? 'rotate-180' : ''}`}
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M5.3 7.3a1 1 0 011.4 0L10 10.6l3.3-3.3a1 1 0 111.4 1.4l-4 4a1 1 0 01-1.4 0l-4-4a1 1 0 010-1.4z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </Tooltip>

            {pickerOpen && (
              <>
                {/* click-away backdrop */}
                <div className="fixed inset-0 z-40" onClick={() => setPickerOpen(false)} />
                <div
                  className="glass-panel absolute bottom-full z-50 mb-1 max-h-64 w-56 overflow-y-auto rounded-lg border border-borderLight py-1 shadow-2xl scrollbar-thin"
                  // Opaque themed surface: a live backdrop-blur flickers over chat.
                  style={{ backgroundColor: 'var(--color-background-tertiary)' }}
                >
                  {groups.map((g) => {
                    const allOn = g.chans.every(isOn);
                    const someOn = g.chans.some(isOn);
                    return (
                      <div key={g.provider}>
                        <button
                          type="button"
                          onClick={() => toggleProvider(g.provider)}
                          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs font-semibold text-textPrimary transition-colors hover:bg-white/5"
                        >
                          <Check checked={allOn} indeterminate={!allOn && someOn} />
                          <ProviderLogo provider={g.provider} size={14} />
                          <span>{PROVIDERS[g.provider]?.label ?? g.provider}</span>
                        </button>
                        {g.chans.map((c) => {
                          const status = sendStatus(c);
                          return (
                            <div
                              key={sourceKey(c)}
                              className="flex w-full items-center gap-2 py-1.5 pl-8 pr-2.5 text-xs transition-colors hover:bg-white/5"
                            >
                              <button
                                type="button"
                                onClick={() => toggleChannel(c)}
                                className="flex min-w-0 flex-1 items-center gap-2 text-left text-textSecondary transition-colors hover:text-textPrimary"
                              >
                                <Check checked={isOn(c)} />
                                <span className="min-w-0 flex-1 truncate">{c.channelName}</span>
                              </button>
                              {status === 'login' && (
                                <Tooltip content="Sign in from Account Connections">
                                  <button
                                    type="button"
                                    onClick={openConnections}
                                    className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-400 transition-colors hover:bg-amber-500/30"
                                  >
                                    Log in
                                  </button>
                                </Tooltip>
                              )}
                              {status === 'readonly' && (
                                <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-textMuted">
                                  Read-only
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              } else if (e.key === 'Escape' && replyingTo) {
                e.preventDefault();
                setReplyingTo(null);
              }
            }}
            placeholder={
              replyingTo
                ? canSendTo(replyingTo.channel)
                  ? `Reply to ${replyingTo.username}…`
                  : `Log in to reply on ${PROVIDERS[provOf(replyingTo.channel)]?.label ?? provOf(replyingTo.channel)}…`
                : sendableSelected.length === 0
                ? 'Log in to send to these chats…'
                : sendableSelected.length < selected.length
                ? `Send to ${sendableSelected.length} connected chat${sendableSelected.length > 1 ? 's' : ''}…`
                : selected.length > 1
                ? 'Send to selected chats…'
                : 'Send a message…'
            }
            className="glass-input min-w-0 flex-1 rounded-md px-3 py-2 text-sm text-textPrimary placeholder-textSecondary focus:outline-none"
          />
          <Tooltip content="Send">
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={
                !text.trim() ||
                sending ||
                (replyingTo ? !canSendTo(replyingTo.channel) : sendableSelected.length === 0)
              }
              className="glass-button flex h-9 w-9 shrink-0 items-center justify-center self-center rounded text-white transition-all disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

export default BlendedChatPane;
