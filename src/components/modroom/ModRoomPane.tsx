import { useEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode, MouseEvent, CSSProperties, ChangeEvent } from 'react';
import { ShieldCheck, Paperclip, X, CornerUpLeft, Pencil } from 'lucide-react';
import { EmotePickerPanel, useSwappingSmiley } from '../chat/EmotePickerPanel';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import {
  connectModRoom,
  connectModRoomConsent,
  type ModRoomController,
  type ModRoomChat,
  type ModRoomMember,
  type ModRoomState,
  type ModRoomDenial,
} from '../../services/modRoomService';
import { isEncrypted, importRoomKey, encryptText, decryptText, encryptBytes, decryptBytes } from '../../services/modRoomCrypto';
import { StreamNookBadge } from '../StreamNookBadge';
import { AtmosphereBackground } from '../AtmosphereBackground';
import { MajorCologneChrome } from '../MajorCologneChrome';
import { MAJOR_COLOGNE_THEME_ID } from '../../services/cologneEvent';
import { computePaintStyle } from '../../services/seventvService';
import { getAtmosphere } from '../../services/atmospheres';
import {
  isStreamNookUser,
  getStreamNookUserNumber,
  subscribeCosmeticsVersion,
  getCosmeticsVersion,
  subscribeStreamNookRegistryVersion,
  getStreamNookRegistryVersion,
} from '../../services/supabaseService';
import { useChatUserStore, ensureAtmosphereResolved } from '../../stores/chatUserStore';
import { useAppStore } from '../../stores/AppStore';
import { parseEmojisSync, getAppleEmojiUrl } from '../../services/emojiService';
import type { EmoteSet, Emote } from '../../services/emoteService';

interface ModRoomPaneProps {
  channelId: string;
  channelLogin?: string;
  emotes?: EmoteSet | null;
  /** Reports room state up so the host (chat header) can display it. */
  onStatus?: (s: { memberCount: number; encrypted: boolean; connected: boolean }) => void;
  onUsernameClick?: (login: string, userId: string, event: MouseEvent) => void;
}

const TYPING_TTL_MS = 3000;
const TYPING_PING_MS = 1500;

interface ReplyRef {
  id: string;
  login: string;
  text: string;
}

// An emote the sender used, embedded in the message so it renders identically for
// everyone, forever — independent of the viewer's emote set or future changes.
interface EmoteRef {
  n: string; // name (the token in the text)
  id: string;
  p: string; // provider
  u: string; // url
}

// Decrypted (or plaintext) message payload.
interface Resolved {
  text: string;
  attachment?: string;
  reply?: ReplyRef;
  emotes?: EmoteRef[];
}

function roleColorClass(role: string): string {
  if (role === 'broadcaster') return 'text-[#f0c674]';
  if (role === 'moderator') return 'text-accent';
  return 'text-textSecondary';
}

// Register a sender with the shared chat user store so its cosmetics (7TV paint,
// atmosphere, StreamNook badge) resolve once and decorate the row, like live chat.
// addUser only resolves the atmosphere on first sight, so prod it explicitly for
// users already known from live chat (the fast path skips it).
function ensureUser(userId: string, login: string) {
  if (!userId) return;
  useChatUserStore.getState().addUser({ userId, username: login, displayName: login, color: '' });
  ensureAtmosphereResolved(userId);
}

// ----- emote/emoji tokenizer ------------------------------------------------

type BodySeg =
  | { kind: 'text'; text: string }
  | { kind: 'emote'; name: string; url: string }
  | { kind: 'emoji'; alt: string; url: string };

function findEmote(word: string, emotes?: EmoteSet | null): Emote | undefined {
  if (!emotes) return undefined;
  return (
    emotes['7tv']?.find((e) => e.name === word) ||
    emotes.bttv?.find((e) => e.name === word) ||
    emotes.ffz?.find((e) => e.name === word) ||
    emotes.twitch?.find((e) => e.name === word)
  );
}

// Collect the emotes a message used, resolved once at send time against the
// sender's full emote set, so they travel WITH the message (persistent +
// consistent for every viewer).
function collectEmoteRefs(text: string, emotes?: EmoteSet | null): EmoteRef[] {
  if (!emotes) return [];
  const out: EmoteRef[] = [];
  const seen = new Set<string>();
  for (const word of text.split(/\s+/)) {
    if (!word || seen.has(word)) continue;
    const e = findEmote(word, emotes);
    if (e) {
      seen.add(word);
      out.push({ n: e.name, id: e.id, p: e.provider, u: e.url });
    }
  }
  return out;
}

