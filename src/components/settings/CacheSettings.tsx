import { useAppStore } from '../../stores/AppStore';
import { SettingsSection, SettingsRow } from './_primitives';
import { Toggle } from '../ui/Toggle';
import EmotePrefetchSection from './EmotePrefetchSection';

import { Logger } from '../../utils/logger';
const CacheSettings = () => {
  const { settings, updateSettings } = useAppStore();

  return (
    <div className="space-y-8">
      <SettingsSection label="Cache">
        <SettingsRow
          title="Enable Cache"
          description="Cache emotes and badges to speed up loading"
          control={
            <Toggle
              enabled={settings.cache?.enabled ?? true}
              onChange={() =>
                updateSettings({
                  ...settings,
                  cache: { ...settings.cache, enabled: !(settings.cache?.enabled ?? true) },
                })
              }
            />
          }
        />

        <SettingsRow
          title={`Cache Expiry: ${settings.cache?.expiry_days ?? 7} days`}
          description="How long to keep cached data before refreshing"
        >
          <input
            type="range"
            min="1"
            max="30"
            step="1"
            value={settings.cache?.expiry_days ?? 7}
            onChange={(e) =>
              updateSettings({
                ...settings,
                cache: { ...settings.cache, expiry_days: parseInt(e.target.value) },
              })
            }
            className="w-full accent-accent cursor-pointer"
          />
        </SettingsRow>

        <SettingsRow
          title="Cache Maintenance"
          description="View cache statistics or delete all cached emotes and badges"
        >
          <div className="flex gap-2">
            <button
              onClick={async () => {
                try {
                  const { invoke } = await import('@tauri-apps/api/core');
                  // The real cache (emotes/badges/cosmetics + the AFK prefetch) lives
                  // in the UNIVERSAL cache. The legacy get_cache_statistics only counts
                  // loose files in the cache root and misses cache/universal entirely.
                  const stats = (await invoke('get_universal_cache_statistics')) as {
                    total_entries: number;
                    entries_by_type: Record<string, number>;
                    cache_dir: string;
                  };
                  const parts = Object.entries(stats.entries_by_type || {})
                    .filter(([, n]) => n > 0)
                    .map(([t, n]) => `${n} ${t}`);
                  const summary = parts.length ? parts.join(', ') : 'empty';
                  Logger.debug('[Cache] Universal cache dir:', stats.cache_dir);
                  useAppStore.getState().addToast(`Cache: ${summary}`, 'info');
                } catch (error) {
                  Logger.error('Failed to get cache stats:', error);
                  useAppStore.getState().addToast('Failed to get cache statistics: ' + error, 'error');
                }
              }}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded transition-all"
            >
              View Cache Info
            </button>
            <button
              onClick={async () => {
                try {
                  const { invoke } = await import('@tauri-apps/api/core');
                  await invoke('open_universal_cache_folder');
                } catch (error) {
                  Logger.error('Failed to open cache folder:', error);
                  useAppStore.getState().addToast('Failed to open cache folder: ' + error, 'error');
                }
              }}
              className="px-4 py-2 bg-secondary hover:bg-surface-hover text-textPrimary text-sm font-medium rounded transition-all"
            >
              Open Folder
            </button>
            <button
              onClick={async () => {
                try {
                  const { invoke } = await import('@tauri-apps/api/core');
                  await invoke('clear_cache'); // legacy cache root
                  await invoke('clear_all_universal_cache'); // emotes/badges/cosmetics + prefetch
                  const { addToast } = useAppStore.getState();
                  addToast('Cache cleared successfully!', 'success');
                } catch (error) {
                  Logger.error('Failed to clear cache:', error);
                  const { addToast } = useAppStore.getState();
                  addToast('Failed to clear cache: ' + error, 'error');
                }
              }}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded transition-all"
            >
              Clear Cache
            </button>
          </div>
        </SettingsRow>
      </SettingsSection>

      <EmotePrefetchSection />
    </div>
  );
};

export default CacheSettings;
