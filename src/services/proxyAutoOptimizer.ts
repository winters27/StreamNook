/**
 * Proxy Auto-Optimizer Service
 * 
 * Runs on every app launch to ensure proxy routing is enabled and optimized.
 * 
 * Behavior:
 * - First launch: force-enables use_proxy + ttvlol_plugin, runs health check, applies fastest proxy
 * - Subsequent launches (auto-optimized): re-checks silently, updates if meaningfully faster
 * - Manual override: respects user's intentional proxy selection, does NOT override
 * - Network-failure resilient: never overwrites good config with nothing
 * 
 * All persistence lives in settings.json (via Rust backend), NOT localStorage.
 * This survives WebView2 resets, app updates, and forced re-logins.
 */
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/AppStore';
import { useProxyHealthStore } from '../stores/proxyHealthStore';
import { Logger } from '../utils/logger';

/** Legacy localStorage key — migrated to settings.json, then removed */
const LEGACY_PROXY_OPTIMIZED_KEY = 'streamnook-proxy-optimized';

/** 
 * Minimum percentage improvement required to switch proxies on auto-optimization.
 * Prevents flip-flopping between proxies with similar latency.
 * 30% = the new proxy must be at least 30% faster to justify a switch.
 */
const MEANINGFUL_IMPROVEMENT_THRESHOLD = 0.30;

/**
 * Run proxy optimization. Called from App.tsx on every launch via lazy import.
 */
export async function runProxyOptimization(): Promise<void> {
  try {
    const { settings, updateSettings, addToast } = useAppStore.getState();
    const streamlink = settings.streamlink;

    // Guard: settings not yet loaded from disk
    if (!streamlink || settings.streamlink_path === undefined) {
      Logger.warn('[ProxyOptimizer] Settings not loaded yet, skipping');
      return;
    }

    // ──────────────────────────────────────────────────
    // ONE-TIME MIGRATION: Transfer localStorage flag → settings.json
    // ──────────────────────────────────────────────────
    const legacyOptimized = localStorage.getItem(LEGACY_PROXY_OPTIMIZED_KEY);
    if (legacyOptimized === 'true' && !streamlink.proxy_optimized_once) {
      Logger.info('[ProxyOptimizer] Migrating localStorage flag to settings.json');
      await updateSettings({
        ...settings,
        streamlink: {
          ...streamlink,
          proxy_optimized_once: true,
          proxy_auto_optimized: true, // Assume auto since the flag was set by auto-optimizer
        },
      });
      localStorage.removeItem(LEGACY_PROXY_OPTIMIZED_KEY);
      // Re-read after migration
      return runProxyOptimization();
    }
    // Clean up legacy key even if migration wasn't needed
    if (legacyOptimized !== null) {
      localStorage.removeItem(LEGACY_PROXY_OPTIMIZED_KEY);
    }

    // ──────────────────────────────────────────────────
    // FIRST-TIME SETUP
    // ──────────────────────────────────────────────────
    if (!streamlink.proxy_optimized_once) {
      Logger.info('[ProxyOptimizer] First-time proxy optimization starting...');

      // Force-enable proxy routing and ttvlol plugin
      if (!streamlink.use_proxy || !settings.ttvlol_plugin?.enabled) {
        Logger.info('[ProxyOptimizer] Auto-enabling proxy routing and ttvlol plugin');
        await updateSettings({
          ...settings,
          streamlink: { ...streamlink, use_proxy: true },
          ttvlol_plugin: { ...settings.ttvlol_plugin, enabled: true },
        });
      }

      // Run health check and apply best proxy
      const applied = await runHealthCheckAndApply(true);

      if (applied) {
        const { bestProxy } = useProxyHealthStore.getState();
        if (bestProxy) {
          addToast(
            `Proxy optimized — using ${bestProxy.name} (${bestProxy.latency_ms}ms)`,
            'info'
          );
        }
      }

      Logger.info('[ProxyOptimizer] First-time optimization complete');
      return;
    }

    // ──────────────────────────────────────────────────
    // SUBSEQUENT LAUNCHES
    // ──────────────────────────────────────────────────
    const freshSettings = useAppStore.getState().settings;

    // If proxy routing is disabled, respect user choice
    if (!freshSettings.streamlink?.use_proxy) {
      Logger.debug('[ProxyOptimizer] Proxy routing disabled by user, skipping');
      return;
    }

    // If user manually selected a proxy, DON'T override
    if (freshSettings.streamlink?.proxy_auto_optimized === false) {
      Logger.info('[ProxyOptimizer] User has manual proxy override, skipping optimization');
      return;
    }

    // Auto-optimized mode — re-check silently
    Logger.info('[ProxyOptimizer] Running background proxy health check...');
    await runHealthCheckAndApply(false);

    Logger.info('[ProxyOptimizer] Proxy optimization complete');
  } catch (err) {
    Logger.error('[ProxyOptimizer] Optimization failed:', err);
    // Never crash the app — proxy optimization is non-critical
  }
}

