import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, Users, Zap, Radio, Loader2, Sparkles } from 'lucide-react';

import { Logger } from '../../utils/logger';
interface MiningChannel {
  id: string;
  display_name: string;
  game_id: string;
  game_name: string;
  viewer_count: number;
  drops_enabled: boolean;
  is_live: boolean;
  is_acl_based: boolean;
}

interface ChannelPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  campaignId: string;
  campaignName: string;
  gameName: string;
  onStartMining: (channelId: string | null) => void;
}

export default function ChannelPickerModal({
  isOpen,
  onClose,
  campaignId,
  campaignName,
  gameName,
  onStartMining,
}: ChannelPickerModalProps) {
  const [channels, setChannels] = useState<MiningChannel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadEligibleChannels();
    }
  }, [isOpen, campaignId]);

  const loadEligibleChannels = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const eligibleChannels = await invoke<MiningChannel[]>('get_eligible_channels_for_campaign', {
        campaignId,
      });
      setChannels(eligibleChannels);
      // Auto-select the first channel (highest viewers)
      if (eligibleChannels.length > 0) {
        setSelectedChannelId(eligibleChannels[0].id);
      }
    } catch (err) {
      Logger.error('Failed to load eligible channels:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleStartMining = async () => {
    setIsStarting(true);
    onStartMining(selectedChannelId);
  };

  const handleAutoSelect = async () => {
    setIsStarting(true);
    onStartMining(null); // null means auto-select
  };

  const formatViewerCount = (count: number): string => {
    if (count >= 1000000) {
      return `${(count / 1000000).toFixed(1)}M`;
    }
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}K`;
    }
    return count.toString();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div 
        className="absolute inset-0"
        onClick={onClose}
      />
      
      <div className="relative w-full max-w-lg bg-background rounded-xl shadow-2xl border border-borderLight overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-borderLight bg-backgroundSecondary">
          <div className="flex-1 min-w-0 pr-4">
            <h2 className="text-lg font-semibold text-textPrimary truncate">
              Choose a Channel
            </h2>
            <p className="text-sm text-textSecondary truncate mt-0.5">
              {campaignName} • {gameName}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-textSecondary hover:text-textPrimary hover:bg-glass rounded-lg transition-all"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="p-5">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-12 text-textSecondary">
              <Loader2 className="w-8 h-8 animate-spin text-accent mb-3" />
              <span className="text-sm">Finding available channels...</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="text-red-400 mb-2">Failed to load channels</div>
              <div className="text-sm text-textSecondary mb-4">{error}</div>
              <button
                onClick={loadEligibleChannels}
                className="px-4 py-2 bg-accent text-white rounded-lg hover:bg-accentHover transition-colors text-sm"
              >
                Retry
              </button>
            </div>
          ) : channels.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Radio className="w-12 h-12 text-textSecondary mb-3 opacity-50" />
              <div className="text-textPrimary font-medium mb-1">No channels available</div>
              <div className="text-sm text-textSecondary">
                No streamers are currently live with drops enabled for this campaign.
              </div>
            </div>
          ) : (
            <>
              {/* Auto-select option */}
              <button
                onClick={handleAutoSelect}
                disabled={isStarting}
                className="w-full mb-4 p-4 bg-gradient-to-r from-accent/20 to-purple-500/20 border-2 border-accent/50 hover:border-accent rounded-xl transition-all group disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-accent/20 rounded-lg group-hover:bg-accent/30 transition-colors">
                    <Sparkles className="w-5 h-5 text-accent" />
                  </div>
                  <div className="flex-1 text-left">
                    <div className="font-medium text-textPrimary flex items-center gap-2">
                      Auto-select Best Channel
                      <span className="text-xs bg-accent/20 text-accent px-2 py-0.5 rounded-full">
                        Recommended
                      </span>
                    </div>
                    <div className="text-sm text-textSecondary mt-0.5">
                      Automatically picks the most optimal channel for you
                    </div>
                  </div>
                </div>
              </button>

              {/* Divider */}
              <div className="flex items-center gap-3 mb-4">
                <div className="flex-1 h-px bg-borderLight"></div>
                <span className="text-xs text-textSecondary uppercase tracking-wider">or choose manually</span>
                <div className="flex-1 h-px bg-borderLight"></div>
              </div>

              {/* Channel list */}
              <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar pr-1">
                {channels.map((channel, index) => (
                  <button
                    key={channel.id}
                    onClick={() => setSelectedChannelId(channel.id)}
                    className={`w-full p-3 rounded-xl border-2 transition-all text-left ${
                      selectedChannelId === channel.id
                        ? 'border-accent bg-accent/10'
                        : 'border-borderLight hover:border-accent/50 bg-backgroundSecondary hover:bg-glass'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      {/* Channel avatar placeholder */}
                      <div className="w-10 h-10 rounded-full bg-gradient-to-br from-accent/30 to-purple-500/30 flex items-center justify-center text-textPrimary font-semibold text-sm">
                        {channel.display_name.charAt(0).toUpperCase()}
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-textPrimary truncate">
                            {channel.display_name}
                          </span>
                          {channel.is_acl_based && (
                            <span className="text-xs bg-purple-500/20 text-purple-400 px-1.5 py-0.5 rounded">
                              Partner
                            </span>
                          )}
                          {index === 0 && (
                            <span className="text-xs bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded">
                              Top
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-0.5">
                          <span className="flex items-center gap-1 text-xs text-textSecondary">
                            <Users size={12} />
                            {formatViewerCount(channel.viewer_count)} viewers
                          </span>
                          {channel.is_live && (
                            <span className="flex items-center gap-1 text-xs text-red-400">
                              <Radio size={12} className="animate-pulse" />
                              LIVE
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Selection indicator */}
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
                        selectedChannelId === channel.id
                          ? 'border-accent bg-accent'
                          : 'border-borderLight'
                      }`}>
                        {selectedChannelId === channel.id && (
                          <div className="w-2 h-2 rounded-full bg-white"></div>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>

              {/* Start button */}
              <button
                onClick={handleStartMining}
                disabled={!selectedChannelId || isStarting}
                className="w-full mt-4 px-4 py-3 glass-button disabled:opacity-50 disabled:cursor-not-allowed text-textPrimary rounded-xl transition-all font-medium flex items-center justify-center gap-2 shadow-lg"
              >
                {isStarting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Starting...
                  </>
                ) : (
                  <>
                    <Zap size={18} />
                    Start Mining on Selected Channel
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
