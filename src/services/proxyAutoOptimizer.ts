/**
 * Proxy Auto-Optimizer Service
 * 
 * Runs on every app launch to ensure proxy routing is enabled and optimized.
 * - First launch: force-enables use_proxy + ttvlol_plugin, runs health check, applies fastest proxy
 * - Subsequent launches: re-checks health silently, updates if a faster proxy is found
 * - Respects user's intentional disable of proxy routing after first optimization
 * - Network-failure resilient: never overwrites good config with nothing
 */
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/AppStore';
import { useProxyHealthStore } from '../stores/proxyHealthStore';
import { Logger } from '../utils/logger';

/** localStorage key to track if proxy has been optimized at least once */
const PROXY_OPTIMIZED_KEY = 'streamnook-proxy-optimized';

/**
 * Run proxy optimization. Called from App.tsx on every launch via lazy import.
 */
export async function runProxyOptimization(): Promise<void> {
  try {
    const { settings, updateSettings, addToast } = useAppStore.getState();
    const streamlink = settings.streamlink;

    // Guard: settings not yet loaded (streamlink block missing entirely)
    if (!streamlink) {
      Logger.warn('[ProxyOptimizer] Settings not loaded yet, skipping');
      return;
    }

    const hasBeenOptimized = localStorage.getItem(PROXY_OPTIMIZED_KEY) === 'true';
    const currentPlaylist = streamlink.proxy_playlist || '';
    const isDefaultOrEmpty = !currentPlaylist ||
      currentPlaylist === '--twitch-proxy-playlist=https://lb-na.cdn-perfprod.com,https://eu.luminous.dev --twitch-proxy-playlist-fallback';

    // === FIRST-TIME SETUP ===
    // If proxy has never been optimized AND playlist is default/empty,
    // force-enable everything and run the optimization
    if (!hasBeenOptimized && isDefaultOrEmpty) {
      Logger.info('[ProxyOptimizer] First-time proxy optimization starting...');

      // Ensure both use_proxy AND ttvlol_plugin are enabled
      // (streaming.rs gates proxy args on ttvlol_plugin.enabled && plugin_installed)
      if (!streamlink.use_proxy || !settings.ttvlol_plugin?.enabled) {
        Logger.info('[ProxyOptimizer] Auto-enabling proxy routing and ttvlol plugin');
        await updateSettings({
          ...settings,
          streamlink: { ...streamlink, use_proxy: true },
          ttvlol_plugin: { ...settings.ttvlol_plugin, enabled: true },
        });
      }
    }

    // === EVERY-LAUNCH OPTIMIZATION ===
    // Only run health check if proxy routing is enabled (respect user toggle)
    const freshSettings = useAppStore.getState().settings;
    if (!freshSettings.streamlink?.use_proxy) {
      Logger.debug('[ProxyOptimizer] Proxy routing disabled by user, skipping optimization');
      return;
    }

    Logger.info('[ProxyOptimizer] Running background proxy health check...');

    // Run health check ONCE — directly via the store
    const { checkAllProxies } = useProxyHealthStore.getState();
    const response = await checkAllProxies();

    if (!response || response.healthy_count === 0) {
      Logger.warn('[ProxyOptimizer] No healthy proxies found, keeping current settings');
      return;
    }

    // Generate optimal args using the SAME response (no second health check)
    // Call the Rust command directly with the cached response
    let optimalArgs: string;
    try {
      optimalArgs = await invoke<string>('generate_optimal_proxy_args', {
        results: response,
        maxProxies: 3,
      });
    } catch (err) {
      Logger.error('[ProxyOptimizer] Failed to generate optimal args:', err);
      return;
    }

    if (!optimalArgs) {
      Logger.warn('[ProxyOptimizer] Empty optimal args returned');
      return;
    }

    Logger.info(`[ProxyOptimizer] Generated optimal args: ${optimalArgs.substring(0, 100)}...`);

    // Re-read settings (may have been updated in first-time block above)
    const latestSettings = useAppStore.getState().settings;
    const latestPlaylist = latestSettings.streamlink?.proxy_playlist || '';

    // Only update if the args actually changed
    if (optimalArgs !== latestPlaylist) {
      Logger.info(
        `[ProxyOptimizer] Applying optimized proxy: ${response.best_proxy?.name} ` +
        `(${response.best_proxy?.latency_ms}ms)`
      );
      const sl = latestSettings.streamlink!;
      await updateSettings({
        ...latestSettings,
        streamlink: {
          low_latency_enabled: sl.low_latency_enabled,
          hls_live_edge: sl.hls_live_edge,
          stream_timeout: sl.stream_timeout,
          retry_streams: sl.retry_streams,
          disable_hosting: sl.disable_hosting,
          skip_ssl_verify: sl.skip_ssl_verify,
          custom_streamlink_path: sl.custom_streamlink_path,
          use_proxy: true,
          proxy_playlist: optimalArgs,
        },
      });

      Logger.info('[ProxyOptimizer] ✅ Settings saved with optimized proxy');

      // Toast only on first optimization — subsequent updates are silent
      if (!hasBeenOptimized && response.best_proxy) {
        addToast(
          `Proxy optimized — using ${response.best_proxy.name} (${response.best_proxy.latency_ms}ms)`,
          'info'
        );
      }
    } else {
      Logger.debug('[ProxyOptimizer] Current proxy is already optimal, no changes needed');
    }

    // Mark that we've optimized at least once (so future launches don't force-enable)
    localStorage.setItem(PROXY_OPTIMIZED_KEY, 'true');
    Logger.info('[ProxyOptimizer] Proxy optimization complete');
  } catch (err) {
    Logger.error('[ProxyOptimizer] Optimization failed:', err);
    // Never crash the app — proxy optimization is non-critical
  }
}
