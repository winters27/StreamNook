import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BadgeCheck,
  CalendarDays,
  CalendarClock,
  Download,
  ExternalLink,
  Package,
  PackageCheck,
  Puzzle,
  X,
} from 'lucide-react';
import { IndexEntry, PluginInfo, PluginTier, compareVersions } from '../../types/plugins';
import TierBadge from './TierBadge';
import OfficialBadge from './OfficialBadge';
import MarkdownLite from './MarkdownLite';
import { Tooltip } from '../ui/Tooltip';
import { Logger } from '../../utils/logger';

const TILE_BEVEL =
  'inset 1px 1px 0 0 rgba(255,255,255,0.10), inset -1px -1px 0 0 rgba(0,0,0,0.18)';

const TIER_WASH: Record<PluginTier, string> = {
  A: 'linear-gradient(160deg, rgba(110, 200, 160, 0.14), rgba(110, 200, 160, 0.03))',
  B: 'linear-gradient(160deg, rgba(225, 185, 120, 0.14), rgba(225, 185, 120, 0.03))',
  C: 'linear-gradient(160deg, rgba(225, 130, 130, 0.14), rgba(225, 130, 130, 0.03))',
};

const openExternal = async (url: string) => {
  try {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } catch (err) {
    Logger.error('Failed to open external URL:', err);
    window.open(url, '_blank');
  }
};

