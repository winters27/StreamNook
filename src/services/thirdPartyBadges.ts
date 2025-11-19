// Service for fetching badges from third-party providers (FFZ, Chatterino, Homies, etc.)

export interface ThirdPartyBadge {
  id: string;
  provider: 'ffz' | 'chatterino' | 'homies';
  title: string;
  imageUrl: string;
  link?: string;
}

// FrankerFaceZ Badges
export async function getFFZBadges(userId: string): Promise<ThirdPartyBadge[]> {
  try {
    const response = await fetch('https://api.frankerfacez.com/v1/badges/ids');
    if (!response.ok) return [];
    
    const data = await response.json();
    const badges: ThirdPartyBadge[] = [];
    
    // Check if user has any FFZ badges
    if (data.users && data.users[userId]) {
      const userBadgeIds = data.users[userId];
      
      for (const badgeId of userBadgeIds) {
        const badgeInfo = data.badges?.find((b: any) => b.id === badgeId);
        if (badgeInfo) {
          // Get the highest resolution image
          const imageUrl = badgeInfo.urls?.['4'] || badgeInfo.urls?.['2'] || badgeInfo.urls?.['1'];
          
          if (imageUrl) {
            badges.push({
              id: `ffz-${badgeId}`,
              provider: 'ffz',
              title: badgeInfo.title || badgeInfo.name || `FFZ Badge ${badgeId}`,
              imageUrl: imageUrl,
              link: `https://www.frankerfacez.com/badges`
            });
          }
        }
      }
    }
    
    return badges;
  } catch (error) {
    console.error('[FFZ Badges] Failed to fetch:', error);
    return [];
  }
}

// Chatterino Badges
export async function getChatterinoBadges(userId: string): Promise<ThirdPartyBadge[]> {
  try {
    const response = await fetch('https://api.chatterino.com/badges');
    if (!response.ok) return [];
    
    const data = await response.json();
    const badges: ThirdPartyBadge[] = [];
    
    // Check if user has any Chatterino badges
    if (data.badges) {
      for (const badge of data.badges) {
        if (badge.users && badge.users.includes(userId)) {
          badges.push({
            id: `chatterino-${badge.tooltip}`,
            provider: 'chatterino',
            title: badge.tooltip || 'Chatterino Badge',
            imageUrl: badge.image3 || badge.image2 || badge.image1,
            link: 'https://chatterino.com/'
          });
        }
      }
    }
    
    return badges;
  } catch (error) {
    console.error('[Chatterino Badges] Failed to fetch:', error);
    return [];
  }
}

// Homies Badges (Chatterino Homies)
export async function getHomiesBadges(userId: string): Promise<ThirdPartyBadge[]> {
  try {
    // Fetch both badge sources
    const [badges1Response, badges2Response] = await Promise.all([
      fetch('https://itzalex.github.io/badges').catch(() => null),
      fetch('https://itzalex.github.io/badges2').catch(() => null)
    ]);
    
    let allBadges: any[] = [];
    
    // Merge badge data from both sources
    if (badges1Response?.ok) {
      const data1 = await badges1Response.json();
      allBadges = data1.badges || [];
    }
    
    if (badges2Response?.ok) {
      const data2 = await badges2Response.json();
      const badges2 = data2.badges || [];
      
      // Merge badges, avoiding duplicates
      badges2.forEach((badge: any) => {
        const existing = allBadges.find((b) => b.tooltip === badge.tooltip);
        if (existing) {
          if (badge.users && badge.users.length) {
            existing.users = [...(existing.users || []), ...badge.users];
          }
        } else {
          allBadges.push(badge);
        }
      });
    }
    
    const userBadges: ThirdPartyBadge[] = [];
    
    // Find badges for this user
    for (const badge of allBadges) {
      if (badge.users && badge.users.includes(userId)) {
        userBadges.push({
          id: `homies-${badge.tooltip}`,
          provider: 'homies',
          title: badge.tooltip || 'Homies Badge',
          imageUrl: badge.image3 || badge.image2 || badge.image1,
          link: 'https://chatterinohomies.com/'
        });
      }
    }
    
    return userBadges;
  } catch (error) {
    console.error('[Homies Badges] Failed to fetch:', error);
    return [];
  }
}

// Get all third-party badges for a user
export async function getAllThirdPartyBadges(userId: string): Promise<ThirdPartyBadge[]> {
  try {
    const [ffzBadges, chatterinoBadges, homiesBadges] = await Promise.all([
      getFFZBadges(userId),
      getChatterinoBadges(userId),
      getHomiesBadges(userId)
    ]);
    
    return [...ffzBadges, ...chatterinoBadges, ...homiesBadges];
  } catch (error) {
    console.error('[Third Party Badges] Failed to fetch all badges:', error);
    return [];
  }
}
