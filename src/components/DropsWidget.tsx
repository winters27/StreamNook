import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface DropCampaign {
  id: string;
  name: string;
  game_name: string;
  description: string;
  image_url: string;
  start_at: string;
  end_at: string;
  time_based_drops: TimeBasedDrop[];
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

export default function DropsWidget() {
  const [campaigns, setCampaigns] = useState<DropCampaign[]>([]);
  const [progress, setProgress] = useState<DropProgress[]>([]);
  const [statistics, setStatistics] = useState<DropsStatistics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDropsData = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const [campaignsData, progressData, statsData] = await Promise.all([
        invoke<DropCampaign[]>('get_active_drop_campaigns'),
        invoke<DropProgress[]>('get_drop_progress'),
        invoke<DropsStatistics>('get_drops_statistics'),
      ]);

      setCampaigns(campaignsData);
      setProgress(progressData);
      setStatistics(statsData);
    } catch (err) {
      console.error('Failed to load drops data:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadDropsData();
    // Refresh every 60 seconds
    const interval = setInterval(loadDropsData, 60000);
    return () => clearInterval(interval);
  }, []);

  const getDropProgress = (dropId: string): DropProgress | undefined => {
    return progress.find(p => p.drop_id === dropId);
  };

  const handleClaimDrop = async (dropId: string) => {
    try {
      await invoke('claim_drop', { dropId });
      // Refresh data after claiming
      await loadDropsData();
    } catch (err) {
      console.error('Failed to claim drop:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (isLoading && campaigns.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-textSecondary">Loading drops...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4">
        <div className="text-red-500 mb-2">Failed to load drops</div>
        <div className="text-textSecondary text-sm mb-4">{error}</div>
        <button
          onClick={loadDropsData}
          className="px-4 py-2 bg-accent text-white rounded hover:bg-accentHover transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (campaigns.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4 text-center">
        <div className="text-textSecondary mb-2">No active drop campaigns</div>
        <div className="text-textSecondary text-sm">
          Check back later for new drops!
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Statistics Header */}
      {statistics && (
        <div className="flex gap-4 p-4 bg-backgroundSecondary border-b border-borderLight">
          <div className="flex-1 text-center">
            <div className="text-2xl font-bold text-accent">{statistics.total_drops_claimed}</div>
            <div className="text-xs text-textSecondary">Drops Claimed</div>
          </div>
          <div className="flex-1 text-center">
            <div className="text-2xl font-bold text-accent">{statistics.total_channel_points_earned.toLocaleString()}</div>
            <div className="text-xs text-textSecondary">Points Earned</div>
          </div>
          <div className="flex-1 text-center">
            <div className="text-2xl font-bold text-accent">{statistics.drops_in_progress}</div>
            <div className="text-xs text-textSecondary">In Progress</div>
          </div>
        </div>
      )}

      {/* Campaigns List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {campaigns.map(campaign => (
          <div
            key={campaign.id}
            className="bg-backgroundSecondary rounded-lg overflow-hidden border border-borderLight hover:border-accent transition-colors"
          >
            {/* Campaign Header */}
            <div className="flex gap-3 p-3">
              <img
                src={campaign.image_url}
                alt={campaign.name}
                className="w-16 h-16 rounded object-cover"
              />
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-textPrimary truncate">{campaign.name}</h3>
                <p className="text-sm text-accent">{campaign.game_name}</p>
                <p className="text-xs text-textSecondary mt-1 line-clamp-2">
                  {campaign.description}
                </p>
              </div>
            </div>

            {/* Drops */}
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
                    className="bg-background rounded p-3 border border-borderLight"
                  >
                    <div className="flex items-start gap-3">
                      {drop.benefit_edges[0] && (
                        <img
                          src={drop.benefit_edges[0].image_url}
                          alt={drop.benefit_edges[0].name}
                          className="w-12 h-12 rounded object-cover"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <h4 className="font-medium text-textPrimary text-sm truncate">
                            {drop.name}
                          </h4>
                          {isClaimed && (
                            <span className="text-xs bg-green-500/20 text-green-400 px-2 py-1 rounded">
                              Claimed
                            </span>
                          )}
                          {isComplete && (
                            <button
                              onClick={() => handleClaimDrop(drop.id)}
                              className="text-xs bg-accent hover:bg-accentHover text-white px-3 py-1 rounded transition-colors"
                            >
                              Claim
                            </button>
                          )}
                        </div>
                        
                        {/* Progress Bar */}
                        <div className="mt-2">
                          <div className="flex justify-between text-xs text-textSecondary mb-1">
                            <span>
                              {dropProgress?.current_minutes_watched || 0} / {drop.required_minutes_watched} minutes
                            </span>
                            <span>{Math.min(100, Math.round(progressPercent))}%</span>
                          </div>
                          <div className="w-full bg-backgroundSecondary rounded-full h-2 overflow-hidden">
                            <div
                              className={`h-full transition-all duration-300 ${
                                isClaimed ? 'bg-green-500' : 'bg-accent'
                              }`}
                              style={{ width: `${Math.min(100, progressPercent)}%` }}
                            />
                          </div>
                        </div>

                        {/* Benefits */}
                        {drop.benefit_edges.length > 0 && (
                          <div className="mt-2 text-xs text-textSecondary">
                            Reward: {drop.benefit_edges[0].name}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