function tokenizeBody(body: string, emotes?: EmoteSet | null, embedded?: Map<string, EmoteRef>): BodySeg[] {
  const segs: BodySeg[] = [];
  for (const part of body.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) {
      segs.push({ kind: 'text', text: part });
      continue;
    }
    // Embedded refs win (exact image the sender used); fall back to the viewer's
    // channel set only for legacy messages that carry no embedded emotes.
    const ref = embedded?.get(part);
    if (ref) {
      segs.push({ kind: 'emote', name: ref.n, url: ref.u });
      continue;
    }
    const emote = findEmote(part, emotes);
    if (emote) {
      segs.push({ kind: 'emote', name: emote.name, url: emote.url });
      continue;
    }
    for (const es of parseEmojisSync(part)) {
      if (es.type === 'emoji' && es.emojiUrl) segs.push({ kind: 'emoji', alt: es.content, url: es.emojiUrl });
      else segs.push({ kind: 'text', text: es.content });
    }
  }
  return segs;
}

function renderSeg(seg: BodySeg, i: number): ReactNode {
  if (seg.kind === 'emote') {
    return (
      <img
        key={i}
        src={seg.url}
        alt={seg.name}
        title={seg.name}
        loading="lazy"
        className="mx-px inline-block align-middle"
        style={{ height: '1.8em', maxWidth: '9em', objectFit: 'contain' }}
      />
    );
  }
  if (seg.kind === 'emoji') {
    return (
      <img
        key={i}
        src={seg.url}
        alt={seg.alt}
        loading="lazy"
        className="mx-px inline-block align-middle"
        style={{ height: '1.3em', width: '1.3em' }}
      />
    );
  }
  return <span key={i}>{seg.text}</span>;
}

// ----- one message row, decorated like live chat ----------------------------

