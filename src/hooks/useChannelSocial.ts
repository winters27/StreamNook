import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/AppStore';
import { Logger } from '../utils/logger';

interface ChannelSocialTarget {
  /** Twitch broadcaster id of the channel. */
  userId?: string | null;
  /** Twitch login (lowercase handle) of the channel. */
  userLogin?: string | null;
  /** Display name of the channel (for window titles / tooltips). */
  userName?: string | null;
  /** When false the hook stays idle — no follow/subscription lookups fire.
   *  Lets MultiNook run it only for the focused tile instead of every cell. */
  enabled?: boolean;
}

/** Follow + subscribe state and actions for a single channel.
 *
 *  Extracted from the single-stream player so the same controls can back both
 *  the main VideoPlayer overlay and the focused MultiNook tile without
 *  duplicating the follow-status / subscription / subscribe-window logic. */
export function useChannelSocial({ userId, userLogin, userName, enabled = true }: ChannelSocialTarget) {
  const currentUser = useAppStore((s) => s.currentUser);

  // Follow state
  const [isFollowing, setIsFollowing] = useState<boolean | null>(null);
  const [followLoading, setFollowLoading] = useState(false);
  const [checkingFollowStatus, setCheckingFollowStatus] = useState(true);
  const [heartDropAnimation, setHeartDropAnimation] = useState(false);

  // Subscription state
  const [isSubscribed, setIsSubscribed] = useState<boolean>(false);
  const [hasSubHistory, setHasSubHistory] = useState<boolean>(false);
  const [cumulativeMonths, setCumulativeMonths] = useState<number>(0);
  const [subscriberBadgeUrl, setSubscriberBadgeUrl] = useState<string | null>(null);

  // Check follow status when the channel changes
  useEffect(() => {
    if (!enabled || !userId) {
      setIsFollowing(null);
      setCheckingFollowStatus(false);
      return;
    }

    const checkFollowStatus = async () => {
      try {
        setCheckingFollowStatus(true);
        const result = await invoke<boolean>('check_following_status', { targetUserId: userId });
        setIsFollowing(result);
      } catch (err) {
        Logger.error('[useChannelSocial] Failed to check follow status:', err);
        setIsFollowing(false);
      } finally {
        setCheckingFollowStatus(false);
      }
    };

    checkFollowStatus();
  }, [enabled, userId]);

  // Check subscription status when the channel changes
  useEffect(() => {
    if (!enabled || !userId || !userLogin || !currentUser?.login) {
      setIsSubscribed(false);
      setHasSubHistory(false);
      setCumulativeMonths(0);
      setSubscriberBadgeUrl(null);
      return;
    }

    const channelId = userId;
    const channelLogin = userLogin;
    const loginOfUser = currentUser.login;

    const checkSubscriptionStatus = async () => {
      try {
        const { fetchIVRSubage } = await import('../services/ivrService');
        const subageData = await fetchIVRSubage(loginOfUser, channelLogin);

        // IVR API uses meta.type to indicate an active sub ("paid", "gift", "prime", etc.)
        const metaData = (subageData as unknown as Record<string, unknown>)?.meta as Record<string, unknown> | undefined;
        const isSub = metaData?.type != null;
        const cumMonths = subageData?.cumulative?.months ?? 0;

        setIsSubscribed(isSub);
        setHasSubHistory(cumMonths > 0 && !isSub);
        setCumulativeMonths(cumMonths);

        // Determine which badge version to show
        let badgeMonths = cumMonths;
        if (!isSub && cumMonths > 0) {
          // Lapsed subscriber: show badge for the NEXT month they'd reach
          badgeMonths = cumMonths + 1;
        }

        const getBadgeVersion = (months: number): string => {
          if (months >= 72) return '72';
          if (months >= 60) return '60';
          if (months >= 48) return '48';
          if (months >= 36) return '36';
          if (months >= 24) return '24';
          if (months >= 18) return '18';
          if (months >= 12) return '12';
          if (months >= 9) return '9';
          if (months >= 6) return '6';
          if (months >= 3) return '3';
          if (months >= 2) return '2';
          return '0';
        };

        const badgeVersion = getBadgeVersion(badgeMonths);

        const { initializeBadgeCache, parseBadges } = await import('../services/twitchBadges');
        await initializeBadgeCache(channelId);
        const badges = parseBadges(`subscriber/${badgeVersion}`, channelId);

        if (badges.length > 0 && badges[0].info?.image_url_2x) {
          setSubscriberBadgeUrl(badges[0].info.image_url_2x);
        } else {
          setSubscriberBadgeUrl(null);
        }
      } catch (err) {
        Logger.error('[useChannelSocial] Failed to check subscription status:', err);
        setIsSubscribed(false);
        setHasSubHistory(false);
        setSubscriberBadgeUrl(null);
      }
    };

    checkSubscriptionStatus();
  }, [enabled, userId, userLogin, currentUser?.login]);

  // Handle follow/unfollow action
  const handleFollowClick = useCallback(async () => {
    if (followLoading || !userId) return;

    const action = isFollowing ? 'unfollow' : 'follow';

    // If unfollowing, play the heart-drop animation first
    if (isFollowing) {
      setHeartDropAnimation(true);
      await new Promise((resolve) => setTimeout(resolve, 600));
      setHeartDropAnimation(false);
    }

    setFollowLoading(true);
    Logger.debug(`[useChannelSocial] Initiating ${action} for ${userLogin} (ID: ${userId})`);

    try {
      const command = isFollowing ? 'unfollow_channel' : 'follow_channel';
      await invoke(command, { targetUserId: userId });
      setIsFollowing((prev) => !prev);
      Logger.debug(`[useChannelSocial] Successfully ${action}ed ${userLogin}`);
    } catch (err) {
      Logger.error(`[useChannelSocial] ${action} error:`, err);
      useAppStore.getState().addToast(
        `Follow/Unfollow failed. Try logging out and back in via Settings to re-authenticate.`,
        'error'
      );
    } finally {
      setFollowLoading(false);
    }
  }, [userLogin, userId, isFollowing, followLoading]);

  // Track the subscribe window's label so we can auto-close it on a successful sub
  const subscribeWindowLabelRef = useRef<string | null>(null);

  // Listen for subscription events to auto-close the subscribe window
  useEffect(() => {
    if (!enabled) return;

    const handleSubscriptionDetected = async (event: Event) => {
      const customEvent = event as CustomEvent<{ login: string; msgId: string; displayName: string }>;
      const { login, msgId } = customEvent.detail;
      const currentUserLogin = currentUser?.login?.toLowerCase();

      // Only react to the current user's own subscription on this channel's window
      if (currentUserLogin && login === currentUserLogin && subscribeWindowLabelRef.current) {
        useAppStore.getState().addToast(
          `Subscription successful! ${msgId === 'subgift' ? 'Gift sent!' : 'Thank you for subscribing!'}`,
          'success'
        );

        try {
          await invoke('close_login_overlay', { label: subscribeWindowLabelRef.current });
        } catch (e) {
          Logger.warn('[useChannelSocial] Failed to close subscribe overlay:', e);
        }

        subscribeWindowLabelRef.current = null;
      }
    };

    window.addEventListener('twitch-subscription-detected', handleSubscriptionDetected);
    return () => {
      window.removeEventListener('twitch-subscription-detected', handleSubscriptionDetected);
    };
  }, [enabled, currentUser?.login]);

  // Open the Twitch subscribe page for this channel in a dedicated window,
  // isolated to the active (main) account's Twitch web profile so you subscribe
  // as the account you watch and stream as. The backend returns the window label
  // so the subscription listener above can auto-close it.
  const handleSubscribeClick = useCallback(async () => {
    if (!userLogin) return;
    try {
      const label = await invoke<string>('open_subscribe_window', {
        channelLogin: userLogin,
        title: `Subscribe to ${userName || userLogin}`,
      });
      subscribeWindowLabelRef.current = label;
    } catch (e) {
      Logger.error('[useChannelSocial] Error opening subscribe window:', e);
      subscribeWindowLabelRef.current = null;
    }
  }, [userLogin, userName]);

  return {
    // Follow
    isFollowing,
    followLoading,
    checkingFollowStatus,
    heartDropAnimation,
    handleFollowClick,
    // Subscribe
    isSubscribed,
    hasSubHistory,
    cumulativeMonths,
    subscriberBadgeUrl,
    handleSubscribeClick,
  };
}
