import { useAppStore } from '../../stores/AppStore';

const CacheSettings = () => {
  const { settings, updateSettings } = useAppStore();

  return (
    <div className="space-y-6">
      {/* Enable Cache */}
      <div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.cache?.enabled ?? true}
            onChange={(e) =>
              updateSettings({
                ...settings,
                cache: { ...settings.cache, enabled: e.target.checked },
              })
            }
            className="w-5 h-5 accent-accent cursor-pointer"
          />
          <div>
            <span className="text-sm font-medium text-textPrimary">Enable Cache</span>
            <p className="text-xs text-textSecondary">
              Cache emotes and badges to speed up loading
            </p>
          </div>
        </label>
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