const ModRoomMessageRow = ({
  m,
  body,
  attachment,
  reply,
  emoteRefs,
  locked,
  canEdit,
  emotes,
  fontSize,
  roomKey,
  onUsernameClick,
  onReply,
  onEdit,
}: {
  m: ModRoomChat;
  body: string;
  attachment?: string;
  reply?: ReplyRef;
  emoteRefs?: EmoteRef[];
  locked: boolean;
  canEdit: boolean;
  emotes?: EmoteSet | null;
  fontSize: number;
  roomKey: CryptoKey | null;
  onUsernameClick?: (login: string, userId: string, event: MouseEvent) => void;
  onReply: () => void;
  onEdit: () => void;
}) => {
  useSyncExternalStore(subscribeCosmeticsVersion, getCosmeticsVersion);
  // The StreamNook registry (badge / member status) and theme catalog load async;
  // re-render when they do, the same way ChatMessage does.
  useSyncExternalStore(subscribeStreamNookRegistryVersion, getStreamNookRegistryVersion, getStreamNookRegistryVersion);
  const paint = useChatUserStore((s) => s.users.get(m.userId)?.paint);
  const storeColor = useChatUserStore((s) => s.users.get(m.userId)?.color);
  const atmosphereId = useChatUserStore((s) => s.users.get(m.userId)?.atmosphereId ?? null);
  const cologne = useChatUserStore((s) => s.users.get(m.userId)?.cologne ?? null);
  const paintShadowMode = useAppStore((s) => s.settings.cosmetics?.paint_shadows) ?? 'all';

  const isSN = isStreamNookUser(m.userId);
  const userNumber = getStreamNookUserNumber(m.userId);
  const atmosphere = getAtmosphere(atmosphereId);
  const cologneAtm = cologne ? getAtmosphere(MAJOR_COLOGNE_THEME_ID) : null;
  const embedded = useMemo(
    () => (emoteRefs && emoteRefs.length ? new Map(emoteRefs.map((r) => [r.n, r])) : undefined),
    [emoteRefs],
  );
  const segments = useMemo(() => (locked ? [] : tokenizeBody(body, emotes, embedded)), [body, locked, emotes, embedded]);
  const time = useMemo(() => new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), [m.ts]);
  const nameStyle: CSSProperties | undefined = paint
    ? computePaintStyle(paint, storeColor || undefined, paintShadowMode)
    : undefined;

  const rowStyle = {
    fontSize: `${fontSize}px`,
    fontWeight: 'var(--chat-body-weight, 300)',
    // The Cologne frame needs horizontal room + a min height so the gold border
    // is never clipped on a single line (mirrors ChatMessage).
    ...(cologne?.frame ? { paddingLeft: 18, paddingRight: 18, paddingTop: 7, paddingBottom: 7, minHeight: 36 } : {}),
  } as CSSProperties;

  // `isolate` creates a stacking context so the -z-10 atmosphere/cologne wash
  // paints behind this row's content but ABOVE the chat panel background. Without
  // it the wash sinks behind the opaque panel and never shows.
  return (
    <div className="group relative isolate px-1 py-0.5 leading-snug hover:bg-glass" style={rowStyle}>
      {cologne && cologneAtm ? (
        <MajorCologneChrome
          textureUrl={cologneAtm.chromeTexture ?? ''}
          coinUrl={cologneAtm.chromeCoin}
          frameUrl={cologneAtm.chromeFrame}
          coin={cologne.coin}
          frame={cologne.frame}
        />
      ) : atmosphere ? (
        <AtmosphereBackground atm={atmosphere} variant="chat" />
      ) : null}
      <div className="relative z-10">
        {reply && (
          <div className="mb-0.5 flex items-center gap-1 pl-1 text-[11px] text-textSecondary">
            <CornerUpLeft size={11} className="shrink-0" />
            <span className="shrink-0 font-semibold">{reply.login}</span>
            <span className="truncate opacity-80">{reply.text}</span>
          </div>
        )}
        <span>
          <span className="mr-1.5 align-middle text-[10px] tabular-nums text-textSecondary">{time}</span>
          {isSN && (
            <span className="mr-1 inline-flex align-middle">
              <StreamNookBadge userId={m.userId} userNumber={userNumber} />
            </span>
          )}
          {onUsernameClick ? (
            <button
              onClick={(e) => onUsernameClick(m.login, m.userId, e)}
              style={nameStyle}
              className={`mr-1.5 align-middle font-semibold hover:underline ${nameStyle ? '' : roleColorClass(m.role)}`}
            >
              {m.login}
            </button>
          ) : (
            <span style={nameStyle} className={`mr-1.5 align-middle font-semibold ${nameStyle ? '' : roleColorClass(m.role)}`}>
              {m.login}
            </span>
          )}
          {locked ? (
            <span className="align-middle italic text-textSecondary">decrypting...</span>
          ) : (
            <span className="align-middle text-textPrimary break-words">
              {segments.map(renderSeg)}
              {m.editedAt ? (
                <span className="ml-1 align-middle text-[10px] text-textSecondary">(edited)</span>
              ) : null}
            </span>
          )}
        </span>
        {!locked && attachment && (
          <div className="mt-1">
            <AttachmentImage url={attachment} roomKey={roomKey} />
          </div>
        )}
      </div>
      {!locked && (
        <div
          className="absolute right-1 top-0 z-20 hidden items-center gap-0.5 rounded-md group-hover:flex"
          style={{ background: 'rgba(20,20,22,0.92)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)' }}
        >
          <button
            onClick={onReply}
            aria-label="Reply"
            className="grid h-6 w-6 place-items-center rounded text-textSecondary transition-colors hover:text-accent"
          >
            <CornerUpLeft size={13} />
          </button>
          {canEdit && (
            <button
              onClick={onEdit}
              aria-label="Edit"
              className="grid h-6 w-6 place-items-center rounded text-textSecondary transition-colors hover:text-accent"
            >
              <Pencil size={13} />
            </button>
          )}
        </div>
      )}
    </div>
  );
};

// ----- the pane -------------------------------------------------------------

