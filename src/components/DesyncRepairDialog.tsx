import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AlertTriangle, RefreshCw, X, ExternalLink, Loader2 } from 'lucide-react';
import { Logger } from '../utils/logger';
import { useAppStore } from '../stores/AppStore';

interface InstallDesync {
  desynced: boolean;
  binary_version: string;
  manifest_version: string | null;
}

const RELEASE_PAGE = 'https://github.com/winters27/StreamNook/releases/latest';

const DesyncRepairDialog = () => {
  const { addToast } = useAppStore();
  const [info, setInfo] = useState<InstallDesync | null>(null);
  const [open, setOpen] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [progress, setProgress] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await invoke<InstallDesync>('check_install_desync');
        if (cancelled) return;
        setInfo(result);
        if (result.desynced) {
          Logger.warn(
            `Install desync detected: binary=${result.binary_version}, manifest=${result.manifest_version}`
          );
          setOpen(true);
        }
      } catch (e) {
        Logger.error('check_install_desync failed:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<string>('bundle-update-progress', (event) => {
      setProgress(event.payload);
    });
    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const handleRepair = async () => {
    setRepairing(true);
    setProgress('Starting repair...');
    try {
      await invoke('reinstall_latest_bundle');
    } catch (e) {
      Logger.error('reinstall_latest_bundle failed:', e);
      addToast(`Repair failed: ${e}. Try the manual recovery instead.`, 'error');
      setRepairing(false);
      setProgress('');
    }
  };

  const handleOpenReleasePage = async () => {
    try {
      await invoke('open_browser_url', { url: RELEASE_PAGE });
    } catch (e) {
      Logger.error('open_browser_url failed:', e);
    }
  };

  if (!info?.desynced) return null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => !repairing && setOpen(false)}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 320 }}
            className="bg-glass border border-borderColor rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-borderColor">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-amber-500/15 text-amber-400">
                  <AlertTriangle size={22} />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-textPrimary">
                    Your install needs a repair
                  </h2>
                  <p className="text-xs text-textSecondary">
                    The last update didn't fully apply
                  </p>
                </div>
              </div>
              {!repairing && (
                <button
                  onClick={() => setOpen(false)}
                  className="p-2 text-textSecondary hover:text-textPrimary hover:bg-glass rounded-lg transition-colors"
                  aria-label="Dismiss"
                >
                  <X size={18} />
                </button>
              )}
            </div>

            <div className="p-4 space-y-3">
              <p className="text-sm text-textSecondary">
                StreamNook is running version{' '}
                <span className="text-textPrimary font-medium">{info.binary_version}</span>{' '}
                but the installed components claim version{' '}
                <span className="text-textPrimary font-medium">
                  {info.manifest_version ?? 'unknown'}
                </span>
                . This happens when a previous update was interrupted (usually by
                antivirus locking the file mid-swap), so part of the new release
                was copied in and part wasn't.
              </p>

              <div className="p-3 bg-amber-500/8 border border-amber-500/25 rounded-lg">
                <p className="text-xs text-textPrimary font-medium mb-1">
                  Repair will:
                </p>
                <ul className="text-xs text-textSecondary list-disc list-inside space-y-0.5 pl-1">
                  <li>Re-download the latest release</li>
                  <li>Replace the binary with retry logic that survives AV locks</li>
                  <li>Restart StreamNook on success</li>
                </ul>
              </div>

              {repairing && progress && (
                <div className="flex items-center gap-2 text-xs text-textSecondary">
                  <Loader2 size={14} className="animate-spin" />
                  <span>{progress}</span>
                </div>
              )}

              <details className="text-xs text-textSecondary">
                <summary className="cursor-pointer hover:text-textPrimary">
                  Manual recovery (if automatic repair keeps failing)
                </summary>
                <ol className="mt-2 list-decimal list-inside space-y-1 pl-1">
                  <li>Close StreamNook completely.</li>
                  <li>
                    Download <code className="text-accent">StreamNook.7z</code>{' '}
                    from the latest release.
                  </li>
                  <li>Extract over your install folder, overwriting all files.</li>
                  <li>Launch StreamNook again.</li>
                </ol>
                <button
                  onClick={handleOpenReleasePage}
                  className="mt-2 inline-flex items-center gap-1 text-accent hover:underline"
                >
                  Open release page <ExternalLink size={11} />
                </button>
              </details>
            </div>

            <div className="flex items-center justify-end gap-2 p-4 border-t border-borderColor">
              {!repairing && (
                <button
                  onClick={() => setOpen(false)}
                  className="px-3 py-2 text-sm text-textSecondary hover:text-textPrimary transition-colors"
                >
                  Not now
                </button>
              )}
              <button
                onClick={handleRepair}
                disabled={repairing}
                className="px-4 py-2 glass-button text-white text-sm font-medium rounded inline-flex items-center gap-2 disabled:opacity-60"
              >
                {repairing ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Repairing
                  </>
                ) : (
                  <>
                    <RefreshCw size={14} />
                    Repair install
                  </>
                )}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default DesyncRepairDialog;
