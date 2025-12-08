import { useAppStore } from '../../stores/AppStore';

const CacheSettings = () => {
  const { settings, updateSettings } = useAppStore();

  // Toggle component for reuse
  const Toggle = ({ enabled, onChange }: { enabled: boolean; onChange: () => void }) => (
    <button
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${enabled ? 'bg-accent' : 'bg-gray-600'
        }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'
          }`}
      />
    </button>
  );

  return (
    <div className="space-y-6">
      {/* Enable Cache */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <span className="text-sm font-medium text-textPrimary">Enable Cache</span>
          <p className="text-xs text-textSecondary">
            Cache emotes and badges to speed up loading
          </p>
        </div>
        <Toggle
          enabled={settings.cache?.enabled ?? true}
          onChange={() =>
            updateSettings({
              ...settings,
              cache: { ...settings.cache, enabled: !(settings.cache?.enabled ?? true) },
            })
          }
        />
      </div>

      {/* Cache Expiry */}
      <div>
        <label className="block text-sm font-medium text-textPrimary mb-2">
          Cache Expiry: {settings.cache?.expiry_days ?? 7} days
        </label>
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
        <p className="text-xs text-textSecondary mt-1">
          How long to keep cached data before refreshing
        </p>
      </div>

      {/* Cache Statistics */}
      <div>
        <button
          onClick={async () => {
            try {
              const { invoke } = await import('@tauri-apps/api/core');
              const stats = (await invoke('get_cache_statistics')) as {
                total_files: number;
                total_size_bytes: number;
                cache_dir: string;
              };
              const sizeMB = (stats.total_size_bytes / (1024 * 1024)).toFixed(2);
              const { addToast } = useAppStore.getState();
              addToast(`Cache: ${stats.total_files} files, ${sizeMB} MB`, 'info');
            } catch (error) {
              console.error('Failed to get cache stats:', error);
              const { addToast } = useAppStore.getState();
              addToast('Failed to get cache statistics: ' + error, 'error');
            }
          }}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded transition-all mr-2"
        >
          View Cache Info
        </button>
        <button
          onClick={async () => {
            try {
              const { invoke } = await import('@tauri-apps/api/core');
              await invoke('clear_cache');
              const { addToast } = useAppStore.getState();
              addToast('Cache cleared successfully!', 'success');
            } catch (error) {
              console.error('Failed to clear cache:', error);
              const { addToast } = useAppStore.getState();
              addToast('Failed to clear cache: ' + error, 'error');
            }
          }}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded transition-all"
        >
          Clear Cache
        </button>
        <p className="text-xs text-textSecondary mt-2">
          View cache statistics or delete all cached emotes and badges
        </p>
      </div>
    </div>
  );
};

export default CacheSettings;
