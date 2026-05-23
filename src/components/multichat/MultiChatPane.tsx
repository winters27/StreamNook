// MultiChatPane — channel-keyed chat surface used inside the StreamNook
// MultiChat popout window.
//
// Mounts the main app's ChatWidget with a richer `channelOverride` so the
// popout reaches feature parity with the in-app chat: copy, reply, pinned
// messages, emote picker, mod menu, profile clicks, badge interactions —
// AND the stream-view chrome (viewer count, uptime, About panel, etc.) reads
// real values because this pane polls Helix for the live stream metadata.
//
// Polling cadence: check_stream_online every 30s. Cheaper than EventSub and
// good enough for the popout's at-a-glance "what's happening" use case.
// Hype train / raid events still require EventSub (which is single-broadcaster
// today); those remain main-app-only until EventSub is made multi-broadcaster.

import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import ChatWidget, { type ChatWidgetChannelOverride } from '../ChatWidget';
import type { TwitchStream } from '../../types';
import { Logger } from '../../utils/logger';

export interface MultiChatPaneProps {
  channel: string;
  channelId?: string | null;
  channelName?: string;
}

const STREAM_POLL_INTERVAL_MS = 30_000;

interface ChannelUserInfo {
  id?: string;
  login?: string;
  display_name?: string;
  profile_image_url?: string;
  broadcaster_type?: string;
}

export function MultiChatPane({ channel, channelId, channelName }: MultiChatPaneProps) {
  const channelKey = channel.toLowerCase();

  const [stream, setStream] = useState<TwitchStream | null>(null);
  const [userInfo, setUserInfo] = useState<ChannelUserInfo | null>(null);

  // Resolve channel-level metadata (display name, avatar, broadcaster type)
  // once per channel. Doesn't change between live/offline.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const info = await invoke<ChannelUserInfo>('get_user_by_login', { login: channelKey });
        if (active) setUserInfo(info);
      } catch (err) {
        Logger.warn('[MultiChatPane] get_user_by_login failed:', err);
      }
    })();
    return () => {
      active = false;
    };
  }, [channelKey]);

  // Poll live stream metadata so viewer count, uptime, title, and game stay
  // current. check_stream_online returns the full TwitchStream when online
  // and null when offline.
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const fetchStream = async () => {
      try {
        const s = await invoke<TwitchStream | null>('check_stream_online', {
          userLogin: channelKey,
        });
        if (active) setStream(s);
      } catch (err) {
        Logger.warn('[MultiChatPane] check_stream_online failed:', err);
      }
    };

    void fetchStream();
    timer = setInterval(fetchStream, STREAM_POLL_INTERVAL_MS);

    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [channelKey]);

  const channelOverride = useMemo<ChatWidgetChannelOverride>(() => {
    const liveUserId = stream?.user_id || channelId || userInfo?.id || '';
    const liveLogin = stream?.user_login || channelKey;
    const liveName =
      stream?.user_name ||
      userInfo?.display_name ||
      channelName ||
      channelKey;

    return {
      user_login: liveLogin,
      user_id: liveUserId,
      user_name: liveName,
      title: stream?.title,
      game_name: stream?.game_name,
      viewer_count: stream?.viewer_count,
      started_at: stream?.started_at,
      thumbnail_url: stream?.thumbnail_url,
      profile_image_url: userInfo?.profile_image_url ?? stream?.profile_image_url,
      broadcaster_type: userInfo?.broadcaster_type ?? stream?.broadcaster_type,
      is_live: stream !== null,
    };
  }, [stream, userInfo, channelKey, channelId, channelName]);

  return <ChatWidget channelOverride={channelOverride} />;
}

export default MultiChatPane;
