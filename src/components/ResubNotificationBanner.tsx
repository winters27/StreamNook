import React from 'react';

// Types
export interface ResubNotification {
  id: string;
  token: string;
  cumulative_tenure_months: number;
  streak_tenure_months: number;
  months: number;
  is_gift_subscription: boolean;
  gifter_display_name: string | null;
}

interface ResubNotificationBannerProps {
  resubNotification: ResubNotification;
  channelLogin: string;
  isResubMode: boolean;
  includeStreak: boolean;
  onActivateShare: () => void;
  onDismiss: () => void;
  onToggleStreak: () => void;
  onCancelShare: () => void;
}

// Celebration/Star icon SVG
const CelebrationIcon = ({ className = '', size = 16 }: { className?: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

// Reply/Share arrow icon SVG
const ShareIcon = ({ className = '', size = 16 }: { className?: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 10h10a8 8 0 0 1 8 8v2M3 10l6 6m-6-6l6-6" />
  </svg>
);

// Close/X icon SVG
const CloseIcon = ({ className = '', size = 16 }: { className?: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6L6 18" />
    <path d="M6 6l12 12" />
  </svg>
);

// Checkbox SVG
const CheckboxIcon = ({ checked, className = '', size = 14 }: { checked: boolean; className?: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="18" height="18" rx="3" className={checked ? 'fill-accent/20' : ''} />
    {checked && <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />}
  </svg>
);

const ResubNotificationBanner: React.FC<ResubNotificationBannerProps> = ({
  resubNotification,
  // channelLogin is passed but reserved for future use (e.g., channel-specific styling)
  isResubMode,
  includeStreak,
  onActivateShare,
  onDismiss,
  onToggleStreak,
  onCancelShare,
}) => {
  const months = resubNotification.cumulative_tenure_months;
  const streakMonths = resubNotification.streak_tenure_months;
  const isGift = resubNotification.is_gift_subscription;
  const gifter = resubNotification.gifter_display_name;

  // Active mode: user is composing their resub message
  if (isResubMode) {
    return (
      <div className="mb-2 flex items-center gap-2 px-3 py-2 bg-accent/10 rounded-lg border border-accent/30">
        <ShareIcon size={16} className="text-accent flex-shrink-0" />
        <span className="text-xs text-textSecondary flex-1">
          Sharing{' '}
          <span className="text-accent font-semibold">
            {months}-month{months > 1 ? 's' : ''} sub
          </span>
          {isGift && gifter && (
            <span className="text-textTertiary"> (gifted by {gifter})</span>
          )}
        </span>
        
        {/* Include streak checkbox */}
        {streakMonths > 0 && (
          <button
            onClick={onToggleStreak}
            className="flex items-center gap-1.5 text-xs text-textSecondary hover:text-textPrimary transition-colors"
            title={includeStreak ? "Streak will be shown" : "Click to include streak"}
          >
            <CheckboxIcon checked={includeStreak} size={14} className="text-accent" />
            <span>Streak ({streakMonths}mo)</span>
          </button>
        )}
        
        {/* Cancel button */}
        <button 
          onClick={onCancelShare} 
          className="text-textSecondary hover:text-textPrimary transition-colors" 
          title="Cancel share"
        >
          <CloseIcon size={16} />
        </button>
      </div>
    );
  }

  // Collapsed mode: notification banner
  return (
    <div className="mb-2 flex items-center gap-2 px-3 py-2 bg-glass rounded-lg border border-accent/20 hover:border-accent/40 transition-colors">
      <CelebrationIcon size={16} className="text-accent flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-xs text-textPrimary">
          Share your{' '}
          <span className="text-accent font-semibold">
            {months}-month
          </span>
          {' '}sub anniversary!
        </span>
        {isGift && gifter && (
          <span className="text-xs text-textTertiary ml-1">(Gift from {gifter})</span>
        )}
      </div>
      
      {/* Share button */}
      <button
        onClick={onActivateShare}
        className="px-3 py-1 text-xs font-medium text-white bg-accent hover:bg-accent/80 rounded transition-colors"
      >
        Share
      </button>
      
      {/* Dismiss button */}
      <button 
        onClick={onDismiss} 
        className="text-textTertiary hover:text-textSecondary transition-colors" 
        title="Dismiss"
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
};

export default ResubNotificationBanner;
