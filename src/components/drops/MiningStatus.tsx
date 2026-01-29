import { useEffect, useState } from 'react';
import { MiningStatus as MiningStatusType } from '../../types';

import { Logger } from '../../utils/logger';
const MiningStatus = () => {
  const [status, setStatus] = useState<MiningStatusType | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isStopping, setIsStopping] = useState(false);
  const [lastProgressUpdate, setLastProgressUpdate] = useState<number>(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlistenProgress: (() => void) | undefined;

    const setupListener = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const { listen } = await import('@tauri-apps/api/event');

        // Get initial status
        const initialStatus = await invoke<MiningStatusType>('get_mining_status');
        setStatus(initialStatus);
        setIsLoading(false);

        // Listen for status updates
        unlisten = await listen<MiningStatusType>('mining-status-update', (event) => {
          Logger.debug('🔄 Mining status update received:', event.payload);
          setStatus(event.payload);
          setLastProgressUpdate(Date.now());
        });

        // Also listen for direct progress updates from WebSocket
        unlistenProgress = await listen<{
          drop_id: string;
          current_minutes: number;
          required_minutes: number;
          timestamp: string;
        }>('drops-progress-update', (event) => {
          Logger.debug('📊 Direct WebSocket progress update received:', event.payload);
          
          // Update status if the drop ID matches
          setStatus((prevStatus) => {
            if (!prevStatus?.current_drop) {
              return prevStatus;
            }
            
            if (prevStatus.current_drop.drop_id === event.payload.drop_id) {
              const progressPercentage = 
                (event.payload.current_minutes / event.payload.required_minutes) * 100;
              
              const remainingMinutes = event.payload.required_minutes - event.payload.current_minutes;
              const estimatedCompletion = remainingMinutes > 0 
                ? new Date(Date.now() + remainingMinutes * 60000).toISOString()
                : null;
              
              return {
                ...prevStatus,
                current_drop: {
                  ...prevStatus.current_drop,
                  current_minutes: event.payload.current_minutes,
                  required_minutes: event.payload.required_minutes,
                  progress_percentage: progressPercentage,
                  estimated_completion: estimatedCompletion,
                },
                last_update: new Date().toISOString(),
              };
            }
            
            return prevStatus;
          });
          
          setLastProgressUpdate(Date.now());
        });
      } catch (error) {
        Logger.error('Failed to setup mining status listener:', error);
        setIsLoading(false);
      }
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
      if (unlistenProgress) {
        unlistenProgress();
      }
    };
  }, []);

  const handleStopMining = async () => {
    try {
      setIsStopping(true);
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('stop_auto_mining');
      // Update status immediately
      setStatus(prev => prev ? { ...prev, is_mining: false } : null);
      
      // Trigger a reload of the parent component's data
      window.dispatchEvent(new CustomEvent('reload-drops-data'));
    } catch (error) {
      Logger.error('Failed to stop mining:', error);
    } finally {
      setIsStopping(false);
    }
  };

  if (isLoading) {
    return (
      <div className="bg-backgroundSecondary rounded-lg p-4 border border-border">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-textSecondary rounded-full animate-pulse"></div>
          <span className="text-sm text-textSecondary">Loading mining status...</span>
        </div>
      </div>
    );
  }

  if (!status || !status.is_mining) {
    return (
      <div className="bg-backgroundSecondary rounded-lg p-4 border border-border">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-gray-500 rounded-full"></div>
          <span className="text-sm text-textSecondary">Auto mining is not active</span>
        </div>
      </div>
    );
  }

  const progressPercentage = status.current_drop
    ? (status.current_drop.current_minutes / status.current_drop.required_minutes) * 100
    : 0;

  const remainingMinutes = status.current_drop
    ? status.current_drop.required_minutes - status.current_drop.current_minutes
    : 0;

  // Calculate if we just received an update (within last 2 seconds)
  const isRecentUpdate = Date.now() - lastProgressUpdate < 2000;

  return (
    <div className="bg-backgroundSecondary rounded-lg p-4 border border-border space-y-4">
      {/* Mining Active Indicator */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
          <span className="text-sm font-semibold text-textPrimary">Mining Active</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-textSecondary">
            {new Date(status.last_update).toLocaleTimeString()}
          </span>
          <button
            onClick={handleStopMining}
            disabled={isStopping}
            className="px-3 py-1 bg-red-500 hover:bg-red-600 disabled:bg-red-800 text-white text-xs rounded transition-colors"
          >
            {isStopping ? 'Stopping...' : 'Stop Mining'}
          </button>
        </div>
      </div>

      {/* Current Channel */}
      {status.current_channel && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-textSecondary">Watching</span>
            <span className="text-xs text-textSecondary">
              {status.current_channel.viewer_count?.toLocaleString() || '0'} viewers
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-red-500 rounded-full"></div>
            <div>
              <div className="text-sm font-medium text-textPrimary">
                {status.current_channel.display_name || 'Unknown Channel'}
              </div>
              <div className="text-xs text-textSecondary">
                {status.current_channel.game_name || 'Unknown Game'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Current Drop Progress */}
      {status.current_drop && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-textSecondary">Current Drop</span>
            <span className="text-xs text-textSecondary">
              {remainingMinutes} min remaining
            </span>
          </div>
          <div>
            <div className="text-sm font-medium text-textPrimary mb-1">
              {status.current_drop.drop_name}
            </div>
            <div className="text-xs text-textSecondary mb-2">
              {status.current_drop.campaign_name}
            </div>
            
            {/* Progress Bar */}
            <div className="relative">
              <div className="w-full bg-background rounded-full h-2 overflow-hidden">
                <div
                  className={`bg-accent h-full transition-all duration-300 ${isRecentUpdate ? 'animate-pulse' : ''}`}
                  style={{ width: `${progressPercentage}%` }}
                ></div>
              </div>
              {isRecentUpdate && (
                <div className="absolute -top-1 -right-1 w-2 h-2 bg-green-500 rounded-full animate-ping"></div>
              )}
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-xs text-textSecondary">
                {status.current_drop.current_minutes} / {status.current_drop.required_minutes} min
              </span>
              <span className={`text-xs ${isRecentUpdate ? 'text-green-400 font-semibold' : 'text-textSecondary'} transition-colors duration-300`}>
                {progressPercentage.toFixed(0)}%
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Eligible Channels */}
      {status.eligible_channels.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-textSecondary">Eligible Channels</span>
            <span className="text-xs text-textSecondary">
              {status.eligible_channels.length} available
            </span>
          </div>
          <div className="max-h-32 overflow-y-auto space-y-1">
            {status.eligible_channels.slice(0, 5).map((channel) => (
              <div
                key={channel.id}
                className="flex items-center justify-between text-xs p-2 bg-background rounded"
              >
                <div className="flex items-center gap-2">
                  {channel.is_live && (
                    <div className="w-1.5 h-1.5 bg-red-500 rounded-full"></div>
                  )}
                  <span className="text-textPrimary">{channel.display_name || 'Unknown'}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-textSecondary">{channel.game_name || 'Unknown'}</span>
                  <span className="text-textSecondary">
                    {channel.viewer_count?.toLocaleString() || '0'}
                  </span>
                </div>
              </div>
            ))}
            {status.eligible_channels.length > 5 && (
              <div className="text-xs text-textSecondary text-center py-1">
                +{status.eligible_channels.length - 5} more channels
              </div>
            )}
          </div>
        </div>
      )}

      {/* No Eligible Channels Warning */}
      {status.eligible_channels.length === 0 && !status.current_channel && (
        <div className="text-xs text-yellow-500 bg-yellow-500/10 p-2 rounded">
          No eligible channels found. Check your priority settings or wait for streams to go live.
        </div>
      )}
    </div>
  );
};

export default MiningStatus;
