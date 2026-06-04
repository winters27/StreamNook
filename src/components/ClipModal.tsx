import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ExternalLink, Loader2, Copy, Pencil, Trash2, Clapperboard, Check, ArrowUpRight } from 'lucide-react';
import { useAppStore } from '../stores/AppStore';
import type { MediaInfo } from '../stores/AppStore';
import { Logger } from '../utils/logger';

interface ClipResolveResult {
  url: string;
  quality: string;
  available: string[];
}

function FooterBtn({
  icon,
  label,
  onClick,
  danger,
  primary,
  className,
}: {
  icon: ReactNode;
  label: string;
  onClick: (e: ReactMouseEvent) => void;
  danger?: boolean;
  primary?: boolean;
  className?: string;
}) {
  // Built on the app's `glass-button` primitive (inset bevel + depth). Primary
  // tints the surface Twitch-purple; danger/secondary just recolor the label.
  // Only the emphasized action (`primary`) is a real glass button; the rest are
  // flat icon+label actions (no bevel, just a subtle hover) so the main action
  // stands out.
  const variant = primary
    ? 'glass-button text-[#bf94ff] hover:text-[#d4b3ff]'
    : danger
      ? 'text-red-400 hover:bg-red-500/[0.1] hover:text-red-300'
      : 'text-textSecondary hover:bg-white/[0.05] hover:text-textPrimary';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-all ${variant} ${className ?? ''}`}
    >
      {icon}
      {label}
    </button>
  );
}

// A purple "drop" that flies from a point to a target — used to show a clip
// being sent to chat (mirrors the MultiNook add-from-home drop). Self-portals to
// <body> so it animates above the modal. Removed by the parent after it lands.
function PurpleDrop({
  startX,
  startY,
  targetX,
  targetY,
}: {
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
}) {
  const [flying, setFlying] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setFlying(true), 10);
    return () => clearTimeout(t);
  }, []);
  return createPortal(
    <div
      className="pointer-events-none fixed z-[9999] flex h-5 w-5 items-center justify-center rounded-full"
      style={{
        left: flying ? targetX : startX,
        top: flying ? targetY : startY,
        opacity: flying ? 0.15 : 1,
        transform: `translate(-50%, -50%) scale(${flying ? 0.3 : 1})`,
        transition: 'all 600ms cubic-bezier(0.22, 1, 0.36, 1)',
        backgroundColor: '#9146FF',
        boxShadow: '0 0 14px rgba(145,70,255,0.85)',
      }}
    >
      <ArrowUpRight size={12} className="text-white" />
    </div>,
    document.body,
  );
}

// A centered overlay player for a Twitch clip posted in chat. A clip is a direct
// signed MP4 (no streaming server), so it plays in its own <video> here while the
// main stream/chat stays mounted underneath — closing the modal lands the viewer
// back exactly where they were. Rendered in both the main window and MultiChat
// popouts, so a clip opens in whichever window it was clicked (no window jump).
export default function ClipModal() {
  const clipModal = useAppStore((s) => s.clipModal);
  const close = useAppStore((s) => s.closeClipModal);
  const quality = useAppStore((s) => s.settings?.quality) ?? 'best';

  return (
    <AnimatePresence>
      {clipModal && (
        <ClipModalInner
          key={clipModal.url}
          url={clipModal.url}
          info={clipModal.info}
          created={clipModal.created}
          editUrl={clipModal.editUrl}
          shareOnly={clipModal.shareOnly}
          quality={quality}
          onClose={close}
        />
      )}
    </AnimatePresence>
  );
}

function ClipModalInner({
  url,
  info,
  quality,
  onClose,
  created,
  editUrl,
  shareOnly,
}: {
  url: string;
  info: MediaInfo;
  quality: string;
  onClose: () => void;
  created?: boolean;
  editUrl?: string;
  shareOnly?: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const addToast = useAppStore((s) => s.addToast);
  const channelLogin = useAppStore((s) => s.currentStream?.user_login);
  const [pendingDelete, setPendingDelete] = useState(false);
  // Purple "sent to chat" drops in flight (each flies from the click → chat input).
  const [drops, setDrops] = useState<
    Array<{ id: number; startX: number; startY: number; targetX: number; targetY: number }>
  >([]);
  const dropIdRef = useRef(0);
  // The clip slug (handles clips.twitch.tv/<slug> and twitch.tv/<ch>/clip/<slug>).
  const slug =
    url.match(/clips\.twitch\.tv\/([^/?#]+)/)?.[1] ||
    url.match(/\/clip\/([^/?#]+)/)?.[1] ||
    info.id ||
    '';

  // Release the media element when it detaches (modal close / clip change). A
  // detached <video> can keep decoding, buffering, and even playing audio until
  // GC reclaims it; pausing + clearing the src and calling load() frees it
  // immediately. Done via a ref callback (React calls it with null on detach) so
  // we always release the exact node that's going away.
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    if (el === null && videoRef.current) {
      const prev = videoRef.current;
      prev.pause();
      prev.removeAttribute('src');
      prev.load();
    }
    videoRef.current = el;
  }, []);

  // Get the playable source. A freshly-created clip (`created`) needs Twitch to
  // finish RENDERING it first — resolving too early yields a black frame that
  // never refreshes — so poll ShareClipRenderStatus until CREATED, then resolve
  // the SIGNED playback URL. An already-finalized clip (a chat link) resolves
  // directly. Cancellation guards against a result landing after close.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    setSrc(null);
    setError(false);

    const fail = (e: unknown) => {
      if (cancelled) return;
      Logger.error('[ClipModal] could not load clip:', e);
      setError(true);
    };

    // resolve_clip_media returns a SIGNED, playable URL. (The raw `sourceURL`
    // from ShareClipRenderStatus is unsigned → 401, so that op is used only to
    // learn readiness.) A little retry covers transient hiccups.
    const resolveSrc = (retriesLeft: number) => {
      invoke<ClipResolveResult>('resolve_clip_media', { url, quality })
        .then((r) => {
          if (!cancelled) setSrc(r.url);
        })
        .catch((e) => {
          if (cancelled) return;
          if (retriesLeft > 0) {
            timer = setTimeout(() => resolveSrc(retriesLeft - 1), 1500);
          } else {
            fail(e);
          }
        });
    };

    // Freshly-created clip: wait until Twitch finishes RENDERING it (else the
    // asset is a black 0:00 frame), THEN resolve the signed URL to play.
    const waitThenResolve = () => {
      invoke<{ ready: boolean }>('get_clip_render_status', { slug })
        .then((st) => {
          if (cancelled) return;
          if (st.ready) {
            resolveSrc(3);
            return;
          }
          attempts += 1;
          if (attempts > 30) return fail('clip render timed out'); // ~60s ceiling
          timer = setTimeout(waitThenResolve, 2000);
        })
        .catch((e) => {
          if (cancelled) return;
          attempts += 1;
          if (attempts > 30) return fail(e);
          timer = setTimeout(waitThenResolve, 2000);
        });
    };

    // Share-only: no player, so don't fetch footage at all.
    if (!shareOnly) {
      if (created) waitThenResolve();
      else resolveSrc(4);
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [url, quality, created, slug, shareOnly]);

  // Esc closes — the keyboard counterpart to the backdrop click and the X.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const openExternal = async (target: string = url) => {
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(target);
    } catch (err) {
      Logger.error('[ClipModal] external open failed:', err);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      addToast('Clip link copied', 'success');
    } catch {
      addToast('Could not copy link', 'error');
    }
  };

  const sendToChat = (e: ReactMouseEvent) => {
    const { currentStream, currentUser } = useAppStore.getState();
    if (!currentStream?.user_login) {
      addToast('No channel to post to', 'warning');
      return;
    }
    // Fly a purple drop from the click toward the chat input box — a visual cue
    // that the clip just went to chat (mirrors the MultiNook add animation).
    const input = document.getElementById('chat-compose-input');
    if (input) {
      const r = input.getBoundingClientRect();
      const id = (dropIdRef.current += 1);
      setDrops((prev) => [
        ...prev,
        {
          id,
          startX: e.clientX,
          startY: e.clientY,
          targetX: r.left + r.width / 2,
          targetY: r.top + r.height / 2,
        },
      ]);
      window.setTimeout(() => setDrops((prev) => prev.filter((d) => d.id !== id)), 700);
    }
    void (async () => {
      try {
        await invoke('send_chat_message', {
          message: url,
          replyParentMsgId: null,
          targetChannel: currentStream.user_login,
          broadcasterId: currentStream.user_id || null,
          senderId: currentUser?.user_id || null,
          senderAccountId: null,
        });
        addToast('Clip posted to chat', 'success');
      } catch (err) {
        Logger.error('[ClipModal] send to chat failed:', err);
        addToast('Could not post to chat', 'error');
      }
    })();
  };

  // Delete is two-step (first click arms it, second confirms) so a freshly-made
  // clip isn't nuked by a stray click. Only offered for clips you own (created).
  const deleteClip = async () => {
    if (!pendingDelete) {
      setPendingDelete(true);
      setTimeout(() => setPendingDelete(false), 3000);
      return;
    }
    try {
      await invoke('delete_clip', { slug });
      addToast('Clip deleted', 'success');
      onClose();
    } catch (err) {
      Logger.error('[ClipModal] delete failed:', err);
      addToast('Could not delete clip', 'error');
    }
  };

  const channel = info.broadcaster_name || info.user_name;

  const actionsFooter = (
    <div className="flex flex-wrap items-center gap-1.5 px-3 py-2.5">
      {channelLogin && (
        <FooterBtn primary icon={<ArrowUpRight size={15} />} label="Send to chat" onClick={sendToChat} />
      )}
      <FooterBtn icon={<Copy size={15} />} label="Copy link" onClick={copyLink} />
      {editUrl && (
        <FooterBtn icon={<Pencil size={15} />} label="Edit on Twitch" onClick={() => openExternal(editUrl)} />
      )}
      <FooterBtn icon={<ExternalLink size={15} />} label="Open in browser" onClick={() => openExternal(url)} />
      {created && (
        <FooterBtn
          icon={<Trash2 size={15} />}
          label={pendingDelete ? 'Confirm delete?' : 'Delete'}
          onClick={deleteClip}
          danger
          className="ml-auto"
        />
      )}
    </div>
  );

  const flyingDrops = drops.map((d) => (
    <PurpleDrop key={d.id} startX={d.startX} startY={d.startY} targetX={d.targetX} targetY={d.targetY} />
  ));

  // Share-only: the clip was just made + previewed in the editor, so skip the
  // player and show a clean "share your clip" card — just the actions.
  if (shareOnly) {
    return createPortal(
      <motion.div
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={onClose}
      >
        <motion.div
          className="glass-panel relative w-full max-w-md overflow-hidden"
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.96, opacity: 0 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start gap-2.5 px-4 pb-3 pt-4">
            <Clapperboard size={20} style={{ color: '#9146FF' }} className="mt-0.5 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: '#bf94ff' }}>
                Clip created
              </div>
              {info.title && (
                <div className="truncate text-base font-semibold leading-snug text-textPrimary">
                  {info.title}
                </div>
              )}
              <div className="truncate text-xs text-textSecondary">
                <span style={{ color: '#9146FF' }} className="font-semibold">
                  Twitch
                </span>
                {channel ? ` · ${channel}` : ''}
              </div>
            </div>
          </div>
          <div className="mx-3 border-t border-white/[0.06]" />
          <div className="space-y-1.5 px-3 pb-3 pt-2.5">
            <div className="grid grid-cols-2 gap-1">
              <FooterBtn className="w-full" icon={<Copy size={15} />} label="Copy link" onClick={copyLink} />
              {channelLogin && (
                <FooterBtn
                  primary
                  className="w-full"
                  icon={<ArrowUpRight size={15} />}
                  label="Send to chat"
                  onClick={sendToChat}
                />
              )}
            </div>
            {flyingDrops}
            <div className="flex items-center justify-between pt-1">
              {created ? (
                <FooterBtn
                  danger
                  icon={<Trash2 size={15} />}
                  label={pendingDelete ? 'Confirm delete?' : 'Delete'}
                  onClick={deleteClip}
                />
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={onClose}
                className="glass-button inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-textPrimary transition-all"
              >
                <Check size={15} /> Done
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>,
      document.body,
    );
  }

  return createPortal(
    <motion.div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onClose}
    >
      <motion.div
        className="glass-panel relative w-full max-w-7xl overflow-hidden"
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            {info.title && (
              <div className="truncate text-sm font-medium text-textPrimary">{info.title}</div>
            )}
            <div className="truncate text-xs text-textSecondary">
              <span style={{ color: '#9146FF' }} className="font-semibold">
                Twitch
              </span>
              {channel ? ` · ${channel}` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close clip"
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-textSecondary transition-colors hover:bg-white/[0.06] hover:text-textPrimary"
          >
            <X size={18} />
          </button>
        </div>

        <div className="relative w-full bg-black" style={{ aspectRatio: '16 / 9' }}>
          {src ? (
            <video
              ref={attachVideo}
              src={src}
              autoPlay
              controls
              className="h-full w-full"
              onError={() => setError(true)}
            />
          ) : error ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-sm text-textSecondary">Couldn&apos;t load this clip.</p>
              <button
                type="button"
                onClick={() => openExternal()}
                className="inline-flex items-center gap-1.5 rounded-md bg-white/[0.06] px-3 py-1.5 text-xs text-textPrimary transition-colors hover:bg-white/[0.1]"
              >
                <ExternalLink size={13} /> Open in browser
              </button>
            </div>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <Loader2 size={28} className="animate-spin text-textSecondary" />
              {created && <p className="text-xs text-textSecondary">Preparing your clip…</p>}
            </div>
          )}
        </div>

        {/* Action bar — the all-in-one: watch above, act below. */}
        {actionsFooter}
        {flyingDrops}
      </motion.div>
    </motion.div>,
    document.body,
  );
}
