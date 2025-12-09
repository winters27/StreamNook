import { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, Star, UserPlus, UserMinus, Loader2 } from 'lucide-react';
import { useAppStore } from '../stores/AppStore';

interface SubscribeOverlayProps {
  channel: string;
}

interface AutomationResult {
  success: boolean;
  message: string;
  action: string;
}

const SubscribeOverlay = ({ channel }: SubscribeOverlayProps) => {
  const [visible, setVisible] = useState(false);
  const [isFollowing, setIsFollowing] = useState<boolean | null>(null);
  const [followLoading, setFollowLoading] = useState(false);
  const [checkingFollowStatus, setCheckingFollowStatus] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 500);
    return () => clearTimeout(timer);
  }, []);

  // Check initial follow status using the existing API
  useEffect(() => {
    const checkFollowStatus = async () => {
      try {
        setCheckingFollowStatus(true);
        // Use the existing check_following_status command
        const result = await invoke<boolean>('check_following_status', { channel });
        setIsFollowing(result);
      } catch (err) {
        console.error('[SubscribeOverlay] Failed to check follow status:', err);
        // Default to showing "Follow" if we can't determine status
        setIsFollowing(false);
      } finally {
        setCheckingFollowStatus(false);
      }
    };

    if (channel) {
      checkFollowStatus();
    }
  }, [channel]);

  // Handle follow/unfollow action using browser automation
  const handleFollowAction = useCallback(async () => {
    if (followLoading) return;

    setFollowLoading(true);

    const action = isFollowing ? 'unfollow' : 'follow';
    console.log(`[SubscribeOverlay] Initiating ${action} for ${channel}`);

    try {
      const result = await invoke<AutomationResult>('automate_connection', {
        channel: channel,
        action: action
      });

      console.log('[SubscribeOverlay] Automation result:', result);

      if (result.success) {
        // Toggle the follow state
        setIsFollowing(prev => !prev);
        console.log(`[SubscribeOverlay] Successfully ${action}ed ${channel}`);
      } else {
        console.error(`[SubscribeOverlay] ${action} failed:`, result.message);
        // Show helpful toast message
        useAppStore.getState().addToast(
          `Follow/Unfollow failed. Try logging out and back in via Settings to re-authenticate.`,
          'error'
        );
      }
    } catch (err: any) {
      console.error(`[SubscribeOverlay] ${action} error:`, err);
      // Show helpful error message
      useAppStore.getState().addToast(
        `Follow/Unfollow failed. Try logging out and back in via Settings to re-authenticate.`,
        'error'
      );
    } finally {
      setFollowLoading(false);
    }
  }, [channel, isFollowing, followLoading]);

  if (!visible) return null;

  const handleSubscribe = () => {
    invoke('shell_open', { url: `https://www.twitch.tv/subs/${channel}` });
  };

  return (
    <div className="absolute top-4 right-4 glass-panel backdrop-blur-lg p-3 rounded-lg shadow-lg flex items-center gap-3 animate-fade-in">
      {/* Follow Button */}
      <button
        onClick={handleFollowAction}
        disabled={followLoading || checkingFollowStatus}
        className={`flex items-center gap-2 glass-button text-white px-4 py-2 text-sm font-medium transition-all ${followLoading || checkingFollowStatus
          ? 'opacity-50 cursor-wait'
          : isFollowing
            ? 'hover:bg-red-500/20'
            : 'hover:bg-green-500/20'
          }`}
        title={
          checkingFollowStatus
            ? 'Checking...'
            : followLoading
              ? 'Processing...'
              : isFollowing
                ? `Unfollow ${channel}`
                : `Follow ${channel}`
        }
      >
        {followLoading || checkingFollowStatus ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            <span>{checkingFollowStatus ? 'Loading' : 'Working...'}</span>
          </>
        ) : isFollowing ? (
          <>
            <UserMinus size={16} className="text-red-400" />
            <span>Unfollow</span>
          </>
        ) : (
          <>
            <UserPlus size={16} className="text-green-400" />
            <span>Follow</span>
          </>
        )}
      </button>

      {/* Subscribe Button */}
      <button
        onClick={handleSubscribe}
        className="flex items-center gap-2 glass-button text-white px-4 py-2 text-sm font-medium"
      >
        <Star size={16} className="fill-current text-yellow-400" />
        <span>Subscribe</span>
      </button>

      {/* Close Button */}
      <button
        onClick={() => setVisible(false)}
        className="p-1.5 text-textSecondary hover:text-red-400 hover:bg-glass rounded transition-all"
        title="Close"
      >
        <X size={16} />
      </button>
    </div>
  );
};

export default SubscribeOverlay;
