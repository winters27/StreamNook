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
  X,
} from 'lucide-react';
import { IndexEntry, PluginInfo, compareVersions } from '../../types/plugins';
import TierBadge from './TierBadge';
import OfficialBadge from './OfficialBadge';
import MarkdownLite from './MarkdownLite';
import { Tooltip } from '../ui/Tooltip';
import { Logger } from '../../utils/logger';
import PluginIcon from './PluginIcon';
import InstalledBadge from './InstalledBadge';

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
            {/* Close */}
            <div className="flex flex-shrink-0 items-center justify-end px-3 pt-2.5">
              <Tooltip content="Close" delay={200}>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md p-1.5 text-textSecondary transition-colors hover:bg-white/10 hover:text-textPrimary"
                >
                  <X size={16} />
                </button>
              </Tooltip>
            </div>

            {/* Identity row */}
            <div className="flex flex-shrink-0 items-center gap-3.5 px-5 py-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[16px] font-semibold text-textPrimary">
                    {entry.name}
                  </span>
                  {entry.official && <OfficialBadge />}
                  <TierBadge tier={entry.tier} />
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[12px] text-textSecondary">
                  <PluginIcon
                    iconUrl={entry.icon_url}
                    official={!!entry.official}
                    author={entry.author.name}
                    tier={entry.tier}
                    sizeClass="h-5 w-5 rounded"
                    glyphSize={12}
                  />
                  <span className="truncate">by {entry.author.name}</span>
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
                {isInstalled && !hasUpdate ? (
                  <InstalledBadge />
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onInstall(entry)}
                    className="glass-button flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium text-accent disabled:cursor-default disabled:text-textMuted"
                  >
                    <Download size={14} />
                    {hasUpdate ? 'Update' : 'Install'}
                  </button>
                )}
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
