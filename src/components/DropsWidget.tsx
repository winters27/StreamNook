import { useEffect, useState, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { useAppStore } from '../stores/AppStore';
import { listen } from '@tauri-apps/api/event';
import { X, Search, TrendingUp, Settings as SettingsIcon, BarChart3, Gift, Lock, ExternalLink, Play, Pause, Package } from 'lucide-react';
import { InventoryOverlay } from './InventoryOverlay';
import ChannelPointsLeaderboard from './ChannelPointsLeaderboard';

// Twitch SVG Icon Component
const TwitchIcon = ({ size = 20 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z" />
  </svg>
);

interface DropCampaign {
  id: string;
  name: string;
  game_name: string;
  description: string;
  image_url: string;
  start_at: string;
  end_at: string;
  time_based_drops: TimeBasedDrop[];
  details_url?: string;  // "About this drop" link
}

interface TimeBasedDrop {
  id: string;
  name: string;
  required_minutes_watched: number;
  benefit_edges: DropBenefit[];
}

interface DropBenefit {
  id: string;
  name: string;
  image_url: string;
}

interface DropProgress {
  campaign_id: string;
  drop_id: string;
  current_minutes_watched: number;
  required_minutes_watched: number;
  is_claimed: boolean;
  last_updated: string;
}

interface DropsStatistics {
  total_drops_claimed: number;
  total_channel_points_earned: number;
  active_campaigns: number;
  drops_in_progress: number;
}

interface DropsDeviceCodeInfo {
  user_code: string;
  verification_uri: string;
  device_code: string;
  interval: number;
  expires_in: number;
}

interface MiningChannel {
  id: string;
  name: string;
  display_name?: string;
  game_id: string;
  game_name: string;
  viewer_count?: number;
  is_live: boolean;
}

interface CurrentDropInfo {
  drop_id: string;
  drop_name: string;
  campaign_name: string;
  game_name: string;
  current_minutes: number;
  required_minutes: number;
  progress_percentage: number;
  estimated_completion?: string;
}

interface MiningStatus {
  is_mining: boolean;
  current_channel: MiningChannel | null;
  current_campaign: string | null;
  current_drop: CurrentDropInfo | null;
  eligible_channels: MiningChannel[];
  last_update: string;
}

type Tab = 'campaigns' | 'stats' | 'settings';

export default function DropsWidget() {
  const [campaigns, setCampaigns] = useState<DropCampaign[]>([]);
  const [progress, setProgress] = useState<DropProgress[]>([]);
  const [statistics, setStatistics] = useState<DropsStatistics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Authentication state
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [deviceCodeInfo, setDeviceCodeInfo] = useState<DropsDeviceCodeInfo | null>(null);
  
  // Mining state
  const [miningStatus, setMiningStatus] = useState<MiningStatus | null>(null);
  const [isStartingMining, setIsStartingMining] = useState(false);
  
  // UI state
  const [activeTab, setActiveTab] = useState<Tab>('campaigns');
  const [searchTerm, setSearchTerm] = useState('');
  const [lastProgressUpdate, setLastProgressUpdate] = useState<number>(0);
  const [updatedDropIds, setUpdatedDropIds] = useState<Set<string>>(new Set());
  
  // Track which drop is currently being displayed for each campaign
  const [displayedDropId, setDisplayedDropId] = useState<string | null>(null);
  
  // Settings state
  const [dropsSettings, setDropsSettings] = useState<any>(null);
  const [showInventory, setShowInventory] = useState(false);
  const { addToast } = useAppStore();
  const prevProgressRef = useRef<DropProgress[]>([]);

  useEffect(() => {
    prevProgressRef.current = progress;
  }, [progress]);

  // Clear updated drop IDs after animation duration
  useEffect(() => {
    if (updatedDropIds.size > 0) {
      const timer = setTimeout(() => {
        setUpdatedDropIds(new Set());
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [updatedDropIds]);

  const filteredCampaigns = useMemo(() => {
    if (!searchTerm) {
      return campaigns;
    }
    return campaigns.filter(campaign =>
      campaign.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      campaign.game_name.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [campaigns, searchTerm]);

  const checkAuthentication = async () => {
    try {
      const authenticated = await invoke<boolean>('is_drops_authenticated');
      setIsAuthenticated(authenticated);
      return authenticated;
    } catch (err) {
      console.error('Failed to check drops authentication:', err);
      return false;
    }
  };

  const startDropsLogin = async () => {
    try {
      setIsAuthenticating(true);
      setError(null);
      
      const deviceInfo = await invoke<DropsDeviceCodeInfo>('start_drops_device_flow');
      setDeviceCodeInfo(deviceInfo);
      
      await open(deviceInfo.verification_uri);
      
      pollForToken(deviceInfo);
    } catch (err) {
      console.error('Failed to start drops login:', err);
      setError(err instanceof Error ? err.message : String(err));
      setIsAuthenticating(false);
    }
  };

  const pollForToken = async (deviceInfo: DropsDeviceCodeInfo) => {
    try {
      const token = await invoke<string>('poll_drops_token', {
        deviceCode: deviceInfo.device_code,
        interval: deviceInfo.interval,
        expiresIn: deviceInfo.expires_in,
      });
      
      console.log('[DROPS AUTH] Token obtained successfully!');
      
      setIsAuthenticated(true);
      setIsAuthenticating(false);
      setDeviceCodeInfo(null);
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      await loadDropsData();
    } catch (err) {
      console.error('Failed to complete drops login:', err);
      setError(err instanceof Error ? err.message : String(err));
      setIsAuthenticating(false);
      setDeviceCodeInfo(null);
    }
  };

  const handleDropsLogout = async () => {
    try {
      await invoke('drops_logout');
      setIsAuthenticated(false);
      setCampaigns([]);
      setProgress([]);
      setStatistics(null);
    } catch (err) {
      console.error('Failed to logout from drops:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadDropsData = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const [campaignsData, progressData, statsData] = await Promise.all([
        invoke<DropCampaign[]>('get_active_drop_campaigns').catch(err => {
          console.error('Failed to get campaigns:', err);
          return null;
        }),
        invoke<DropProgress[]>('get_drop_progress').catch(err => {
          console.error('Failed to get progress:', err);
          return null;
        }),
        invoke<DropsStatistics>('get_drops_statistics').catch(err => {
          console.error('Failed to get statistics:', err);
          return null;
        }),
      ]);

      if (campaignsData !== null) {
        setCampaigns(campaignsData);
      }
      if (progressData !== null) {
        const newlyClaimedDrops = progressData.filter(newDrop => {
          const oldDrop = prevProgressRef.current.find(d => d.drop_id === newDrop.drop_id);
          return newDrop.is_claimed && (!oldDrop || !oldDrop.is_claimed);
        });

        if (newlyClaimedDrops.length > 1) {
          addToast(`${newlyClaimedDrops.length} new drops have been claimed!`, 'success');
        } else if (newlyClaimedDrops.length === 1) {
          const claimedDrop = newlyClaimedDrops[0];
          let dropDetailsFound = false;
          for (const campaign of campaigns) {
            const dropDetails = campaign.time_based_drops.find(d => d.id === claimedDrop.drop_id);
            if (dropDetails) {
              addToast(
                `'${dropDetails.name}' from the '${campaign.name}' campaign has been claimed!`,
                'success'
              );
              dropDetailsFound = true;
              break;
            }
          }
          if (!dropDetailsFound) {
            addToast('A new drop has been claimed!', 'success');
          }
        }

        setProgress(progressData);
      }
      if (statsData !== null) {
        setStatistics(statsData);
      }
      
      if (campaignsData === null && campaigns.length > 0) {
        console.warn('Failed to refresh campaigns, keeping existing data');
      }
    } catch (err) {
      console.error('Failed to load drops data:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const init = async () => {
      const authenticated = await checkAuthentication();
      if (authenticated) {
        await loadDropsData();
        try {
          const status = await invoke<MiningStatus>('get_mining_status');
          setMiningStatus(status);
          useAppStore.setState({ isMiningActive: status.is_mining });
        } catch (err) {
          console.error('Failed to get mining status:', err);
        }
        try {
          const settings = await invoke<any>('get_drops_settings');
          setDropsSettings(settings);
        } catch (err) {
          console.error('Failed to get drops settings:', err);
        }
      } else {
        setIsLoading(false);
      }
    };
    
    init();
    
    let unlisten: (() => void) | undefined;
    let unlistenProgress: (() => void) | undefined;
    
    const setupMiningListener = async () => {
      // Listen for full mining status updates
      unlisten = await listen<MiningStatus>('mining-status-update', (event) => {
        console.log('🔄 Mining status update received in DropsWidget:', event.payload);
        setMiningStatus(event.payload);
        useAppStore.setState({ isMiningActive: event.payload.is_mining });
        setLastProgressUpdate(Date.now());
      });

      // Listen for direct progress updates from WebSocket
      unlistenProgress = await listen<{
        drop_id: string;
        current_minutes: number;
        required_minutes: number;
        timestamp: string;
      }>('drops-progress-update', (event) => {
        console.log('📊 Direct WebSocket progress update received in DropsWidget:', event.payload);
        
        // Update the progress array with new values
        setProgress((prevProgress) => {
          const updated = prevProgress.map(p => {
            if (p.drop_id === event.payload.drop_id) {
              return {
                ...p,
                current_minutes_watched: event.payload.current_minutes,
                required_minutes_watched: event.payload.required_minutes,
                last_updated: event.payload.timestamp,
              };
            }
            return p;
          });
          
          // If drop not found, check if we need to create it
          const exists = prevProgress.some(p => p.drop_id === event.payload.drop_id);
          if (!exists) {
            console.log('✅ Created new drop progress from WebSocket:', event.payload.current_minutes + '/' + event.payload.required_minutes, 'minutes for drop', event.payload.drop_id);
            return [
              ...prevProgress,
              {
                campaign_id: '', // Will be filled by next full update
                drop_id: event.payload.drop_id,
                current_minutes_watched: event.payload.current_minutes,
                required_minutes_watched: event.payload.required_minutes,
                is_claimed: false,
                last_updated: event.payload.timestamp,
              },
            ];
          }
          
          return updated;
        });
        
        // Mark this drop as recently updated for visual feedback
        setUpdatedDropIds(prev => new Set(prev).add(event.payload.drop_id));
        setLastProgressUpdate(Date.now());
      });
    };
    setupMiningListener();
    
    const interval = setInterval(async () => {
      const authenticated = await checkAuthentication();
      if (authenticated) {
        await loadDropsData();
        try {
          const status = await invoke<MiningStatus>('get_mining_status');
          setMiningStatus(status);
          useAppStore.setState({ isMiningActive: status.is_mining });
        } catch (err) {
          console.error('Failed to get mining status:', err);
        }
      }
    }, 60000);
    
    const handleVisibilityChange = async () => {
      if (!document.hidden) {
        try {
          const status = await invoke<MiningStatus>('get_mining_status');
          setMiningStatus(status);
          useAppStore.setState({ isMiningActive: status.is_mining });
        } catch (err) {
          console.error('Failed to get mining status on visibility change:', err);
        }
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (unlisten) {
        unlisten();
      }
      if (unlistenProgress) {
        unlistenProgress();
      }
    };
  }, []);

  const getDropProgress = (dropId: string): DropProgress | undefined => {
    return progress.find(p => p.drop_id === dropId);
  };

  const handleClaimDrop = async (dropId: string) => {
    try {
      await invoke('claim_drop', { dropId });
      await loadDropsData();
    } catch (err) {
      console.error('Failed to claim drop:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleStartMining = async (campaignId: string) => {
    try {
      setIsStartingMining(true);
      
      // When starting manual mining, disable auto mining first
      if (dropsSettings?.auto_mining_enabled) {
        await updateDropsSettings({ auto_mining_enabled: false });
      }
      
      await invoke('start_campaign_mining', { campaignId });
    } catch (err) {
      console.error('Failed to start mining:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsStartingMining(false);
    }
  };

  const handleStopMining = async () => {
    try {
      await invoke('stop_auto_mining');
    } catch (err) {
      console.error('Failed to stop mining:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateDropsSettings = async (newSettings: Partial<any>) => {
    try {
      const updatedSettings = {
        ...dropsSettings,
        ...newSettings,
      };
      await invoke('update_drops_settings', { settings: updatedSettings });
      setDropsSettings(updatedSettings);
    } catch (err) {
      console.error('Failed to update drops settings:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const addPriorityGame = (gameName: string) => {
    if (gameName && !dropsSettings?.priority_games?.includes(gameName)) {
      updateDropsSettings({
        priority_games: [...(dropsSettings?.priority_games || []), gameName],
      });
    }
  };

  const removePriorityGame = (index: number) => {
    const newPriority = [...(dropsSettings?.priority_games || [])];
    newPriority.splice(index, 1);
    updateDropsSettings({ priority_games: newPriority });
  };

  const addExcludedGame = (gameName: string) => {
    if (gameName && !dropsSettings?.excluded_games?.includes(gameName)) {
      updateDropsSettings({
        excluded_games: [...(dropsSettings?.excluded_games || []), gameName],
      });
    }
  };

  const removeExcludedGame = (index: number) => {
    const newExcluded = [...(dropsSettings?.excluded_games || [])];
    newExcluded.splice(index, 1);
    updateDropsSettings({ excluded_games: newExcluded });
  };

  // Show authentication UI if not authenticated
  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <div className="max-w-md space-y-6">
          {/* Icon */}
          <div className="flex justify-center">
            <div className="p-6 bg-accent/10 rounded-full border-2 border-accent/20">
              <Gift className="w-16 h-16 text-accent" />
            </div>
          </div>

          {/* Title and Description */}
          <div className="space-y-2">
            <h2 className="text-2xl font-bold text-textPrimary">Drops Authentication Required</h2>
            <p className="text-textSecondary">
              Authenticate with Twitch to enable drops mining and channel point collection.
            </p>
          </div>
          
          {/* Device Code Display */}
          {isAuthenticating && deviceCodeInfo && (
            <div className="bg-backgroundSecondary border border-accent rounded-lg p-6 space-y-4">
              <div className="flex items-center justify-center gap-2 text-accent">
                <Lock size={20} />
                <span className="text-lg font-semibold">Enter this code on Twitch</span>
              </div>
              <div className="text-5xl font-mono font-bold text-accent tracking-widest py-4">
                {deviceCodeInfo.user_code}
              </div>
              <div className="pt-2 border-t border-borderLight">
                <p className="text-sm text-textSecondary mb-3">
                  A browser window should have opened automatically.
                </p>
                <button
                  onClick={() => open(deviceCodeInfo.verification_uri)}
                  className="flex items-center justify-center gap-2 w-full px-4 py-2 bg-glass hover:bg-glassHover text-textPrimary rounded-lg transition-colors text-sm"
                >
                  <ExternalLink size={16} />
                  <span>Open Verification Page</span>
                </button>
              </div>
              <div className="flex items-center justify-center gap-2 text-xs text-textSecondary pt-2">
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-accent border-t-transparent"></div>
                <span>Waiting for authorization...</span>
              </div>
            </div>
          )}
          
          {/* Error Display */}
          {error && (
            <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-4">
              <div className="text-red-400 text-sm">{error}</div>
            </div>
          )}
          
          {/* Login Button */}
          {!isAuthenticating && (
            <button
              onClick={startDropsLogin}
              className="w-full px-6 py-3 bg-glass hover:bg-glassHover backdrop-blur-md border border-borderLight hover:border-accent/50 text-textPrimary rounded-lg transition-all font-semibold flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-accent/20"
            >
              <TwitchIcon size={20} />
              <span>Connect Twitch Account</span>
            </button>
          )}
          
          {/* Info Footer */}
          <div className="pt-4 border-t border-borderLight">
            <p className="text-xs text-textSecondary">
              This authentication is separate from your main app login and uses Twitch's secure device flow.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (error && campaigns.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4">
        <div className="text-red-500 mb-2">Failed to load drops</div>
        <div className="text-textSecondary text-sm mb-4">{error}</div>
        <div className="flex gap-2">
          <button
            onClick={loadDropsData}
            className="px-4 py-2 bg-accent text-white rounded hover:bg-accentHover transition-colors"
          >
            Retry
          </button>
          <button
            onClick={handleDropsLogout}
            className="px-4 py-2 bg-backgroundSecondary text-textPrimary rounded hover:bg-backgroundTertiary transition-colors"
          >
            Logout
          </button>
        </div>
      </div>
    );
  }

  if (campaigns.length === 0 && !isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4 text-center">
        <div className="text-textSecondary mb-2">No active drop campaigns</div>
        {error && (
          <div className="text-red-400 text-sm mb-2">Error: {error}</div>
        )}
        <div className="text-textSecondary text-sm mb-4">
          Check back later for new drops or try refreshing!
        </div>
        <div className="flex gap-2">
          <button
            onClick={loadDropsData}
            className="px-4 py-2 bg-accent text-white rounded hover:bg-accentHover transition-colors"
          >
            Refresh
          </button>
          <button
            onClick={handleDropsLogout}
            className="px-4 py-2 bg-backgroundSecondary text-textPrimary rounded hover:bg-backgroundTertiary transition-colors"
          >
            Logout from Drops
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {showInventory && <InventoryOverlay onClose={() => setShowInventory(false)} />}
      
      <div className="flex flex-col h-full bg-background">
      {/* Tab Navigation */}
      <div className="flex items-center gap-2 px-4 py-3 bg-backgroundSecondary border-b border-borderLight">
        <button
          onClick={() => setActiveTab('campaigns')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
            activeTab === 'campaigns'
              ? 'bg-glass text-textPrimary border-2 border-accent shadow-lg shadow-accent/20'
              : 'text-textSecondary hover:text-textPrimary hover:bg-glass border-2 border-transparent'
          }`}
        >
          <TrendingUp size={18} />
          <span>Campaigns</span>
        </button>
        <button
          onClick={() => setActiveTab('stats')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
            activeTab === 'stats'
              ? 'bg-glass text-textPrimary border-2 border-accent shadow-lg shadow-accent/20'
              : 'text-textSecondary hover:text-textPrimary hover:bg-glass border-2 border-transparent'
          }`}
        >
          <BarChart3 size={18} />
          <span>Stats</span>
        </button>
        <button
          onClick={() => setShowInventory(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all text-textSecondary hover:text-textPrimary hover:bg-glass border-2 border-transparent"
        >
          <Package size={18} />
          <span>Inventory</span>
        </button>
        <button
          onClick={() => setActiveTab('settings')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
            activeTab === 'settings'
              ? 'bg-glass text-textPrimary border-2 border-accent shadow-lg shadow-accent/20'
              : 'text-textSecondary hover:text-textPrimary hover:bg-glass border-2 border-transparent'
          }`}
        >
          <SettingsIcon size={18} />
          <span>Settings</span>
        </button>
        
        {/* Toggles */}
        <div className="ml-auto flex items-center gap-3">
          {/* Auto-claim Channel Points Toggle */}
          <label className="flex items-center gap-1.5 cursor-pointer group">
            <span className="text-xs font-medium text-textSecondary group-hover:text-textPrimary transition-colors whitespace-nowrap">
              Channel Points
            </span>
            <div className="relative">
              <input
                type="checkbox"
                checked={dropsSettings?.auto_claim_channel_points ?? false}
                onChange={async (e) => {
                  await updateDropsSettings({ auto_claim_channel_points: e.target.checked });
                }}
                className="sr-only peer"
              />
              <div className="relative w-10 h-5 bg-glass border-2 border-borderLight peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-accent/50 rounded-full peer peer-checked:after:translate-x-[1.125rem] rtl:peer-checked:after:-translate-x-[1.125rem] peer-checked:after:border-white after:content-[''] after:absolute after:top-0 after:start-0 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-accent peer-checked:border-accent"></div>
            </div>
          </label>

          {/* Drops Mining Toggle */}
          <label className="flex items-center gap-1.5 cursor-pointer group">
            <span className="text-xs font-medium text-textSecondary group-hover:text-textPrimary transition-colors whitespace-nowrap">
              Drops Mining
            </span>
            <div className="relative">
              <input
                type="checkbox"
                checked={dropsSettings?.auto_mining_enabled ?? false}
                onChange={async (e) => {
                  const isEnabled = e.target.checked;
                  
                  if (isEnabled) {
                    // When enabling auto mining, stop any manual mining first
                    if (miningStatus?.is_mining) {
                      await handleStopMining();
                    }
                    
                    try {
                      // Update settings first
                      await updateDropsSettings({ auto_mining_enabled: true });
                      // Then start mining
                      await invoke('start_auto_mining');
                    } catch (err) {
                      console.error('Failed to start auto mining:', err);
                      setError(err instanceof Error ? err.message : String(err));
                      // Revert the setting if starting failed
                      await updateDropsSettings({ auto_mining_enabled: false });
                    }
                  } else {
                    // When disabling auto mining, update settings FIRST to prevent auto-restart
                    await updateDropsSettings({ auto_mining_enabled: false });
                    // Then stop the mining
                    await handleStopMining();
                  }
                }}
                className="sr-only peer"
              />
              <div className="relative w-10 h-5 bg-glass border-2 border-borderLight peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-accent/50 rounded-full peer peer-checked:after:translate-x-[1.125rem] rtl:peer-checked:after:-translate-x-[1.125rem] peer-checked:after:border-white after:content-[''] after:absolute after:top-0 after:start-0 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-accent peer-checked:border-accent"></div>
            </div>
          </label>
          
          <button
            onClick={handleDropsLogout}
            className="px-3 py-2 text-textSecondary hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all text-sm"
            title="Logout from drops authentication"
          >
            Logout
          </button>
        </div>
      </div>

      {/* Tab Content - Campaigns */}
      {activeTab === 'campaigns' && (
        <>
          <div className="p-4 border-b border-borderLight">
            <div className="relative">
              <input
                type="text"
                placeholder="Search campaigns by name or game..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full glass-input px-4 py-2 text-sm text-textPrimary"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
            {filteredCampaigns
              .sort((a, b) => {
                if (miningStatus?.is_mining && miningStatus.current_campaign === a.name) return -1;
                if (miningStatus?.is_mining && miningStatus.current_campaign === b.name) return 1;
                return 0;
              })
              .map(campaign => {
                const isActiveMining = miningStatus?.is_mining && miningStatus.current_campaign === campaign.name;
                
                return (
                  <div
                    key={campaign.id}
                    className={`bg-backgroundSecondary rounded-lg overflow-hidden border transition-colors relative ${
                      isActiveMining 
                        ? 'border-green-500 shadow-lg shadow-green-500/20' 
                        : 'border-borderLight hover:border-accent'
                    }`}
                  >
                    {isActiveMining && (
                      <div className="absolute inset-0 opacity-10 pointer-events-none overflow-hidden">
                        <div 
                          className="absolute inset-0 animate-shimmer"
                          style={{
                            background: 'linear-gradient(90deg, transparent 0%, transparent 25%, rgba(34, 197, 94, 0.3) 40%, rgba(34, 197, 94, 0.8) 50%, rgba(34, 197, 94, 0.3) 60%, transparent 75%, transparent 100%)',
                            backgroundSize: '200% 100%',
                          }}
                        />
                      </div>
                    )}
                    <div className="flex gap-3 p-3">
                      <img
                        src={campaign.image_url}
                        alt={`${campaign.name} campaign image`}
                        className="w-12 h-16 rounded object-cover"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <h3 className="font-semibold text-textPrimary truncate">{campaign.name}</h3>
                            <p className="text-sm text-accent">{campaign.game_name}</p>
                            <p className="text-xs text-textSecondary mt-1 line-clamp-2">
                              {campaign.description}
                            </p>
                            {campaign.details_url && (
                              <button
                                onClick={async () => {
                                  try {
                                    await invoke('open_drop_details', { url: campaign.details_url });
                                  } catch (err) {
                                    console.error('Failed to open drop details:', err);
                                  }
                                }}
                                className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:text-accentHover transition-colors"
                              >
                                <ExternalLink size={12} />
                                <span>About this drop</span>
                              </button>
                            )}
                          </div>
                          <div className="flex-shrink-0">
                            {isActiveMining ? (
                              <button
                                onClick={handleStopMining}
                                className="p-2 bg-glass hover:bg-glassHover border border-borderLight hover:border-red-400/50 text-textPrimary hover:text-red-400 rounded transition-all hover:shadow-lg hover:shadow-red-400/20"
                                title="Pause mining"
                              >
                                <Pause size={16} />
                              </button>
                            ) : (
                              <button
                                onClick={() => handleStartMining(campaign.id)}
                                disabled={isStartingMining || (miningStatus?.is_mining || false)}
                                className="p-2 bg-glass hover:bg-glassHover border border-borderLight hover:border-accent/50 text-textPrimary hover:text-accent rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:shadow-lg hover:shadow-accent/20"
                                title="Start mining"
                              >
                                <Play size={16} />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    {isActiveMining && (
                      <div className="px-3 pb-3">
                        <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-green-400 font-medium text-xs flex items-center gap-1.5">
                              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                              {miningStatus.current_channel?.display_name || miningStatus.current_channel?.name ? 
                                `Mining: ${miningStatus.current_channel.display_name || miningStatus.current_channel.name}` : 
                                'Mining Active'}
                            </span>
                            {(() => {
                              // Show completed/in-progress
                              const completedDrops = campaign.time_based_drops.filter(drop => {
                                const dropProg = getDropProgress(drop.id);
                                return dropProg && dropProg.is_claimed;
                              }).length;
                              const inProgressDrops = campaign.time_based_drops.filter(drop => {
                                const dropProg = getDropProgress(drop.id);
                                return dropProg && !dropProg.is_claimed && dropProg.current_minutes_watched > 0;
                              }).length;
                              
                              return (
                                <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded font-medium">
                                  {completedDrops}/{inProgressDrops}
                                </span>
                              );
                            })()}
                          </div>
                          {(() => {
                            // Get all drops with progress
                            const dropsWithProgress = campaign.time_based_drops
                              .map(drop => {
                                const dropProg = getDropProgress(drop.id);
                                if (dropProg && !dropProg.is_claimed) {
                                  const progressPercent = (dropProg.current_minutes_watched / dropProg.required_minutes_watched) * 100;
                                  return {
                                    drop,
                                    progress: dropProg,
                                    progressPercent,
                                  };
                                }
                                return null;
                              })
                              .filter(Boolean) as Array<{
                                drop: TimeBasedDrop;
                                progress: DropProgress;
                                progressPercent: number;
                              }>;
                            
                            // Sort by highest percentage first
                            dropsWithProgress.sort((a, b) => b.progressPercent - a.progressPercent);
                            
                            // Determine which drop to display
                            let dropToDisplay = dropsWithProgress[0];
                            
                            if (displayedDropId) {
                              // Check if currently displayed drop still has progress
                              const currentlyDisplayed = dropsWithProgress.find(d => d.drop.id === displayedDropId);
                              if (currentlyDisplayed) {
                                // Stick with it unless it's completed
                                dropToDisplay = currentlyDisplayed;
                              }
                            }
                            
                            // Update the displayed drop ID if we're showing something new
                            if (dropToDisplay && dropToDisplay.drop.id !== displayedDropId) {
                              setDisplayedDropId(dropToDisplay.drop.id);
                            }
                            
                            // Show the selected drop
                            if (dropToDisplay) {
                              const { drop: activeDropWithProgress, progress: dropProg, progressPercent } = dropToDisplay;
                              
                              return (
                                <>
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="text-xs text-textSecondary">{activeDropWithProgress.name}</span>
                                    <span className={`text-xs ${updatedDropIds.has(activeDropWithProgress.id) ? 'text-green-400 font-semibold' : 'text-textSecondary'} transition-colors duration-300`}>
                                      {progressPercent.toFixed(0)}%
                                    </span>
                                  </div>
                                  <div className="relative">
                                    <div className="w-full bg-background rounded-full h-1.5">
                                      <div
                                        className={`bg-green-500 h-full rounded-full transition-all duration-300 ${updatedDropIds.has(activeDropWithProgress.id) ? 'animate-pulse' : ''}`}
                                        style={{ width: `${progressPercent}%` }}
                                      />
                                    </div>
                                    {updatedDropIds.has(activeDropWithProgress.id) && (
                                      <div className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-green-500 rounded-full animate-ping"></div>
                                    )}
                                  </div>
                                  <div className="text-xs text-textSecondary">
                                    {dropProg.current_minutes_watched}/{dropProg.required_minutes_watched} min
                                    {dropsWithProgress.length > 1 && (
                                      <span className="ml-2 text-green-400">
                                        (+{dropsWithProgress.length - 1} more)
                                      </span>
                                    )}
                                  </div>
                                </>
                              );
                            }
                            
                            // Fallback: Check ALL progress entries for any with minutes > 0 (WebSocket-created entries)
                            const allProgressWithMinutes = progress
                              .filter(p => p.current_minutes_watched > 0 && !p.is_claimed)
                              .map(p => ({
                                progress: p,
                                remainingMinutes: p.required_minutes_watched - p.current_minutes_watched,
                              }))
                              .sort((a, b) => a.remainingMinutes - b.remainingMinutes);
                            
                            if (allProgressWithMinutes.length > 0) {
                              const { progress: anyProgressEntry } = allProgressWithMinutes[0];
                              const dropDetails = campaign.time_based_drops.find(d => d.id === anyProgressEntry.drop_id);
                              const progressPercent = (anyProgressEntry.current_minutes_watched / anyProgressEntry.required_minutes_watched) * 100;
                              
                              return (
                                <>
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="text-xs text-textSecondary">
                                      {dropDetails?.name || 'Drop in progress'}
                                    </span>
                                    <span className={`text-xs ${updatedDropIds.has(anyProgressEntry.drop_id) ? 'text-green-400 font-semibold' : 'text-textSecondary'} transition-colors duration-300`}>
                                      {progressPercent.toFixed(0)}%
                                    </span>
                                  </div>
                                  <div className="relative">
                                    <div className="w-full bg-background rounded-full h-1.5">
                                      <div
                                        className={`bg-green-500 h-full rounded-full transition-all duration-300 ${updatedDropIds.has(anyProgressEntry.drop_id) ? 'animate-pulse' : ''}`}
                                        style={{ width: `${progressPercent}%` }}
                                      />
                                    </div>
                                    {updatedDropIds.has(anyProgressEntry.drop_id) && (
                                      <div className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-green-500 rounded-full animate-ping"></div>
                                    )}
                                  </div>
                                  <div className="text-xs text-textSecondary">
                                    {anyProgressEntry.current_minutes_watched}/{anyProgressEntry.required_minutes_watched} min
                                    {allProgressWithMinutes.length > 1 && (
                                      <span className="ml-2 text-green-400">
                                        (+{allProgressWithMinutes.length - 1} more)
                                      </span>
                                    )}
                                  </div>
                                </>
                              );
                            }
                            
                            // No progress yet - show initializing message
                            return (
                              <div className="text-xs text-textSecondary text-center py-1">
                                Initializing... progress will appear shortly
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    )}

                    <div className="space-y-2 p-3 pt-0">
                      {campaign.time_based_drops.map(drop => {
                        const dropProgress = getDropProgress(drop.id);
                        const progressPercent = dropProgress
                          ? (dropProgress.current_minutes_watched / dropProgress.required_minutes_watched) * 100
                          : 0;
                        const isClaimed = dropProgress?.is_claimed || false;
                        const isComplete = progressPercent >= 100 && !isClaimed;

                        return (
                          <div
                            key={drop.id}
                            className="bg-background rounded p-2 border border-borderLight flex items-center gap-3"
                          >
                            {drop.benefit_edges[0] && (
                              <img
                                src={drop.benefit_edges[0].image_url}
                                alt={drop.benefit_edges[0].name}
                                className="w-10 h-12 rounded object-cover"
                              />
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between mb-1">
                                <h4 className="font-medium text-textPrimary text-xs truncate">
                                  {drop.name}
                                </h4>
                                {isClaimed && (
                                  <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded">
                                    ✓ Claimed
                                  </span>
                                )}
                                {isComplete && (
                                  <button
                                    onClick={() => handleClaimDrop(drop.id)}
                                    className="text-xs bg-accent hover:bg-accentHover text-white px-2 py-0.5 rounded transition-colors"
                                  >
                                    Claim
                                  </button>
                                )}
                              </div>
                              
                              <div className="relative">
                                <div className="w-full bg-backgroundSecondary rounded-full h-1.5 mb-1">
                                  <div
                                    className={`h-full rounded-full transition-all duration-300 ${
                                      updatedDropIds.has(drop.id) ? 'animate-pulse' : ''
                                    } ${isClaimed ? 'bg-green-500' : 'bg-accent'}`}
                                    style={{ width: `${Math.min(100, progressPercent)}%` }}
                                  />
                                </div>
                                {updatedDropIds.has(drop.id) && (
                                  <div className="absolute top-0 -right-0.5 w-1.5 h-1.5 bg-green-500 rounded-full animate-ping"></div>
                                )}
                              </div>
                              <div className="flex justify-between text-xs text-textSecondary">
                                <span>{dropProgress?.current_minutes_watched || 0}/{drop.required_minutes_watched} min</span>
                                <span className={updatedDropIds.has(drop.id) ? 'text-green-400 font-semibold' : ''}>
                                  {Math.min(100, Math.round(progressPercent))}%
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
          </div>
        </>
      )}

      {/* Tab Content - Stats */}
      {activeTab === 'stats' && statistics && (
        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          <div className="max-w-2xl mx-auto space-y-6">
            <h3 className="text-xl font-bold text-textPrimary mb-4">Statistics Overview</h3>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-backgroundSecondary rounded-lg p-6 border border-borderLight text-center">
                <div className="text-4xl font-bold text-accent mb-2">{statistics.total_drops_claimed}</div>
                <div className="text-sm text-textSecondary">Total Drops Claimed</div>
              </div>
              
              <div className="bg-backgroundSecondary rounded-lg p-6 border border-borderLight text-center">
                <div className="text-4xl font-bold text-accent mb-2">{statistics.total_channel_points_earned.toLocaleString()}</div>
                <div className="text-sm text-textSecondary">Channel Points Earned</div>
              </div>
              
              <div className="bg-backgroundSecondary rounded-lg p-6 border border-borderLight text-center">
                <div className="text-4xl font-bold text-accent mb-2">{statistics.active_campaigns}</div>
                <div className="text-sm text-textSecondary">Active Campaigns</div>
              </div>
              
              <div className="bg-backgroundSecondary rounded-lg p-6 border border-borderLight text-center">
                <div className="text-4xl font-bold text-accent mb-2">{statistics.drops_in_progress}</div>
                <div className="text-sm text-textSecondary">Drops In Progress</div>
              </div>
            </div>

            {miningStatus?.is_mining && (
              <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-6">
                <h4 className="text-lg font-semibold text-green-400 mb-4 flex items-center gap-2">
                  <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
                  Currently Mining
                </h4>
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-textSecondary">Channel:</span>
                    <span className="text-textPrimary font-medium">
                      {miningStatus.current_channel?.display_name || miningStatus.current_channel?.name}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-textSecondary">Campaign:</span>
                    <span className="text-textPrimary font-medium">{miningStatus.current_campaign}</span>
                  </div>
                  {miningStatus.current_drop && (
                    <div className="flex justify-between">
                      <span className="text-textSecondary">Current Drop:</span>
                      <span className="text-textPrimary font-medium">{miningStatus.current_drop.drop_name}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Channel Points Leaderboard */}
            <div className="bg-backgroundSecondary rounded-lg p-6 border border-borderLight">
              <ChannelPointsLeaderboard 
                onStreamClick={(_channelName) => {
                  // Close the drops overlay and start the stream
                  useAppStore.getState().setShowDropsOverlay(false);
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Tab Content - Settings */}
      {activeTab === 'settings' && dropsSettings && (
        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          <div className="max-w-2xl mx-auto space-y-6">
            <h3 className="text-xl font-bold text-textPrimary mb-4">Mining Settings</h3>

            {/* Priority Mode */}
            <div className="bg-backgroundSecondary rounded-lg p-6 border border-borderLight">
              <h4 className="text-base font-semibold text-textPrimary mb-3">Priority Mode</h4>
              <select
                value={dropsSettings.priority_mode ?? 'PriorityOnly'}
                onChange={(e) => updateDropsSettings({ priority_mode: e.target.value })}
                className="w-full px-4 py-2 bg-background border border-border rounded-lg text-textPrimary"
              >
                <option value="PriorityOnly">Priority Games Only</option>
                <option value="EndingSoonest">Campaigns Ending Soonest</option>
                <option value="LowAvailFirst">Low Availability First</option>
              </select>
              <p className="text-sm text-textSecondary mt-2">
                How to select which campaigns to mine
              </p>
            </div>

            {/* Priority Games */}
            <div className="bg-backgroundSecondary rounded-lg p-6 border border-borderLight">
              <h4 className="text-base font-semibold text-textPrimary mb-3">Priority Games</h4>
              <p className="text-sm text-textSecondary mb-4">
                Games will be mined in the order listed below
              </p>
              
              <div className="space-y-2 mb-4">
                {(dropsSettings.priority_games || []).map((game: string, index: number) => (
                  <div key={index} className="flex items-center gap-3 bg-background p-3 rounded-lg">
                    <span className="text-textSecondary font-mono text-sm w-8">{index + 1}.</span>
                    <span className="text-textPrimary flex-1">{game}</span>
                    <button
                      onClick={() => removePriorityGame(index)}
                      className="text-red-400 hover:text-red-300 text-sm px-3 py-1 hover:bg-red-500/10 rounded transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {(dropsSettings.priority_games || []).length === 0 && (
                  <p className="text-sm text-textSecondary italic p-3 text-center bg-background rounded-lg">
                    No priority games set
                  </p>
                )}
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Enter game name..."
                  id="priority-input"
                  className="flex-1 px-4 py-2 bg-background border border-border rounded-lg text-textPrimary"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      addPriorityGame(e.currentTarget.value.trim());
                      e.currentTarget.value = '';
                    }
                  }}
                />
                <button
                  onClick={() => {
                    const input = document.getElementById('priority-input') as HTMLInputElement;
                    addPriorityGame(input.value.trim());
                    input.value = '';
                  }}
                  className="px-4 py-2 bg-accent hover:bg-accentHover text-white rounded-lg transition-colors"
                >
                  Add
                </button>
              </div>
            </div>

            {/* Excluded Games */}
            <div className="bg-backgroundSecondary rounded-lg p-6 border border-borderLight">
              <h4 className="text-base font-semibold text-textPrimary mb-3">Excluded Games</h4>
              <p className="text-sm text-textSecondary mb-4">
                Games to never mine, even if they have active campaigns
              </p>
              
              <div className="space-y-2 mb-4">
                {(dropsSettings.excluded_games || []).map((game: string, index: number) => (
                  <div key={index} className="flex items-center gap-3 bg-background p-3 rounded-lg">
                    <span className="text-textPrimary flex-1">{game}</span>
                    <button
                      onClick={() => removeExcludedGame(index)}
                      className="text-red-400 hover:text-red-300 text-sm px-3 py-1 hover:bg-red-500/10 rounded transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {(dropsSettings.excluded_games || []).length === 0 && (
                  <p className="text-sm text-textSecondary italic p-3 text-center bg-background rounded-lg">
                    No excluded games
                  </p>
                )}
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Enter game name to exclude..."
                  id="excluded-input"
                  className="flex-1 px-4 py-2 bg-background border border-border rounded-lg text-textPrimary"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      addExcludedGame(e.currentTarget.value.trim());
                      e.currentTarget.value = '';
                    }
                  }}
                />
                <button
                  onClick={() => {
                    const input = document.getElementById('excluded-input') as HTMLInputElement;
                    addExcludedGame(input.value.trim());
                    input.value = '';
                  }}
                  className="px-4 py-2 bg-accent hover:bg-accentHover text-white rounded-lg transition-colors"
                >
                  Add
                </button>
              </div>
            </div>

          </div>
        </div>
      )}
      </div>
    </>
  );
}
