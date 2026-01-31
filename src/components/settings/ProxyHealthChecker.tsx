/**
 * ProxyHealthChecker Component
 * 
 * Displays proxy server health status, allows users to run health checks,
 * and can auto-select the best proxy for their location.
 */
import { useEffect, useState, useMemo } from 'react';
import { RefreshCw, Zap, Globe, Check, X, Clock, Server, Sparkles, CheckCircle } from 'lucide-react';
import { 
  useProxyHealthStore, 
  getRegionFlag, 
} from '../../stores/proxyHealthStore';
import type { ProxyHealthResult } from '../../types';
import { useAppStore } from '../../stores/AppStore';
import { Logger } from '../../utils/logger';

interface ProxyHealthCheckerProps {
  /** Compact mode hides some details */
  compact?: boolean;
  /** Callback when user applies optimal settings */
  onApplyOptimal?: (args: string) => void;
}

/** Parse the current proxy playlist to extract proxy info */
const parseCurrentProxy = (proxyPlaylist: string): { name: string; url: string; region: string } | null => {
  if (!proxyPlaylist) return null;
  
  // Extract URLs from the proxy playlist arg
  // Format: --twitch-proxy-playlist=https://...,https://... --twitch-proxy-playlist-fallback
  const match = proxyPlaylist.match(/--twitch-proxy-playlist=([^\s]+)/);
  if (!match) return null;
  
  const urls = match[1].split(',');
  const firstUrl = urls[0];
  if (!firstUrl) return null;
  
  // Try to identify the proxy from URL
  if (firstUrl.includes('luminous.dev')) {
    if (firstUrl.includes('as.')) return { name: 'Luminous Asia', url: firstUrl, region: 'AS' };
    if (firstUrl.includes('eu2.')) return { name: 'Luminous EU 2', url: firstUrl, region: 'EU' };
    if (firstUrl.includes('eu.')) return { name: 'Luminous EU', url: firstUrl, region: 'EU' };
    return { name: 'Luminous', url: firstUrl, region: 'EU' };
  }
  
  if (firstUrl.includes('cdn-perfprod.com')) {
    if (firstUrl.includes('lb-na')) return { name: 'TTV-LOL NA', url: firstUrl, region: 'NA' };
    if (firstUrl.includes('lb-eu2')) return { name: 'TTV-LOL EU 2', url: firstUrl, region: 'EU' };
    if (firstUrl.includes('lb-eu3')) return { name: 'TTV-LOL EU 3', url: firstUrl, region: 'RU' };
    if (firstUrl.includes('lb-eu4')) return { name: 'TTV-LOL EU 4', url: firstUrl, region: 'EU' };
    if (firstUrl.includes('lb-eu5')) return { name: 'TTV-LOL EU 5', url: firstUrl, region: 'EU' };
    if (firstUrl.includes('lb-eu')) return { name: 'TTV-LOL EU', url: firstUrl, region: 'EU' };
    if (firstUrl.includes('lb-as')) return { name: 'TTV-LOL Asia', url: firstUrl, region: 'AS' };
    if (firstUrl.includes('lb-sa')) return { name: 'TTV-LOL SA', url: firstUrl, region: 'SA' };
    return { name: 'TTV-LOL', url: firstUrl, region: 'EU' };
  }
  
  if (firstUrl.includes('nadeko.net')) {
    return { name: 'Community RU', url: firstUrl, region: 'RU' };
  }
  
  // Unknown proxy
  return { name: 'Custom Proxy', url: firstUrl, region: '??' };
};

