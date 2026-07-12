export interface SettingsIndexEntry {
  tab: string;
  section: string;
  sectionId?: string;
  title: string;
  description?: string;
}

const tokenize = (s: string): string[] =>
  s.toLowerCase().split(/\s+/).filter(Boolean);

export const searchSettings = (
  query: string,
  limit = 50,
  // Optional whitelist of source tabs. Lets a scoped surface (e.g. the MultiChat
  // settings, which only has the Chat panel) search just its own settings.
  allowTabs?: string[],
): SettingsIndexEntry[] => {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const scored: { entry: SettingsIndexEntry; score: number }[] = [];

  for (const entry of SETTINGS_INDEX) {
    if (allowTabs && !allowTabs.includes(entry.tab)) continue;
    const title = entry.title.toLowerCase();
    const description = entry.description?.toLowerCase() ?? '';
    const section = entry.section.toLowerCase();
    const tab = entry.tab.toLowerCase();
    const haystack = `${title} ${description} ${section} ${tab}`;

    let allMatch = true;
    let score = 0;
    for (const token of tokens) {
      if (!haystack.includes(token)) {
        allMatch = false;
        break;
      }
      if (title.startsWith(token)) score += 100;
      else if (title.includes(token)) score += 50;
      else if (section.includes(token)) score += 20;
      else if (description.includes(token)) score += 10;
      else if (tab.includes(token)) score += 5;
    }

    if (allMatch) scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.entry);
};

