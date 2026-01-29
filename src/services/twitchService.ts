import { invoke } from '@tauri-apps/api/core';
import { Logger } from '../utils/logger';
// Service for Twitch API calls (GraphQL and Helix)

interface TwitchBadge {
  id: string;
  setID: string;
  version: string;
  title: string;
  description: string;
  imageURL: string;
  image1x: string;
  image2x: string;
  image4x: string;
}

interface TwitchGQLResponse {
  data: {
    user: {
      displayBadges: TwitchBadge[];
    };
  };
}

interface TwitchStreamResponse {
  data: Array<{
    id: string;
    user_id: string;
    user_login: string;
    user_name: string;
    game_id: string;
    game_name: string;
    type: string;
    title: string;
    viewer_count: number;
    started_at: string;
    language: string;
    thumbnail_url: string;
    tag_ids: string[];
    is_mature: boolean;
  }>;
}

/**
 * Fetch all badges for a Twitch user using GraphQL
 * This includes all badges the user has earned, not just the ones shown in chat
 */
export async function fetchUserBadgesGQL(
  username: string,
  clientId: string,
  token: string
): Promise<TwitchBadge[]> {
  try {
    const query = `
      query UserBadges($login: String!) {
        user(login: $login) {
          displayBadges {
            id
            setID
            version
            title
            description
            imageURL
            image1x: imageURL(size: NORMAL)
            image2x: imageURL(size: DOUBLE)
            image4x: imageURL(size: QUADRUPLE)
          }
        }
      }
    `;

    const response = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-ID': clientId,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: {
          login: username,
        },
      }),
    });

    if (!response.ok) {
      Logger.warn('[TwitchGQL] Failed to fetch user badges:', response.status);
      return [];
    }

    const result: TwitchGQLResponse = await response.json();

    if (!result.data?.user?.displayBadges) {
      Logger.warn('[TwitchGQL] No badges found for user:', username);
      return [];
    }

    Logger.debug(`[TwitchGQL] Fetched ${result.data.user.displayBadges.length} badges for ${username}`);
    return result.data.user.displayBadges;
  } catch (error) {
    Logger.error('[TwitchGQL] Error fetching user badges:', error);
    return [];
  }
}

/**
 * Fetches stream information for a given user login using Twitch Helix API.
 * @param userLogin The login name of the user (channel name).
 * @param clientId Your Twitch application's client ID.
 * @param token An OAuth access token with `user:read:broadcast` scope.
 * @returns The viewer count of the stream, or null if the stream is offline or an error occurs.
 */
export async function fetchStreamViewerCount(
  userLogin: string,
  clientId: string,
  token: string
): Promise<number | null> {
  try {
    const response = await fetch(`https://api.twitch.tv/helix/streams?user_login=${userLogin}`, {
      headers: {
        'Client-ID': clientId,
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      Logger.error(`[TwitchHelix] Failed to fetch stream info: ${response.status} ${response.statusText}`);
      return null;
    }

    const result: TwitchStreamResponse = await response.json();

    if (result.data.length > 0) {
      Logger.debug(`[TwitchHelix] Fetched viewer count for ${userLogin}: ${result.data[0].viewer_count}`);
      return result.data[0].viewer_count;
    } else {
      Logger.debug(`[TwitchHelix] Stream for ${userLogin} is offline.`);
      return null;
    }
  } catch (error) {
    Logger.error('[TwitchHelix] Error fetching stream viewer count:', error);
    return null;
  }
}
