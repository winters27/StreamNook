// Chat for a non-Twitch stream watched in the MAIN window.
//
// Non-Twitch sources render through the SAME ChatWidget as Twitch, addressed by
// a `channelOverride` — the seam MultiChat's `ProviderViaChatWidget` already
// uses, so every Twitch-only behavior inside ChatWidget stays gated on
// `provider` with no new branches.
//
// Unlike the MultiChat pane, this one needs no metadata polling of its own:
// AppStore resolved the channel when the stream started and refreshes viewers
// and title from the same live check that detects the stream ending, so the
// override is derived straight from `currentStream`.

import { useMemo } from 'react';
import ChatWidget, { type ChatWidgetChannelOverride } from './ChatWidget';
import { useAppStore } from '../stores/AppStore';
import type { ProviderId } from '../types/providers';

interface MainProviderChatProps {
  provider: ProviderId;
  channel: string;
}

export default function MainProviderChat({ provider, channel }: MainProviderChatProps) {
  const currentStream = useAppStore((s) => s.currentStream);

  const channelOverride = useMemo<ChatWidgetChannelOverride>(
    () => ({
      provider,
      context: 'main',
      user_login: channel.toLowerCase(),
      user_id: currentStream?.user_id ?? '',
      user_name: currentStream?.user_name || channel,
      title: currentStream?.title || undefined,
      game_name: currentStream?.game_name || undefined,
      viewer_count: currentStream?.viewer_count,
      started_at: currentStream?.started_at || undefined,
      profile_image_url: currentStream?.profile_image_url || undefined,
      is_live: currentStream?.is_live ?? true,
      // The main window always owns its moderation hotkeys; MultiChat scopes
      // them to the focused pane, which is why this flag exists at all.
      is_active: true,
    }),
    [provider, channel, currentStream],
  );

  return <ChatWidget channelOverride={channelOverride} />;
}