// Manual index for the in-Settings search box. Mirrors the rendered
// <SettingsSection>/<SettingsRow> tree in src/components/settings/. `sectionId`
// must equal the DOM id on the matching <SettingsSection> (or its wrapper) so a
// hit scrolls to it; sections with no id just switch tabs. `description` is part
// of the haystack, so pack synonyms in. Keep this in sync with the command
// palette catalog in src/utils/commandPaletteSources.ts.
export const SETTINGS_INDEX: SettingsIndexEntry[] = [
  // === Player ===
  {
    tab: 'Player',
    section: 'Player Overlay Buttons',
    title: 'Player Overlay Buttons',
    description: 'Choose which action buttons (follow, subscribe, create clip, identify song, clips & vods, add to multinook, refresh, close) appear in the top-right of the video player.'
  },
  {
    tab: 'Player',
    section: 'Auto-Switch',
    sectionId: 'settings-section-auto-switch',
    title: 'Auto-Switch',
    description: 'When a stream goes offline, automatically switch to another stream.'
  },
  {
    tab: 'Player',
    section: 'Auto-Switch',
    sectionId: 'settings-section-auto-switch',
    title: 'Enable Auto-Switch',
    description: 'Automatically switch when the current stream goes offline.'
  },
  {
    tab: 'Player',
    section: 'Auto-Switch',
    sectionId: 'settings-section-auto-switch',
    title: 'Switch To',
    description: 'Switch to the highest viewer stream in the same game/category, or one of your live followed streamers.'
  },
  {
    tab: 'Player',
    section: 'Auto-Switch',
    sectionId: 'settings-section-auto-switch',
    title: 'Show Notification',
    description: 'Display a toast when auto-switching streams.'
  },
  {
    tab: 'Player',
    section: 'Auto-Switch',
    sectionId: 'settings-section-auto-switch',
    title: 'Auto-Redirect on Raid',
    description: 'Automatically follow raids to the target channel (requires login).'
  },
  {
    tab: 'Player',
    section: 'Auto-Switch',
    sectionId: 'settings-section-auto-switch',
    title: 'Stay in Offline Chat',
    description: "Don't auto-switch when a stream ends, stay in the chat room instead."
  },
  {
    tab: 'Player',
    section: 'Streaming',
    sectionId: 'settings-section-streaming',
    title: 'Streaming',
    description: 'Codec preferences and stream resolve timing: connection timeout and auto-retry delay.'
  },
  {
    tab: 'Player',
    section: 'Streaming',
    sectionId: 'settings-section-streaming',
    title: 'Allow h265 + AV1 codecs',
    description: 'Request AV1 and HEVC stream variants in addition to h264. Turn off if you see decode errors on older hardware.'
  },
  {
    tab: 'Player',
    section: 'Streaming',
    sectionId: 'settings-section-streaming',
    title: 'Connection Timeout',
    description: 'How long to keep retrying to resolve a stream before giving up.'
  },
  {
    tab: 'Player',
    section: 'Streaming',
    sectionId: 'settings-section-streaming',
    title: 'Auto-Retry Delay',
    description: 'Seconds to wait between resolve attempts while a stream is not available yet.'
  },
  {
    tab: 'Player',
    section: 'Video Player',
    sectionId: 'settings-section-video-player',
    title: 'Video Player',
    description: 'Playback behavior: autoplay, live edge, low latency, buffer, quality, volume, aspect ratio, mute.'
  },
  {
    tab: 'Player',
    section: 'Video Player',
    sectionId: 'settings-section-video-player',
    title: 'Autoplay',
    description: 'Automatically play a stream when loaded.'
  },
  {
    tab: 'Player',
    section: 'Video Player',
    sectionId: 'settings-section-video-player',
    title: 'Live Edge Gap',
    description: 'How far behind the live edge to ride. Lower is closer to live and reduces delay; the lowest gaps need Low Latency on. Catch up to live, latency target.'
  },
  {
    tab: 'Player',
    section: 'Video Player',
    sectionId: 'settings-section-video-player',
    title: 'Low Latency',
    description: 'Use the low-latency engine to hold a tight live edge gap on channels that support it. Turn off if a stream stutters or will not play.'
  },
  {
    tab: 'Player',
    section: 'Video Player',
    sectionId: 'settings-section-video-player',
    title: 'Max Buffer Length',
    description: 'Maximum amount of video to buffer ahead (higher = more stable, but more delay).'
  },
  {
    tab: 'Player',
    section: 'Video Player',
    sectionId: 'settings-section-video-player',
    title: 'Default Stream Quality',
    description: 'Quality to use when starting streams (you can change quality anytime using the player controls).'
  },
  {
    tab: 'Player',
    section: 'Video Player',
    sectionId: 'settings-section-video-player',
    title: 'Lock Aspect Ratio (16:9)',
    description: 'Prevent letterboxing by constraining window resize to maintain video aspect ratio.'
  },
  {
    tab: 'Player',
    section: 'Video Player',
    sectionId: 'settings-section-video-player',
    title: 'Cinema Mode',
    description: 'Letterbox bar color. Cinema Mode uses classic black bars; off matches the bars to your theme background so the video floats. Black bars, color-matched, immersive, pillarbox.'
  },
  {
    tab: 'Player',
    section: 'Video Player',
    sectionId: 'settings-section-video-player',
    title: 'Start Muted',
    description: 'Begin playback with audio muted.'
  },
  {
    tab: 'Player',
    section: 'Video Player',
    sectionId: 'settings-section-video-player',
    title: 'Default Volume',
    description: 'Initial volume level when starting playback.'
  },
  {
    tab: 'Player',
    section: 'Audio Boost',
    sectionId: 'settings-section-audio-boost',
    title: 'Audio Boost',
    description: 'Compressor and makeup gain to even out loud and quiet moments and make the stream louder without clipping.'
  },
  {
    tab: 'Player',
    section: 'Audio Boost',
    sectionId: 'settings-section-audio-boost',
    title: 'Enable Audio Boost',
    description: 'Run the stream audio through a compressor and a makeup-gain stage.'
  },
  {
    tab: 'Player',
    section: 'Audio Boost',
    sectionId: 'settings-section-audio-boost',
    title: 'Boost',
    description: 'How much louder to make the stream after compression (volume boost / gain).'
  },
  {
    tab: 'Player',
    section: 'Audio Boost',
    sectionId: 'settings-section-audio-boost',
    title: 'Advanced Compressor Controls',
    description: 'Threshold, ratio, knee, attack and release controls for the audio compressor.'
  },
  {
    tab: 'Player',
    section: 'Song Identification',
    sectionId: 'settings-section-song-id',
    title: 'Song Identification',
    description: 'Identify the music playing in a stream (what song is this). Powers the /song chat command and the player music button; names the track and links it on Spotify, Apple Music, and song.link. Shazam, recognize, now playing.'
  },
  {
    tab: 'Player',
    section: 'Song Identification',
    sectionId: 'settings-section-song-id',
    title: 'Listen Time',
    description: 'How many seconds of audio the song identifier fingerprints. Longer captures match more accurately, especially over talking or noise. Shazam, music recognition.'
  },
  {
    tab: 'Player',
    section: 'Song Identification',
    sectionId: 'settings-section-song-id',
    title: 'Retries on No Match',
    description: 'How many extra times the song identifier listens again when the first try finds no song. Music recognition, Shazam.'
  },

  // === Theme ===
  {
    tab: 'Theme',
    section: 'Theme',
    title: 'Theme',
    description: 'Pick a color theme or build your own. Themes set the palette only; font and glassiness are chosen separately, so you can use any font with any theme.'
  },
  {
    tab: 'Theme',
    section: 'Glassiness',
    title: 'Glassiness',
    description: 'How see-through and frosted every surface is, for every theme. 100% is the signature glass; 0% removes all transparency and blur for a completely flat, solid, opaque look.'
  },
  {
    tab: 'Theme',
    section: 'Font',
    title: 'Font',
    description: 'Interface font, independent of the theme. Choose any font with any theme. Satoshi, Twitch (Inter), Geist, Manrope, Outfit, Space Grotesk, Serif, and System.'
  },

  // === Chat ===
  {
    tab: 'Chat',
    section: 'Chat Placement',
    title: 'Chat Placement',
    description: 'Choose where to display the chat window (right, bottom) or hide it completely.'
  },
  {
    tab: 'Chat',
    section: 'Chat Placement',
    title: 'Placement',
    description: 'Choose where to display the chat window or hide it completely.'
  },
  {
    tab: 'Chat',
    section: 'Channel Points',
    title: 'Channel Points',
    description: 'Auto-claim the bonus chest on the stream you are watching. Channel points, bonus claim, points automation is a separate opt-in plugin.'
  },
  {
    tab: 'Chat',
    section: 'Channel Points',
    title: 'Auto-claim bonus chests',
    description: 'Automatically collect the bonus chest on the stream you are watching. When off, a claim button appears on the points icon.'
  },
  {
    tab: 'Chat',
    section: 'Chat Events',
    sectionId: 'settings-section-chat-events',
    title: 'Chat Events',
    description: 'What live channel activity shows while you watch: polls, predictions, and channel point redemptions. Turn any off to keep chat clean.'
  },
  {
    tab: 'Chat',
    section: 'Chat Events',
    sectionId: 'settings-section-chat-events',
    title: 'Polls',
    description: 'Show a live poll card at the top of chat when the streamer runs one, with the running vote tally.'
  },
  {
    tab: 'Chat',
    section: 'Chat Events',
    sectionId: 'settings-section-chat-events',
    title: 'Predictions',
    description: 'Show a live prediction card at the top of chat, with the outcomes and how points are stacking up.'
  },
  {
    tab: 'Chat',
    section: 'Chat Events',
    sectionId: 'settings-section-chat-events',
    title: 'Channel point redemptions',
    description: 'Drop a chat row when someone redeems a reward that does not post its own message, such as a no-input reward.'
  },
  {
    tab: 'Chat',
    section: 'Chat Logging',
    title: 'Chat Logging',
    description: 'Save chat to plain text files as you watch: one folder per channel, one file per day. Log folder, per-channel filter, timestamps, events and moderation.'
  },
  {
    tab: 'Chat',
    section: 'Chat Logging',
    title: 'Save chat logs',
    description: 'Write chat to plain text files as you watch: one folder per channel, one file per day.'
  },
  {
    tab: 'Chat',
    section: 'Chat Logging',
    title: 'Log folder',
    description: 'The folder chat logs are written to. Browse to pick a custom location or open the current one.'
  },
  {
    tab: 'Chat',
    section: 'Chat Logging',
    title: 'Only log these channels',
    description: 'Restrict logging to specific channels. Leave empty to log every channel you open.'
  },
  {
    tab: 'Chat',
    section: 'Chat Logging',
    title: 'Events and moderation',
    description: 'Also log subscriptions, raids, announcements, timeouts, and deleted messages.'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Chat Design',
    description: 'Customize the appearance of chat messages: dividers, backgrounds, spacing, font, timestamps, mentions, name prefix.'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Show Message Dividers',
    description: 'Display subtle lines between chat messages.'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Alternating Backgrounds',
    description: 'Alternate message background colors using your theme palette.'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Message Spacing',
    description: 'Space between chat messages.'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Font Size',
    description: 'Chat message text size.'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Font Weight',
    description: 'Boldness of chat message text.'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Mention Animation',
    description: "Flash animation when you're mentioned or replied to."
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Show Timestamps',
    description: 'Display the time each message was sent next to the username.'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Include Seconds',
    description: 'Show seconds in timestamps (e.g., 7:42:30 PM instead of 7:42 PM).'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Pins Start Collapsed',
    description: 'Show the pinned message as its compact one-line bar when you enter a channel instead of fully expanded.'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Collapsed Pinned Message',
    description: 'When a pinned message is collapsed, shrink it to a thin one-line bar (sender + truncated text) instead of hiding it entirely.'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Name Separator',
    description: 'Glyph between the username and the message: colon, dot, arrow, pipe, or dash. Makes the name read as a prefix (name: message).'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Name Style',
    description: 'Make the username stand out as a prefix: accent bar, frosted chip or tag, brackets [name], or a small color dot.'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Prefix Color',
    description: "Color for the username separator and name style: the chatter's own color, or your theme accent."
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: '@ Mention Color',
    description: 'Color used for messages that mention you.'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Reply Thread Color',
    description: 'Color used for replies in threads.'
  },
  {
    tab: 'Chat',
    section: 'Link Previews',
    title: 'Link Previews',
    description: 'Show rich preview cards when links are posted in chat. Unfurl, embed, trusted sources, shorten links.'
  },
  {
    tab: 'Chat',
    section: 'Link Previews',
    title: 'Preview Mode',
    description: 'Off keeps links as plain text. Card + Link shows the preview and keeps the link in chat. Clean shows only the preview card and hides the link.'
  },
  {
    tab: 'Chat',
    section: 'Link Previews',
    title: 'Shorten Links',
    description: 'Display links as a clean compact label (site plus a short path) instead of the full raw URL.'
  },
  {
    tab: 'Chat',
    section: 'Link Previews',
    title: 'Trusted Sources',
    description: 'Sites that expand into a preview automatically. Add or remove your own trusted sites.'
  },
  {
    tab: 'Chat',
    section: 'Emotes',
    title: 'Emotes',
    description: 'Customize emote display: inline size, hover preview size, and spacing.'
  },
  {
    tab: 'Chat',
    section: 'Emotes',
    title: 'Emote Size',
    description: 'Multiplier for inline emote size. 1.00x matches the default.'
  },
  {
    tab: 'Chat',
    section: 'Emotes',
    title: 'Emote Hover Size',
    description: 'How large an emote grows in its hover preview. Hover the sample to try the chosen size.'
  },
  {
    tab: 'Chat',
    section: 'Emotes',
    title: 'Emote Spacing',
    description: 'Horizontal space around emotes. Negative values let them overlap for an inline feel.'
  },
  {
    tab: 'Chat',
    section: 'Chat Input',
    title: 'Chat Input',
    description: 'Quality-of-life behavior for the message composer: duplicate-message bypass and quick send.'
  },
  {
    tab: 'Chat',
    section: 'Chat Input',
    title: 'Bypass duplicate-message check',
    description: 'Append an invisible character when you send the same message twice so Twitch does not reject the second send. Useful for repeating an emote.'
  },
  {
    tab: 'Chat',
    section: 'Chat Input',
    title: 'Quick Send (Ctrl+Enter keeps message)',
    description: 'Hold Ctrl while pressing Enter to send the message and leave it in the input box so you can re-send fast.'
  },
  {
    tab: 'Chat',
    section: 'Emote Tab Completion',
    sectionId: 'settings-section-emote-tab-completion',
    title: 'Emote Tab Completion',
    description: 'Tab cycles forward through matching emotes in the chat input, Shift+Tab cycles back. Autocomplete.'
  },
  {
    tab: 'Chat',
    section: 'Emote Tab Completion',
    sectionId: 'settings-section-emote-tab-completion',
    title: 'Enable Tab Completion',
    description: 'Press Tab while typing a partial emote name to insert the best-matching emote.'
  },
  {
    tab: 'Chat',
    section: 'Emote Tab Completion',
    sectionId: 'settings-section-emote-tab-completion',
    title: 'Match Mode',
    description: 'Whether the tab carousel ranks matches by prefix (starts with) or by substring (contains).'
  },
  {
    tab: 'Chat',
    section: 'Emote Tab Completion',
    sectionId: 'settings-section-emote-tab-completion',
    title: 'Include Chat Users',
    description: 'Also cycle through display names of users currently in chat.'
  },
  {
    tab: 'Chat',
    section: 'Render Style',
    title: 'Render Style',
    description: 'How specific message classes look in chat: deleted messages, shared chat, mention paint, emote tooltips, scroll, message buffer.'
  },
  {
    tab: 'Chat',
    section: 'Render Style',
    title: 'Deleted messages',
    description: 'How banned, timed-out, and deleted messages render: strikethrough, dimmed, keep, or hidden.'
  },
  {
    tab: 'Chat',
    section: 'Render Style',
    title: 'Hide shared chat messages',
    description: 'Suppress messages flagged as coming from another room in a Twitch shared-chat session.'
  },
  {
    tab: 'Chat',
    section: 'Render Style',
    title: 'Paint @mentions inline',
    description: 'Render an @ mentioned name with their 7TV paint. Off renders mentions in their flat color only.'
  },
  {
    tab: 'Chat',
    section: 'Render Style',
    title: 'Compact emote tooltips',
    description: 'Show just the emote name on hover instead of the full hint.'
  },
  {
    tab: 'Chat',
    section: 'Render Style',
    title: '7TV emote update notices',
    description: "Show a chat notice when a channel's 7TV emote set changes live (a mod adds, removes, or renames an emote)."
  },
  {
    tab: 'Chat',
    section: 'Render Style',
    title: 'Smooth scroll on Resume',
    description: 'Animate the scroll when you click Resume. New-message auto-scroll stays instant.'
  },
  {
    tab: 'Chat',
    section: 'Render Style',
    title: 'Message buffer',
    description: 'How many messages to keep in the local scrollback per channel. Higher = more history, more memory.'
  },
  {
    tab: 'Chat',
    section: '7TV Cosmetics',
    title: '7TV Cosmetics',
    description: 'Visual controls for 7TV-rendered usernames (paints), including drop shadows.'
  },
  {
    tab: 'Chat',
    section: '7TV Cosmetics',
    title: 'Paint drop shadows',
    description: 'Some 7TV paints stack heavy drop shadows for readability. Drop to One or None if they feel too noisy.'
  },
  {
    tab: 'Chat',
    section: 'Highlight Appearance',
    title: 'Highlight Appearance',
    description: 'How highlights look across every highlight type: phrases, usernames, badges, and built-in events. Display style, tint opacity, flash window title.'
  },
  {
    tab: 'Chat',
    section: 'Highlight Appearance',
    title: 'Display style',
    description: 'How a highlighted message is emphasized (standard tint and other styles).'
  },
  {
    tab: 'Chat',
    section: 'Highlight Appearance',
    title: 'Tint opacity',
    description: 'Strength of the highlight tint behind a matched message.'
  },
  {
    tab: 'Chat',
    section: 'Highlight Appearance',
    title: 'Flash window title when unfocused',
    description: 'Flash the window title bar when a highlight fires while the app is in the background.'
  },
  {
    tab: 'Chat',
    section: 'Highlight Phrases',
    title: 'Highlight Phrases',
    description: 'Flash chat messages that match specific words, names, or patterns. Mentions of your own name and replies to you are always highlighted; these are extra.'
  },
  {
    tab: 'Chat',
    section: 'Built-in Event Highlights',
    title: 'Built-in Event Highlights',
    description: 'Auto-highlight messages from event types: first-time chatters, returning chatters, your own messages, and raid announcements.'
  },
  {
    tab: 'Chat',
    section: 'Built-in Event Highlights',
    title: 'First-time chatters',
    description: "Highlight a chatter's very first message in the channel."
  },
  {
    tab: 'Chat',
    section: 'Built-in Event Highlights',
    title: 'Returning chatters',
    description: 'Highlight the first message from a returning chatter.'
  },
  {
    tab: 'Chat',
    section: 'Built-in Event Highlights',
    title: 'Your own messages',
    description: 'Highlight messages you send.'
  },
  {
    tab: 'Chat',
    section: 'Built-in Event Highlights',
    title: 'Raid announcements',
    description: 'Highlight raid announcement messages.'
  },
  {
    tab: 'Chat',
    section: 'Username Highlights',
    title: 'Username Highlights',
    description: 'Always highlight messages from specific users by login. Match is case-insensitive.'
  },
  {
    tab: 'Chat',
    section: 'Badge Highlights',
    title: 'Badge Highlights',
    description: 'Highlight every message from users carrying a specific Twitch badge. Use name/version (e.g. moderator/1) or name/* to match any version.'
  },
  {
    tab: 'Chat',
    section: 'Custom Commands',
    title: 'Custom Commands',
    description: 'Define your own chat commands with expansions and auto-fill.'
  },
  {
    tab: 'Chat',
    section: 'Reminders',
    sectionId: 'reminders',
    title: 'Reminders',
    description: 'Auto-post a message into chat to remind the streamer: every N minutes, after a delay, at a clock time, at a stream uptime, or when a keyword appears. Repeat it several times so it lands. Also settable from chat with /remind.'
  },
  {
    tab: 'Chat',
    section: 'Reminders',
    sectionId: 'reminders',
    title: 'Auto message timer',
    description: 'Schedule a recurring or one-off chat message with the /remind command.'
  },
  {
    tab: 'Chat',
    section: 'User Overrides',
    title: 'User Overrides',
    description: "Nicknames you've set for individual chatters. Only visible to you. Set or clear a nickname from the user's profile card in chat."
  },

  // === Moderation ===
  {
    tab: 'Moderation',
    section: 'Moderation Actions',
    title: 'Moderation Actions',
    description: 'Choose how to moderate: classic click buttons, drag a chat message into an action bucket (ban/timeout/delete/whisper/profile), or both. Also called Action Style. Includes Drag Style and Pin Action placement.'
  },
  {
    tab: 'Moderation',
    section: 'Moderation Actions',
    title: 'Action Style',
    description: 'Choose how moderation actions are triggered in chat: buttons, drag, or both.'
  },
  {
    tab: 'Moderation',
    section: 'Moderation Actions',
    title: 'Drag Style',
    description: 'Where the action buckets appear: a vertical bucket column beside chat, or a compact bucket cluster above the message.'
  },
  {
    tab: 'Moderation',
    section: 'Moderation Actions',
    title: 'Pin Action',
    description: 'The inline Pin button next to Copy is always available to mods; this toggles whether a Pin tile also appears in the drag-to-moderate gesture.'
  },
  {
    tab: 'Moderation',
    section: 'Mod Logs',
    title: 'Mod Logs',
    description: 'Control moderation action visibility.'
  },
  {
    tab: 'Moderation',
    section: 'Mod Logs',
    title: 'Show Mod Logs panel',
    description: 'Display the recent moderation actions sidebar inside chat (timeouts, bans, deletions).'
  },
  {
    tab: 'Moderation',
    section: 'Message Visibility',
    title: 'Message Visibility',
    description: 'Control how removed messages are shown in chat.'
  },
  {
    tab: 'Moderation',
    section: 'Message Visibility',
    title: 'Announce mod actions inline',
    description: 'Add an extra system row to chat when a mod times someone out, bans, or deletes a message (on top of the strikethrough you already see).'
  },
  {
    tab: 'Moderation',
    section: 'Message Visibility',
    title: 'Hide strikethrough on removed messages',
    description: 'Suppress the strikethrough overlay on banned, timed-out, or deleted messages so your backlog stays pristine.'
  },
  {
    tab: 'Moderation',
    section: 'Log Highlights',
    title: 'Log Highlights',
    description: 'Color-code mod-log entries by severity. Choose how the highlight shows, then customize any category color.'
  },
  {
    tab: 'Moderation',
    section: 'Log Highlights',
    title: 'Highlight style',
    description: 'How each mod-log entry is emphasized by severity.'
  },
  {
    tab: 'Moderation',
    section: 'Mass Actions',
    title: 'Mass Actions',
    description: 'Mods can sweep a phrase or pattern across the current channel using these commands in the chat input.'
  },
  {
    tab: 'Moderation',
    section: 'Mass Actions',
    title: '/nuke',
    description: 'Mass-action by phrase or /regex/flags: delete, ban, or timeout matching messages across a lookback window. Bulk purge spam.'
  },
  {
    tab: 'Moderation',
    section: 'Mass Actions',
    title: '/undo',
    description: 'Reverses the most recent /nuke on this channel. Bans and timeouts are reversible; deletes are permanent.'
  },

  // === Overlay ===
  {
    tab: 'Overlay',
    section: 'Stream Overlay',
    title: 'Stream Overlay',
    description: 'Design a chat overlay for OBS, StreamElements, and Streamlabs browser sources. Put your multi-platform stream chat on screen with emotes, 7TV paints, badges, and cosmetics. On-stream chat widget, alerts, chat box.'
  },
  {
    tab: 'Overlay',
    section: 'Sources',
    title: 'Sources',
    description: 'Choose which platforms feed the overlay (Twitch, Kick, YouTube, TikTok) and whether to tag each message with its source platform.'
  },
  {
    tab: 'Overlay',
    section: 'Typography',
    title: 'Font and Size',
    description: 'Overlay font family, font size, line height, and spacing between messages.'
  },
  {
    tab: 'Overlay',
    section: 'Emotes & Badges',
    title: 'Emotes and Badges',
    description: 'Emote size on the overlay and whether chatter badges are shown: platform badges, third-party badges (7TV, FFZ, Chatterino), the StreamNook member badge, 7TV paints, and atmospheres.'
  },
  {
    tab: 'Overlay',
    section: 'Appearance',
    title: 'Appearance',
    description: 'Message text color, text shadow for legibility over any scene, timestamps, and a transparent or solid background.'
  },
  {
    tab: 'Overlay',
    section: 'Chatters',
    title: 'Profile pictures',
    description: 'Show or hide chatter avatars (profile pictures) on the overlay. YouTube and TikTok send them. Pfp, user photo, author image.'
  },
  {
    tab: 'Overlay',
    section: 'Chatters',
    title: '@ before usernames',
    description: 'Show or strip the leading @ on usernames on the overlay. YouTube handles arrive as @name; turn off to remove the at sign.'
  },
  {
    tab: 'Overlay',
    section: 'Messages',
    title: 'Reply context',
    description: 'Show or hide the small "Replying to" line above reply messages on the overlay. Reply thread, reply preview.'
  },
  {
    tab: 'Overlay',
    section: 'Chatters',
    title: 'First-time chatters',
    description: 'Mark the first message someone ever sends in the channel on the overlay: Twitch style (pink outline like Twitch chat) or StreamNook style (purple highlight like the app chat). First message highlight, new chatter, first time chat border.'
  },
  {
    tab: 'Overlay',
    section: 'Chatters',
    title: 'Fill the highlight',
    description: 'Nearly transparent color-matched tint inside the first-time chatter outline on the overlay. Fill, background tint, highlight.'
  },
  {
    tab: 'Overlay',
    section: 'Chatters',
    title: 'First-time highlight animation',
    description: 'Border accent when a first-time chatter\'s message lands on the overlay: Sheen (glint sweep), Pulse (border breathes), or Chase (spark orbits the ring). Plays once, or repeats every 5 seconds with the repeat toggle. Animation, sweep, shimmer, border flash, loop.'
  },
  {
    tab: 'Overlay',
    section: 'Events',
    title: 'Event style',
    description: 'How subs, gifts, raids, and other events look on the overlay: Plain per-platform tint, Outline thin ring in the platform color, or the StreamNook signature gradient wash.'
  },
  {
    tab: 'Overlay',
    section: 'Events',
    title: 'Show events',
    description: 'Per-source event filter: choose which event types each platform shows on the overlay, separately for Twitch, YouTube, TikTok, and Kick. Hide subs, gifts, raids, bits, follows, milestones, or announcements per platform.'
  },
  {
    tab: 'Overlay',
    section: 'Events',
    title: 'Fill the outline',
    description: 'Nearly transparent color-matched tint inside the Outline event ring on the overlay. Fill, background tint.'
  },
  {
    tab: 'Overlay',
    section: 'Chatters',
    title: 'Highlight color',
    description: 'Custom accent color for the first-time chatter highlight on the overlay (outline, fill, bar, and label together). Default is Twitch pink or StreamNook purple.'
  },
  {
    tab: 'Overlay',
    section: 'Messages',
    title: 'Message bubbles',
    description: 'Each overlay chat message sits in its own bubble with adjustable shape (rounded, pill, speech), corner radius, color, and opacity. Chat bubble, pill, messenger style, message background.'
  },
  {
    tab: 'Overlay',
    section: 'Messages',
    title: 'Max lines per message',
    description: 'Clamp long overlay messages to a number of lines with an ellipsis so walls of text and copypasta can\'t fill the canvas. Truncate, line limit.'
  },
  {
    tab: 'Overlay',
    section: 'Messages',
    title: 'Remove messages after',
    description: 'Auto-remove overlay messages a number of seconds after they appear, so a quiet stream doesn\'t show stale chat forever. Expire, auto clear, hide after inactivity, message lifetime.'
  },
  {
    tab: 'Overlay',
    section: 'Filters',
    title: 'Hide messages containing',
    description: 'Hide overlay messages containing chosen words or phrases, case-insensitive. Profanity filter, banned words, phrase blocklist, spoiler shield.'
  },
  {
    tab: 'Overlay',
    section: 'Events',
    title: 'Outline color',
    description: 'One fixed ring color for Outline-style events on the overlay, or the default where each event uses its platform\'s color.'
  },
  {
    tab: 'Overlay',
    section: 'Events',
    title: 'Event outline animation',
    description: 'Border accent when an Outline-style event lands on the overlay: Sheen (glint sweep), Pulse (border breathes), or Chase (spark orbits the ring). Plays once, or repeats every 5 seconds with the repeat toggle. Animation, sweep, shimmer, border flash, loop.'
  },
  {
    tab: 'Overlay',
    section: 'Behavior',
    title: 'Behavior',
    description: 'Whether new messages appear at the bottom or top, message entrance animation (fade, slide, drift, rise, pop, stamp), and the maximum messages kept on screen.'
  },

  // === Interface ===
  {
    tab: 'Interface',
    section: 'Sidebar',
    sectionId: 'settings-section-sidebar',
    title: 'Sidebar',
    description: 'Control the appearance of the stream list sidebar: display mode, expand on hover, recommended streams.'
  },
  {
    tab: 'Interface',
    section: 'Sidebar',
    sectionId: 'settings-section-sidebar',
    title: 'Sidebar Display Mode',
    description: 'Choose how the sidebar appears (expanded, compact, hidden, or disabled).'
  },
  {
    tab: 'Interface',
    section: 'Sidebar',
    sectionId: 'settings-section-sidebar',
    title: 'Expand on Hover',
    description: 'Sidebar expands when you hover over it.'
  },
  {
    tab: 'Interface',
    section: 'Sidebar',
    sectionId: 'settings-section-sidebar',
    title: 'Show recommended streams',
    description: 'Show the Recommended section in the sidebar. Turn this off to keep only your followed channels and favorites.'
  },
  {
    tab: 'Interface',
    section: 'Motion',
    sectionId: 'settings-section-motion',
    title: 'Animations',
    description: 'Choose how much the interface animates: Full, Reduced (fades only), or Off (instant and snappy, best for low-end PCs). Reduce motion, accessibility, performance, disable animations and transitions.'
  },
  {
    tab: 'Interface',
    section: 'Settings Window',
    sectionId: 'settings-section-settings-window',
    title: 'Compact settings window',
    description: 'Show settings in a centered window, or turn off for a full-page settings layout that fills the entire app.'
  },
  {
    tab: 'Interface',
    section: 'Compact View',
    sectionId: 'settings-section-compact',
    title: 'Compact View',
    description: 'Choose the window size when entering Compact View mode. Perfect for fitting the app on a second monitor.'
  },

  // === Integrations ===
  {
    tab: 'Integrations',
    section: 'Discord Rich Presence',
    title: 'Discord Rich Presence',
    description: "Show what you're watching on your Discord profile. Discord RPC, activity, status."
  },
  {
    tab: 'Integrations',
    section: 'Ad Blocking',
    title: 'Ad Blocking',
    description: 'Block Twitch ads with the ad blocker plugin. Ad-free, TTV LOL, proxy, splice. Plugin integration panels appear here once installed.'
  },

  // === Notifications ===
  {
    tab: 'Notifications',
    section: 'Notifications',
    title: 'Notifications',
    description: 'Control notification system settings.'
  },
  {
    tab: 'Notifications',
    section: 'Notifications',
    title: 'Enable Notifications',
    description: 'Master toggle for all notification types.'
  },
  {
    tab: 'Notifications',
    section: 'Notification Methods',
    title: 'Notification Methods',
    description: 'Choose how to display notifications: Dynamic Island, toasts, toast position, edge spacing.'
  },
  {
    tab: 'Notifications',
    section: 'Notification Methods',
    title: 'Dynamic Island',
    description: 'Show notifications in the notification center at the top.'
  },
  {
    tab: 'Notifications',
    section: 'Notification Methods',
    title: 'Toast Notifications',
    description: 'Show popup toasts at the corner of the screen.'
  },
  {
    tab: 'Notifications',
    section: 'Notification Methods',
    title: 'Toast Position',
    description: 'Which corner toast notifications appear in.'
  },
  {
    tab: 'Notifications',
    section: 'Notification Methods',
    title: 'Edge Spacing',
    description: 'How far toasts sit from the edge of the screen.'
  },
  {
    tab: 'Notifications',
    section: 'Notification Types',
    title: 'Notification Types',
    description: 'Enable or disable specific types: live streams, whispers, updates, drops, channel points, badges.'
  },
  {
    tab: 'Notifications',
    section: 'Notification Types',
    title: 'Live Stream Notifications',
    description: 'Get notified when followed streamers go live.'
  },
  {
    tab: 'Notifications',
    section: 'Notification Types',
    title: 'Whisper Notifications',
    description: 'Get notified when you receive whispers.'
  },
  {
    tab: 'Notifications',
    section: 'Notification Types',
    title: 'Update Notifications',
    description: 'Get notified when a new app update is available.'
  },
  {
    tab: 'Notifications',
    section: 'Notification Types',
    title: 'Quick Update on Toast Click',
    description: 'Clicking the update toast immediately starts the update.'
  },
  {
    tab: 'Notifications',
    section: 'Notification Types',
    title: 'Drops Notifications',
    description: 'Get notified when a drop is claimed.'
  },
  {
    tab: 'Notifications',
    section: 'Notification Types',
    title: 'Favorite Category Drops',
    description: 'Notify when favorited categories have new drops on startup.'
  },
  {
    tab: 'Notifications',
    section: 'Notification Types',
    title: 'Channel Points Notifications',
    description: 'Get notified when channel points are claimed.'
  },
  {
    tab: 'Notifications',
    section: 'Notification Types',
    title: 'Badge Notifications',
    description: 'Get notified when new badges become available.'
  },
  {
    tab: 'Notifications',
    section: 'Sound',
    title: 'Sound',
    description: 'Configure notification sounds.'
  },
  {
    tab: 'Notifications',
    section: 'Sound',
    title: 'Notification Sound',
    description: 'Play a subtle sound for notifications.'
  },
  {
    tab: 'Notifications',
    section: 'Sound',
    title: 'Sound Style',
    description: 'All sounds are designed to be pleasant and non-intrusive.'
  },
  {
    tab: 'Notifications',
    section: 'Sound',
    title: 'Test Notification',
    description: 'Send a test notification to preview your settings.'
  },
  {
    tab: 'Notifications',
    section: 'About',
    title: 'About',
    description: 'About notifications and how to use them.'
  },

  // === Cache ===
  {
    tab: 'Cache',
    section: 'Cache',
    title: 'Cache',
    description: 'Manage cached emotes and badges.'
  },
  {
    tab: 'Cache',
    section: 'Cache',
    title: 'Enable Cache',
    description: 'Cache emotes and badges to speed up loading.'
  },
  {
    tab: 'Cache',
    section: 'Cache',
    title: 'Cache Expiry',
    description: 'How long to keep cached data before refreshing.'
  },
  {
    tab: 'Cache',
    section: 'Cache',
    title: 'Cache Maintenance',
    description: 'View cache statistics or delete all cached emotes and badges.'
  },
  {
    tab: 'Cache',
    section: 'Emote Prefetch',
    title: 'Emote Prefetch',
    description: 'Download every emote from all the channels you follow so the emote menu opens instantly. Dedupes shared emotes and skips anything already cached. Preload, warm cache, scan follows.'
  },
  {
    tab: 'Cache',
    section: 'Emote Prefetch',
    title: 'Followed channels',
    description: 'Scan all the channels you follow and download their emotes ahead of time.'
  },

  // === Command Palette ===
  {
    tab: 'Command Palette',
    section: 'Keyboard Shortcuts',
    sectionId: 'settings-section-keyboard',
    title: 'Keyboard Shortcuts',
    description: 'Keyboard controls for the command palette (Ctrl+K, arrows, Enter, Esc, Home, End).'
  },
  {
    tab: 'Command Palette',
    section: 'What lives in the palette',
    title: 'What lives in the palette',
    description: 'Overview of palette sections and available actions: quick actions, current stream, share, settings, categories, snippets.'
  },
  {
    tab: 'Command Palette',
    section: 'Snippet Manager',
    sectionId: 'settings-section-snippets',
    title: 'Snippet Manager',
    description: 'Star the snippets you use most, bind aliases for instant matching, and add your own copypastas.'
  },

  // === Keybindings ===
  {
    tab: 'Keybindings',
    section: 'Application',
    title: 'Application',
    description: 'App-wide keyboard shortcuts available everywhere. Hotkeys, binds, combos, rebind, customize.'
  },
  {
    tab: 'Keybindings',
    section: 'Navigation',
    title: 'Navigation',
    description: 'Keyboard shortcuts to jump between the main surfaces of StreamNook. Hotkeys, binds, combos.'
  },
  {
    tab: 'Keybindings',
    section: 'Player',
    title: 'Player Shortcuts',
    description: 'Keyboard shortcuts active while a stream or VOD is playing: play, pause, mute, fullscreen, volume. Hotkeys, binds, combos.'
  },
  {
    tab: 'Keybindings',
    section: 'Moderation',
    title: 'Moderation Shortcuts',
    description: 'Keyboard shortcuts for channels you moderate. Focus a message with J/K, then act on it. Hotkeys, binds, combos.'
  },
  {
    tab: 'Keybindings',
    section: 'Chat',
    title: 'Chat Shortcuts',
    description: 'Keyboard shortcuts for the chat compose field. Hotkeys, binds, combos.'
  },
  {
    tab: 'Keybindings',
    section: 'Multi-view',
    title: 'Multi-view Shortcuts',
    description: 'Keyboard shortcuts for MultiChat windows. Hotkeys, binds, combos.'
  },

  // === Support ===
  {
    tab: 'Support',
    section: 'Community Discord',
    title: 'Community Discord',
    description: 'Join the StreamNook community for help, feature requests, updates, and chat with other users.'
  },
  {
    tab: 'Support',
    section: 'Community Discord',
    title: 'Join the Discord',
    description: 'Open the StreamNook community Discord invite.'
  },

  // === Backup ===
  {
    tab: 'Backup',
    section: 'Backup and restore',
    title: 'Backup and restore',
    description: 'Export your settings to a file, or import a saved backup to restore them after a reset, reinstall, or move to a new PC.'
  },
  {
    tab: 'Backup',
    section: 'Backup and restore',
    title: 'Export settings',
    description: 'Save a backup of all your preferences to a file you choose.'
  },
  {
    tab: 'Backup',
    section: 'Backup and restore',
    title: 'Import settings',
    description: 'Restore your preferences from a previously exported backup file.'
  },
  {
    tab: 'Backup',
    section: 'Settings file',
    title: 'Settings folder',
    description: 'Open the folder on this PC where StreamNook stores settings.json.'
  },
];
