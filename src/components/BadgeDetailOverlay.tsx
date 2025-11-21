import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface BadgeVersion {
  id: string;
  image_url_1x: string;
  image_url_2x: string;
  image_url_4x: string;
  title: string;
  description: string;
  click_action: string | null;
  click_url: string | null;
}

interface BadgeMetadata {
  date_added: string | null;
  usage_stats: string | null;
  more_info: string | null;
  info_url: string;
}

interface BadgeDetailOverlayProps {
  badge: BadgeVersion;
  setId: string;
  onClose: () => void;
  onBack: () => void;
}

const BadgeDetailOverlay = ({ badge, setId, onClose, onBack }: BadgeDetailOverlayProps) => {
  const [badgeBaseInfo, setBadgeBaseInfo] = useState<BadgeMetadata | null>(null);
  const [loadingBadgeBase, setLoadingBadgeBase] = useState(true);

  // Fetch BadgeBase.co information
  useEffect(() => {
    const fetchBadgeBaseInfo = async () => {
      try {
        setLoadingBadgeBase(true);
        const info = await invoke<BadgeMetadata>('fetch_badge_metadata', {
          badgeSetId: setId,
          badgeVersion: badge.id,
        });
        setBadgeBaseInfo(info);
      } catch (error) {
        console.warn('[BadgeDetail] Failed to fetch BadgeBase info:', error);
        // Silently fail - BadgeBase info is optional
      } finally {
        setLoadingBadgeBase(false);
      }
    };

    fetchBadgeBaseInfo();
  }, [setId, badge.id]);

  // Check badge availability status
  const getBadgeStatus = (): 'available' | 'coming-soon' | 'expired' | null => {
    const moreInfo = badgeBaseInfo?.more_info;
    if (!moreInfo) return null;

    // Extract ISO timestamps from the more_info text
    const isoRegex = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z)?)/g;
    const timestamps = moreInfo.match(isoRegex);
    
    if (!timestamps || timestamps.length < 2) return null;

    try {
      // Assume first timestamp is start, last is end
      const startTime = new Date(timestamps[0]).getTime();
      const endTime = new Date(timestamps[timestamps.length - 1]).getTime();
      const now = Date.now();

      if (now < startTime) {
        return 'coming-soon';
      } else if (now >= startTime && now <= endTime) {
        return 'available';
      } else {
        return 'expired';
      }
    } catch {
      return null;
    }
  };

  const badgeStatus = getBadgeStatus();
  const isAvailable = badgeStatus === 'available';
  const isComingSoon = badgeStatus === 'coming-soon';

  // Convert ISO timestamps to local time
  const convertTimestampsToLocal = (text: string): string => {
    // Match ISO 8601 timestamps in the format: 2025-09-12T17:00 or 2025-09-12T17:00:00Z
    const isoRegex = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z)?)/g;
    
    return text.replace(isoRegex, (match) => {
      try {
        const date = new Date(match);
        // Format to local time with readable format
        return date.toLocaleString(undefined, {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
      } catch (e) {
        return match; // Return original if parsing fails
      }
    });
  };

  // Format the badge ID for display
  const formatBadgeId = (id: string) => {
    return id.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm group">
      {/* Hover-sensitive background overlay */}
      <div 
        className="absolute inset-0 group-hover:pointer-events-none"
        onClick={onClose}
      />
      
      <div className="bg-secondary border border-borderSubtle rounded-lg shadow-2xl w-[90vw] h-[85vh] max-w-5xl flex flex-col relative z-10">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-borderSubtle">
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className="p-2 hover:bg-glass rounded-lg transition-colors"
              title="Back to badges"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                className="w-5 h-5 text-textSecondary"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
            </button>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold text-textPrimary">{badge.title}</h2>
                {isAvailable && (
                  <div className="flex items-center gap-1.5 px-2 py-1 bg-green-600/20 border border-green-500/50 rounded-full">
                    <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                    <span className="text-xs font-medium text-green-400">Available Now</span>
                  </div>
                )}
                {isComingSoon && (
                  <div className="flex items-center gap-1.5 px-2 py-1 bg-blue-600/20 border border-blue-500/50 rounded-full">
                    <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></span>
                    <span className="text-xs font-medium text-blue-400">Coming Soon</span>
                  </div>
                )}
              </div>
              <p className="text-sm text-accent">Twitch Chat Badge</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-glass rounded-lg transition-colors"
            title="Close"
          >
            <X size={20} className="text-textSecondary" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          <div className="max-w-3xl mx-auto space-y-8">
            {/* Badge Variations */}
            <div className="flex items-end gap-4">
              <a
                href={badge.image_url_4x}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center bg-glass rounded-lg p-4 hover:bg-glass/80 transition-colors cursor-pointer"
                title="View 72px image"
              >
                <img
                  src={badge.image_url_4x}
                  alt={badge.title}
                  className="w-18 h-18 object-contain"
                />
              </a>
              <a
                href={badge.image_url_2x}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center bg-glass rounded-lg p-3 hover:bg-glass/80 transition-colors cursor-pointer"
                title="View 36px image"
              >
                <img
                  src={badge.image_url_2x}
                  alt={badge.title}
                  className="w-9 h-9 object-contain"
                />
              </a>
              <a
                href={badge.image_url_1x}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center bg-glass rounded-lg p-2 hover:bg-glass/80 transition-colors cursor-pointer"
                title="View 18px image"
              >
                <img
                  src={badge.image_url_1x}
                  alt={badge.title}
                  className="w-[18px] h-[18px] object-contain"
                />
              </a>
            </div>

            {/* Additional Info */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-accent uppercase tracking-wide">About This Badge</h3>
              <div className="bg-glass rounded-lg p-4">
                <p className="text-textSecondary text-sm leading-relaxed">
                  This is a global Twitch chat badge that appears next to usernames in chat. 
                  {badge.description && (
                    <span className="block mt-2 text-textPrimary">
                      {badge.description}
                    </span>
                  )}
                </p>
              </div>
            </div>

            {/* Badge Data */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-accent uppercase tracking-wide">Badge Data</h3>
              <div className="bg-glass rounded-lg divide-y divide-borderSubtle">
                <div className="flex py-3 px-4">
                  <span className="text-textSecondary font-medium w-40">ID</span>
                  <span className="text-textPrimary break-all">{setId}</span>
                </div>
                <div className="flex py-3 px-4">
                  <span className="text-textSecondary font-medium w-40">Version</span>
                  <span className="text-textPrimary">{badge.id}</span>
                </div>
                <div className="flex py-3 px-4">
                  <span className="text-textSecondary font-medium w-40">Title</span>
                  <span className="text-textPrimary">{badge.title}</span>
                </div>
                <div className="flex py-3 px-4">
                  <span className="text-textSecondary font-medium w-40">Description</span>
                  <span className="text-textPrimary">
                    {badge.description || 'No description available'}
                  </span>
                </div>
                <div className="flex py-3 px-4">
                  <span className="text-textSecondary font-medium w-40">Click Action</span>
                  <span className="text-textPrimary">
                    {badge.click_action || '-'}
                  </span>
                </div>
                <div className="flex py-3 px-4">
                  <span className="text-textSecondary font-medium w-40">Click URL</span>
                  <span className="text-textPrimary break-all">
                    {badge.click_url ? (
                      <a
                        href={badge.click_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline"
                      >
                        {badge.click_url}
                      </a>
                    ) : (
                      '-'
                    )}
                  </span>
                </div>
                {/* Additional fields from community data */}
                {badgeBaseInfo?.date_added && (
                  <div className="flex py-3 px-4">
                    <span className="text-textSecondary font-medium w-40">Date of Addition</span>
                    <span className="text-textPrimary">{badgeBaseInfo.date_added}</span>
                  </div>
                )}
                {badgeBaseInfo?.usage_stats && (
                  <div className="flex py-3 px-4">
                    <span className="text-textSecondary font-medium w-40">Usage Statistics</span>
                    <span className="text-textPrimary">{badgeBaseInfo.usage_stats}</span>
                  </div>
                )}
                {badgeBaseInfo?.more_info && (
                  <div className="flex py-3 px-4">
                    <span className="text-textSecondary font-medium w-40 self-start">More Info</span>
                    <span className="text-textPrimary flex-1">
                      {convertTimestampsToLocal(badgeBaseInfo.more_info)}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Loading state for BadgeBase info */}
            {loadingBadgeBase && (
              <div className="flex items-center justify-center py-4">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent"></div>
                <span className="ml-3 text-textSecondary text-sm">Loading additional badge info...</span>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
};

export default BadgeDetailOverlay;
