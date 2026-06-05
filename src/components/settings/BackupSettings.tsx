import { useEffect, useState } from 'react';
import { FolderOpen, Download, Upload, type LucideIcon } from 'lucide-react';
import { useAppStore } from '../../stores/AppStore';
import { SettingsSection, SettingsRow } from './_primitives';
import { Logger } from '../../utils/logger';

// Local YYYY-MM-DD for a friendly default backup filename.
const dateStamp = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

type Busy = null | 'open' | 'export' | 'import';

const ActionButton = ({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled: boolean;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    style={{ borderRadius: 10 }}
    className="glass-button flex items-center gap-2 px-3.5 py-2 text-[13px] font-medium text-textPrimary transition-all hover:text-textPrimary disabled:cursor-default disabled:opacity-50"
  >
    <Icon size={15} strokeWidth={2} />
    {label}
  </button>
);

const BackupSettings = () => {
  const [dir, setDir] = useState<string>('');
  const [busy, setBusy] = useState<Busy>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const resolved = await invoke<string>('get_settings_dir');
        if (!cancelled) setDir(resolved);
      } catch (e) {
        Logger.error('Failed to resolve settings folder:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openFolder = async () => {
    setBusy('open');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_settings_folder');
    } catch (e) {
      Logger.error('Failed to open settings folder:', e);
      useAppStore.getState().addToast('Could not open the settings folder.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const exportSettings = async () => {
    setBusy('export');
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const path = await save({
        title: 'Export StreamNook settings',
        defaultPath: `streamnook-settings-${dateStamp()}.json`,
        filters: [{ name: 'StreamNook settings', extensions: ['json'] }],
      });
      if (!path) return; // cancelled
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('export_settings', { path });
      useAppStore.getState().addToast('Settings exported.', 'success');
    } catch (e) {
      Logger.error('Failed to export settings:', e);
      useAppStore.getState().addToast('Export failed: ' + e, 'error');
    } finally {
      setBusy(null);
    }
  };

  const importSettings = async () => {
    let reloading = false;
    setBusy('import');
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const path = await open({
        title: 'Import StreamNook settings',
        multiple: false,
        directory: false,
        filters: [{ name: 'StreamNook settings', extensions: ['json'] }],
      });
      if (!path || typeof path !== 'string') return; // cancelled
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('import_settings', { path });
      // The whole settings tree changed at once (theme, layout, keybindings,
      // highlights, ...). A reload re-runs startup so every subsystem picks up
      // the restored values cleanly rather than half-applying them.
      reloading = true;
      useAppStore.getState().addToast('Settings imported. Reloading...', 'success');
      setTimeout(() => window.location.reload(), 700);
    } catch (e) {
      Logger.error('Failed to import settings:', e);
      useAppStore.getState().addToast('Import failed: ' + e, 'error');
    } finally {
      if (!reloading) setBusy(null);
    }
  };

  return (
    <div className="space-y-8">
      <SettingsSection
        label="Settings file"
        description="Everything you customize in StreamNook (theme, chat layout, keybindings, highlight phrases, custom commands, player and notification preferences, and your custom themes) is saved in a single file on this PC. Your Twitch login is stored separately and is never part of a backup."
      >
        <SettingsRow
          title="Settings folder"
          description={dir || 'Resolving location...'}
          control={
            <ActionButton
              icon={FolderOpen}
              label="Open folder"
              onClick={openFolder}
              disabled={busy !== null}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        label="Backup and restore"
        description="Keep a copy of your setup so you can bring it back after a reset, a reinstall, or a move to a new PC."
      >
        <SettingsRow
          title="Export settings"
          description="Save a backup file wherever you like, such as a USB drive or a cloud-synced folder."
          control={
            <ActionButton
              icon={Download}
              label="Export"
              onClick={exportSettings}
              disabled={busy !== null}
            />
          }
        />
        <SettingsRow
          title="Import settings"
          description="Load a backup and apply it. This replaces your current preferences while leaving your Twitch login untouched. StreamNook reloads when it finishes."
          control={
            <ActionButton
              icon={Upload}
              label="Import"
              onClick={importSettings}
              disabled={busy !== null}
            />
          }
        />
      </SettingsSection>
    </div>
  );
};

export default BackupSettings;