const ModRoomPane = ({ channelId, channelLogin, emotes, onStatus, onUsernameClick }: ModRoomPaneProps) => {
  const [state, setState] = useState<ModRoomState>('connecting');
  const [denial, setDenial] = useState<ModRoomDenial | null>(null);
  const [messages, setMessages] = useState<ModRoomChat[]>([]);
  const [members, setMembers] = useState<ModRoomMember[]>([]);
  const [typing, setTyping] = useState<Record<string, { login: string; at: number }>>({});
  const [draft, setDraft] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [showEmotes, setShowEmotes] = useState(false);

  const [key, setKey] = useState<CryptoKey | null>(null);
  const [decrypted, setDecrypted] = useState<Record<string, Resolved | null>>({});
  const [myUserId, setMyUserId] = useState('');
  const [replyingTo, setReplyingTo] = useState<ReplyRef | null>(null);
  const [editing, setEditing] = useState<{ id: string; attachment?: string; reply?: ReplyRef } | null>(null);

  const fontSize = useAppStore((s) => s.settings.chat_design?.font_size) ?? 14;
  const snRegVersion = useSyncExternalStore(
    subscribeStreamNookRegistryVersion,
    getStreamNookRegistryVersion,
    getStreamNookRegistryVersion,
  );

  const ctrlRef = useRef<ModRoomController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastTypingSent = useRef(0);
  const lastKeyB64 = useRef('');
  const [attempt, setAttempt] = useState(0);

  const smiley = useSwappingSmiley();

  const insertEmote = (name: string) => {
    setDraft((prev) => prev + (prev && !prev.endsWith(' ') ? ' ' : '') + name + ' ');
    textareaRef.current?.focus();
  };

  // Decrypt any encrypted bodies not yet resolved. Each payload is JSON
  // { x: text, a?: attachmentUrl } so the attachment URL is encrypted too.
  useEffect(() => {
    if (!key) return;
    const todo = messages.filter((m) => isEncrypted(m.body) && decrypted[m.id] === undefined);
    if (todo.length === 0) return;
    let cancelled = false;
    (async () => {
      const updates: Record<string, Resolved | null> = {};
      for (const m of todo) {
        const pt = await decryptText(key, m.body);
        if (pt === null) {
          updates[m.id] = null;
          continue;
        }
        try {
          const obj = JSON.parse(pt) as { x?: string; a?: string; r?: ReplyRef; e?: EmoteRef[] };
          updates[m.id] = { text: obj.x ?? '', attachment: obj.a, reply: obj.r, emotes: obj.e };
        } catch {
          updates[m.id] = { text: pt };
        }
      }
      if (!cancelled) setDecrypted((prev) => ({ ...prev, ...updates }));
    })();
    return () => {
      cancelled = true;
    };
  }, [messages, key, decrypted]);

  // If the key changes (e.g. a re-mint delivers a corrected key), give messages
  // that failed to decrypt under the old key another pass instead of leaving them
  // locked forever. Dropping the null entries re-arms the decrypt pass above.
  useEffect(() => {
    if (!key) return;
    setDecrypted((prev) => {
      let changed = false;
      const next: Record<string, Resolved | null> = {};
      for (const [id, v] of Object.entries(prev)) {
        if (v === null) {
          changed = true;
          continue;
        }
        next[id] = v;
      }
      return changed ? next : prev;
    });
  }, [key]);

  useEffect(() => {
    if (!channelId) return;
    setDenial(null);
    setMessages([]);
    setMembers([]);
    setTyping({});
    setKey(null);
    setDecrypted({});
    setHasLoaded(false);
    lastKeyB64.current = '';

    const ctrl = connectModRoom(channelId, {
      onState: setState,
      onIdentity: setMyUserId,
      onEdit: (id, body, editedAt) => {
        setMessages((prev) => prev.map((mm) => (mm.id === id ? { ...mm, body, editedAt } : mm)));
        setDecrypted((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      },
      onKey: (b64) => {
        if (b64 === lastKeyB64.current) return;
        lastKeyB64.current = b64;
        importRoomKey(b64)
          .then(setKey)
          .catch(() => setKey(null));
      },
      onHistory: (msgs) => {
        msgs.forEach((mm) => ensureUser(mm.userId, mm.login));
        setMessages(msgs);
        setHasLoaded(true);
      },
      onChat: (mm) => {
        ensureUser(mm.userId, mm.login);
        setMessages((prev) => [...prev, mm]);
      },
      onPresence: (mem) => {
        mem.forEach((mm) => ensureUser(mm.userId, mm.login));
        setMembers(mem);
      },
      onTyping: (mm) =>
        setTyping((prev) => ({ ...prev, [mm.userId]: { login: mm.login, at: Date.now() } })),
      onDenied: (reason) => setDenial(reason),
    });
    ctrlRef.current = ctrl;

    return () => {
      ctrl.close();
      ctrlRef.current = null;
    };
  }, [channelId, attempt]);

  useEffect(() => {
    if (Object.keys(typing).length === 0) return;
    const t = setInterval(() => {
      const now = Date.now();
      setTyping((prev) => {
        let changed = false;
        const next: typeof prev = {};
        for (const [id, v] of Object.entries(prev)) {
          if (now - v.at < TYPING_TTL_MS) next[id] = v;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [typing]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Surface room state to the host so the chat header can show it (no sub-header).
  useEffect(() => {
    onStatus?.({ memberCount: members.length, encrypted: !!key, connected: state === 'connected' });
  }, [members.length, key, state, onStatus]);

  // Once the StreamNook registry/theme catalog loads, re-resolve decorations for
  // everyone in view (their atmosphere/cologne/badge may have no-op'd before it
  // was ready). Keyed on the registry version so it only fires on a real load.
  useEffect(() => {
    messages.forEach((m) => ensureUser(m.userId, m.login));
    members.forEach((mm) => ensureUser(mm.userId, mm.login));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snRegVersion]);

  // Encrypt + send a message (text and/or an attachment URL), folding both into
  // one encrypted payload so nothing readable hits the server.
  const sendNew = useCallback(
    async (text: string, attachment?: string, reply?: ReplyRef | null) => {
      if (!text && !attachment) return;
      // Never emit plaintext from a mod room. If the key isn't ready yet, drop the
      // send rather than leaking the message to the server in the clear (the
      // composer is disabled in this state, so this is just defense in depth).
      if (!key) return;
      const refs = collectEmoteRefs(text, emotes);
      const token = await encryptText(
        key,
        JSON.stringify({ x: text, a: attachment, r: reply ?? undefined, e: refs.length ? refs : undefined }),
      );
      ctrlRef.current?.send(token);
    },
    [key, emotes],
  );

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (editing) {
      // Edit: re-encrypt the new text, preserving the original attachment + reply,
      // and re-resolve the emotes used so they stay embedded. If there's text but
      // no key yet, keep the composer as-is rather than dropping the edit silently.
      if (text && !key) return;
      if (key && text) {
        const refs = collectEmoteRefs(text, emotes);
        const token = await encryptText(
          key,
          JSON.stringify({ x: text, a: editing.attachment, r: editing.reply, e: refs.length ? refs : undefined }),
        );
        ctrlRef.current?.edit(editing.id, token);
      }
      setEditing(null);
      setDraft('');
      return;
    }
    if (!text) return;
    if (!key) return; // wait until we can encrypt; the composer is disabled too
    await sendNew(text, undefined, replyingTo);
    setReplyingTo(null);
    setDraft('');
  }, [draft, editing, key, emotes, replyingTo, sendNew]);

  const handleDraftChange = (value: string) => {
    setDraft(value);
    const now = Date.now();
    if (now - lastTypingSent.current > TYPING_PING_MS) {
      lastTypingSent.current = now;
      ctrlRef.current?.sendTyping();
    }
  };

  const handleFilePick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !ctrlRef.current) return;
    // Don't upload/send attachments before encryption is ready: the bytes would
    // be stored in the clear. The attach button is disabled in this state too.
    if (!key) return;
    setUploading(true);
    try {
      const body = await encryptBytes(key, new Uint8Array(await file.arrayBuffer()));
      const url = await ctrlRef.current.upload(body, 'application/x-sn-enc');
      await sendNew(draft.trim(), url, replyingTo);
      setReplyingTo(null);
      setDraft('');
    } catch {
      // upload failed; leave the draft so the user can retry
    } finally {
      setUploading(false);
    }
  };

  const handleConnectConsent = async () => {
    setConnecting(true);
    try {
      await connectModRoomConsent();
      setDenial(null);
      setAttempt((a) => a + 1);
    } catch {
      // cancelled / failed; leave the CTA
    } finally {
      setConnecting(false);
    }
  };

  const startReply = (m: ModRoomChat, text: string) => {
    setEditing(null);
    setReplyingTo({ id: m.id, login: m.login, text: text.slice(0, 140) });
    textareaRef.current?.focus();
  };

  const startEdit = (m: ModRoomChat, text: string, attachment?: string, reply?: ReplyRef) => {
    setReplyingTo(null);
    setEditing({ id: m.id, attachment, reply });
    setDraft(text);
    textareaRef.current?.focus();
  };

  const cancelComposer = () => {
    setEditing(null);
    setReplyingTo(null);
    setDraft('');
  };

  if (denial === 'needs_connect') {
    return (
      <CenterNote
        icon={<ShieldCheck size={28} className="text-accent" />}
        title="Connect mod rooms"
        body="Grant one-time access to the channels you moderate to join their private mod room."
        action={
          <MinimalButton onClick={handleConnectConsent} disabled={connecting}>
            {connecting ? 'Opening browser...' : 'Connect'}
          </MinimalButton>
        }
      />
    );
  }

  if (denial === 'not_entitled') {
    return (
      <CenterNote
        icon={<ShieldCheck size={28} className="text-[#f0c674]" />}
        title="Supporter feature"
        body="Mod rooms are available to StreamNook supporters and subscribers."
        action={
          <MinimalButton
            onClick={() =>
              openExternal(
                `https://streamnook.app/support?tier=supporter${channelLogin ? `&handle=${channelLogin}` : ''}`,
              )
            }
          >
            Become a supporter
          </MinimalButton>
        }
      />
    );
  }

  if (denial === 'not_moderator') {
    return (
      <CenterNote
        icon={<ShieldCheck size={28} className="text-textSecondary" />}
        title="No mod room here"
        body="You don't moderate this channel, so there's no room to join."
      />
    );
  }

  if (denial === 'error') {
    return (
      <CenterNote
        icon={<ShieldCheck size={28} className="text-textSecondary" />}
        title="Couldn't reach the mod room"
        body="Something went wrong connecting. Try again in a moment."
        action={<MinimalButton onClick={() => setAttempt((a) => a + 1)}>Retry</MinimalButton>}
      />
    );
  }

  const typingLogins = Object.values(typing).map((t) => t.login).filter(Boolean);

  const resolve = (
    m: ModRoomChat,
  ): { text: string; attachment?: string; reply?: ReplyRef; emotes?: EmoteRef[]; locked: boolean } => {
    if (!isEncrypted(m.body)) return { text: m.body, attachment: m.attachment, locked: false };
    const d = decrypted[m.id];
    if (!key || d === undefined || d === null) return { text: '', locked: true };
    return { text: d.text, attachment: d.attachment, reply: d.reply, emotes: d.emotes, locked: false };
  };

  return (
    <div className="flex h-full flex-col">
      <div ref={listRef} className="flex-1 overflow-y-auto py-1">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6">
            {state === 'connected' && hasLoaded && (
              <p className="text-center text-sm text-textSecondary">No messages yet. Say hello to your mod team.</p>
            )}
          </div>
        ) : (
          messages.map((m) => {
            const { text, attachment, reply, emotes: msgEmotes, locked } = resolve(m);
            const canEdit = !!myUserId && m.userId === myUserId && !locked;
            return (
              <ModRoomMessageRow
                key={m.id}
                m={m}
                body={text}
                attachment={attachment}
                reply={reply}
                emoteRefs={msgEmotes}
                locked={locked}
                canEdit={canEdit}
                emotes={emotes}
                fontSize={fontSize}
                roomKey={key}
                onUsernameClick={onUsernameClick}
                onReply={() => startReply(m, text)}
                onEdit={() => startEdit(m, text, attachment, reply)}
              />
            );
          })
        )}
      </div>

      <div className="h-4 px-3 text-[11px] text-textSecondary">
        {typingLogins.length === 1 && `${typingLogins[0]} is typing...`}
        {typingLogins.length === 2 && `${typingLogins[0]} and ${typingLogins[1]} are typing...`}
        {typingLogins.length > 2 && 'Several people are typing...'}
      </div>

      <div className="relative flex-shrink-0 border-t border-borderSubtle p-2" style={{ backgroundColor: 'rgba(12, 12, 13, 0.9)' }}>
        <EmotePickerPanel
          open={showEmotes}
          onClose={() => setShowEmotes(false)}
          emotes={emotes ?? null}
          isTwitch
          isKick={false}
          channelId={channelId}
          channelLogin={channelLogin}
          onInsert={insertEmote}
        />
        {(replyingTo || editing) && (
          <div
            className="mb-2 flex items-center gap-2 rounded-md px-2 py-1 text-[11px]"
            style={
              editing
                ? { background: 'rgba(245,158,11,0.14)', boxShadow: 'inset 0 0 0 1px rgba(245,158,11,0.32)' }
                : { background: 'rgba(255,255,255,0.05)' }
            }
          >
            {editing ? (
              <span className="flex shrink-0 items-center gap-1 font-semibold text-amber-300">
                <Pencil size={11} /> Editing message
              </span>
            ) : (
              <span className="flex shrink-0 items-center gap-1 text-textSecondary">
                <CornerUpLeft size={11} /> Replying to <span className="text-accent">{replyingTo!.login}</span>
              </span>
            )}
            {replyingTo && <span className="truncate text-textSecondary opacity-70">{replyingTo.text}</span>}
            <button
              onClick={cancelComposer}
              aria-label="Cancel"
              className="ml-auto shrink-0 text-textSecondary transition-colors hover:text-textPrimary"
            >
              <X size={13} />
            </button>
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFilePick} />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={state !== 'connected' || !key || uploading}
            aria-label="Attach image"
            className="grid h-[34px] w-[34px] place-items-center rounded text-textSecondary transition-colors hover:bg-surface-hover hover:text-accent disabled:opacity-40"
          >
            <Paperclip size={16} />
          </button>
          <button
            onClick={() => setShowEmotes((v) => !v)}
            onMouseLeave={smiley.cycleEmoteSmiley}
            disabled={state !== 'connected' || !key}
            aria-label="Emotes"
            className="group grid h-[34px] w-[34px] place-items-center rounded transition-colors hover:bg-surface-hover disabled:opacity-40"
          >
            {showEmotes ? (
              <svg className="h-4 w-4 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <img
                src={getAppleEmojiUrl(smiley.currentSmiley)}
                alt={smiley.currentSmiley}
                draggable={false}
                className={`h-4 w-4 object-contain transition-all ease-in-out ${smiley.isSmileyTransitioning ? 'scale-50 opacity-0 duration-100' : 'scale-100 opacity-100 duration-150'}`}
              />
            )}
          </button>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => handleDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            rows={1}
            placeholder={state !== 'connected' ? 'Connecting...' : key ? 'Encrypted message' : 'Securing room...'}
            disabled={state !== 'connected' || !key}
            className="glass-input max-h-28 min-h-[34px] flex-1 resize-none px-3 py-2 text-sm placeholder-textSecondary"
          />
          <button
            onClick={() => void handleSend()}
            disabled={state !== 'connected' || !key || !draft.trim()}
            aria-label="Send"
            className="glass-button flex h-9 w-9 flex-shrink-0 items-center justify-center self-center rounded text-white transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};

function sniffImageType(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp';
  return 'image/png';
}

// Fetches an attachment and, if it was stored encrypted (application/x-sn-enc),
// decrypts it with the room key into a blob URL. Legacy plaintext images render
// as-is. The bytes never sit decrypted anywhere but this client.
const AttachmentImage = ({ url, roomKey }: { url: string; roomKey: CryptoKey | null }) => {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let blobUrl: string | null = null;
    void (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const ct = res.headers.get('Content-Type') || '';
        let bytes = new Uint8Array(await res.arrayBuffer());
        if (ct.includes('x-sn-enc')) {
          if (!roomKey) return;
          const dec = await decryptBytes(roomKey, bytes);
          if (!dec) return;
          bytes = dec;
        }
        blobUrl = URL.createObjectURL(new Blob([bytes], { type: sniffImageType(bytes) }));
        if (active) setSrc(blobUrl);
        else URL.revokeObjectURL(blobUrl);
      } catch {
        // leave the placeholder
      }
    })();
    return () => {
      active = false;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [url, roomKey]);
  if (!src) return <div className="h-24 w-40 animate-pulse rounded-md bg-white/5" />;
  return <img src={src} alt="attachment" className="max-h-48 max-w-[85%] rounded-md object-contain" />;
};

const CenterNote = ({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) => (
  <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
    {icon}
    <div>
      <p className="text-sm font-semibold text-textPrimary">{title}</p>
      <p className="mt-1 text-xs text-textSecondary">{body}</p>
    </div>
    {action}
  </div>
);

const MinimalButton = ({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className="px-3 py-1.5 text-sm font-medium text-textSecondary transition-colors hover:text-accent disabled:opacity-50"
  >
    {children}
  </button>
);

export default ModRoomPane;