const ProxyHealthChecker = ({ compact = false, onApplyOptimal }: ProxyHealthCheckerProps) => {
  const { settings, updateSettings, streamUrl, restartStream } = useAppStore();
  const {
    proxyList,
    healthResults,
    bestProxy,
    isChecking,
    lastCheckAt,
    checkDurationMs,
    healthyCount,
    totalCount,
    error,
    loadProxyList,
    checkAllProxies,
    generateOptimalArgs,
  } = useProxyHealthStore();
  
  const [showAllProxies, setShowAllProxies] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [applyingProxyId, setApplyingProxyId] = useState<string | null>(null);
  const [applySuccess, setApplySuccess] = useState(false);
  const [appliedProxyId, setAppliedProxyId] = useState<string | null>(null);
  
  // Parse current proxy from settings
  const currentProxy = useMemo(() => {
    return parseCurrentProxy(settings.streamlink?.proxy_playlist || '');
  }, [settings.streamlink?.proxy_playlist]);
  
  // Load proxy list on mount
  useEffect(() => {
    if (proxyList.length === 0) {
      loadProxyList();
    }
  }, [loadProxyList, proxyList.length]);
  
  // Reset success state after 3 seconds
  useEffect(() => {
    if (applySuccess) {
      const timer = setTimeout(() => setApplySuccess(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [applySuccess]);
  
  const handleRunCheck = async () => {
    await checkAllProxies();
  };
  
  const handleApplyOptimal = async () => {
    if (!bestProxy) return;
    
    setIsApplying(true);
    setApplySuccess(false);
    try {
      const optimalArgs = await generateOptimalArgs(3);
      
      Logger.info(`[ProxyHealth] Generated optimal args: ${optimalArgs}`);
      
      // Update settings with the new proxy args
      const streamlink = settings.streamlink || {
        low_latency_enabled: true,
        hls_live_edge: 3,
        stream_timeout: 60,
        retry_streams: 3,
        disable_hosting: true,
        skip_ssl_verify: false,
        use_proxy: true,
        proxy_playlist: optimalArgs,
      };
      
      const newSettings = {
        ...settings,
        streamlink: {
          ...streamlink,
          use_proxy: true,
          proxy_playlist: optimalArgs,
        },
      };
      
      Logger.info(`[ProxyHealth] Updating settings with proxy_playlist: ${newSettings.streamlink.proxy_playlist}`);
      
      await updateSettings(newSettings);
      
      Logger.info('[ProxyHealth] Settings updated successfully');
      
      // Auto-restart stream if one is currently playing
      if (streamUrl) {
        Logger.info('[ProxyHealth] Stream is active, restarting with new proxy...');
        await restartStream();
      }
      
      // Show success state
      setApplySuccess(true);
      
      onApplyOptimal?.(optimalArgs);
    } catch (err) {
      Logger.error('[ProxyHealth] Failed to apply optimal settings:', err);
    } finally {
      setIsApplying(false);
      setApplyingProxyId(null);
    }
  };
  
  /** Apply a specific proxy */
  const handleApplyProxy = async (proxy: ProxyHealthResult) => {
    if (!proxy.is_healthy) return;
    
    setApplyingProxyId(proxy.id);
    setApplySuccess(false);
    setAppliedProxyId(null);
    
    try {
      // Generate args for this specific proxy (use up to 2 fallbacks from healthy list)
      const healthyProxies = healthResults
        .filter(p => p.is_healthy && p.id !== proxy.id)
        .sort((a, b) => (a.latency_ms ?? Infinity) - (b.latency_ms ?? Infinity))
        .slice(0, 2);
      
      const proxyUrls = [proxy.url, ...healthyProxies.map(p => p.url)];
      const proxyArgs = `--twitch-proxy-playlist=${proxyUrls.join(',')} --twitch-proxy-playlist-fallback`;
      
      Logger.info(`[ProxyHealth] Applying proxy: ${proxy.name} (${proxyArgs})`);
      
      // Update settings
      const streamlink = settings.streamlink || {
        low_latency_enabled: true,
        hls_live_edge: 3,
        stream_timeout: 60,
        retry_streams: 3,
        disable_hosting: true,
        skip_ssl_verify: false,
        use_proxy: true,
        proxy_playlist: proxyArgs,
      };
      
      const newSettings = {
        ...settings,
        streamlink: {
          ...streamlink,
          use_proxy: true,
          proxy_playlist: proxyArgs,
        },
      };
      
      await updateSettings(newSettings);
      
      Logger.info(`[ProxyHealth] Applied proxy: ${proxy.name}`);
      
      // Auto-restart stream if one is currently playing
      if (streamUrl) {
        Logger.info('[ProxyHealth] Stream is active, restarting with new proxy...');
        await restartStream();
      }
      
      setApplySuccess(true);
      setAppliedProxyId(proxy.id);
    } catch (err) {
      Logger.error('[ProxyHealth] Failed to apply proxy:', err);
    } finally {
      setApplyingProxyId(null);
    }
  };
  
  const getLatencyColor = (ms: number | null): string => {
    if (ms === null) return 'text-textMuted';
    if (ms < 100) return 'text-green-400';
    if (ms < 300) return 'text-yellow-400';
    return 'text-red-400';
  };
  
  const sortedResults = [...healthResults].sort((a, b) => {
    // Healthy first
    if (a.is_healthy !== b.is_healthy) return a.is_healthy ? -1 : 1;
    // Then by latency
    return (a.latency_ms ?? Infinity) - (b.latency_ms ?? Infinity);
  });
  
  const displayResults = showAllProxies ? sortedResults : sortedResults.slice(0, 5);
  
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server size={16} className="text-accent" />
          <span className="text-sm font-medium text-textPrimary">Proxy Health</span>
          {healthResults.length > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-glass text-textSecondary">
              {healthyCount}/{totalCount} healthy
            </span>
          )}
        </div>
        
        <button
          onClick={handleRunCheck}
          disabled={isChecking}
          className="flex items-center gap-2 px-3 py-1.5 text-sm glass-button rounded transition-all disabled:opacity-50"
        >
          <RefreshCw size={14} className={isChecking ? 'animate-spin' : ''} />
          {isChecking ? 'Checking...' : 'Check All'}
        </button>
      </div>
      
      {/* Current Proxy Status */}
      {currentProxy && settings.streamlink?.use_proxy && (
        <div className="p-3 bg-glass rounded-lg border border-white/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span className="text-xs text-textSecondary">Currently using:</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-lg">{getRegionFlag(currentProxy.region)}</span>
              <span className="text-sm font-medium text-textPrimary">{currentProxy.name}</span>
            </div>
          </div>
        </div>
      )}
      
      {/* Error display */}
      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
          {error}
        </div>
      )}
      
      {/* Best Proxy Card */}
      {bestProxy && !compact && (
        <div className={`p-4 rounded-lg transition-all duration-300 ${
          applySuccess 
            ? 'bg-gradient-to-r from-green-500/20 to-transparent border border-green-500/30' 
            : 'bg-gradient-to-r from-accent/10 to-transparent border border-accent/20'
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center transition-all duration-300 ${
                applySuccess ? 'bg-green-500/20' : 'bg-accent/20'
              }`}>
                {applySuccess ? (
                  <CheckCircle size={20} className="text-green-400" />
                ) : (
                  <Sparkles size={20} className="text-accent" />
                )}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-textPrimary">
                    {applySuccess ? 'Applied!' : 'Best Proxy'}
                  </span>
                  <span className="text-lg">{getRegionFlag(bestProxy.region)}</span>
                </div>
                <div className="text-xs text-textSecondary">
                  {bestProxy.name} — {bestProxy.latency_ms}ms latency
                </div>
              </div>
            </div>
            
            <button
              onClick={handleApplyOptimal}
              disabled={isApplying || applySuccess}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded transition-all duration-300 ${
                applySuccess 
                  ? 'bg-green-500/20 text-green-400 cursor-default' 
                  : 'glass-button disabled:opacity-50'
              }`}
            >
              {applySuccess ? (
                <>
                  <CheckCircle size={14} />
                  Applied!
                </>
              ) : isApplying ? (
                <>
                  <RefreshCw size={14} className="animate-spin" />
                  Applying...
                </>
              ) : (
                <>
                  <Zap size={14} />
                  Apply Optimal
                </>
              )}
            </button>
          </div>
        </div>
      )}
      
      {/* Proxy List */}
      {healthResults.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-textSecondary mb-2">
            {lastCheckAt && (
              <span className="flex items-center gap-1">
                <Clock size={12} />
                Last check: {new Date(lastCheckAt).toLocaleTimeString()} ({checkDurationMs}ms)
              </span>
            )}
          </div>
          
          <div className="grid gap-2">
            {displayResults.map((result) => (
              <ProxyRow 
                key={result.id} 
                result={result} 
                isBest={bestProxy?.id === result.id}
                isCurrentlyUsed={currentProxy?.url === result.url}
                isApplying={applyingProxyId === result.id}
                justApplied={appliedProxyId === result.id && applySuccess}
                onApply={() => handleApplyProxy(result)}
                getLatencyColor={getLatencyColor}
              />
            ))}
          </div>
          
          {sortedResults.length > 5 && (
            <button
              onClick={() => setShowAllProxies(!showAllProxies)}
              className="text-xs text-accent hover:underline"
            >
              {showAllProxies ? 'Show less' : `Show all ${sortedResults.length} proxies`}
            </button>
          )}
        </div>
      )}
      
      {/* Initial state - no results yet */}
      {healthResults.length === 0 && !isChecking && (
        <div className="p-6 text-center bg-glass rounded-lg">
          <Globe size={32} className="mx-auto mb-2 text-textMuted" />
          <p className="text-sm text-textSecondary">
            Click "Check All" to test proxy servers and find the fastest one for your location.
          </p>
        </div>
      )}
      
      {/* Checking state */}
      {isChecking && healthResults.length === 0 && (
        <div className="p-6 text-center bg-glass rounded-lg">
          <RefreshCw size={32} className="mx-auto mb-2 text-accent animate-spin" />
          <p className="text-sm text-textSecondary">
            Testing {proxyList.length} proxy servers...
          </p>
        </div>
      )}
    </div>
  );
};

/** Individual proxy row */
const ProxyRow = ({ 
  result, 
  isBest,
  isCurrentlyUsed,
  isApplying,
  justApplied,
  onApply,
  getLatencyColor 
}: { 
  result: ProxyHealthResult; 
  isBest: boolean;
  isCurrentlyUsed?: boolean;
  isApplying?: boolean;
  justApplied?: boolean;
  onApply?: () => void;
  getLatencyColor: (ms: number | null) => string;
}) => {
  return (
    <div 
      className={`
        flex items-center justify-between p-3 rounded-lg transition-all
        ${isBest ? 'bg-accent/10 border border-accent/30' : 'bg-glass'}
        ${isCurrentlyUsed ? 'ring-1 ring-green-400/50' : ''}
        ${justApplied ? 'ring-1 ring-green-400 bg-green-500/10' : ''}
        ${!result.is_healthy ? 'opacity-60' : ''}
      `}
    >
      <div className="flex items-center gap-3">
        {/* Status indicator */}
        <div className={`w-2 h-2 rounded-full ${result.is_healthy ? 'bg-green-400' : 'bg-red-400'}`} />
        
        {/* Region flag */}
        <span className="text-lg">{getRegionFlag(result.region)}</span>
        
        {/* Name */}
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-textPrimary">{result.name}</span>
            {isBest && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-accent/20 text-accent">
                Fastest
              </span>
            )}
            {isCurrentlyUsed && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">
                Active
              </span>
            )}
          </div>
          {result.error && (
            <span className="text-xs text-red-400">{result.error}</span>
          )}
        </div>
      </div>
      
      {/* Right side: Latency + Use button */}
      <div className="flex items-center gap-3">
        {/* Latency */}
        <div className="flex items-center gap-2">
          {result.is_healthy ? (
            <Check size={14} className="text-green-400" />
          ) : (
            <X size={14} className="text-red-400" />
          )}
          <span className={`text-sm font-mono ${getLatencyColor(result.latency_ms)}`}>
            {result.latency_ms !== null ? `${result.latency_ms}ms` : '—'}
          </span>
        </div>
        
        {/* Use button */}
        {result.is_healthy && !isCurrentlyUsed && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onApply?.();
            }}
            disabled={isApplying}
            className={`px-2 py-1 text-xs font-medium rounded transition-all ${
              justApplied
                ? 'bg-green-500/20 text-green-400'
                : isApplying
                  ? 'bg-glass text-textMuted'
                  : 'bg-glass hover:bg-accent/20 hover:text-accent text-textSecondary'
            }`}
          >
            {justApplied ? (
              <span className="flex items-center gap-1">
                <Check size={12} />
                Done
              </span>
            ) : isApplying ? (
              <span className="flex items-center gap-1">
                <RefreshCw size={12} className="animate-spin" />
              </span>
            ) : (
              'Use'
            )}
          </button>
        )}
      </div>
    </div>
  );
};

export default ProxyHealthChecker;
