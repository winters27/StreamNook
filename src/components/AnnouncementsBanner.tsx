import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, Info, AlertOctagon, X, ExternalLink } from 'lucide-react';
import { Logger } from '../utils/logger';

interface AnnouncementAction {
  label: string;
  url: string;
}

interface Announcement {
  id: string;
  severity: 'critical' | 'warning' | 'info' | string;
  title: string;
  body: string;
  min_version?: string | null;
  max_version?: string | null;
  dismissible?: boolean | null;
  action?: AnnouncementAction | null;
}

interface AnnouncementsFile {
  version: number;
  announcements: Announcement[];
}

interface BinaryInfo {
  binary_version: string;
}

const POLL_INTERVAL_MS = 30 * 60 * 1000;
const DISMISSED_STORAGE_KEY = 'streamnook_dismissed_announcements_v1';

const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
};

const loadDismissed = (): Set<string> => {
  try {
    const raw = localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
};

const saveDismissed = (ids: Set<string>) => {
  try {
    localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // localStorage full or unavailable; lose the dismissal silently
  }
};

const severityTone = (severity: string) => {
  switch (severity) {
    case 'critical':
      return {
        wrap: 'bg-red-500/10 border-red-500/30',
        icon: 'text-red-400',
        Icon: AlertOctagon,
      };
    case 'warning':
      return {
        wrap: 'bg-amber-500/10 border-amber-500/30',
        icon: 'text-amber-400',
        Icon: AlertTriangle,
      };
    default:
      return {
        wrap: 'bg-blue-500/10 border-blue-500/30',
        icon: 'text-blue-400',
        Icon: Info,
      };
  }
};

const AnnouncementsBanner = () => {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [binaryVersion, setBinaryVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());

  const fetchOnce = useCallback(async () => {
    try {
      const file = await invoke<AnnouncementsFile>('fetch_announcements');
      setAnnouncements(file.announcements ?? []);
    } catch (e) {
      Logger.warn('fetch_announcements failed:', e);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const info = await invoke<BinaryInfo>('check_install_desync');
        setBinaryVersion(info.binary_version);
      } catch (e) {
        Logger.warn('check_install_desync failed (binary version unknown):', e);
      }
    })();
  }, []);

  useEffect(() => {
    fetchOnce();
    const id = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchOnce]);

  const dismiss = (id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveDismissed(next);
      return next;
    });
  };

  const handleAction = async (url: string) => {
    try {
      await invoke('open_browser_url', { url });
    } catch (e) {
      Logger.error('open_browser_url failed:', e);
    }
  };

  const visible = announcements.filter((a) => {
    if (dismissed.has(a.id)) return false;
    if (binaryVersion) {
      if (a.min_version && compareVersions(binaryVersion, a.min_version) < 0) return false;
      if (a.max_version && compareVersions(binaryVersion, a.max_version) > 0) return false;
    }
    return true;
  });

  if (visible.length === 0) return null;

  return (
    <div className="fixed top-12 right-4 z-[150] flex flex-col gap-2 max-w-sm pointer-events-none">
      <AnimatePresence>
        {visible.map((a) => {
          const tone = severityTone(a.severity);
          const { Icon } = tone;
          const allowDismiss = a.dismissible !== false;
          return (
            <motion.div
              key={a.id}
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className={`pointer-events-auto rounded-lg border ${tone.wrap} backdrop-blur-md p-3 shadow-lg`}
            >
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 ${tone.icon}`}>
                  <Icon size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-textPrimary">{a.title}</h3>
                    {allowDismiss && (
                      <button
                        onClick={() => dismiss(a.id)}
                        className="text-textSecondary hover:text-textPrimary"
                        aria-label="Dismiss"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-textSecondary whitespace-pre-line">
                    {a.body}
                  </p>
                  {a.action && (
                    <button
                      onClick={() => handleAction(a.action!.url)}
                      className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline"
                    >
                      {a.action.label} <ExternalLink size={11} />
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
};

export default AnnouncementsBanner;
