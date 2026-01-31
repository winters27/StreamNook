/**
 * Proxy Health Store
 * 
 * Manages TTV-LOL proxy health checking, auto-selection of best proxy,
 * and integration with streamlink settings.
 */
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { 
  ProxyServer, 
  ProxyHealthResult, 
  ProxyHealthCheckResponse, 
  ProxyList 
} from '../types';
import { Logger } from '../utils/logger';

interface ProxyHealthState {
  // Proxy data
  proxyList: ProxyServer[];
  healthResults: ProxyHealthResult[];
  bestProxy: ProxyHealthResult | null;
  
  // Status
  isChecking: boolean;
  lastCheckAt: string | null;
  checkDurationMs: number | null;
  
  // Stats
  healthyCount: number;
  totalCount: number;
  
  // Error handling
  error: string | null;
  
  // Actions
  loadProxyList: () => Promise<void>;
  checkAllProxies: () => Promise<ProxyHealthCheckResponse | null>;
  generateOptimalArgs: (maxProxies?: number) => Promise<string>;
  getHealthyProxies: () => ProxyHealthResult[];
  getProxiesByRegion: (region: string) => ProxyHealthResult[];
  clearResults: () => void;
}

export const useProxyHealthStore = create<ProxyHealthState>((set, get) => ({
  // Initial state
  proxyList: [],
  healthResults: [],
  bestProxy: null,
  isChecking: false,
  lastCheckAt: null,
  checkDurationMs: null,
  healthyCount: 0,
  totalCount: 0,
  error: null,
  
  /**
   * Load the bundled proxy list from the backend
   */
  loadProxyList: async () => {
    try {
      Logger.info('[ProxyHealth] Loading bundled proxy list...');
      const list = await invoke<ProxyList>('get_proxy_list');
      
      set({
        proxyList: list.proxies,
        totalCount: list.proxies.length,
        error: null,
      });
      
      Logger.info(`[ProxyHealth] Loaded ${list.proxies.length} proxies (v${list.version})`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      Logger.error(`[ProxyHealth] Failed to load proxy list: ${errorMsg}`);
      set({ error: errorMsg });
    }
  },
  
  /**
   * Check health of all proxies and get best recommendation
   */
  checkAllProxies: async () => {
    try {
      set({ isChecking: true, error: null });
      Logger.info('[ProxyHealth] Starting health check for all proxies...');
      
      const response = await invoke<ProxyHealthCheckResponse>('check_proxy_health');
      
      set({
        healthResults: response.results,
        bestProxy: response.best_proxy,
        lastCheckAt: new Date().toISOString(),
        checkDurationMs: response.check_duration_ms,
        healthyCount: response.healthy_count,
        totalCount: response.total_checked,
        isChecking: false,
        error: null,
      });
      
      Logger.info(
        `[ProxyHealth] Check complete: ${response.healthy_count}/${response.total_checked} healthy ` +
        `(${response.check_duration_ms}ms)`
      );
      
      if (response.best_proxy) {
        Logger.info(
          `[ProxyHealth] Best proxy: ${response.best_proxy.name} ` +
          `(${response.best_proxy.latency_ms}ms, ${response.best_proxy.region})`
        );
      }
      
      return response;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      Logger.error(`[ProxyHealth] Health check failed: ${errorMsg}`);
      set({ 
        isChecking: false, 
        error: errorMsg,
      });
      return null;
    }
  },
  
  /**
   * Generate optimal streamlink proxy args based on health check results
   */
  generateOptimalArgs: async (maxProxies = 3) => {
    try {
      const { healthResults } = get();
      
      if (healthResults.length === 0) {
        Logger.warn('[ProxyHealth] No health results available, running check first...');
        await get().checkAllProxies();
      }
      
      const response = await invoke<ProxyHealthCheckResponse>('check_proxy_health');
      const args = await invoke<string>('generate_optimal_proxy_args', {
        results: response,
        maxProxies,
      });
      
      Logger.info(`[ProxyHealth] Generated optimal args: ${args.substring(0, 100)}...`);
      return args;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      Logger.error(`[ProxyHealth] Failed to generate args: ${errorMsg}`);
      // Return a safe default
      return '--twitch-proxy-playlist=https://lb-na.cdn-perfprod.com,https://eu.luminous.dev --twitch-proxy-playlist-fallback';
    }
  },
  
  /**
   * Get all healthy proxies sorted by latency
   */
  getHealthyProxies: () => {
    const { healthResults } = get();
    return healthResults
      .filter(r => r.is_healthy)
      .sort((a, b) => (a.latency_ms ?? Infinity) - (b.latency_ms ?? Infinity));
  },
  
  /**
   * Get proxies filtered by region, sorted by latency
   */
  getProxiesByRegion: (region: string) => {
    const { healthResults } = get();
    return healthResults
      .filter(r => r.region === region)
      .sort((a, b) => {
        // Healthy ones first
        if (a.is_healthy !== b.is_healthy) return a.is_healthy ? -1 : 1;
        // Then by latency
        return (a.latency_ms ?? Infinity) - (b.latency_ms ?? Infinity);
      });
  },
  
  /**
   * Clear all health check results
   */
  clearResults: () => {
    set({
      healthResults: [],
      bestProxy: null,
      lastCheckAt: null,
      checkDurationMs: null,
      healthyCount: 0,
      error: null,
    });
  },
}));

/**
 * Helper to format latency for display
 */
export function formatLatency(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 100) return `${ms}ms 🟢`;
  if (ms < 300) return `${ms}ms 🟡`;
  return `${ms}ms 🔴`;
}

/**
 * Helper to get region flag emoji
 */
export function getRegionFlag(region: string): string {
  const flags: Record<string, string> = {
    'NA': '🇺🇸',
    'EU': '🇪🇺',
    'AS': '🇯🇵',
    'SA': '🇧🇷',
    'RU': '🇷🇺',
  };
  return flags[region] ?? '🌍';
}

/**
 * Helper to get status icon
 */
export function getStatusIcon(isHealthy: boolean): string {
  return isHealthy ? '✅' : '❌';
}
