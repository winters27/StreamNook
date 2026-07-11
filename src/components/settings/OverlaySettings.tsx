// Overlay builder — the in-app WYSIWYG design studio for the OBS chat overlay.
// Left: controls. Right: a large scaled preview that renders the SAME renderer
// the hosted overlay uses (OverlayChat) at the chosen canvas size, so streamers
// see exactly how many chats fit and what viewers will see. Multi-source, like
// MultiChat: add Twitch/Kick/YouTube/TikTok channels and preview the merged feed
// (Twitch connects live now; the others join once the overlay service ships).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RotateCcw, Link2, Plus, X, AlertTriangle, Play, Pause } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { Dropdown } from '../ui/Dropdown';
import { SettingsSection, SettingsRow, SegmentedSelect } from './_primitives';
import { OverlayChat } from '../overlay/OverlayChat';
import { LiveOverlayFeed } from '../overlay/LiveOverlayFeed';
import { ProviderIcon } from '../overlay/ProviderIcon';
import { SAMPLE_MESSAGES, randomSampleMessage, seedFlowMessages, type OverlayMessage } from '../overlay/sampleMessages';
import {
  DEFAULT_OVERLAY_STYLE,
  EMOJI_STYLES,
  EVENT_CATEGORIES,
  FONT_OPTIONS,
  OVERLAY_LIMITS,
  PROVIDER_EVENT_CATEGORIES,
  THIRD_PARTY_BADGE_PROVIDERS,
  sanitizeCommandFilters,
  type OverlayStyle,
} from '../overlay/overlayConfig';
import { CURRENCY_OPTIONS } from '../../services/currencyService';
import { PROVIDERS, type ProviderId } from '../../types/providers';

const STORAGE_KEY = 'sn_overlay_style_v1';
const SOURCES_KEY = 'sn_overlay_sources_v1';
// The published overlay's opaque id, remembered so re-publishing UPDATES the same
// row (the OBS link the streamer already pasted stays valid) instead of minting a
// new link each time.
const OVERLAY_ID_KEY = 'sn_overlay_id_v1';
const PUBLISH_ENDPOINT = 'https://streamnook.app/api/overlays';
const SOURCE_PROVIDERS: ProviderId[] = ['twitch', 'kick', 'youtube', 'tiktok'];

function loadOverlayId(): string | null {
  try { return localStorage.getItem(OVERLAY_ID_KEY); } catch { return null; }
}

interface OverlaySource { provider: ProviderId; channel: string; }

const SIZE_PRESETS: { label: string; width: number; height: number }[] = [
  { label: 'Standard', width: 400, height: 640 },
  { label: 'Tall', width: 380, height: 1000 },
  { label: 'Wide', width: 620, height: 520 },
  { label: 'Full column', width: 380, height: 1440 },
];

// YouTube/TikTok can't be connected by a bare name the way Twitch can — the
// input must resolve to a stable identifier first. Mirrors MultiChatWindow's
// parseYouTubeInput/parseTikTokInput so the overlay connects sources the same way.
function parseYouTubeInput(input: string): string | null {
  const s = input.trim();
  // Video links → 11-char video id.
  let m = s.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  if (/[?&]v=/.test(s)) {
    m = s.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
  }
  m = s.match(/\/(?:live|shorts)\/([A-Za-z0-9_-]{11})/i);
  if (m) return m[1];
  // Channel id.
  m = s.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/i);
  if (m) return m[1];
  // @handle in a URL.
  m = s.match(/\/@([A-Za-z0-9_.-]+)/);
  if (m) return `@${m[1]}`;
  // Legacy /c/NAME or /user/NAME custom URLs → treat as a handle.
  m = s.match(/youtube\.com\/(?:c|user)\/([A-Za-z0-9_.-]+)/i);
  if (m) return `@${m[1]}`;
  // A typed value (no link): a UC… channel id as-is; otherwise a handle — with OR
  // without the leading @ (so both "@mrbeast" and "mrbeast" resolve the same).
  const bare = s.replace(/^@+/, '');
  if (/^UC[A-Za-z0-9_-]{22}$/.test(bare)) return bare;
  if (/^[A-Za-z0-9_.-]+$/.test(bare)) return `@${bare}`;
  return null;
}

function parseTikTokInput(input: string): string | null {
  const m = input.trim().match(/tiktok\.com\/@([A-Za-z0-9_.]+)/i);
  if (m) return m[1];
  const bare = input.trim().replace(/^@/, '');
  return /^[A-Za-z0-9_.]+$/.test(bare) ? bare : null;
}

const SOURCE_PLACEHOLDER: Record<ProviderId, string> = {
  twitch: 'Twitch login (e.g. sodapoppin)',
  kick: 'Kick channel (e.g. trainwreckstv)',
  youtube: 'YouTube channel or link (e.g. mrbeast)',
  tiktok: 'TikTok @handle or LIVE link',
  rumble: 'Rumble channel',
  x: 'X handle',
};

const loadStyle = (): OverlayStyle => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const merged = { ...DEFAULT_OVERLAY_STYLE, ...JSON.parse(raw) } as OverlayStyle;
      merged.commandFilters = sanitizeCommandFilters(merged.commandFilters);
      return merged;
    }
  } catch { /* ignore malformed */ }
  return { ...DEFAULT_OVERLAY_STYLE };
};