/**
 * Run health check and apply best proxy if warranted.
 * 
 * @param isFirstTime - If true, always apply. If false, only apply if meaningfully faster.
 * @returns true if a proxy was applied, false otherwise.
 */
async function runHealthCheckAndApply(isFirstTime: boolean): Promise<boolean> {
  const { checkAllProxies } = useProxyHealthStore.getState();
  const response = await checkAllProxies();

  if (!response || response.healthy_count === 0) {
    Logger.warn('[ProxyOptimizer] No healthy proxies found, keeping current settings');
    return false;
  }

  // Generate optimal args using the Rust command with the cached response
  let optimalArgs: string;
  try {
    optimalArgs = await invoke<string>('generate_optimal_proxy_args', {
      results: response,
      maxProxies: 3,
    });
  } catch (err) {
    Logger.error('[ProxyOptimizer] Failed to generate optimal args:', err);
    return false;
  }

  if (!optimalArgs) {
    Logger.warn('[ProxyOptimizer] Empty optimal args returned');
    return false;
  }

  const { settings, updateSettings } = useAppStore.getState();
  const currentPlaylist = settings.streamlink?.proxy_playlist || '';
  const currentProxyId = settings.streamlink?.last_applied_proxy_id;
  const bestProxyId = response.best_proxy?.id;

  // Check if we should actually apply
  if (!isFirstTime && optimalArgs === currentPlaylist) {
    Logger.debug('[ProxyOptimizer] Current proxy is already optimal, no changes needed');
    return false;
  }

  // For subsequent launches, check if the improvement is meaningful
  if (!isFirstTime && currentProxyId && bestProxyId && currentProxyId !== bestProxyId) {
    const currentResult = response.results.find(r => r.id === currentProxyId);
    const bestResult = response.best_proxy;

    if (currentResult?.is_healthy && bestResult?.latency_ms && currentResult.latency_ms) {
      const improvement = (currentResult.latency_ms - bestResult.latency_ms) / currentResult.latency_ms;
      if (improvement < MEANINGFUL_IMPROVEMENT_THRESHOLD) {
        Logger.debug(
          `[ProxyOptimizer] Best proxy is only ${Math.round(improvement * 100)}% faster — ` +
          `below ${MEANINGFUL_IMPROVEMENT_THRESHOLD * 100}% threshold, keeping current`
        );
        return false;
      }
      Logger.info(
        `[ProxyOptimizer] Switching: ${currentResult.name} (${currentResult.latency_ms}ms) → ` +
        `${bestResult.name} (${bestResult.latency_ms}ms), ${Math.round(improvement * 100)}% improvement`
      );
    }
  }

  // Apply the optimized proxy — use spread to preserve all fields
  Logger.info(
    `[ProxyOptimizer] Applying optimized proxy: ${response.best_proxy?.name} ` +
    `(${response.best_proxy?.latency_ms}ms)`
  );

  await updateSettings({
    ...settings,
    streamlink: {
      ...settings.streamlink!,
      use_proxy: true,
      proxy_playlist: optimalArgs,
      last_applied_proxy_id: bestProxyId || undefined,
      proxy_auto_optimized: true,
      proxy_optimized_once: true,
    },
  });

  Logger.info('[ProxyOptimizer] ✅ Settings saved with optimized proxy');
  return true;
}
