import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { InventoryResponse, InventoryItem, TimeBasedDrop, CampaignStatus } from '../types';

interface InventoryOverlayProps {
  onClose: () => void;
}

export const InventoryOverlay: React.FC<InventoryOverlayProps> = ({ onClose }) => {
  const [inventory, setInventory] = useState<InventoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterNotLinked, setFilterNotLinked] = useState(false);
  const [filterUpcoming, setFilterUpcoming] = useState(false);
  const [filterExpired, setFilterExpired] = useState(false);
  const [filterFinished, setFilterFinished] = useState(false);

  const fetchInventory = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<InventoryResponse>('get_drops_inventory');
      setInventory(data);
    } catch (err) {
      setError(err as string);
      console.error('Failed to fetch inventory:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchInventory();
  }, []);

  const getFilteredItems = (): InventoryItem[] => {
    if (!inventory) return [];
    
    return inventory.items.filter(item => {
      if (filterNotLinked && item.campaign.is_account_connected) return false;
      if (filterUpcoming && item.status !== 'Upcoming') return false;
      if (filterExpired && item.status !== 'Expired') return false;
      if (filterFinished && item.claimed_drops < item.total_drops) return false;
      return true;
    });
  };

  const getStatusColor = (status: CampaignStatus): string => {
    switch (status) {
      case 'Active': return 'text-green-500';
      case 'Upcoming': return 'text-yellow-500';
      case 'Expired': return 'text-red-500';
      default: return 'text-gray-500';
    }
  };

  const getStatusText = (status: CampaignStatus): string => {
    return status;
  };

  const getDropStatusColor = (drop: TimeBasedDrop): string => {
    if (drop.progress?.is_claimed) return 'text-green-500';
    if (drop.progress && drop.progress.current_minutes_watched >= drop.required_minutes_watched) {
      return 'text-yellow-500';
    }
    if (drop.progress && drop.progress.current_minutes_watched > 0) {
      return 'text-blue-500';
    }
    return 'text-gray-400';
  };

  const getDropStatusText = (drop: TimeBasedDrop): string => {
    if (drop.progress?.is_claimed) return 'Claimed';
    if (drop.progress && drop.progress.current_minutes_watched >= drop.required_minutes_watched) {
      return 'Ready to Claim';
    }
    if (drop.progress && drop.progress.current_minutes_watched > 0) {
      const percent = (drop.progress.current_minutes_watched / drop.required_minutes_watched) * 100;
      return `${percent.toFixed(1)}% (${drop.progress.current_minutes_watched}/${drop.required_minutes_watched} min)`;
    }
    return `${drop.required_minutes_watched} min required`;
  };

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const filteredItems = getFilteredItems();

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-background rounded-lg w-full max-w-6xl max-h-[90vh] flex flex-col border border-borderLight shadow-2xl">
        {/* Header */}
        <div className="flex justify-between items-center p-6 border-b border-borderLight bg-backgroundSecondary">
          <div>
            <h2 className="text-2xl font-bold text-textPrimary">Drops Inventory</h2>
            {inventory && (
              <p className="text-sm text-textSecondary mt-1">
                {inventory.total_campaigns} campaigns ({inventory.active_campaigns} active, {inventory.upcoming_campaigns} upcoming, {inventory.expired_campaigns} expired)
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-textSecondary hover:text-textPrimary transition-colors"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Filters */}
        <div className="p-4 border-b border-borderLight bg-backgroundSecondary">
          <div className="flex flex-wrap gap-4 items-center">
            <span className="text-sm text-textSecondary">Show:</span>
            <label className="flex items-center gap-2 text-sm text-textPrimary cursor-pointer hover:text-accent transition-colors">
              <input
                type="checkbox"
                checked={filterNotLinked}
                onChange={(e) => setFilterNotLinked(e.target.checked)}
                className="rounded accent-accent"
              />
              Not Linked
            </label>
            <label className="flex items-center gap-2 text-sm text-textPrimary cursor-pointer hover:text-accent transition-colors">
              <input
                type="checkbox"
                checked={filterUpcoming}
                onChange={(e) => setFilterUpcoming(e.target.checked)}
                className="rounded accent-accent"
              />
              Upcoming
            </label>
            <label className="flex items-center gap-2 text-sm text-textPrimary cursor-pointer hover:text-accent transition-colors">
              <input
                type="checkbox"
                checked={filterExpired}
                onChange={(e) => setFilterExpired(e.target.checked)}
                className="rounded accent-accent"
              />
              Expired
            </label>
            <label className="flex items-center gap-2 text-sm text-textPrimary cursor-pointer hover:text-accent transition-colors">
              <input
                type="checkbox"
                checked={filterFinished}
                onChange={(e) => setFilterFinished(e.target.checked)}
                className="rounded accent-accent"
              />
              Finished
            </label>
            <button
              onClick={fetchInventory}
              className="ml-auto px-4 py-1 bg-accent hover:bg-accentHover text-white rounded text-sm transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          {loading && (
            <div className="flex items-center justify-center h-64">
              <div className="text-textPrimary text-lg">Loading inventory...</div>
            </div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/50 rounded p-4">
              <p className="font-semibold text-red-400">Error loading inventory</p>
              <p className="text-sm mt-1 text-red-300">{error}</p>
            </div>
          )}

          {!loading && !error && filteredItems.length === 0 && (
            <div className="text-center text-textSecondary py-12">
              No campaigns found matching your filters.
            </div>
          )}

          {!loading && !error && filteredItems.length > 0 && (
            <div className="space-y-6">
              {filteredItems.map((item) => (
                <div key={item.campaign.id} className="bg-backgroundSecondary rounded-lg p-4 border border-borderLight hover:border-accent/50 transition-colors">
                  {/* Campaign Header */}
                  <div className="flex gap-4 mb-4">
                    <img
                      src={item.campaign.image_url.replace('{width}', '285').replace('{height}', '380')}
                      alt={item.campaign.game_name}
                      className="w-24 h-32 object-cover rounded border border-borderLight"
                    />
                    <div className="flex-1">
                      <div className="flex items-start justify-between">
                        <div>
                          <h3 className="text-xl font-bold text-textPrimary">{item.campaign.name}</h3>
                          <p className="text-accent font-semibold mt-1">{item.campaign.game_name}</p>
                        </div>
                        <span className={`text-sm font-semibold ${getStatusColor(item.status)}`}>
                          {getStatusText(item.status)}
                        </span>
                      </div>
                      
                      <div className="mt-2 space-y-1 text-sm text-textSecondary">
                        <p>Ends: {formatDate(item.campaign.end_at)}</p>
                        <p>Progress: {item.claimed_drops}/{item.total_drops} drops claimed ({item.progress_percentage.toFixed(1)}%)</p>
                        {item.campaign.is_account_connected ? (
                          <span className="text-green-500">✓ Account Connected</span>
                        ) : (
                          <span className="text-red-500">✗ Account Not Connected</span>
                        )}
                      </div>

                      {item.campaign.is_acl_based && item.campaign.allowed_channels.length > 0 && (
                        <div className="mt-2 text-sm text-textSecondary">
                          <p>Allowed Channels:</p>
                          <p className="text-textPrimary">
                            {item.campaign.allowed_channels.slice(0, 4).map(ch => ch.name).join(', ')}
                            {item.campaign.allowed_channels.length > 4 && ` +${item.campaign.allowed_channels.length - 4} more`}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Drops */}
                  <div className="space-y-2">
                    {item.campaign.time_based_drops.map((drop) => (
                      <div key={drop.id} className="bg-background rounded p-3 flex items-center gap-4 border border-borderLight">
                        {/* Drop rewards */}
                        <div className="flex gap-2">
                          {drop.benefit_edges.map((benefit) => (
                            <img
                              key={benefit.id}
                              src={benefit.image_url}
                              alt={benefit.name}
                              title={benefit.name}
                              className="w-12 h-12 rounded border border-borderLight"
                            />
                          ))}
                        </div>

                        {/* Drop info */}
                        <div className="flex-1">
                          <p className="text-textPrimary font-semibold">{drop.name}</p>
                          <p className="text-sm text-textSecondary">
                            {drop.benefit_edges.map(b => b.name).join(', ')}
                          </p>
                        </div>

                        {/* Progress */}
                        <div className="text-right">
                          <p className={`text-sm font-semibold ${getDropStatusColor(drop)}`}>
                            {getDropStatusText(drop)}
                          </p>
                          {drop.progress && drop.progress.current_minutes_watched > 0 && !drop.progress.is_claimed && (
                            <div className="w-32 bg-backgroundSecondary rounded-full h-2 mt-1 border border-borderLight">
                              <div
                                className="bg-accent h-2 rounded-full transition-all"
                                style={{
                                  width: `${Math.min(100, (drop.progress.current_minutes_watched / drop.required_minutes_watched) * 100)}%`
                                }}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-borderLight bg-backgroundSecondary rounded-b-lg">
          <div className="flex justify-between items-center text-sm">
            <a
              href="https://www.twitch.tv/drops/inventory"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:text-accentHover transition-colors"
            >
              View on Twitch →
            </a>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-glass hover:bg-glassHover border border-borderLight text-textPrimary rounded transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