const loadSources = (): OverlaySource[] => {
  try {
    const raw = localStorage.getItem(SOURCES_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
};

const Toggle = ({ enabled, onChange }: { enabled: boolean; onChange: () => void }) => (
  <button
    onClick={onChange}
    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${enabled ? 'bg-accent' : 'bg-gray-600'}`}
  >
    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
  </button>
);

const Slider = ({
  value, min, max, step = 1, onChange, format,
}: {
  value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; format?: (v: number) => string;
}) => (
  <div className="flex items-center gap-3 w-full">
    <input
      type="range" min={min} max={max} step={step} value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="flex-1 accent-accent cursor-pointer"
    />
    <span className="w-16 text-right text-[12px] tabular-nums text-textSecondary">
      {format ? format(value) : value}
    </span>
  </div>
);

type SceneBg = 'scene' | 'checker' | 'dark' | 'light';

const SCENE_STYLES: Record<SceneBg, CSSProperties> = {
  // A soft "studio" backdrop so the overlay reads as sitting in a real scene,
  // not floating in empty space. The faint grid is drawn by an overlaid element.
  scene: {
    background:
      'radial-gradient(120% 90% at 72% 12%, rgba(84,74,150,0.28), transparent 55%), radial-gradient(90% 80% at 12% 92%, rgba(29,158,117,0.18), transparent 55%), linear-gradient(160deg, #171a20, #0c0e12)',
  },
  checker: {
    backgroundColor: '#2a2a30',
    backgroundImage:
      'linear-gradient(45deg, #3a3a42 25%, transparent 25%), linear-gradient(-45deg, #3a3a42 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #3a3a42 75%), linear-gradient(-45deg, transparent 75%, #3a3a42 75%)',
    backgroundSize: '20px 20px',
    backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0',
  },
  dark: { background: 'linear-gradient(135deg, #12121a, #1c1030)' },
  light: { background: 'linear-gradient(135deg, #dfe4ee, #c3ccdd)' },
};

type OverlayTab = 'sources' | 'layout' | 'appearance' | 'filters' | 'events';
const OVERLAY_TABS: { id: OverlayTab; label: string }[] = [
  { id: 'sources', label: 'Sources' },
  { id: 'layout', label: 'Layout' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'filters', label: 'Filters' },
  { id: 'events', label: 'Events' },
];

// Appends a random chatter's message on a jittered timer so the preview reads
// like a live chat. OverlayChat caps to what fits and animates each new row, so
// this just grows the list (bounded) and lets the renderer do the rest.
const SampleFlowFeed = ({ style }: { style: OverlayStyle }) => {
  const [msgs, setMsgs] = useState<OverlayMessage[]>(() => seedFlowMessages(8));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setMsgs((prev) => [...prev, randomSampleMessage()].slice(-60));
      // Jittered cadence so it feels organic, not metronomic.
      timer = setTimeout(tick, 850 + Math.random() * 1700);
    };
    timer = setTimeout(tick, 600);
    return () => clearTimeout(timer);
  }, []);
  return <OverlayChat messages={msgs} style={style} superSample={2} />;
};

// A plain source row: platform + channel + remove. Blocking lives in the Filters
// tab now (BlockRow), so this stays a clean list of where chat comes from.
const SourceRow = ({ source, onRemove }: { source: OverlaySource; onRemove: () => void }) => (
  <div className="flex items-center gap-2 rounded-lg bg-glass px-2.5 py-1.5">
    <ProviderIcon provider={source.provider} size="14px" />
    <span className="text-sm text-textPrimary truncate flex-1">{source.channel}</span>
    <button onClick={onRemove} className="text-textSecondary hover:text-textPrimary flex-shrink-0">
      <X size={14} />
    </button>
  </div>
);

// A per-source hidden-accounts editor (Filters tab). Renders as a flat SettingsRow
// (channel as the row title, input + chips below) so it sits inline in the section
// card instead of a nested box-in-box.
const BlockRow = ({ source, blocked, onAddBlocked, onRemoveBlocked }: {
  source: OverlaySource;
  blocked: string[];
  onAddBlocked: (name: string) => void;
  onRemoveBlocked: (name: string) => void;
}) => {
  const [val, setVal] = useState('');
  const add = () => { const n = val.trim(); if (n) { onAddBlocked(n); setVal(''); } };
  return (
    <SettingsRow
      title={(
        <span className="inline-flex items-center gap-1.5">
          <ProviderIcon provider={source.provider} size="14px" /> {source.channel}
        </span>
      ) as unknown as string}
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <input
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            placeholder="Username to hide"
            className="flex-1 min-w-0 rounded-lg bg-glass border border-borderLight px-3 py-1.5 text-sm text-textPrimary placeholder:text-textMuted focus:outline-none focus:border-accent/60"
          />
          <button onClick={add} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium glass-input text-textPrimary flex-shrink-0">
            <Plus size={14} /> Hide
          </button>
        </div>
        {blocked.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {blocked.map((u) => (
              <span key={u} className="inline-flex items-center gap-1.5 rounded-lg bg-glass px-3 py-1 text-[13px] text-textSecondary">
                {u}
                <button onClick={() => onRemoveBlocked(u)} className="hover:text-textPrimary"><X size={14} /></button>
              </span>
            ))}
          </div>
        )}
      </div>
    </SettingsRow>
  );
};

type CommandMode = 'prefix' | 'exact';
type CommandFilter = { value: string; mode: CommandMode };

// The command-filter list editor (Filters tab): pick Prefix (hide every command
// starting with a character) or Exact (hide one specific command), type it, and
// it's added as a labeled, removable chip. No guessing — you choose the mode.
const CommandFilterEditor = ({ filters, onAdd, onRemove }: {
  filters: CommandFilter[];
  onAdd: (value: string, mode: CommandMode) => void;
  onRemove: (value: string, mode: CommandMode) => void;
}) => {
  const [val, setVal] = useState('');
  const [mode, setMode] = useState<CommandMode>('prefix');
  const add = () => { const t = val.trim(); if (t) { onAdd(t, mode); setVal(''); } };
  return (
    <div className="w-full space-y-2">
      <SegmentedSelect
        value={mode}
        onChange={setMode}
        options={[{ value: 'prefix', label: 'Prefix' }, { value: 'exact', label: 'Exact command' }]}
      />
      <div className="flex items-center gap-2">
        <input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder={mode === 'prefix' ? '! or #' : '!title'}
          className="flex-1 min-w-0 rounded-lg bg-glass border border-borderLight px-3 py-1.5 text-sm text-textPrimary placeholder:text-textMuted focus:outline-none focus:border-accent/60"
        />
        <button onClick={add} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium glass-input text-textPrimary flex-shrink-0">
          <Plus size={14} /> Add
        </button>
      </div>
      {filters.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {filters.filter((f) => f?.value).map((f, i) => (
            <span key={`${f.mode}:${f.value}:${i}`} className="inline-flex items-center gap-1.5 rounded-lg bg-glass px-3 py-1 text-[13px]">
              <span className="font-medium text-textPrimary">{f.value}</span>
              <span className="text-textMuted">{f.mode === 'prefix' ? 'all commands' : 'exact'}</span>
              <button onClick={() => onRemove(f.value, f.mode)} className="text-textSecondary hover:text-textPrimary"><X size={14} /></button>
            </span>
          ))}
        </div>
      )}
      <p className="text-[12px] leading-relaxed text-textMuted">
        <span className="text-textSecondary">Prefix</span> hides every command starting with the character (e.g. <span className="text-textSecondary">!</span> hides all). <span className="text-textSecondary">Exact command</span> hides only that one (e.g. <span className="text-textSecondary">!title</span>).
      </p>
    </div>
  );
};

const sourceKey = (s: OverlaySource) => `${s.provider}:${s.channel.toLowerCase()}`;

// Sentinel dropdown value + starter for the custom-font option, and a helper to
// pull the bare family name out of a font-family string for the text input.
const CUSTOM_FONT = '__custom__';
const CUSTOM_FONT_STARTER = "'Poppins', sans-serif";
const primaryFamilyName = (ff: string) => (ff || '').split(',')[0].trim().replace(/^["']|["']$/g, '');

// A few sample emoji shown in the Emoji-style dropdown so users can compare vendor
// styles at a glance. Built from codepoints (no literal emoji in source).
const EMOJI_SAMPLES = [0x1f600, 0x1f602, 0x1f60d].map((cp) => ({
  cp: cp.toString(16),
  char: String.fromCodePoint(cp),
}));

const OverlaySettings = () => {
  const [style, setStyle] = useState<OverlayStyle>(loadStyle);
  const [flow, setFlow] = useState(false);
  const [sources, setSources] = useState<OverlaySource[]>(loadSources);
  const [sceneBg, setSceneBg] = useState<SceneBg>('scene');
  const [previewMode, setPreviewMode] = useState<'sample' | 'live'>('sample');
  const [activeTab, setActiveTab] = useState<OverlayTab>('sources');
  const [addProvider, setAddProvider] = useState<ProviderId>('twitch');
  const [addChannel, setAddChannel] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [publishState, setPublishState] = useState<'idle' | 'publishing' | 'done' | 'error'>('idle');
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  // Persisted so re-publish updates the same link (see OVERLAY_ID_KEY).
  const overlayIdRef = useRef<string | null>(loadOverlayId());

  // The scaled stage measures its own width so the overlay canvas fits the pane
  // at true proportions (scaled down when the canvas is wider than the pane).
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const [stageW, setStageW] = useState(360);
  useLayoutEffect(() => {
    const el = stageWrapRef.current;
    if (!el) return;
    // Measure synchronously BEFORE paint so the first frame already uses the right
    // scale. Otherwise it paints at the default guess, then the observer corrects
    // the width and the whole canvas visibly jumps — and re-scaling a painted frame
    // leaves the text blurry until the next full repaint.
    setStageW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      setStageW(entries[entries.length - 1].contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Cap the stage to the available viewport height so a tall overlay scales down
  // to fit instead of clipping into the settings window.
  const [viewportH, setViewportH] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 900));
  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const maxStageH = Math.max(340, viewportH - 240);
  // Leave an inset around the canvas so it sits framed inside the scene, not edge to edge.
  const STAGE_PAD = 44;
  const scale = Math.min(1, (stageW - STAGE_PAD) / style.width, (maxStageH - STAGE_PAD) / style.height);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(style)); } catch { /* ignore */ }
  }, [style]);
  useEffect(() => {
    try { localStorage.setItem(SOURCES_KEY, JSON.stringify(sources)); } catch { /* ignore */ }
  }, [sources]);

  const set = <K extends keyof OverlayStyle>(key: K, val: OverlayStyle[K]) =>
    setStyle((s) => ({ ...s, [key]: val }));

  const toggleEvent = (cat: string) =>
    setStyle((s) => {
      const hidden = s.hiddenEvents ?? [];
      return { ...s, hiddenEvents: hidden.includes(cat) ? hidden.filter((c) => c !== cat) : [...hidden, cat] };
    });

  // Per-platform event hide, keyed `provider:category`.
  const toggleProviderEvent = (key: string) =>
    setStyle((s) => {
      const hidden = s.hiddenProviderEvents ?? [];
      return { ...s, hiddenProviderEvents: hidden.includes(key) ? hidden.filter((c) => c !== key) : [...hidden, key] };
    });

  const toggleBadgeProvider = (id: string) =>
    setStyle((s) => {
      const hidden = s.hiddenBadgeProviders ?? [];
      return { ...s, hiddenBadgeProviders: hidden.includes(id) ? hidden.filter((k) => k !== id) : [...hidden, id] };
    });

  const toggleSourceFilter = (id: ProviderId) =>
    setStyle((s) => {
      const has = s.sources.includes(id);
      const next = has ? s.sources.filter((p) => p !== id) : [...s.sources, id];
      return { ...s, sources: next.length ? next : s.sources };
    });

  const addSource = () => {
    const raw = addChannel.trim();
    if (!raw) return;
    // Resolve the input to what each provider actually connects by.
    let channel: string | null;
    if (addProvider === 'youtube') {
      channel = parseYouTubeInput(raw);
      if (!channel) { setAddError('Enter a YouTube @handle, channel link, or live video link.'); return; }
    } else if (addProvider === 'tiktok') {
      channel = parseTikTokInput(raw);
      if (!channel) { setAddError('Enter a TikTok @handle or LIVE link.'); return; }
    } else {
      channel = raw.replace(/^#/, '').toLowerCase(); // Twitch login / Kick slug
    }
    setAddError(null);
    const chan = channel;
    setSources((list) =>
      list.some((s) => s.provider === addProvider && s.channel.toLowerCase() === chan.toLowerCase())
        ? list
        : [...list, { provider: addProvider, channel: chan }],
    );
    setAddChannel('');
  };

  const removeSource = (src: OverlaySource) => {
    setSources((list) => list.filter((s) => !(s.provider === src.provider && s.channel === src.channel)));
    // Drop that source's blocklist so removed sources don't leave orphan entries.
    setStyle((st) => {
      const key = sourceKey(src);
      if (!st.blockedUsers?.[key]) return st;
      const next = { ...st.blockedUsers };
      delete next[key];
      return { ...st, blockedUsers: next };
    });
  };

  const addBlockedUser = (src: OverlaySource, name: string) =>
    setStyle((st) => {
      const key = sourceKey(src);
      const cur = st.blockedUsers?.[key] ?? [];
      const n = name.trim().replace(/^@+/, '');
      if (!n || cur.some((x) => x.toLowerCase() === n.toLowerCase())) return st;
      return { ...st, blockedUsers: { ...st.blockedUsers, [key]: [...cur, n] } };
    });

  const removeBlockedUser = (src: OverlaySource, name: string) =>
    setStyle((st) => {
      const key = sourceKey(src);
      const cur = st.blockedUsers?.[key] ?? [];
      return { ...st, blockedUsers: { ...st.blockedUsers, [key]: cur.filter((x) => x !== name) } };
    });

  const addCommandFilter = (value: string, mode: 'prefix' | 'exact') =>
    setStyle((s) => {
      const cur = s.commandFilters ?? [];
      const v = value.trim();
      if (!v || cur.some((x) => x.mode === mode && x.value.toLowerCase() === v.toLowerCase())) return s;
      return { ...s, commandFilters: [...cur, { value: v, mode }] };
    });
  const removeCommandFilter = (value: string, mode: 'prefix' | 'exact') =>
    setStyle((s) => ({ ...s, commandFilters: (s.commandFilters ?? []).filter((x) => !(x.value === value && x.mode === mode)) }));

  // Push the current config to streamnook.app. `copy` = the manual publish action
  // (copies the OBS link + shows state); auto-sync passes copy=false to SILENTLY
  // update the same link whenever a setting changes, so the published overlay is
  // always a direct mirror of the builder — no need to re-copy after tweaking.
  const pushConfig = async (copy: boolean) => {
    if (sources.length === 0) {
      if (copy) { setPublishError('Add at least one source first.'); setPublishState('error'); }
      return;
    }
    if (copy) { setPublishState('publishing'); setPublishError(null); }
    try {
      let token: string;
      try {
        [, token] = await invoke<[string, string]>('get_twitch_credentials');
      } catch {
        throw new Error('Sign in to Twitch in StreamNook to publish an overlay.');
      }
      const res = await fetch(PUBLISH_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: overlayIdRef.current ?? undefined, channels: sources, style }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          err.error === 'unauthenticated' ? 'Sign in to Twitch in StreamNook to publish an overlay.'
            : err.error === 'no_channels' ? 'Add at least one source first.'
              : `Publish failed (${err.error || res.status}).`,
        );
      }
      const data = (await res.json()) as { id: string; url: string };
      overlayIdRef.current = data.id;
      try { localStorage.setItem(OVERLAY_ID_KEY, data.id); } catch { /* ignore */ }
      setPublishedUrl(data.url);
      if (copy) {
        try { await navigator.clipboard.writeText(data.url); } catch { /* clipboard may be blocked; URL still shown */ }
        setPublishState('done');
      }
    } catch (e) {
      if (copy) { setPublishError(e instanceof Error ? e.message : 'Publish failed.'); setPublishState('error'); }
    }
  };

  const publish = () => pushConfig(true);

  // Keep the published link a LIVE MIRROR of the builder: once published, silently
  // re-push on any style/source change (debounced), so the streamer never has to
  // re-copy after tweaking a setting.
  useEffect(() => {
    if (!overlayIdRef.current) return;
    const t = setTimeout(() => { void pushConfig(false); }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style, sources]);

  // Cross-machine link: the overlay is keyed to the Twitch account, so on a fresh
  // install we ask the server for THIS account's overlay and adopt its id, link,
  // and (if nothing is configured locally yet) its sources + style — no need to
  // re-publish or copy a new URL after signing in on another machine.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current || overlayIdRef.current) return;
    hydratedRef.current = true;
    let cancelled = false;
    void (async () => {
      let token: string;
      try {
        [, token] = await invoke<[string, string]>('get_twitch_credentials');
      } catch {
        return; // not signed in → nothing to recover
      }
      let data: { id?: string; url?: string; channels?: unknown; style?: unknown };
      try {
        const res = await fetch(PUBLISH_ENDPOINT, { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) return; // 404 (no overlay yet) or transient → nothing to adopt
        data = await res.json();
      } catch {
        return;
      }
      if (cancelled || !data.id) return;
      overlayIdRef.current = data.id;
      try { localStorage.setItem(OVERLAY_ID_KEY, data.id); } catch { /* ignore */ }
      if (data.url) setPublishedUrl(data.url);
      // Only adopt the account's config on a truly fresh builder; otherwise local
      // edits win and sync up on the next change.
      if (sources.length === 0 && Array.isArray(data.channels)) {
        const valid = (data.channels as Array<{ provider?: unknown; channel?: unknown }>)
          .filter((c) => typeof c?.channel === 'string' && !!PROVIDERS[c.provider as ProviderId])
          .map((c) => ({ provider: c.provider as ProviderId, channel: c.channel as string }));
        if (valid.length > 0) setSources(valid);
        if (data.style && typeof data.style === 'object') setStyle({ ...DEFAULT_OVERLAY_STYLE, ...(data.style as Record<string, unknown>) });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fontOptions = useMemo(
    () => [
      // Preview each font in its own typeface ("Ag") so the difference is visible.
      ...FONT_OPTIONS.map((f) => ({
        value: f.value,
        label: f.label,
        icon: <span style={{ fontFamily: f.value, fontSize: 15, lineHeight: 1, width: 24, display: 'inline-block', textAlign: 'center' }}>Ag</span>,
      })),
      { value: CUSTOM_FONT, label: 'Custom…' },
    ],
    [],
  );
  const isCustomFont = !FONT_OPTIONS.some((f) => f.value === style.fontFamily);
  // Distinct platforms currently added as sources — drives the per-platform event
  // toggles + shows the Super Chat currency picker only when YouTube is present.
  const sourceProviders = useMemo(
    () => Array.from(new Set(sources.map((s) => s.provider))),
    [sources],
  );
  const catLabel = (id: string) => EVENT_CATEGORIES.find((c) => c.id === id)?.label ?? id;
  const currencyOptions = useMemo(
    () => [{ value: '', label: 'As sent' }, ...CURRENCY_OPTIONS.map((c) => ({ value: c, label: c }))],
    [],
  );
  // Each emoji-style option previews a few sample emoji in that style (or the OS
  // font for 'system') so the difference is visible before picking.
  const emojiStyleOptions = useMemo(
    () => EMOJI_STYLES.map((e) => ({
      value: e.value,
      label: e.label,
      icon: (
        <span className="inline-flex items-center gap-0.5">
          {EMOJI_SAMPLES.map((s) => (e.value === 'system'
            ? <span key={s.cp} style={{ fontSize: 18, lineHeight: 1 }}>{s.char}</span>
            : <img
                key={s.cp}
                src={e.value === 'twitter'
                  ? `https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/${s.cp}.svg`
                  : `https://cdn.jsdelivr.net/npm/emoji-datasource-${e.value}@15.1.2/img/${e.value}/64/${s.cp}.png`}
                alt=""
                width={18}
                height={18}
                loading="lazy"
                style={{ display: 'inline-block' }}
              />
          ))}
        </span>
      ),
    })),
    [],
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(340px,430px)]">
      {/* ── Controls ─────────────────────────────────────────────── */}
      <div className="space-y-5 min-w-0">
        <div className="flex items-center justify-between px-1">
          <p className="text-[12px] leading-relaxed text-textMuted max-w-[54ch]">
            Design your chat overlay and paste one link into OBS. Everything you change updates the preview and the published overlay.
          </p>
          <Tooltip content="Reset to defaults">
            <button
              onClick={() => setStyle({ ...DEFAULT_OVERLAY_STYLE })}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-textSecondary hover:text-textPrimary transition-colors flex-shrink-0"
            >
              <RotateCcw size={13} /> Reset
            </button>
          </Tooltip>
        </div>

        {/* Tabs: one focused group at a time instead of one long scroll. */}
        <div className="flex gap-2">
          {OVERLAY_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              style={{ borderRadius: 8 }}
              className={`flex-1 px-3 py-2 text-sm font-medium transition-all ${activeTab === t.id ? 'glass-input text-textPrimary' : 'glass-button text-textSecondary hover:text-textPrimary'}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {activeTab === 'sources' && (
        <SettingsSection label="Sources" description="Where the chat comes from. Add channels, filter platforms, and tag each message.">
          <div className="settings-row -mx-4 px-4 py-3 space-y-2.5">
            <div className="flex items-center gap-2">
              <Dropdown
                value={addProvider}
                options={SOURCE_PROVIDERS.map((p) => ({ value: p, label: PROVIDERS[p].label, icon: <ProviderIcon provider={p} size="14px" /> }))}
                onChange={(v) => { setAddProvider(v); setAddError(null); }}
                className="flex-shrink-0"
              />
              <input
                value={addChannel}
                onChange={(e) => { setAddChannel(e.target.value); if (addError) setAddError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSource(); } }}
                placeholder={SOURCE_PLACEHOLDER[addProvider]}
                className="flex-1 min-w-0 rounded-lg bg-glass border border-borderLight px-3 py-1.5 text-sm text-textPrimary placeholder:text-textMuted focus:outline-none focus:border-accent/60"
              />
              <button onClick={addSource} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-medium glass-input text-textPrimary flex-shrink-0">
                <Plus size={14} /> Add
              </button>
            </div>
            {addError && <p className="text-[12px] text-error">{addError}</p>}
            {sources.length === 0 ? (
              <p className="text-[12px] text-textMuted">No sources yet. Add a channel to preview its live chat.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {sources.map((s) => (
                  <SourceRow key={`${s.provider}:${s.channel}`} source={s} onRemove={() => removeSource(s)} />
                ))}
              </div>
            )}
            <p className="text-[12px] leading-relaxed text-textMuted">
              All platforms connect live in this preview, just like MultiChat. On the published overlay, Kick, YouTube, and TikTok join once the overlay service ships.
            </p>
          </div>
          <SettingsRow title="Platform filter" description="Hide a platform's messages without removing its source.">
            <div className="flex flex-wrap gap-2">
              {SOURCE_PROVIDERS.map((id) => {
                // Only a platform you've actually added as a source can be toggled;
                // the rest gray out (nothing to show or hide for them).
                const hasSource = sourceProviders.includes(id);
                const active = hasSource && style.sources.includes(id);
                return (
                  <button
                    key={id}
                    onClick={() => hasSource && toggleSourceFilter(id)}
                    disabled={!hasSource}
                    style={{ borderRadius: 8 }}
                    className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed ${active ? 'glass-input text-textPrimary' : 'glass-button text-textSecondary hover:text-textPrimary'}`}
                  >
                    <ProviderIcon provider={id} size="15px" />
                    {PROVIDERS[id].label}
                  </button>
                );
              })}
            </div>
          </SettingsRow>
          <SettingsRow title="Source tag" description="Mark which platform each message came from.">
            <SegmentedSelect
              value={style.sourceTag}
              onChange={(v) => set('sourceTag', v)}
              options={[
                { value: 'none', label: 'Off' },
                { value: 'dot', label: 'Dot' },
                { value: 'icon', label: 'Icon' },
                { value: 'label', label: 'Label' },
              ]}
            />
          </SettingsRow>
        </SettingsSection>
        )}

        {activeTab === 'layout' && (
        <SettingsSection label="Layout" description="Size and background. Set your OBS Browser Source to the same dimensions.">
          <SettingsRow title="Presets">
            <div className="flex flex-wrap gap-2">
              {SIZE_PRESETS.map((p) => {
                const active = style.width === p.width && style.height === p.height;
                return (
                  <button
                    key={p.label}
                    onClick={() => setStyle((s) => ({ ...s, width: p.width, height: p.height }))}
                    style={{ borderRadius: 8 }}
                    className={`px-3 py-2 text-sm font-medium transition-all ${active ? 'glass-input text-textPrimary' : 'glass-button text-textSecondary hover:text-textPrimary'}`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </SettingsRow>
          <SettingsRow title="Width">
            <Slider value={style.width} min={OVERLAY_LIMITS.width.min} max={OVERLAY_LIMITS.width.max} step={10} onChange={(v) => set('width', Math.round(v))} format={(v) => `${v}px`} />
          </SettingsRow>
          <SettingsRow title="Height" description="Taller fits more chat on screen at once.">
            <Slider value={style.height} min={OVERLAY_LIMITS.height.min} max={OVERLAY_LIMITS.height.max} step={10} onChange={(v) => set('height', Math.round(v))} format={(v) => `${v}px`} />
          </SettingsRow>
          <SettingsRow title="Background" description="Transparent lets your scene show through. Solid draws a panel behind the chat.">
            <SegmentedSelect
              value={style.background}
              onChange={(v) => set('background', v)}
              options={[{ value: 'transparent', label: 'Transparent' }, { value: 'solid', label: 'Solid' }]}
            />
          </SettingsRow>
          {style.background === 'solid' && (
            <>
              <SettingsRow title="Background color" control={
                <input type="color" value={style.backgroundColor} onChange={(e) => set('backgroundColor', e.target.value)} className="h-7 w-10 rounded cursor-pointer bg-transparent border border-borderSubtle" />
              } />
              <SettingsRow title="Background opacity">
                <Slider value={style.backgroundOpacity} min={0} max={1} step={0.05} onChange={(v) => set('backgroundOpacity', v)} format={(v) => `${Math.round(v * 100)}%`} />
              </SettingsRow>
            </>
          )}
        </SettingsSection>
        )}

        {activeTab === 'appearance' && (
        <SettingsSection label="Text" description="Font, sizing, and legibility of the message text.">
          <SettingsRow title="Font" control={
            <Dropdown
              value={isCustomFont ? CUSTOM_FONT : style.fontFamily}
              options={fontOptions}
              onChange={(v) => set('fontFamily', v === CUSTOM_FONT ? CUSTOM_FONT_STARTER : v)}
              align="right"
            />
          } />
          {isCustomFont && (
            <SettingsRow title="Custom font" description="Type a font name and it loads automatically, here and on your overlay.">
              <div className="w-full space-y-2">
                <input
                  value={primaryFamilyName(style.fontFamily)}
                  onChange={(e) => set('fontFamily', `'${e.target.value.replace(/['"]/g, '')}', sans-serif`)}
                  placeholder="e.g. Poppins"
                  style={{ fontFamily: style.fontFamily }}
                  className="w-full min-w-0 rounded-lg bg-glass border border-borderLight px-3 py-1.5 text-sm text-textPrimary placeholder:text-textMuted focus:outline-none focus:border-accent/60"
                />
                <div className="rounded-lg bg-glass px-3 py-2.5 text-[12px] leading-relaxed text-textMuted space-y-1">
                  <p className="font-medium text-textSecondary">Getting a custom font</p>
                  <p>1. Browse free fonts at <span className="text-accent">fonts.google.com</span>.</p>
                  <p>2. Type the font's exact name above (e.g. <span className="text-textSecondary">Poppins</span>, <span className="text-textSecondary">Bebas Neue</span>, <span className="text-textSecondary">Rubik</span>).</p>
                  <p>3. It loads instantly, no download or install needed.</p>
                  <p className="pt-0.5">Any font already installed on your streaming PC also works, just type its name.</p>
                </div>
              </div>
            </SettingsRow>
          )}
          <SettingsRow title="Font size">
            <Slider value={style.fontSize} min={OVERLAY_LIMITS.fontSize.min} max={OVERLAY_LIMITS.fontSize.max} onChange={(v) => set('fontSize', v)} format={(v) => `${v}px`} />
          </SettingsRow>
          <SettingsRow title="Line height" description="Spacing within a wrapped message.">
            <Slider value={style.lineHeight} min={OVERLAY_LIMITS.lineHeight.min} max={OVERLAY_LIMITS.lineHeight.max} step={0.05} onChange={(v) => set('lineHeight', v)} format={(v) => v.toFixed(2)} />
          </SettingsRow>
          <SettingsRow title="Message spacing" description="Gap between messages.">
            <Slider value={style.messageGap} min={OVERLAY_LIMITS.messageGap.min} max={OVERLAY_LIMITS.messageGap.max} onChange={(v) => set('messageGap', v)} format={(v) => `${v}px`} />
          </SettingsRow>
          <SettingsRow title="Text color" control={
            <input type="color" value={style.bodyTextColor} onChange={(e) => set('bodyTextColor', e.target.value)} className="h-7 w-10 rounded cursor-pointer bg-transparent border border-borderSubtle" />
          } />
          <SettingsRow title="Text shadow" description="Dark outline behind text so it stays readable over any scene." control={<Toggle enabled={style.textShadow} onChange={() => set('textShadow', !style.textShadow)} />} />
          <SettingsRow title="Emoji style" description="Render every platform's emoji in one consistent style. System uses your machine's emoji font." control={<Dropdown value={style.emojiStyle} options={emojiStyleOptions} onChange={(v) => set('emojiStyle', v)} align="right" />} />
        </SettingsSection>
        )}

        {activeTab === 'appearance' && (
        <SettingsSection label="Messages" description="How messages render and flow.">
          <SettingsRow title="Emote size">
            <Slider value={style.emoteScale} min={OVERLAY_LIMITS.emoteScale.min} max={OVERLAY_LIMITS.emoteScale.max} step={0.05} onChange={(v) => set('emoteScale', v)} format={(v) => `${v.toFixed(2)}x`} />
          </SettingsRow>
          <SettingsRow title="Show badges" control={<Toggle enabled={style.showBadges} onChange={() => set('showBadges', !style.showBadges)} />} />
          <SettingsRow title="Badge size" disabled={!style.showBadges}>
            <Slider value={style.badgeScale} min={OVERLAY_LIMITS.badgeScale.min} max={OVERLAY_LIMITS.badgeScale.max} step={0.05} onChange={(v) => set('badgeScale', v)} format={(v) => `${v.toFixed(2)}x`} />
          </SettingsRow>
          <SettingsRow title="Third-party badges" description="7TV, FFZ, Chatterino, and more. Native platform badges use the toggle above." control={<Toggle enabled={style.showThirdPartyBadges} onChange={() => set('showThirdPartyBadges', !style.showThirdPartyBadges)} />} />
          <SettingsRow title="Badge providers" description="Show or hide each badge provider on its own. StreamNook is the member badge; the rest are third-party.">
            <div className="flex flex-wrap gap-2">
              {THIRD_PARTY_BADGE_PROVIDERS.map((p) => {
                const on = style.showThirdPartyBadges !== false && !(style.hiddenBadgeProviders ?? []).includes(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => toggleBadgeProvider(p.id)}
                    disabled={style.showThirdPartyBadges === false}
                    style={{ borderRadius: 8 }}
                    className={`px-3 py-2 text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed ${on ? 'glass-input text-textPrimary' : 'glass-button text-textSecondary hover:text-textPrimary'}`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </SettingsRow>
          <SettingsRow title="7TV paints" description="Colored and animated username gradients." control={<Toggle enabled={style.showPaints} onChange={() => set('showPaints', !style.showPaints)} />} />
          <SettingsRow title="StreamNook atmospheres" description="A member's equipped atmosphere: the animated wash behind their own message only. Separate from event styles and your overlay's background." control={<Toggle enabled={style.showAtmospheres} onChange={() => set('showAtmospheres', !style.showAtmospheres)} />} />
          <SettingsRow title="Show timestamps" control={<Toggle enabled={style.showTimestamps} onChange={() => set('showTimestamps', !style.showTimestamps)} />} />
          <SettingsRow title="New messages" description="Where incoming messages appear.">
            <SegmentedSelect
              value={style.direction}
              onChange={(v) => set('direction', v)}
              options={[{ value: 'newBottom', label: 'Bottom' }, { value: 'newTop', label: 'Top' }]}
            />
          </SettingsRow>
          <SettingsRow title="Entrance" description="Animation for each incoming message.">
            <SegmentedSelect
              value={style.entrance}
              onChange={(v) => set('entrance', v)}
              options={[{ value: 'none', label: 'None' }, { value: 'fade', label: 'Fade' }, { value: 'slide', label: 'Slide' }, { value: 'pop', label: 'Pop' }]}
            />
          </SettingsRow>
        </SettingsSection>
        )}

        {activeTab === 'filters' && (
        <>
        <SettingsSection label="Filters" description="Keep bots and command spam out of the overlay.">
          <SettingsRow title="Hide bot messages" description="Filter out known chat bots (Nightbot, StreamElements, and more) and users with a bot badge." control={<Toggle enabled={style.hideBots} onChange={() => set('hideBots', !style.hideBots)} />} />
          <p className="px-1 pt-1 text-[12px] leading-relaxed text-textMuted">
            Auto-hiding catches common bots, but channel bots vary and some slip through. For anyone it misses, hide them by name under Hidden accounts below.
          </p>
          <SettingsRow title="Hide command messages" description="Hide chat commands like !title. Pick which below." control={<Toggle enabled={style.hideCommands} onChange={() => set('hideCommands', !style.hideCommands)} />} />
          {style.hideCommands && (
            <SettingsRow title="Commands to hide">
              <CommandFilterEditor filters={style.commandFilters ?? []} onAdd={addCommandFilter} onRemove={removeCommandFilter} />
            </SettingsRow>
          )}
        </SettingsSection>
        <SettingsSection label="Hidden accounts" description="Hide specific people per source, matched on username or display name (either case). Perfect for a bot the auto-filter misses, like PotatBotat.">
          {sources.length === 0 ? (
            <p className="py-3 text-[13px] text-textMuted">Add a source first, then hide accounts on it.</p>
          ) : (
            sources.map((s) => (
              <BlockRow
                key={sourceKey(s)}
                source={s}
                blocked={style.blockedUsers?.[sourceKey(s)] ?? []}
                onAddBlocked={(n) => addBlockedUser(s, n)}
                onRemoveBlocked={(n) => removeBlockedUser(s, n)}
              />
            ))
          )}
        </SettingsSection>
        </>
        )}

        {activeTab === 'events' && (
        <SettingsSection label="Events" description="Subs, gifts, raids, and more. How they look and which ones show.">
          <SettingsRow title="Event style" description="Both show the sender's badges and paint name. StreamNook adds our signature multi-color gradient wash; Plain keeps a subtle per-platform tint.">
            <SegmentedSelect
              value={style.eventStyle}
              onChange={(v) => set('eventStyle', v)}
              options={[{ value: 'plain', label: 'Plain' }, { value: 'streamnook', label: 'StreamNook' }]}
            />
          </SettingsRow>
          <SettingsRow title="Show events" description="Hide an event type across every platform.">
            <div className="flex flex-wrap gap-2">
              {EVENT_CATEGORIES.map((c) => {
                const on = !(style.hiddenEvents ?? []).includes(c.id);
                return (
                  <button
                    key={c.id}
                    onClick={() => toggleEvent(c.id)}
                    style={{ borderRadius: 8 }}
                    className={`px-3 py-2 text-sm font-medium transition-all ${on ? 'glass-input text-textPrimary' : 'glass-button text-textSecondary hover:text-textPrimary'}`}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          </SettingsRow>
          {sourceProviders.filter((p) => (PROVIDER_EVENT_CATEGORIES[p] ?? []).length > 0).map((provider) => (
            <SettingsRow
              key={`pe-${provider}`}
              title={<span className="inline-flex items-center gap-1.5"><ProviderIcon provider={provider} size="14px" /> {PROVIDERS[provider].label} events</span> as unknown as string}
              description={`Turn off specific ${PROVIDERS[provider].label} events without affecting other platforms.`}
            >
              <div className="flex flex-wrap gap-2">
                {(PROVIDER_EVENT_CATEGORIES[provider] ?? []).map((cat) => {
                  const key = `${provider}:${cat}`;
                  const on = !(style.hiddenProviderEvents ?? []).includes(key) && !(style.hiddenEvents ?? []).includes(cat);
                  const globallyOff = (style.hiddenEvents ?? []).includes(cat);
                  return (
                    <button
                      key={key}
                      onClick={() => toggleProviderEvent(key)}
                      disabled={globallyOff}
                      style={{ borderRadius: 8 }}
                      className={`px-3 py-2 text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed ${on ? 'glass-input text-textPrimary' : 'glass-button text-textSecondary hover:text-textPrimary'}`}
                    >
                      {catLabel(cat)}
                    </button>
                  );
                })}
              </div>
            </SettingsRow>
          ))}
          {sourceProviders.includes('youtube') && (
            <SettingsRow
              title="Super Chat currency"
              description="Convert every YouTube Super Chat into one currency, or show each as it was sent."
              control={<Dropdown value={style.superchatCurrency} options={currencyOptions} onChange={(v) => set('superchatCurrency', v)} align="right" />}
            />
          )}
        </SettingsSection>
        )}

        <div className="settings-card px-4 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-textPrimary">Overlay URL</div>
              <p className="mt-0.5 text-[12px] leading-relaxed text-textSecondary">
                {publishState === 'error' ? (
                  <span className="text-red-400">{publishError}</span>
                ) : publishState === 'done' && publishedUrl ? (
                  <>Copied. Paste into an OBS Browser Source. It stays in sync as you tweak here, no need to re-copy. <span className="text-textPrimary break-all">{publishedUrl}</span></>
                ) : (
                  'Publish once to get a permanent OBS Browser Source link. It stays in sync as you tweak here, no need to re-copy.'
                )}
              </p>
              <div
                className="mt-2 flex items-start gap-2 rounded-lg px-2.5 py-2 text-[12px] leading-relaxed"
                style={{ background: 'rgba(245,158,11,0.14)', boxShadow: 'inset 0 0 0 1px rgba(245,158,11,0.45)' }}
              >
                <AlertTriangle size={14} className="flex-shrink-0 mt-[1px]" style={{ color: '#f59e0b' }} />
                <span style={{ color: '#f2b13a' }}>
                  Set the OBS Browser Source Width &amp; Height to{' '}
                  <span className="font-semibold tabular-nums" style={{ color: '#ffc23d' }}>{style.width} × {style.height}</span>
                  , the same as your Layout size above. OBS crops to the source size, it won't grow to fit the overlay.
                </span>
              </div>
            </div>
            <Tooltip content={sources.length === 0 ? 'Add a source first' : 'Publish and copy the OBS link'}>
              <button
                onClick={publish}
                disabled={publishState === 'publishing' || sources.length === 0}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium glass-button text-textPrimary flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Link2 size={14} /> {publishState === 'publishing' ? 'Publishing…' : publishState === 'done' ? 'Copied!' : 'Copy overlay URL'}
              </button>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* ── Preview studio ───────────────────────────────────────── */}
      <div className="lg:sticky lg:top-2 self-start space-y-3">
        <div className="flex items-center justify-between px-1 gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <SegmentedSelect
              value={previewMode}
              onChange={setPreviewMode}
              options={[{ value: 'sample', label: 'Sample' }, { value: 'live', label: 'Live chat' }]}
            />
            {previewMode === 'sample' && (
              <Tooltip content={flow ? 'Pause the demo chat' : 'Play a live-feeling demo chat'}>
                <button
                  onClick={() => setFlow((f) => !f)}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-textSecondary hover:text-textPrimary transition-colors"
                >
                  {flow ? <Pause size={13} /> : <Play size={13} />} {flow ? 'Flowing' : 'Flow'}
                </button>
              </Tooltip>
            )}
            <span className="text-[11px] text-textMuted tabular-nums">{style.width}×{style.height}</span>
          </div>
          <div className="flex items-center gap-2">
            <Tooltip content="Preview only. These backdrops just let you check your overlay against different scenes. They don't change your published overlay, that's the Layout background.">
              <span className="text-[11px] text-textMuted cursor-help">Backdrop</span>
            </Tooltip>
            <SegmentedSelect
              value={sceneBg}
              onChange={setSceneBg}
              options={[{ value: 'scene', label: 'Scene' }, { value: 'checker', label: 'Alpha' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]}
            />
          </div>
        </div>

        {/* The scene fills the pane so the overlay reads as sitting in a real
            layout, not floating in empty space; the canvas is centered and framed
            at true proportion inside it. */}
        <div
          ref={stageWrapRef}
          className="relative w-full flex items-center justify-center rounded-2xl overflow-hidden"
          style={{ height: maxStageH, ...SCENE_STYLES[sceneBg], boxShadow: 'inset 0 0 0 1px rgba(151,177,185,0.16), 0 24px 60px -30px rgba(0,0,0,0.75)' }}
        >
          {sceneBg === 'scene' && (
            <div
              aria-hidden
              className="absolute inset-0 pointer-events-none"
              style={{
                backgroundImage:
                  'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
                backgroundSize: '34px 34px',
                maskImage: 'radial-gradient(92% 88% at 50% 45%, #000, transparent)',
                WebkitMaskImage: 'radial-gradient(92% 88% at 50% 45%, #000, transparent)',
              }}
            />
          )}
          <div
            className="relative"
            style={{ width: Math.round(style.width * scale), height: Math.round(style.height * scale), borderRadius: 8, overflow: 'hidden', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)' }}
          >
            <div style={{ position: 'absolute', top: 0, left: 0, width: style.width, height: style.height, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
              {previewMode === 'sample' ? (
                flow ? (
                  <SampleFlowFeed style={style} />
                ) : (
                  <OverlayChat messages={SAMPLE_MESSAGES} style={style} superSample={2} />
                )
              ) : (
                // Kept mounted through all add/remove/swap so the feed diffs
                // connections instead of remounting (which raced the bridge).
                <LiveOverlayFeed sources={sources} style={style} superSample={2} />
              )}
            </div>
          </div>
        </div>

        <p className="px-1 text-[12px] leading-relaxed text-textMuted">
          {previewMode === 'sample'
            ? 'Sample chat rendered through the real overlay code.'
            : 'Merged live chat through the real overlay renderer.'}{' '}
          Backdrops restyle only this preview, never your published overlay.
        </p>
      </div>
    </div>
  );
};

export default OverlaySettings;
