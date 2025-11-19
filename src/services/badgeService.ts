// Comprehensive badge service using IVR API and Twitch GQL
export interface TwitchBadge {
  id: string;
  setID: string;
  version: string;
  title: string;
  description: string;
  image1x: string;
  image2x: string;
  image4x: string;
}

export interface UserBadgesResponse {
  displayBadges: TwitchBadge[];
  earnedBadges: TwitchBadge[];
  ivrBadges: any[];
}

// Get global Twitch badges from IVR
export async function getGlobalBadges(): Promise<any[]> {
  try {
    const response = await fetch('https://api.ivr.fi/v2/twitch/badges/global');
    if (!response.ok) {
      return [];
    }
    return await response.json();
  } catch (error) {
    console.error('[Badges] Failed to fetch global badges:', error);
    return [];
  }
}

// Get channel-specific badges from IVR
export async function getChannelBadges(channelName: string): Promise<any[]> {
  try {
    const response = await fetch(`https://api.ivr.fi/v2/twitch/badges/channel?login=${channelName}`);
    if (!response.ok) {
      return [];
    }
    return await response.json();
  } catch (error) {
    console.error('[Badges] Failed to fetch channel badges:', error);
    return [];
  }
}

// Get user data from IVR
export async function getUserData(userName: string): Promise<any | null> {
  try {
    const response = await fetch(`https://api.ivr.fi/v2/twitch/user?login=${userName}`);
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error('[Badges] Failed to fetch user data:', error);
    return null;
  }
}

// Get user's displayed and earned badges from Twitch GQL
export async function getUserBadgesFromGQL(
  channelID: string,
  channelLogin: string,
  userName: string
): Promise<{ displayBadges: any[]; earnedBadges: any[] }> {
  try {
    // First, try to get the user's ID from IVR API
    const userData = await getUserData(userName);
    const targetUserID = userData?.[0]?.id;
    
    const response = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Accept-Language': 'en-US',
        'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([
        {
          operationName: 'ViewerCard',
          variables: {
            channelID: channelID,
            channelLogin: channelLogin,
            hasChannelID: true,
            targetUserID: targetUserID || undefined,
            targetLogin: userName,
            giftRecipientLogin: userName,
            isViewerBadgeCollectionEnabled: true,
            withStandardGifting: true,
            badgeSourceChannelID: channelID,
            badgeSourceChannelLogin: channelLogin
          },
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash: '80c53fe04c79a6414484104ea573c28d6a8436e031a235fc6908de63f51c74fd'
            }
          }
        }
      ])
    });

    if (!response.ok) {
      console.error('[Badges] GQL response not ok:', response.status, response.statusText);
      return { displayBadges: [], earnedBadges: [] };
    }

    const data = await response.json();
    const badgesData = data[0]?.data;
    
    console.log('[Badges] GQL response data:', badgesData);
    
    const displayBadges = badgesData?.targetUser?.displayBadges || [];
    const earnedBadges = badgesData?.channelViewer?.earnedBadges || [];

    return { displayBadges, earnedBadges };
  } catch (error) {
    console.error('[Badges] Failed to fetch user badges from GQL:', error);
    return { displayBadges: [], earnedBadges: [] };
  }
}

// Filtered badge categories to show
export const filteredBadgeCategories = [
  'artist-badge',
  'broadcaster',
  'subscriber',
  'sub-gifter',
  'hype-train',
  'moderator',
  'founder',
  'moments',
  'bits',
  'vip',
  'partner',
  'premium',
  'staff',
  'admin',
  'global_mod',
  'turbo',
  'predictions',
  'sub-gift-leader',
  'clip-champ'
];

// Parse badge data to create consistent format
function parseBadgeData(badge: any, globalBadges: any[], channelBadges: any[]): TwitchBadge | null {
  try {
    const setID = badge.setID;
    const version = badge.version || '1';
    
    // Try to find badge info from global badges
    let badgeInfo = globalBadges.find((b) => b.setID === setID);
    
    // If not found, try channel badges
    if (!badgeInfo) {
      badgeInfo = channelBadges.find((b) => b.setID === setID);
    }
    
    if (!badgeInfo) {
      console.warn(`[Badges] Badge info not found for setID: ${setID}, trying direct image URLs`);
      // If we can't find badge info, but we have direct image URLs from GQL, use those
      if (badge.image1x || badge.image2x || badge.image4x) {
        return {
          id: `${setID}_${version}`,
          setID: setID,
          version: version,
          title: badge.title || setID,
          description: badge.description || '',
          image1x: badge.image1x || '',
          image2x: badge.image2x || '',
          image4x: badge.image4x || ''
        };
      }
      return null;
    }
    
    // Find the specific version
    const versionInfo = badgeInfo.versions?.find((v: any) => v.id === version) || badgeInfo.versions?.[0];
    
    if (!versionInfo) {
      // If we can't find version info, but we have direct image URLs from GQL, use those
      if (badge.image1x || badge.image2x || badge.image4x) {
        return {
          id: `${setID}_${version}`,
          setID: setID,
          version: version,
          title: badge.title || badgeInfo.title || setID,
          description: badge.description || badgeInfo.description || '',
          image1x: badge.image1x || '',
          image2x: badge.image2x || '',
          image4x: badge.image4x || ''
        };
      }
      return null;
    }
    
    return {
      id: `${setID}_${version}`,
      setID: setID,
      version: version,
      title: versionInfo.title || badgeInfo.title || setID,
      description: versionInfo.description || badgeInfo.description || '',
      image1x: versionInfo.image_url_1x || badge.image1x || '',
      image2x: versionInfo.image_url_2x || badge.image2x || '',
      image4x: versionInfo.image_url_4x || badge.image4x || ''
    };
  } catch (error) {
    console.error('[Badges] Failed to parse badge:', error);
    return null;
  }
}

// Get all badges for a user (comprehensive)
export async function getAllUserBadges(
  userId: string,
  username: string,
  channelId: string,
  channelName: string
): Promise<UserBadgesResponse> {
  try {
    console.log('[Badges] Fetching all badges for:', { userId, username, channelId, channelName });
    
    // Fetch all badge data in parallel
    const [globalBadges, channelBadges, gqlBadges] = await Promise.all([
      getGlobalBadges(),
      getChannelBadges(channelName),
      getUserBadgesFromGQL(channelId, channelName, username)
    ]);

    console.log('[Badges] Raw GQL badges:', gqlBadges);
    console.log('[Badges] Global badges count:', globalBadges.length);
    console.log('[Badges] Channel badges count:', channelBadges.length);

    // Parse displayed badges
    const displayBadges: TwitchBadge[] = gqlBadges.displayBadges
      .map((badge) => parseBadgeData(badge, globalBadges, channelBadges))
      .filter((badge): badge is TwitchBadge => badge !== null);

    // Parse earned badges and filter by category
    const earnedBadges: TwitchBadge[] = gqlBadges.earnedBadges
      .map((badge) => parseBadgeData(badge, globalBadges, channelBadges))
      .filter((badge): badge is TwitchBadge => badge !== null);

    console.log('[Badges] Parsed display badges:', displayBadges);
    console.log('[Badges] Parsed earned badges:', earnedBadges);

    return {
      displayBadges,
      earnedBadges,
      ivrBadges: [...globalBadges, ...channelBadges]
    };
  } catch (error) {
    console.error('[Badges] Failed to fetch all user badges:', error);
    return {
      displayBadges: [],
      earnedBadges: [],
      ivrBadges: []
    };
  }
}