const formatDate = (value: string | null | undefined) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const Stat = ({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) => (
  <span className="inline-flex items-center gap-1.5 text-[11.5px] text-textSecondary">
    <span className="text-textMuted">{icon}</span>
    <span className="text-textMuted">{label}</span>
    <span className="font-medium text-textPrimary">{value}</span>
  </span>
);

interface Props {
  entry: IndexEntry | null;
  sourceName: string;
  installed: PluginInfo | undefined;
  busy: boolean;
  onInstall: (entry: IndexEntry) => void;
  onClose: () => void;
}

/**
 * Marketplace detail page for an index entry: banner, identity row with the
 * primary action, README body, and a stats footer. README markdown comes
 * from the entry's readme_url and renders as plain markdown.
 */
const PluginDetailOverlay = ({ entry, sourceName, installed, busy, onInstall, onClose }: Props) => {
  // Keyed by entry id so a stale fetch never renders under another entry and
  // no synchronous state reset is needed when the entry changes.
  const [readmeResult, setReadmeResult] = useState<{ forId: string; text: string | null } | null>(
    null
  );

  useEffect(() => {
    if (!entry?.readme_url) return;
    let cancelled = false;
    const forId = entry.id;
    invoke<string>('plugins_fetch_readme', { url: entry.readme_url })
      .then((text) => {
        if (!cancelled) setReadmeResult({ forId, text });
      })
      .catch((err) => {
        Logger.error('[Plugins] readme fetch failed:', err);
        if (!cancelled) setReadmeResult({ forId, text: null });
      });
    return () => {
      cancelled = true;
    };
  }, [entry]);

  const readme = readmeResult?.forId === entry?.id ? readmeResult?.text ?? null : null;
  const readmeLoading =
    Boolean(entry?.readme_url) && (readmeResult === null || readmeResult.forId !== entry?.id);

  const isInstalled = Boolean(entry && installed);
  const hasUpdate = Boolean(
    entry && installed && compareVersions(entry.version, installed.version) > 0
  );
  const actionLabel = hasUpdate ? 'Update' : isInstalled ? 'Installed' : 'Install';
  const actionDisabled = busy || (isInstalled && !hasUpdate);

  const created = formatDate(entry?.created_at ?? entry?.released_at);
  const updated = formatDate(entry?.updated_at);

  return (
    <AnimatePresence>
      {entry && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[290] flex items-center justify-center bg-black/60 backdrop-blur-sm"
        >
          <div className="absolute inset-0" onClick={onClose} />
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 14 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 14 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            className="glass-panel relative z-10 flex max-h-[86vh] w-[620px] max-w-[92vw] flex-col overflow-hidden"
          >
            {/* Banner */}
            <div className="relative h-36 flex-shrink-0 overflow-hidden">
              {entry.banner_url ? (
                <img
                  src={entry.banner_url}
                  alt=""
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div
                  className="flex h-full w-full items-center justify-center"
                  style={{ background: TIER_WASH[entry.tier] }}
                >
                  <Puzzle size={56} strokeWidth={1.5} className="text-white/[0.07]" />
                </div>
              )}
              <Tooltip content="Close" delay={200}>
                <button
                  type="button"
                  onClick={onClose}
                  className="absolute right-3 top-3 rounded-md bg-black/40 p-1.5 text-textSecondary backdrop-blur-sm transition-colors hover:bg-black/60 hover:text-textPrimary"
                >
                  <X size={15} />
                </button>
              </Tooltip>
            </div>

            {/* Identity row */}
            <div className="flex flex-shrink-0 items-center gap-3.5 px-5 py-4">
              <div
                className="flex h-12 w-12 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl"
                style={
                  entry.icon_url
                    ? undefined
                    : { backgroundImage: TIER_WASH[entry.tier], boxShadow: TILE_BEVEL }
                }
              >
                {entry.icon_url ? (
                  <img src={entry.icon_url} alt="" className="h-full w-full object-cover" />
                ) : (
                  <Puzzle size={22} strokeWidth={2} className="text-textPrimary" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[15px] font-semibold text-textPrimary">
                    {entry.name}
                  </span>
                  {entry.official && <OfficialBadge />}
                  <TierBadge tier={entry.tier} />
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-textSecondary">
                  <span className="truncate">{entry.author.name}</span>
                  {entry.author.verified && (
                    <Tooltip content={`Identity verified by ${sourceName}`} delay={200}>
                      <BadgeCheck size={13} className="flex-shrink-0 text-accent" />
                    </Tooltip>
                  )}
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1.5">
                {entry.homepage && (
                  <Tooltip content="Open homepage" delay={200}>
                    <button
                      type="button"
                      onClick={() => openExternal(entry.homepage!)}
                      className="rounded-md p-2 text-textMuted transition-colors hover:bg-white/[0.06] hover:text-textPrimary"
                    >
                      <ExternalLink size={15} />
                    </button>
                  </Tooltip>
                )}
                <button
                  type="button"
                  disabled={actionDisabled}
                  onClick={() => onInstall(entry)}
                  className={`flex items-center gap-1.5 rounded-lg border px-4 py-2 text-[13px] font-medium transition-colors ${
                    actionDisabled
                      ? 'cursor-default border-white/10 bg-white/5 text-textMuted'
                      : 'border-accent/25 bg-accent/15 text-textPrimary hover:bg-accent/25'
                  }`}
                >
                  {isInstalled && !hasUpdate ? (
                    <PackageCheck size={14} />
                  ) : (
                    <Download size={14} />
                  )}
                  {actionLabel}
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 pb-4">
              <div className="rounded-lg bg-white/[0.02] px-4 py-3.5">
                {readme ? (
                  <MarkdownLite content={readme} />
                ) : readmeLoading ? (
                  <p className="text-[12.5px] text-textMuted">Loading description...</p>
                ) : (
                  <p className="text-[12.5px] leading-relaxed text-textSecondary">
                    {entry.description}
                  </p>
                )}
              </div>
            </div>

            {/* Stats footer */}
            <div className="flex flex-shrink-0 flex-wrap items-center justify-center gap-x-5 gap-y-1.5 border-t border-white/[0.06] px-5 py-3">
              {typeof entry.downloads === 'number' && (
                <Stat
                  icon={<Download size={12} />}
                  label="Downloads"
                  value={entry.downloads.toLocaleString()}
                />
              )}
              {created && <Stat icon={<CalendarDays size={12} />} label="Created" value={created} />}
              {updated && <Stat icon={<CalendarClock size={12} />} label="Updated" value={updated} />}
              <Stat icon={<Package size={12} />} label="Version" value={entry.version} />
              {installed && (
                <Stat
                  icon={<PackageCheck size={12} />}
                  label="Installed"
                  value={installed.version}
                />
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default PluginDetailOverlay;
