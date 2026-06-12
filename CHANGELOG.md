## [7.8.7] - 2026-06-12
### 🔧 Maintenance
- **StreamNook is moving to its own GitHub organization**: The project is getting a proper home at github.com/StreamNook instead of living under a personal account. This update teaches the built-in updater to follow the project to its new address, so install it to keep receiving future releases automatically.

## [7.8.6] - 2026-06-10
## 🎉 New: Low latency playback, rebuilt to ride seconds behind live
> StreamNook now picks up video in small pieces as the broadcaster encodes them, instead of waiting for whole segments to finish. On channels with low latency enabled, that puts you roughly two to three seconds behind the broadcaster, in the solo player and in every Multi-Nook tile. Channels without low latency keep playing exactly as before.

---

### ✨ Features
- **Lists, a home for your go-to text**: Create as many lists as you like for usernames, commands, links, or anything else you keep reaching for. Click an entry to copy it, hover to send it into chat, and paste a whole batch at once (one per line, comma separated, or straight from a spreadsheet). The panel floats over the app without blocking chat, pops out into its own pinnable window, and can dock right into the mod logs view. Open it from the title bar, the command palette, or Ctrl+Shift+L.
- **A latency readout you can trust**: The stream stats overlay now shows your true delay to the broadcaster (the same number Twitch reports) plus your configured buffer target, so you can tell at a glance whether you are actually behind.

### 🐛 Bug Fixes
- **Low latency no longer freezes on refresh**: Upcoming segments promoted into the playlist could change identity between updates, which could crash playback mid-stream. Their numbering and addresses now stay stable from one update to the next.
- **Go Live lands where it should**: The button now jumps only to video that is actually ready to play, and if the stream has genuinely stalled it restarts playback instead of seeking somewhere unplayable.
- **Quieter quality switches**: Changing quality or restarting a stream no longer lets the outgoing player surface errors while the new one spins up.

### ⚡ Performance
- **Stays close to live on every channel**: On channels without low latency, playback now speeds up almost imperceptibly whenever you drift past your buffer target, so delay no longer creeps up over a long session.
- **Faster grid cold starts**: Multi-Nook tiles now start up in parallel when you load a full preset, instead of waiting on each other.

## [7.8.5] - 2026-06-07
### ✨ Features
- **Spotlight a stream in Multi-Nook**: Double-click any tile (or use the new spotlight button) to fill the whole grid with that one stream, then double-click again or press Esc to drop back to the grid. Spotlighting also moves audio and chat to that stream, so it behaves just like the solo player, and the other streams keep running in the background for an instant switch back.

### 🐛 Bug Fixes
- **Channel emotes no longer drop to plain text**: The emote prefetch added in 7.8.3 could leave a channel's emotes showing as plain words when 7TV was slow or down. Each channel's emote list is now saved locally and loaded the instant you open chat, a failed or partial 7TV fetch can no longer overwrite a good saved list, and your emotes survive restarts.
- **No more freezes in low-latency mode**: The player was riding too close to the live edge, so a normal gap in Twitch's segment delivery could drain the buffer and stall playback. It now keeps a bit more cushion, and Multi-Nook tiles use a steadier buffer, so streams play smoothly without stalling.

## [7.8.4] - 2026-06-06
## 🎉 New: Save and reload your multi-stream layouts with Grid Presets
> Build the perfect multi-stream grid once, then save it as a named preset and bring it back any time with a single click. Swap between your favorite lineups, drop a preset on top of what you are already watching, and give each one a custom icon from game art or a channel avatar. Searching for channels to add now works right inside the preset editor too.

---

### ✨ Features
- **Friendlier offline tiles**: When a channel is offline or cannot load, its tile now shows a clear status with one-tap Retry and Hide buttons instead of spinning forever.
- **Per-tile quality that sticks**: The stream quality you choose for a tile in multi-view is now remembered across restarts and saved with your backups.
- **Instant unlock celebrations**: The moment a Subscriber or Supporter badge purchase comes through, a gentle notification slides in to confirm it, with no restart needed.
- **Clickable member badges**: Tap someone's StreamNook number badge on their profile card to open their public profile, even from a popped-out window.
- **Favorites get their own section**: Favorited channels now sit in a dedicated section above Followed, and you can hide the Recommended section entirely from Interface settings.
- **One-tap reload**: The player refresh button, and a new /reload chat command, now reload the video and reconnect chat together in a single action.
- **Twitch-first emote search**: Typing a colon, like :PogU, now surfaces Twitch and sub emotes ahead of third-party sets.

### 🐛 Bug Fixes
- **Smoother multi-stream startup**: Tiles now wait for a small buffer cushion before playing, so cold-starting several streams at once no longer stalls right after they load.
- **One offline channel no longer drags down the grid**: A tile that cannot go live stops retrying in the background, keeping the rest of your streams responsive.
- **Login and popup windows restored**: 7TV login, automation, and chat-identity windows open reliably again.
- **Up-to-date 7TV sign-in**: Logging in to 7TV now uses the current flow that actually issues a token.
- **Cosmetics update right away**: Changing your badge or paint now repaints your chat row and profile card immediately instead of waiting up to a minute.
- **Missed unlocks catch up on their own**: Badges or perks granted while you were away now appear when you return to the app or reconnect, without a restart.
- **Fullscreen tiles come to the front**: Fullscreening a tile in the grid now lifts it cleanly above the other tiles.
- **Changelog dates show the right day**: Date-only entries no longer appear a day early in time zones behind UTC.
- **No more doubled badge**: Members without an equipped cosmetic now show a single default badge instead of two.

### 🔧 Maintenance
- **Refined title-bar pill**: The notification pill sits more cleanly in the title bar with a subtler unread indicator.
- **Consistent sidebar glass**: The floating sidebar now follows your Glassiness setting like every other glass surface.

## [7.8.3] - 2026-06-05
### ✨ Features
- **Audio Boost**: Make stream audio louder and more even. A built-in compressor evens out quiet talking and loud moments and lifts overall loudness past the source without the harsh distortion of cranking volume past max. Turn it on from the player control bar or Player settings, fine-tune it with on-screen sliders right over the video, and reset to defaults anytime. Off until you enable it.
- **Emote Prefetch**: Bulk-download the emotes from every channel you follow in one background pass, ideally while you are away. Once it finishes, chat and the emote menu fill in instantly with nothing left to fetch, and it takes load off 7TV. Start, watch progress, or stop it from Cache settings.
- **Place Notifications Anywhere**: Pick which corner or edge your popup notifications appear in with a simple visual picker, and use a spacing slider to lift them off the screen edge so they do not sit on top of chat.
- **Fully Flat Glass**: The Glassiness slider now goes all the way to a completely solid, blur-free interface for anyone who does not want any frosted-glass effect, not just slightly more opaque panels.
- **Jump Straight to a Setting**: Settings can now open directly to a specific section and scroll right to it, instead of dropping you on a tab to hunt for the option.

### 🐛 Bug Fixes
- **Chat no longer goes blank when you join**: A slow or down 7TV could leave chat empty for several seconds on join. Recent messages now backfill immediately while emotes load in the background, and a circuit breaker stops a 7TV outage from stalling the whole connection.
- **Emotes recover on their own during a 7TV outage**: When 7TV returns an empty set, the app no longer caches that gap for the rest of your session. It quietly re-fetches once 7TV is healthy again, so you do not have to refresh manually.
- **Animated FrankerFaceZ emotes actually animate**: Animated FFZ emotes were being shown as still images. They now play.
- **Emotes and badges render reliably**: Cached images are now saved in their true format and keyed per provider, so they no longer collide or show up broken. Existing miscached emotes are repaired automatically on launch.
- **Consistent drops progress everywhere**: The title-bar drops badge, the game cards, and the detailed drops panel now read from the same live source, so progress updates promptly and matches across all three instead of drifting apart.
- **Readable announcement banners**: In-app announcement banners are now solid and legible at any Glassiness setting, including fully transparent.
- **Steadier low-latency playback**: Hardened a low-latency code path that could freeze playback on certain streams.

### ⚡ Performance
- **Smoother, faster chat**: Busy channels scroll and animate far more smoothly, the emote picker opens faster and uses less memory over long sessions, and joining a channel does less work up front.

### 🔧 Maintenance
- The Cache settings panel now reports what is actually stored, clears everything in one click, and adds a button to open the cache folder.

## [7.8.2] - 2026-06-05
### ✨ Features
- **True Low-Latency Streaming**: Experience minimal delay with an actively managed HLS pipeline, featuring dynamic target duration adjustments and Twitch PREFETCH segment promotion, allowing your player to ride closer to the live edge than ever before.
- **Third-Party Chat Badges for Everyone**: Enjoy a richer chat experience as StreamNook now displays BTTV, FFZ, Chatterino, and other third-party badges for *all* chatters, not just StreamNook members. Badge resolution is now significantly more efficient.
- **Reimagined Profile & Live Preview**: Your public StreamNook profile has a stunning new design. Track how many times your profile is viewed, customize which sections are visible to others, and use the new 'Live Preview' in settings to see your edits in real-time.
- **Real-Time Stream Stats**: A new overlay provides vital diagnostics like latency to live, resolution, FPS, bitrate, and buffer status. Easily jump to the absolute live edge with the 'Go Live' button.
- **Global Motion Control**: Tailor StreamNook's animations to your preference with new settings: 'Full' for all fluid transitions, 'Reduced' for fades only (easier on the eyes and lighter on slower PCs), or 'Off' for an instant, snappy interface.
- **Full-Page Settings Window**: Configure StreamNook with more room! The settings dialog can now expand to a full-page layout, providing ample space for extensive customization.
- **Smoother UI Transitions**: Enjoy a more polished experience with new, fluid animations for opening and closing overlays, modals, and dropdown menus.

### 🐛 Bug Fixes
- **Accurate Drops Mining Completion**: Fixed issues where drops campaigns would sometimes continue mining indefinitely or display incorrect progress after completion. We now precisely identify when all drops are claimed and properly shut down background tasks.
- **Reliable Stream Information**: Resolved an issue where stream titles and game categories could appear blank after raid redirects, ensuring your UI and Discord Rich Presence always show the correct details.
- **YouTube Link Previews**: Corrected an issue preventing link previews from loading for some YouTube channel pages.
- **Chat Moderation Overlay**: The moderation drag layer no longer overlaps messages, ensuring clear visibility.

### 🔧 Maintenance
- Refined and updated the visual style of various settings and profile display components for a more cohesive 'glass-tile' aesthetic.

## [7.8.1] - 2026-06-04
## 🧰 New: Manage Your 7TV Emotes Inside StreamNook
> Connect your 7TV account and run your emotes entirely from the app. Add, rename, remove, and organize emotes across every channel you can edit, manage your emote sets, and add or remove editors, all without opening a browser. This release also reworks chat moderation with a drag-to-moderate gesture and real channel-wide message pinning, and lets you back up your entire setup to a single file and restore it on any machine.

---

### ✨ Features
- **7TV Emote Manager**: A full 7TV workspace built into StreamNook, covering your own channel and every channel you're an editor of.
  - Browse and search the entire 7TV directory with sort (Trending, Top, Newest) and filters (Animated, Zero-width, Exact match), or add an emote by pasting its 7tv.app link.
  - Add emotes under a custom name and as a zero-width overlay, then rename, re-toggle, or remove them later.
  - Open an emote's detail card for large previews, tags, flags, and how many channels use it.
  - Create, rename, resize, and switch your active emote set, with a live capacity meter.
  - Manage editors: invite by username, grant or revoke per-area permissions, and accept or decline editor invites from other channels.
  - Quick-add: left-click any 7TV emote in chat to drop it into a set you edit. Open the manager from the command palette or the moderator menu.
- **Reworked Chat Moderation**:
  - **Drag to moderate**: grab any message and drag it onto a floating dock of action buckets (Delete, Timeout, Ban, plus Unban and Untimeout for already-moderated users). Buckets snap magnetically, so no pixel-perfect aim is needed.
  - **Dial timeouts by feel**: drag further from the Timeout bucket to set a longer duration, from 5 seconds up to Twitch's 14-day max, with a live duration label.
  - **Undo**: ban and timeout confirmations include an Undo button.
  - **Pin messages**: mods can pin any message in one click. Pins use Twitch's real pin system, so they appear for every viewer on every client, not just locally. A collapsed pin bar keeps it one line tall until you expand it.
- **Settings Backup & Restore**: Export every preference (themes, chat design, keybindings, highlights, custom commands, moderation, integrations, and more) to a single file, then import it on any machine. Your Twitch login is never included, so backups are safe to move around.
- **Search Your Settings**: A search box in Settings matches across every tab and jumps you straight to the matching section.
- **Styled Chat Usernames**: New options for how names render in chat, including a separator glyph between name and message and several name styles (accent bar, frosted chip, brackets, and more), with a live preview in settings.
- **Expanded Link Previews**: Rich cards now cover Discord invites (server icon, live online and member counts, Join button), Steam store pages (art, description, and current price), Spotify tracks and albums, Instagram profiles, and Tenor GIFs. A new shield button lets you permanently trust a domain so its links always expand.
- **Customizable Player Buttons**: Choose which action buttons appear over the video (Follow, Subscribe, Create Clip, Clips & VODs, Add to MultiNook, Refresh, Close).
- **Channel About, on Scroll**: Scroll down over the player to reveal a Twitch-style About panel with the streamer's panels, social links, and quick actions. The stream keeps playing the whole time, and social links render as rich preview cards.
- **Color-Customizable OLED Theme**: The OLED theme now takes any accent color, with eight one-click presets. Existing OLED users keep their current look.
- **Image-Based Atmospheres**: Premium Atmospheres can now be animated image backdrops, with a portrait mode for the profile panel and a readability frost behind chat. Atmospheres can also be earned through accolades, not just subscriptions, and new ones can arrive without an app update.
- **Animated 7TV Profile Pictures**: Animated 7TV avatars now display on user cards.
- **7TV Paint Usage Stats**: Sort paints by Most Used or Least Used, and see how many people wear a given paint.
- **Redesigned Community & Integrations Tabs**: The Support and Integrations settings are now Discord-style cards with live server stats and a one-click join.
- **Drops: How to Unlock**: Locked campaign rewards now show a tooltip explaining what they require (sub, gift sub, Prime, bits, or follow).

### 🐛 Bug Fixes
- **Streams that wouldn't load now play**: Twitch rolled out a new stream playlist format that the old parser read as having zero qualities, so some channels simply wouldn't start. The parser now handles both the old and new formats.
- **Settings now stick between restarts**: A range of preferences (chat design, emote sizing, link-preview options, highlight phrases, custom commands, moderation preferences, custom themes, and the OLED accent color) were silently dropped on save and reset every launch. They now persist, including when loaded from older settings files.
- **Clips that wrongly said "not found" now open**: Clip lookups no longer break when Twitch rotates an internal query ID, and real errors are surfaced instead of masked.
- **Steadier ad-free playback**: When an ad-block proxy answers with an error page that still reports success, the app now treats it as a miss, races to another proxy, and falls back to the standard stream rather than failing outright.
- **Drops progress tracks the right drop**: Mining now follows the unclaimed drop closest to completion instead of pinning to an already-finished one, and claiming a drop no longer snaps the title-bar progress backward.
- **Mine any campaign you pick**: You can now preview and mine a manually chosen campaign even if it isn't in your priority list.
- **Badge sorting**: Badge entries missing usage stats are re-fetched so Most and Least Used sort correctly, and Available Now / Coming Soon now filter the list instead of just reordering it.
- **Reliable profiles for localized names**: Profile banners and extended profile data now resolve for users whose display name differs from their login, and profile actions (whisper, gift sub, mod commands) always target the correct account.
- **No more blank page after search**: Leaving a stream you opened from search returns you to where you were instead of an empty results page.
- **Overlays no longer cover the Dynamic Island or the drops hover preview.**

### ⚡ Performance
- **Instant profile cards**: Profiles open immediately from a cached snapshot and refresh in the background, so banners and backdrops no longer appear a beat late.
- **Smoother sidebar**: The compact sidebar's glass blur now settles after it finishes expanding, removing the choppy redraw during the animation.

### 🔧 Maintenance
- Cleaned decorative emoji out of internal logs and the proxy-health panel for clearer output.
- Renamed several built-in themes for clarity. Your current selection is preserved.

## [7.8.0] - 2026-06-03
## 🎬 New: Twitch Clip Creation & Advanced Streamer Profiles
> We've completely overhauled how you interact with Twitch clips and streamer profiles! Now you can create clips directly from any live stream or VOD, trim them with precision, and share them instantly. Plus, every streamer profile now includes dedicated tabs for browsing their clips and past broadcasts, complete with rich filters and reaction counts.

---

### ✨ Features
- **Twitch Clip Creation**: Create clips from live streams, or trim and title clips from VODs with an intuitive in-app editor. Share your creations to chat or copy the link to share anywhere.
- **Clip Playback & Management**: Play Twitch clips directly within StreamNook via a new modal player. Copy links, open in browser, or delete clips you own. New clips now show total reactions (likes, etc.) from other viewers.
- **Advanced Streamer Profiles**: The streamer profile panel is now a full-featured hub with dedicated tabs for 'About', 'Clips', and 'Videos'. Browse a streamer's entire catalog of clips and past broadcasts with filters for time, popularity, and video type.
- **New UI Customization**: Personalize StreamNook with new global interface font options and a slider to fine-tune the glass morphism transparency to your liking.
- **Enhanced Chat System**:
  - **Moderator Viewers List**: Moderators can now view the full list of chatters, grouped by role (Broadcaster, Mods, VIPs, Viewers).
  - **Message Recall**: Type a message, press `ArrowUp` to recall previously sent messages (Chatterino-style!), and `ArrowDown` to navigate forward or restore your current draft.
- **Richer Link Previews**: Twitch clips, VODs, and YouTube channel links now expand into beautiful, info-rich preview cards directly in chat.
- **Discord Rich Presence Overhaul**: Your Discord status is now more dynamic, showing proper category art (even for 'Just Chatting' or 'Music'), personalizing idle messages with your username, and resetting the 'watching for' timer more intelligently.
- **Easier Twitch Login**: A persistent 'Login with Twitch' button now appears on the Discover tab when you're logged out, making it simpler to sign in.
- **Quick Sign Out**: Access a convenient 'Sign out' button directly from the Profile tab in Settings, with a quick confirmation step.

### 🐛 Bug Fixes
- Fixed an issue where watch time and stream counts for analytics were inaccurate due to how stream URLs changed during ads or quality switches.
- Resolved a problem where re-authenticating after Twitch scope changes could leave your account in a broken state. The app now performs a full, clean re-authentication when necessary.
- Fixed an issue where clicking on links in chat could open multiple browser tabs by removing redundant `target="_blank"` attributes.
- Corrected an issue where stream lists would sometimes incorrectly filter historical clips, especially for 'last 30 days'.
- Addressed a rare startup issue where the universal cache flush task could fail before the app's core services were ready.

### ⚡ Performance
- **Smoother Chat & Sidebar**: Significant performance improvements to the chat widget and sidebar by optimizing component rendering, leading to faster updates and reduced UI lag.
- **Faster Link Previews**: Generic link previews now load much quicker by intelligently fetching only the essential parts of a webpage.
- **Optimized Emote Display**: Improved loading and caching for 7TV emotes ensures they display faster and more reliably, even with multiple resolution tiers.
- **Efficient Discord Integration**: The app now intelligently caches Discord's detectable game list, reducing network requests and speeding up rich presence updates.

## [7.7.2] - 2026-06-03
## 🎉 New: Inline Link Previews in Chat
> Sharing a link in chat just got a whole lot more engaging! StreamNook now automatically generates rich, interactive previews for YouTube videos, X/Twitter posts and profiles, Giphy GIFs, and most other webpages. See titles, descriptions, and thumbnails directly in your chat, making conversations smoother and more informative.

---

### ✨ Features
- **Inline Link Previews**: Supported links now display rich cards in chat with titles, descriptions, and thumbnails for a variety of services including YouTube, X (Twitter), Giphy, and general webpages.

### 🔧 Maintenance
- Various performance improvements, notably in high-speed-chat streams.

## [7.7.1] - 2026-06-02
### ✨ Features
- **Permanent Perks for Supporters & Subscribers**: Your commitment now grants permanent access to special profile backgrounds and StreamNook Atmospheres! Once unlocked (by being a Supporter or Subscriber), these cosmetics are yours forever, even if your active support ends. The 7TV Paint background is now a Supporter perk, and Atmospheres are a Subscriber perk.

### 🐛 Bug Fixes
- **Improved Fullscreen Experience**: Fullscreen mode now works seamlessly across both single-stream and MultiNook views, ensuring the entire display is covered (including the taskbar) and your layout is correctly restored upon exit.

### 🔧 Maintenance
- Updated internal Supabase tools.

## [7.7.0] - 2026-06-02
## 🚀 Native Streaming is Here
> StreamNook now directly plays Twitch streams without needing Streamlink or the TTVLOL plugin. Enjoy faster startup times, a smaller app footprint, and more reliable ad-free viewing, all handled seamlessly within the app. This is a foundational rewrite of how StreamNook connects to Twitch.

---

### ✨ Features
- **Native Stream Playback**: Faster startup, reduced memory usage, and a completely self-contained app. No more external installations or troubleshooting for Streamlink.
- **Proactive Ad-Block Pivoting**: If an ad-block proxy region starts leaking ads, StreamNook will automatically switch to a different, healthy region and reload the stream, ensuring continuous ad-free viewing.
- **Intelligent Drops Mining**: The automated drops miner now intelligently tracks your closest-to-completion drop in the current game, ensuring you always see the most relevant progress.
- **Robust Mining Recovery**: The drops miner can now detect if a streamer goes offline, switches games, or if your progress stalls. It will automatically switch to another eligible channel or temporarily blacklist problematic streamers, preventing wasted watch time.
- **View Your Subscriptions**: New section to see your active and past Twitch channel subscriptions.

### 🔧 Maintenance
- **Smaller App, Faster Updates**: The app bundle size has been significantly reduced, making downloads faster and updates more reliable. Existing users will also see disk space reclaimed from old bundled components.

## [7.6.1] - 2026-05-31
## ✨ Revamped: Account Switching & Identity Management
> Now you can effortlessly switch between your Twitch accounts directly within StreamNook! Manage which account you watch and stream as, and easily switch the identity you send chat messages from. Each account now has its own isolated web session, ensuring your Twitch logins and subscriptions always happen from the correct account.

---

### ✨ Features
- **Seamless Account Switching**: Promote any linked account to your 'main' account (the one you watch and stream as) directly from Settings. Your chat identity, follows, and other Twitch data will automatically update.- **Seamless Account Switching**: Promote any linked account to your 'main' account (the one you watch and stream as) directly from Settings. Your chat identity, follows, and other Twitch data will automatically update.

### 🐛 Bug Fixes
- **Reliable Chat Pause**: Chat now pauses immediately on user scroll intent (wheel or touch), preventing frustrating fights with auto-scroll and ensuring a more responsive experience.

### 🔧 Maintenance
- Minor backend and configuration updates for improved stability.- Minor backend and configuration updates for improved stability.

### ⚡ Performance
- **Smoother Chat & Emote Picker**: Significant optimizations to chat message rendering and the emote picker, reducing UI lag and improving responsiveness, especially in busy channels or with many emotes.- **Smoother Chat & Emote Picker**: Significant optimizations to chat message rendering and the emote picker, reducing UI lag and improving responsiveness, especially in busy channels or with many emotes.
## [7.6.0] - 2026-05-29
### ✨ Features
- **StreamNook Identity**: Curate your favorite badges (Twitch, 7TV, BTTV, FFZ, Chatterino, and more) to display in chat, configurable in the new Accounts settings.
- **Multi-Account Support**: Seamlessly link multiple Twitch accounts. Send messages in chat from any of your linked accounts with a new 'Send As' picker.
- **BetterTTV Badges**: Full integration for BetterTTV badges, including contributor badges and the unique BTTV Pro loyalty badges (now discoverable in a dedicated tab in the Badges gallery).
- **Persistent Mod Logs**: For moderators, a new Moderation Logs pane displays a persistent, real-time history of mod actions for the current channel. Configurable in new Moderation settings.
- **Real-time Moderation Events**: Live moderation events (bans, timeouts, deletes) are now streamed from Twitch via EventSub to enrich your moderation logs, even for channels you're not actively streaming.
- **Hype Train Confetti**: Celebrate every Hype Train level-up with a dazzling confetti burst animation.
- **Enhanced MultiChat**: Pop out all MultiNook chats into a single MultiChat window, which now tracks all opened popout channels.
- **Rich Chat Feedback**: Message sending now provides authoritative Twitch message IDs and detailed reasons if a message is dropped (e.g., by AutoMod).
- **Automated Installer Deployment**: Faster, more reliable downloads for new releases via Cloudflare R2 CDN.

### 🐛 Bug Fixes
- **MultiNook Ad-Blocking**: Fixed an issue where MultiNook streams could still display ads even when the ad-block proxy was enabled.
- **IRC Reconnects**: Improved IRC connection stability; all joined chat channels now correctly re-establish after an IRC disconnect.
- **7TV Cosmetics Display**: Resolved an issue where your own 7TV paint and badge might not consistently appear after connecting or re-authenticating.
- **EventSub Error Reporting**: Improved error reporting for EventSub subscription failures, providing better diagnostic information.
- **Chat Resizer**: Enhanced the responsiveness and usability of the chat and mod log resizer handles.
- **Hype Train UI**: Refined the visual styling and animation of the Hype Train progress bar and level-up celebration.
- **Moderation Actions**: Updated Twitch API endpoints for deleting messages and clearing chat, providing more robust actions and detailed error messages.

### 🔧 Maintenance
- **Local Crash Logs**: Replaced Discord webhook error reporting with a privacy-focused local crash log. Errors are now saved directly on your machine for optional review, instead of being sent externally.
- **Settings Navigation**: Added an ability to deep-link directly to specific settings tabs for improved navigation experience.

## [7.5.6] - 2026-05-27
### 🐛 Bug Fixes
- Improved the application update process on Windows, preventing a brief command prompt window from appearing and ensuring updates complete reliably in the background.

## [7.5.5] - 2026-05-27
## ✨ New: Live 7TV Emote & Cosmetic Updates
> Your chat just got smarter! Emote sets now update instantly when mods add, remove, or rename 7TV emotes. Plus, 7TV paints and badges for other chatters appear live, not on delay. It's a faster, more dynamic chat experience, keeping you connected to the pulse of your favorite communities.

---

### ✨ Features
- **7TV Live Events**: Get immediate updates for emote set changes and see chatters' 7TV cosmetics refresh in real-time.
- **Chat Client Badge Gallery**: Explore a new section in the Badges Overlay to discover and track badges from popular third-party chat clients like FrankerFaceZ, Chatterino, Chatsen, Chatty, DankChat, and Homies. See which ones you own, how many users have them, and easily access their project pages.
- **Stripe Payments Integration**: StreamNook now offers Stripe for donations and subscriptions via streamnook.app, providing a streamlined and secure experience for supporters. Existing Ko-fi subscribers can easily migrate their support.
- **Lifetime Channel Points**: Track the total channel points you've auto-claimed across all your StreamNook sessions, now persisted even after restarting the app.
- **Enhanced Drops & Rewards UI**: The Drops Center and Game Detail panels now feature a clearer rewards showcase with progress timelines, making it easier to track your journey towards coveted drop rewards.
- **7TV Emote Update Notices**: A new chat setting lets you toggle system messages for live 7TV emote set changes, giving you control over chat notifications.

### 🐛 Bug Fixes
- **Improved Drops Statistics**: Corrected calculations for 'Total Drops Claimed' and 'Drops in Progress' in the Drops Center, providing a more accurate overview of your earned and active drops.
- **Instant 7TV Cosmetic Updates**: Fixed an issue where changing your 7TV paint or badge in Profile Settings wouldn't immediately reflect in chat or your profile card until an app restart. Changes are now instant across the app.
- **Robust 7TV Cosmetic Fetching**: Enhanced reliability for fetching 7TV user cosmetics, reducing instances of blank paints/badges due to transient API errors or overly complex batch requests.
- **Accurate 7TV Paint Shadows**: 7TV paint shadows now render correctly in the Badges Overlay, matching their appearance in chat and on user profiles.

### ⚡ Performance
- **Optimized Chat Rendering**: Removed display of third-party chat client badges from individual chat messages, improving chat rendering performance and reducing visual clutter. These badges are now exclusively viewable in the new Chat Client Badge Gallery.

### 🔧 Maintenance
- **Updated Support Experience**: Streamlined the Support settings tab, removing the direct developer contact section to centralize support through the Discord community and streamnook.app. Your contact options are now clearer and more effective.
- **UI Polish**: Applied "liquid glass" visual refinements to overlays and panels, enhancing the overall aesthetic and consistency across the application.
- **Internal Payment System Upgrade**: Major internal upgrades to support new payment pathways via streamnook.app, including a refined system for awarding cosmetics based on payment tiers.

## [7.5.4] - 2026-05-25
## ✨ New: Emote Tab Completion in Chat!
> Typing in chat just got a whole lot smarter. Now you can type a few letters of an emote or a username, press `Tab`, and StreamNook will instantly suggest and cycle through matching emotes from Twitch, 7TV, BTTV, FFZ, and even current chatters! No more remembering full emote names, just fluid conversation.

---

### ✨ Features
- **Emote Tab Completion**: Type a partial emote name or username in chat, press `Tab` to cycle through suggestions in a slick carousel, and Shift+Tab to cycle backward. Customize matching modes (starts with/contains) and if chatters are included in Chat Settings. Thanks to <@FROGGICON> for the suggestion!
- **MultiNook Shortcut**: Quickly add any stream to MultiNook by Ctrl+clicking a stream card on the Home page or in the sidebar. Thanks to <@FROGGICON> for the suggestion!
- **Enhanced Emote Tooltips**: Hover over any emote in chat for a richer preview showing the full emote name, provider (Twitch, 7TV, BTTV, FFZ), a larger image, and a 'Zero-Width' indicator if applicable. Thanks to <@FROGGICON> for the suggestion!

### 🐛 Bug Fixes
- Resolved an issue where some chat identity badges in Profile Settings would appear duplicated. Spotted by <@grim_7tv>, much appreciated!
- Fixed a layering bug where the sidebar might be obscured by other fullscreen elements when in 'hidden' or 'overlay' mode.

## [7.5.3] - 2026-05-25
## ✨ New: Emote Tab Completion in Chat!
> Typing in chat just got a whole lot smarter. Now you can type a few letters of an emote or a username, press `Tab`, and StreamNook will instantly suggest and cycle through matching emotes from Twitch, 7TV, BTTV, FFZ, and even current chatters! No more remembering full emote names, just fluid conversation.

---

### ✨ Features
- **Emote Tab Completion**: Type a partial emote name or username in chat, press `Tab` to cycle through suggestions in a slick carousel, and Shift+Tab to cycle backward. Customize matching modes (starts with/contains) and if chatters are included in Chat Settings. Thanks to <@FROGGICON> for the suggestion!
- **MultiNook Shortcut**: Quickly add any stream to MultiNook by Ctrl+clicking a stream card on the Home page or in the sidebar. Thanks to <@FROGGICON> for the suggestion!
- **Enhanced Emote Tooltips**: Hover over any emote in chat for a richer preview showing the full emote name, provider (Twitch, 7TV, BTTV, FFZ), a larger image, and a 'Zero-Width' indicator if applicable. Thanks to <@FROGGICON> for the suggestion!

### 🐛 Bug Fixes
- Resolved an issue where some chat identity badges in Profile Settings would appear duplicated. Spotted by <@grim_7tv>, much appreciated!
- Fixed a layering bug where the sidebar might be obscured by other fullscreen elements when in 'hidden' or 'overlay' mode.

## [7.5.2] - 2026-05-25
## 📚 New: Deeper Chat Logs for Power Users
> Ever wonder what someone said five minutes ago, or what a specific user's chat history looks like in a channel? Our new chat log system pulls from multiple sources (Twitch, Justlog, Robotty) to give you a comprehensive, merged view of historical messages. Perfect for moderation or just satisfying curiosity.

---

### ✨ Features
- **Chat Log History**: View a user's full chat history in any channel, aggregated from multiple sources, by right-clicking their username.
- **Enhanced User Profiles**: Profile cards now display more details, including a user's last broadcast, total channels followed, and detailed subscription information (tier, type, gifter).
- **Improved Chat Popout Windows**: Popout chat windows now intelligently anchor to your cursor's position when opened and come with larger, more user-friendly default dimensions.

### 🐛 Bug Fixes
- **Ad-Free Assurance**: Resolved an issue where outdated TTVLOL Streamlink plugins could prevent ad-blocking from working correctly, ensuring a consistent ad-free experience.
- **Drops Mining Reliability**: Fixed drops mining getting stuck on offline channels and improved task management to prevent "ghost" mining sessions.
- **Channel Points Accuracy**: Eliminated a bug that caused duplicate channel points events to appear in chat.
- **Changelog Display**: The in-app changelog overlay now correctly renders all markdown content, including banners and structured sections, without accidental truncation.
- **Windows Update Experience**: Fixed the brief flash of a console window that previously occurred during auto-updates on Windows.

### ⚡ Performance
- **Faster App Startup & Responsiveness**: Major architectural improvements to our internal HTTP client and caching systems mean the app starts faster, feels snappier, and consumes fewer resources.
- **Optimized Chat Rendering**: Chat messages now render more smoothly with reduced flickering, and the app uses significantly less memory for chat history, especially in busy channels.
- **Smarter Background Tasks**: Non-critical background polling (like viewer counts and pinned messages) now intelligently pauses when the window is minimized or not visible, reducing CPU and network usage.

### 🔧 Maintenance
- Removed Magne RPC integration.

## [7.5.1] - 2026-05-25
## 🎉 New: StreamNook has its own badges

> A brand new community cosmetics system, sitting alongside Twitch, 7TV, and FFZ in chat. Every member gets the default StreamNook badge for free. The gold **Supporter** and animated **Subscriber** badges unlock when you back the project on Ko-fi (drop your `@twitchhandle` in the donation message and the badge lands on your account automatically). Browse the full set in the new "StreamNook" tab inside the Badges Overlay, then equip whichever one you want from your Profile.

---

### ✨ Features
- **Command Palette**: A brand new global Command Palette (Ctrl/Cmd+K) lets you quickly search for and execute any app command, setting, streamer, or snippet. It also integrates live Twitch searches and recently chatted users for lightning-fast navigation.
- **StreamNook Cosmetics**: Active selections render next to your name in chat and in your profile card, with animated designs for monthly subscribers.
- **Advanced Chat Customization**: Take control of your chat with new global emote scaling and spacing settings. Introduce new highlight types for specific users, badges, or built-in events like first-time chatters, returning users, self-messages, and raids, all with configurable colors. Important highlights can now flash your window title when unfocused.
- **Smart Chat Input**: Added 'Bypass Duplicate' to send identical messages without triggering Twitch's filter, and 'Quick Send' (Ctrl/Cmd+Enter) to send messages while keeping your input, perfect for rapid-fire responses.
- **Improved Streamlink Management**: StreamNook can now automatically detect existing Streamlink installations on your system (e.g., from Program Files, Scoop, Chocolatey) and validate custom paths, making setup much smoother. Plus, diagnostic logging is now more robust for easier troubleshooting.
- **Native Screen Capture**: Integrated native screen capture capabilities, enabling high-quality static PNGs and animated WebP exports of UI elements. This will power future sharing features, like exporting your StreamNook profile card.
- **Live Announcements**: Receive important messages, tips, or urgent recovery instructions directly within the app. Announcements are filtered by app version and can include actionable links.
- **Update Repair System**: Automatically detects and offers to repair issues where previous app updates might have been interrupted (e.g., by antivirus). This ensures your StreamNook app executable and components are always perfectly in sync, improving stability and performance.
- **Enhanced "What's New"**: Release notes in settings now feature richer markdown, including prominent headlines and styled callouts, making it easier to see what's new at a glance.

### 🐛 Bug Fixes
- **Update Reliability**: Significantly improved the internal update mechanism with retry logic and hardened file operations, preventing silent failures that could lead to desynced installations.
- **Streamlink Error Reporting**: Fixed an issue where Streamlink errors were sometimes silently swallowed, making it difficult to diagnose streaming problems. StreamNook now captures comprehensive diagnostic logs to provide clearer error messages.
- **Update Notifications**: Refined the update notification process to be less intrusive. Update availability is now passively displayed in the title bar, and toasts direct you to the 'What's New' section for details.
- **Chat Display Consistency**: Ensured consistent display for deleted messages and corrected the toast notification type for channel points.


### 🧹 Housekeeping
- The old 'Profile Modal' has been removed as its functionality is now integrated into the new StreamNook cosmetics system and improved search features.

## [7.5.0] - 2026-05-25
### ✨ Features
- **Command Palette**: A brand new global Command Palette (Ctrl/Cmd+K) lets you quickly search for and execute any app command, setting, streamer, or snippet. It also integrates live Twitch searches and recently chatted users for lightning-fast navigation.
- **StreamNook Cosmetics**: Unleash your unique style with the new StreamNook cosmetics system! Browse and equip special badges from the dedicated 'StreamNook' tab in the Badges Overlay, with support for animated designs and acquisition via Ko-fi.
- **Advanced Chat Customization**: Take control of your chat with new global emote scaling and spacing settings. Introduce new highlight types for specific users, badges, or built-in events like first-time chatters, returning users, self-messages, and raids, all with configurable colors. Important highlights can now flash your window title when unfocused.
- **Smart Chat Input**: Added 'Bypass Duplicate' to send identical messages without triggering Twitch's filter, and 'Quick Send' (Ctrl/Cmd+Enter) to send messages while keeping your input, perfect for rapid-fire responses.
- **Improved Streamlink Management**: StreamNook can now automatically detect existing Streamlink installations on your system (e.g., from Program Files, Scoop, Chocolatey) and validate custom paths, making setup much smoother. Plus, diagnostic logging is now more robust for easier troubleshooting.
- **Native Screen Capture**: Integrated native screen capture capabilities, enabling high-quality static PNGs and animated WebP exports of UI elements. This will power future sharing features, like exporting your StreamNook profile card.

### 🐛 Bug Fixes
- **Streamlink Error Reporting**: Fixed an issue where Streamlink errors were sometimes silently swallowed, making it difficult to diagnose streaming problems. StreamNook now captures comprehensive diagnostic logs to provide clearer error messages.
- **Update Notifications**: Refined the update notification process to be less intrusive. Update availability is now passively displayed in the title bar, and toasts directing you to the 'What's New' section for details.
- **Chat Display Consistency**: Ensured consistent display for deleted messages and corrected the toast notification type for channel points.

### 🧹 Housekeeping
- The old 'Profile Modal' has been removed as its functionality is now integrated into the new StreamNook cosmetics system and improved search features.

## [7.4.0] - 2026-05-22
### ✨ Features
- **StreamNook MultiChat (Experimental): A full standalone chat client built right into StreamNook. Open any channel's chat in its own window with no video stream required, and run as many at once as you want. Right-click a stream tile and pick "Pop out chat", or use the pop-out button at the top of any active stream's chat widget. Each MultiChat window keeps running even when the main app is hidden to the system tray.
- **StreamNook Identity Badge**: A new community badge for every StreamNook user, reflecting your rank (#N) based on when you joined. See it in chat, on user profiles, and check out the new StreamNook tab in the Badges Overlay!
- **User Chat Overrides**: Customize your chat experience by setting local nicknames and custom colors for other users directly from their profile card. Only you see these changes!
- **Custom Chat Highlight Phrases**: Define your own keywords or phrases to highlight in chat, complete with custom colors and sounds. Never miss an important message again!
- **User-Defined Custom Chat Commands**: Create your own slash commands or even plain-text triggers that expand into longer messages or templates. Perfect for quick responses or custom emotes.
- **New Moderator Commands**: `/clearmessages` allows for locally clearing recent chat messages visually (only on your screen). `/usercard <username>` quickly opens any user's profile card.
- **System Tray Integration**: StreamNook now lives in your system tray, ensuring MultiChat windows stay active even when the main app is hidden. Easily restore the main window or open new MultiChat windows from the tray menu.
- **Cross-Window Settings Sync**: All your settings now synchronize in real-time across all open StreamNook windows, so changes made in one window instantly apply everywhere else.
- **Enhanced User Profiles**: User profile cards now display the streamer's full channel banner image, not just their offline placeholder.
- **Stream Context Menu Action**: A new 'Pop out chat' option in the stream context menu allows you to quickly open any stream's chat in a dedicated MultiChat window without starting the video stream.

### 🐛 Bug Fixes
- **Channel Points Redemption**: Resolved issues with channel points redemption by updating our system to match recent Twitch API changes, ensuring all rewards can be redeemed as expected. All redemptions now include a confirmation step to prevent accidental spending.
- **Stale Badge Information**: Fixed an issue where some badge details (like event dates) were not updating correctly, causing outdated availability information. Badge metadata now aggressively refreshes to ensure accuracy.
- **Multi-Channel Emote Display**: Repaired a bug that prevented third-party emotes (7TV, FFZ, BTTV) from correctly displaying in newly joined channels, particularly in MultiChat popout windows.
- **Chat Scroll Stability**: Significantly improved chat scrolling smoothness, eliminating visual 'shimmering' or 'jumping' that occurred when new messages arrived and content (emotes, badges, timestamps) resolved.
- **Chat Message Dividers**: Adjusted chat message dividers to anchor to the top of each message, preventing layout shifts and improving overall chat fluidity.
- **Window Aspect Ratio**: Corrected an issue where the main window's aspect ratio would not adjust properly when its chat panel was dynamically hidden because a MultiChat popout was active for the same channel.
- **Minor UI Polish**: Squashed several small bugs related to UI element positioning and hover states in overlays (Badge Detail, Drops, Badges Overlay).

### 🔧 Maintenance
- Refactored internal notification sound system for better performance and consistency.

## [7.3.3] - 2026-05-18
### 🐛 Bug Fixes
- Fixed an issue where the Follow and Subscribe buttons could become unresponsive after restarting a stream or being automatically redirected to a new channel by a raid. StreamNook now ensures all necessary channel information is always correctly loaded to keep these features working seamlessly. Thanks to <@rainyyay> for the report!.

### 🔧 Maintenance
- Minor internal code improvements for the streamlink manager.

## [7.3.2] - 2026-05-15
### ✨ Features
- **Enhanced Streaming Options**: You can now enable support for h265 and AV1 codecs, unlocking higher quality tiers (like 1440p and 2160p) on compatible streams!
- **Improved Quality Selection**: The player now accurately reflects the actual quality being streamed, even if Streamlink had to automatically select a different one due to availability. You'll receive a notification if a fallback occurs.
- **Quality Fallback Notifications**: Get informed when the stream automatically switches to a different quality than your preference due to stream limitations.

### 🐛 Bug Fixes
- Corrected an issue where Streamlink might hang indefinitely when trying to resolve stream URLs under certain network conditions. Thanks to <@Rainy> on Discord for the feedback!
- Ensured that Streamlink uses anonymous authentication when starting multi-viewer sessions to prevent potential conflicts.
- Resolved a bug where certain Twitch badges or emotes might not render correctly in chat.
- Ensured that the correct VOD is selected when viewing offline chat for a streamer.

### 🔧 Maintenance
- Streamlined how Twitch authentication tokens are managed, improving reliability and security.
- Updated dependencies and improved internal logging for better diagnostics.

## [7.3.1] - 2026-05-15
### ✨ Features
- **Enhanced Streaming Options**: You can now enable support for h265 and AV1 codecs, unlocking higher quality tiers (like 1440p and 2160p) on compatible streams!
- **Improved Quality Selection**: The player now accurately reflects the actual quality being streamed, even if Streamlink had to automatically select a different one due to availability. You'll receive a notification if a fallback occurs.
- **Quality Fallback Notifications**: Get informed when the stream automatically switches to a different quality than your preference due to stream limitations.

### 🐛 Bug Fixes
- Corrected an issue where Streamlink might hang indefinitely when trying to resolve stream URLs under certain network conditions. Thanks to <@Rainy> on Discord for the feedback!
- Ensured that Streamlink uses anonymous authentication when starting multi-viewer sessions to prevent potential conflicts.
- Resolved a bug where certain Twitch badges or emotes might not render correctly in chat.
- Ensured that the correct VOD is selected when viewing offline chat for a streamer.

### 🔧 Maintenance
- Streamlined how Twitch authentication tokens are managed, improving reliability and security.
- Updated dependencies and improved internal logging for better diagnostics.

## [7.3.0] - 2026-05-15
### ✨ Features
- **Enhanced Streaming Options**: You can now enable support for h265 and AV1 codecs, unlocking higher quality tiers (like 1440p and 2160p) on compatible streams!
- **Improved Quality Selection**: The player now accurately reflects the actual quality being streamed, even if Streamlink had to automatically select a different one due to availability. You'll receive a notification if a fallback occurs.
- **Quality Fallback Notifications**: Get informed when the stream automatically switches to a different quality than your preference due to stream limitations.

### 🐛 Bug Fixes
- Corrected an issue where Streamlink might hang indefinitely when trying to resolve stream URLs under certain network conditions. Thanks to <@Rainy> on Discord for the feedback!
- Ensured that Streamlink uses anonymous authentication when starting multi-viewer sessions to prevent potential conflicts.
- Resolved a bug where certain Twitch badges or emotes might not render correctly in chat.
- Ensured that the correct VOD is selected when viewing offline chat for a streamer.

### 🔧 Maintenance
- Streamlined how Twitch authentication tokens are managed, improving reliability and security.
- Updated dependencies and improved internal logging for better diagnostics.

## [7.2.2] - 2026-05-07
### 🐛 Bug Fixes
- Fullscreen now fills the entire display when the app window isn't maximized
- Fixed blue border / chrome leak when re-entering fullscreen from a maximized window
- Window correctly returns to maximized after exiting fullscreen, no more drift off-screen
- Closes #125 (items 1 and 2) — special thanks to @swott for filing the very first issue on the repo

## [7.2.1] - 2026-05-07
### 🐛 Bug Fixes
- Fullscreen now fills the entire display when the app window isn't maximized
- Fixed blue border / chrome leak when re-entering fullscreen from a maximized window
- Window correctly returns to maximized after exiting fullscreen, no more drift off-screen
- Closes #125 (items 1 and 2) — special thanks to @swott for filing the very first issue on the repo
## [7.2.0] - 2026-03-31
> [!IMPORTANT]
> **Re-Authentication Required**
> When you launch this update, StreamNook will automatically log you out and prompt you to log back in. This is totally normal and expected! We've added powerful new moderation tools and features that require you to grant StreamNook the new necessary Twitch permissions.

### ✨ Features
- **Enhanced Category Browsing**: Dive into categories with new sub-tabs for Live Streams, Clips, and Videos, complete with sorting and filtering options.
- **Moderator Tools**: Manage your chat effectively with new commands like `/ban`, `/timeout`, `/clear`, `/mod`, `/vip`, and more, directly from the UI.
- **Command Autocomplete**: Type `/` in chat to see a helpful list of available commands and their usage.
- **Moderator Logs**: A new pane displays all moderation actions taken in chat, providing transparency and history.
- **Stream Nook Media Player**: Watch clips and VODs directly within the app with improved playback for MP4 files and a more robust HLS player.
- **User Profile Enhancements**: Quickly access moderator actions, copy messages, or pre-fill commands directly from user profiles.
- **Drops Integration**: Improved visibility and interaction with Twitch Drops campaigns directly from the Home screen.
- **Visual Polish**: Numerous UI refinements, including interactive command suggestions, refined glassmorphism effects, and a collapsible moderator menu.

### 🐛 Bug Fixes
- **Fixed Streamlink Issues**: Resolved problems with custom Streamlink paths and improved handling of VOD/clip playback.
- **Chat Stability**: Addressed various bugs in chat rendering, message parsing, and connection management for a more reliable experience.
- **Player Reliability**: Improved HLS player stability, especially during stream restarts and offline transitions.

### 🔧 Maintenance
- **Expanded Twitch API Integration**: Added support for a wide range of Twitch API endpoints to manage streams, chat settings, user data, and more.
- **Performance Optimizations**: Refined caching strategies and component rendering to improve overall application responsiveness.
- **Code Refactoring**: Various under-the-hood improvements to enhance code quality and maintainability.

## [7.1.2] - 2026-03-30
### 🔧 Maintenance
- **Update Checks**: Improved how StreamNook checks for updates by directly downloading necessary files from GitHub releases. This bypasses GitHub API rate limits, ensuring more reliable update checks, especially during active development.
- **Release Notes**: Release notes for updates are now fetched directly from the `CHANGELOG.md` file, providing a more accurate and up-to-date description of changes.
- **Download Size**: The download size for updates is now more accurately reported by using HTTP HEAD requests.

## [7.1.1] - 2026-03-30
### ✨ Features
- **Enhanced 7TV Emote Support**: 7TV emotes now display correctly with their intended resolutions thanks to improved `srcset` implementation, offering a crisper and more detailed viewing experience. Zero-width emotes are also better integrated.
- **Improved Whisper Functionality**: The Whisper feature now intelligently parses and displays URLs within messages, allowing direct clicking to open them. Additionally, clicking on a user's profile picture in the Whisper sidebar will now correctly open their profile modal.
- **Refined UI & UX**: Several quality-of-life improvements have been made across the application, including better input field focus management, smoother scrolling in chat and whisper windows, and an updated visual appearance for the Whisper widget with enhanced glassmorphism effects.

### 🐛 Bug Fixes
- Fixed an issue where certain input fields and chat areas would lose focus unexpectedly, improving overall usability.
- Resolved issues with scrolling behavior in chat and whisper components, ensuring a smoother experience.

### 🔧 Maintenance
- **Viewport Optimization**: Updated the viewport meta tag to prevent user scaling on mobile devices, ensuring a more consistent display.

### ⚡ Performance
- **Optimized Emote Grid Layout**: Emotes are now grouped by width categories, leading to a more organized and performant emote picker, especially for users with many emotes.

## [7.1.0] - 2026-03-29
### ✨ Features
- **MultiNook Enhancements**: Introducing the Grid Engine (MultiNook)! You can now dock, undock, arrange, and manage multiple streams in a highly customizable grid. The tutorial guides you through adding streams, focusing audio, reordering layouts, and more.
- **7TV Zero-Width Emotes**: Full support for 7TV's zero-width emotes has been added, allowing for more expressive chat interactions.
- **User Profile Modal**: A new modal allows you to view user profiles directly within the app, including their bio, social links, and panels. You can also follow or unfollow users directly from this modal.
- **Offline Channel View**: The Home screen now displays your followed channels that are currently offline, showing their last broadcast time for context.
- **Improved Search & Navigation**: Enhanced stream search with better handling of exact matches and offline users. Improved category browsing and navigation within the app.

### 🐛 Bug Fixes
- **Zero-Width Emote Rendering**: Corrected rendering of zero-width emotes, ensuring they display correctly within chat messages, especially when layered.
- **Chat Refresh Logic**: Fixed an issue where the chat wouldn't properly refresh after certain UI actions, ensuring a more stable chat experience.
- **Follow/Unfollow Status**: Resolved bugs related to accurately displaying follow status for users.
- **MultiNook Hot-Swapping**: Ensured that MultiNook correctly handles switching between streams, updating backend processes like EventSub and drops monitoring.

### 🔧 Maintenance
- **Dependency Updates**: Updated various dependencies, including Tauri core and plugins, for improved stability and performance.
- **Code Splitting**: Implemented code splitting in the Vite build process for faster initial load times.
- **UI Polish**: Numerous minor styling adjustments and usability improvements across various components for a smoother user experience.

## [7.0.0] - 2026-03-28
### ✨ Features
- **Multi-Stream Viewing**: Introducing MultiNook! Watch and manage multiple streams simultaneously.
- **Unified Chat**: View and send messages across multiple chat channels in a single widget.
- **Watch Streak Sharing**: Share your watch streak progress directly in chat.
- **Improved Player**: Enhanced HLS playback with better buffering, adaptive quality, and more robust error handling.
- **Proxy Optimization**: Automatically detects and applies the fastest proxy for ad-free viewing.
- **Customizable UI**: Expanded theme creator with more options and refined appearance.
- **Context Menus**: Added right-click menus for chat messages and streams.
- **Settings Improvements**: Redesigned settings pages with better organization and new options for MultiNook and proxy management.

### 🐛 Bug Fixes
- Fixed issues with stream playback freezing when switching quality.
- Resolved crashes related to WebSocket connections and chat participant updates.
- Improved stability of the automatic stream offline detection.
- Addressed various layout glitches and visual inconsistencies across the application.
- Fixed an issue where the custom Streamlink path setting was not always respected.

### 🔧 Maintenance
- Updated dependencies across frontend and backend for improved performance and security.
- Refactored various components for better code organization and maintainability.
- Added new scripts for diagnostic HLS analysis and SVG to PNG conversion.

### ⚡ Performance
- Optimized emote and badge rendering for significantly faster chat display.
- Improved caching strategies for emotes, badges, and profile data to enhance offline support and load times.
- Reduced application memory footprint for a lighter desktop experience.

## [6.11.0] - 2026-03-26
### ✨ Features
- **Streamer Info Panels**: You can now view detailed streamer information, including bio, social media links, and custom panels, directly within the app when switching to the 'About' view in the chat panel.
- **Pinned Chat Messages**: See important pinned messages at the top of the chat, providing crucial context or announcements from the streamer.
- **Improved Follow/Unfollow**: Follow and unfollow channels directly from the app using StreamNook's new GQL integration, offering a more seamless experience.
- **Enhanced Drops Mining**: Configure dedicated 'Priority Farm Channels' to ensure specific streams are always targeted for drops mining, giving you more control over your campaigns. The mining logic has also been refined for better recovery and stability.

### 🐛 Bug Fixes
- **Chat Layout Stability**: Addressed issues with chat widget layout, ensuring smoother transitions when switching between chat and the new streamer info panels.
- **Follow Action Reliability**: Fixed potential issues with follow/unfollow actions not completing due to changes in Twitch's backend automation.

### 🔧 Maintenance
- **GQL Integration for Follow/Unfollow**: Replaced outdated browser automation for follow/unfollow actions with more robust and efficient GQL mutations.
- **Stream Watching Logic Refinement**: Optimized the background channel points watching service for better performance and more reliable point earning.
- **UI Animation Polish**: Introduced new slide animations for smoother transitions between chat and streamer info views.

## [6.10.1] - 2026-03-08
### ✨ Features
- **Rich Presence Enhancements**: StreamNook now provides more detailed information for Discord and Magne presence, including the stream's title, category, and the game being played. This offers a richer experience for others viewing your activity.

### 🐛 Bug Fixes
- **Accurate Presence Updates**: Fixed an issue where the activity key for presence updates was not comprehensive, potentially leading to duplicate or inaccurate status displays. The presence will now correctly reflect the current stream details.

## [6.10.0] - 2026-03-06
### ✨ Features
- **Magne Rich Presence**: StreamNook now integrates with Magne, a Discord-like rich presence client. Your watching activity will be displayed automatically, including stream details, game, and a "Watch Stream" button that opens the stream directly in StreamNook. We have kept Discord RPC functionality, but will be shifting focus toward Magne, our new project, with ambitions of pursing a privacy-focused social platform that doesn't want to sell your identity.
- **Deep Link Support**: You can now open specific streams directly from external applications or the command line using `streamnook://watch/<channel>` URLs.
- **Automatic Proxy Optimization**: On startup, StreamNook will automatically check available proxy servers, select the fastest one, and configure your streamlink settings for optimal performance. This ensures you always have the best connection without manual intervention.
- **Enhanced Chat Moderation**: The chat now visually reflects moderation actions like timeouts and bans, clarifying which messages are affected. You'll also see timely notifications for chat room state changes (e.g., slow mode, sub-only).

### 🐛 Bug Fixes
- **Accurate Badge Cache Age**: The displayed age of your badge cache now correctly reflects the freshness of your local data, not just the last manifest sync.
- **Improved Date Parsing**: Badge availability dates are parsed more reliably, correctly identifying upcoming, active, and expired events.
- **Streamlink Proxy Stability**: Resolved issues with proxy configuration, ensuring more reliable streaming performance.
- **Chat Message Scoping**: Moderation actions in chat are now accurately scoped to the specific messages they affect.

### 🔧 Maintenance
- Updated dependencies and internal libraries for improved stability and performance.

## [6.9.0] - 2026-01-30
### ✨ Features
- **Proxy Health & Auto-Selection**: StreamNook now includes a robust proxy health checker! Test various proxy servers, see their real-time latency, and automatically select the fastest one for your region to improve stream stability.
- **Stream Restart**: Encounter a stuttering stream? You can now manually restart the current stream without closing and reopening the application.
- **Badge Drop Verification**: Improved logic for verifying ownership of Twitch badge drops by comparing against your earned badge collection.
- **Enhanced Drops Mining**: Subscription-only drops are now correctly handled, preventing them from interfering with active mining progress. Completed drops from expired campaigns are also more reliably displayed.

### 🐛 Bug Fixes
- **7TV Emote Display**: Fixed an issue where certain 7TV emotes and paints might not display correctly.
- **Date Parsing for Badges**: Improved accuracy in parsing badge metadata dates for better display.
- **Chat Timestamp Accuracy**: Ensured chat timestamps are displayed correctly, leveraging backend data where available.
- **Proxy Settings**: Addressed issues with manual proxy argument input and improved the handling of applying optimal proxy settings.
- **UI State Updates**: Optimized various UI components to use `queueMicrotask` for state updates, preventing rendering glitches and ensuring smoother transitions.

### 🔧 Maintenance
- **Dependency Updates**: Updated `lucide-react` for newer icons.
- **Code Refactoring**: Cleaned up various internal components for better maintainability and performance, including improvements to chat message rendering and sidebar logic.

## [6.8.0] - 2026-01-29
### ✨ Features
- **7TV Cosmetics Deep Linking**: You can now open the Badges Overlay directly to a specific 7TV paint or badge using deep links.
- **7TV Cosmetic Sorting & Filtering**: Enhanced the Badges Overlay with sorting options (newest, oldest, name) and filtering for animated/static 7TV paints.
- **Cheermote Segment**: Added support for rendering Twitch Cheermotes (animated bits) in chat messages.
- **Diagnostic Logging Control**: Introduced a new setting to toggle diagnostic log verbosity (Debug/Info vs. Warn/Error), controllable via `Settings > Support > Enable Diagnostic Logging`.
- **ULID Timestamp Utilities**: Added helper functions to extract creation dates from ULID identifiers, used for sorting 7TV cosmetics.

### 🐛 Bug Fixes
- **Chat Badge Display**: Fixed an issue where 7TV badges were not correctly rendered with their associated metadata.
- **Profile Overlay**: Resolved a bug where the profile overlay would fail to open if the user ID was not numeric.
- **Streamlink Missing Dialog**: Improved error handling and fallback behavior when Streamlink is not found.
- **Subscription Status Display**: Corrected the logic for showing subscription status in the video player (e.g., correctly indicating lapsed subscribers).

### 🔧 Maintenance
- **Centralized Logger**: Replaced all `console.log`, `console.warn`, `console.error` calls throughout the application with a new centralized `Logger` utility. This allows for runtime control over log verbosity based on user diagnostic settings, reducing noise in production builds.
- **Dependency Updates**: Updated various project dependencies to their latest stable versions.
- **Code Refactoring**: Applied various refactoring efforts across the codebase to improve code quality and maintainability.

## [6.7.0] - 2026-01-24
### ✨ Features
- **7TV Cosmetics Integration**: Access and view 7TV badges and paints directly within the application! Browse them in the new 'Attainables' section of your profile.
- **Twitch Resub Notifications**: Get notified when you can share your subscription anniversary in chat, with options to include your sub streak.
- **@Mention Autocomplete**: Type '@' in the chat input to bring up a list of recent chat participants, making it easier to tag users.
- **Network Speed Test**: A new 'Network' tab in Settings allows you to run a quick speed test via Cloudflare to understand your connection quality and get recommendations for optimal streaming settings.
- **Improved Emote Handling**: Emotes now load more efficiently with background caching and lazy loading in the emote picker, reducing UI stutter.

### 🐛 Bug Fixes
- **HLS Jump-to-Live Buffer**: Fixed an issue where jumping to live could cause playback stalls due to insufficient buffer.
- **Streamlink Timeouts**: Streamlink processes now have a timeout to prevent the application from hanging indefinitely.
- **Emoji Caching**: Improved emoji caching to prevent retrying failed fetches, ensuring a smoother experience.

### 🔧 Maintenance
- **Code Refinements**: Various code improvements and dependency updates for better performance and stability.

## [6.6.1] - 2026-01-09
### ✨ Features
- **Hype Train Enhancements**: Experience more engaging Hype Trains with animated level-up celebrations, confetti, and special "HYPE" messages! See Hype Train status directly on stream cards in the Home feed and Sidebar. Golden Kappa trains now have a distinct visual flair.
- **Improved Chat Scrolling**: Chat now scrolls smoothly to specific messages, respecting the container boundaries to prevent unexpected document scrolling. Auto-scrolling to new messages is also more robust.
- **7TV Badge Fallbacks**: 7TV badges now utilize a fallback system, ensuring they load reliably even if the primary resolution fails.
- **Stream Card Badges**: A new Hype Train indicator badge has been added to stream cards in the Home feed and Sidebar, showing the current level and if it's a Golden Kappa train.

### 🐛 Bug Fixes
- **Badge Loading**: Addressed issues with loading badges in chat messages and user profiles by pre-initializing caches and implementing a fallback image component.
- **Chat History Loading**: Ensured chat history (IVR messages) loads with fully populated badges by initializing caches before fetching.
- **Hype Train Timer**: Fixed an issue where the Hype Train timer could expire unexpectedly.

### 🔧 Maintenance
- **Badge Caching**: Improved the logic for caching and displaying Twitch badges, preventing cross-channel pollution.
- **Chat Message Limit**: Increased the default chat message history limit to 100 for a more complete view.

## [6.6.0] - 2026-01-08
### ✨ Features
- **Channel Points Rewards - BETA**: You can now view and redeem channel points rewards directly within the chat interface! This includes features like "Highlight My Message", "Unlock Random Emote", "Modify Emote", and "Choose Emote to Unlock".
- **Hype Train Integration**: StreamNook now visually displays active Hype Trains directly in the chat header, showing progress, level, and remaining time. It also subscribes to EventSub notifications for Hype Train events.
- **7TV Emote Improvements**: Emotes from 7TV are now fetched at higher resolution (4x) for better clarity, and animated emotes are handled correctly.
- **Emoji Rendering**: Improved emoji display using the Apple CDN via a local proxy for better performance and consistency, with support for animated emojis.
- **Badge Caching**: Implemented a reactive caching system for Twitch badges, ensuring faster loading and offline availability.

### 🐛 Bug Fixes
- **Badge Rendering**: Fixed issues with badge display, ensuring correct URLs and fallbacks.
- **Message Parsing**: Improved parsing of chat messages to correctly handle emojis and various message types.

### 🔧 Maintenance
- **Satoshi Variable Fonts**: Updated font loading to use variable Satoshi fonts, leading to better text rendering performance and consistency across all weights and styles.
- **Cache Optimizations**: Enhanced the universal file cache to check for existing files before downloading, reducing redundant operations.
- **EventSub Subscriptions**: Added Hype Train EventSub subscriptions and improved handling for events requiring moderator access.

## [6.5.0] - 2026-01-08
### ✨ Features

- **Custom Channel Points Display**: StreamNook now supports displaying custom channel points names (like "Kisses" instead of "Points") and their unique icons directly in chat, predictions, and channel point widgets. This brings a more personalized experience to your favorite streamers' communities.

- **Native Chat Virtualization**: The chat display has been rebuilt to leverage the browser's built-in `content-visibility` CSS property. This significantly improves performance by allowing the browser to skip rendering off-screen messages entirely, leading to smoother scrolling and reduced CPU usage, especially in busy chats.


- **Improved Scroll-to-Message**: The functionality to jump to a specific message has been rewritten for greater reliability. It now uses native DOM scrolling and ensures chat remains paused during navigation, preventing interference and ensuring you land precisely where you intend.

### 🐛 Bug Fixes

- **Chat Height Calculation**: Resolved inconsistencies in chat message height calculations, particularly for historical messages and during fast scrolling, by adopting a DOM-first measurement approach.

### 🔧 Maintenance

- **Backend Chat Parsing Simplification**: Streamlined the backend parsing of historical chat messages, offloading layout calculations to the frontend for a more efficient architecture.

- **Layout Command Cleanup**: Removed unused backend commands related to chat layout configuration, simplifying the backend API.

### ⚡ Performance

- **Chat Performance Boost**: Significant performance improvements in chat rendering due to native CSS virtualization and optimized message handling, making the chat experience much smoother.

## [6.4.0] - 2026-01-05
### 🔧 Maintenance
- **Release Process Update**: Streamlined the release workflow to ensure `main` accurately reflects the `dev` branch before builds.

### ✨ Features
- **Enhanced Drops Mining Resilience**: The Drops mining feature is now more robust. If all streams for a campaign go offline, StreamNook will intelligently attempt to switch to the next campaign in your "Mine All" queue or notify you if no streams are available.

### 🐛 Bug Fixes
- Fixed an issue where the stream would freeze when switching channels.
- Correctly handle reserved streams going offline, returning the watch token to the general rotation pool and notifying the user.
## [6.3.1] - 2026-01-04
### 🐛 Bug Fixes
- **Date Parsing Accuracy**: Resolved an issue where certain badge acquisition dates were parsed incorrectly, ensuring historical data is displayed accurately.

## [6.3.0] - 2026-01-04
ATTENTION: ALL USERS LOG OUT OF TWITCH THEN LOG BACK IN FOR SOME CHANGES OT TAKE EFFECT <3

### ✨ Features
- **Custom Themes**: Unleash your creativity with a new theme editor! Design and save your own unique color schemes to personalize StreamNook.
- **Compact View Presets**: Easily resize your window to predefined sizes optimized for multitasking or second monitors. Choose from various aspect ratios, including 16:9, and create your own custom presets.
- **Favorite Drops Notifications**: Get notified on startup if new drops become available in your favorited game categories.
- **Enhanced Twitch Emotes**: View a richer set of emotes, including your subscription, bits, and follower emotes, directly in chat when authenticated.
- **Bits Cheer Styling**: Messages containing Twitch bits cheers now have distinct styling with dedicated layouts and icons.
- **Universal Cache Auto-Sync**: The app now automatically downloads the latest badge and emote data in the background, ensuring you always have the most up-to-date assets without manual intervention.

### 🐛 Bug Fixes
- Fixed an issue where the stream player could freeze when switching channels.
- Resolved an issue where older badge metadata dates might not parse correctly.
- Improved the accuracy of chat message height calculations to prevent clipping or extra spacing.

### 🔧 Maintenance
- Updated dependencies and Rust backend components for improved stability and performance.
- Refined logging to provide clearer debugging information, especially for HLS streaming errors.
- Optimized emote loading and caching mechanisms for faster chat initialization.

## [6.2.0] - 2025-12-18
### ✨ Features
- **7TV Cosmetics Integration**: Connect your 7TV account to customize your profile with unique paints and badges, directly from StreamNook!
- **Global Badge Management**: Easily view and select your Twitch global badges within the application. Access your selected badge and make changes directly.
- **Enhanced Profile View**: A new dedicated profile modal provides a comprehensive view of your badges and cosmetic items, with improved controls for managing them.

### 🐛 Bug Fixes
- **Chat Reconnection Stability**: Chat reconnection logic has been refined. It now performs a silent check of the stream status before attempting a full reconnect or stream offline action, preventing unnecessary disruptions when only chat has temporarily stalled.
- **HLS Player Offline Detection**: The HLS player's offline detection has been made more robust by using a ref for `isAutoSwitching`, ensuring accurate error handling and stream switching even when settings change.

### 🔧 Maintenance
- **7TV Authentication Flow**: StreamNook now handles 7TV account connections and authentications more smoothly, including improved token management and error handling.
- **Profile Data Caching**: User profile data, including badges and cosmetics, is now cached more effectively for faster loading and better offline support.
- **Chat Identity Badge Caching**: Implemented a robust caching system for chat identity badges, ensuring faster UI updates and reducing unnecessary background fetches.

## [6.1.0] - 2025-12-17
### ✨ Features

- **Chat Heartbeat & Stability**: The chat system now includes background heartbeats to ensure a stable connection, automatically reconnecting if issues arise. You'll see clearer connection status and fewer stale warnings.
- **Drops Favorites**: You can now mark your favorite games in the Drops Center! These will appear at the top, and you'll receive notifications when new drops become available for them.
- **Improved Drops UI**: Games in the Drops Center are now better sorted, with favorites first. We've also refined the display of drop types (time-based, subscription, etc.) for easier understanding.
- **Optimized User Profile Loading**: User profile cards now load significantly faster by instantly displaying cached data while fetching fresh information in the background. Badge and cosmetic rendering is also more performant.
- **Sidebar Auto-Refresh**: Your followed and recommended streams in the sidebar will now automatically refresh when you interact with or expand the sidebar, ensuring you always see the latest status.

### 🐛 Bug Fixes

- Fixed an issue where manually selected drops in the mining service were not bypassing game filters.
- Resolved a bug preventing the correct fetching of channel points balance in the Chat widget and Prediction overlay due to an incorrect GraphQL query path.
- Corrected the Twitch Client ID used for certain channel points queries in the backend.
- Improved the detection of the currently mining game in the Drops detail panel.
- Removed unused Picture-in-Picture (PIP) logic from the main App component.

### 🔧 Maintenance

- Enhanced the internal health check for the chat WebSocket, making it more resilient to temporary network fluctuations and correctly triggering reconnection logic.
- Refined the styling of the Home screen background for better contrast when overlays are present.
- Consolidated and optimized badge rendering logic within the user profile card.

### ⚡ Performance

- Initial loading of user profile cards is now much faster due to improved caching and background refresh strategies.

## [6.0.1] - 2025-12-14
### 🐛 Bug Fixes
- **Chat Performance**: Resolved a performance issue in the chat widget that could lead to incorrect item sizing calculations, improving overall chat rendering stability.

## [6.0.0] - 2025-12-14
### ✨ Features
- **Unified User Profile Service**: StreamNook now fetches and caches comprehensive user profiles (including 7TV cosmetics, all earned Twitch badges, and third-party badges from FFZ/Chatterino/Homies) directly from the Rust backend. This significantly improves performance and reliability.
- **7TV Cosmetics Support**: Display user 7TV paints and selected badges in profile views.
- **Enhanced Chat Rendering**: Chat messages now utilize pre-parsed segments and metadata computed in Rust, ensuring pixel-perfect layout prediction and smoother rendering.
- **Twitch EventSub Integration**: Real-time notifications for channel updates (title, category), stream online/offline status, and raids are now handled directly by the Rust backend.
- **Improved Emoji Handling**: Emoji shortcode conversion is now offloaded to the Rust backend, reducing frontend JavaScript load.
- **Activity Tracking & Logging**: Comprehensive logging system with error buffering, automatic batching, and Discord webhook integration (via Rust) for improved error reporting.
- **Badge Polling & Notifications**: Background polling for new and available Twitch badges is now managed by the Rust backend, triggering desktop notifications.

### 🐛 Bug Fixes
- **UI Layout Stability**: Addressed various layout calculation issues, particularly with messages containing replies, first-time messages, and complex formatting, ensuring accurate heights and preventing overlaps.
- **Reconnect Logic**: Improved reliability of WebSocket connections for chat and EventSub.
- **Emote Rendering**: Correctly prioritizes 7TV emotes over Twitch emotes when both are available.
- **Historical Message Parsing**: Ensures messages fetched from the IVR API are parsed and laid out correctly, matching live message appearance.
- **Third-Party Badge Display**: Resolved issues with loading and displaying badges from FFZ, Chatterino, and Homies.

### 🔧 Maintenance
- **Rust Backend Enhancements**: Significant portion of data fetching, parsing, and caching logic has been moved to the Rust backend for performance and reliability gains.
- **Dependency Updates**: Added `phf` crate for efficient static maps (e.g., emoji conversion).
- **Code Cleanup**: Removed deprecated services and internal data structures (e.g., `emojiMap.ts`, `badgePollingService.ts`, `twitchBadges.ts`, `cosmeticsCache.ts` helpers) in favor of the unified Rust backend calls.

## [5.1.1] - 2025-12-12
### ✨ Features
- **Channel Points Display**: You can now see your current channel points balance in the chat widget.
- **Prediction Overlay**: Participate in live predictions directly from StreamNook!  View active predictions, place bets, and see the results in real-time. This includes automatic bet input validation and enhanced resolution states (win/loss/refund).

### 🐛 Bug Fixes
- Resolved edge cases where prediction events would not display winning outcome correctly.
- Fixed an issue where the stream would freeze when switching channels.

## [5.1.0] - 2025-12-12
### ✨ Features
- **Predictions**: You can now participate in Twitch channel predictions directly in StreamNook! See active predictions in a floating overlay, make your bets with channel points, and track the results.
- **Automated Drop Mining Improvements**: StreamNook now utilizes inventory polling and a new stream selection algorithm to ensure drops mining is highly optimized. Experience improved stability and speed for drops mining.
- **Completed Drops Display**: Completed drops are now displayed in the inventory tab.  

### 🐛 Bug Fixes
- Auto-selecting in home is fixed.

### ⚡ Performance
- The app switches more quickly and reliably to the best stream for drops mining.

## [5.0.4] - 2025-12-11
### ✨ Features
- **Badge Collection**: Introducing a new Twitch Global Badge collection system! Track your collected badges, earn ranks, and show off your achievements.
- **Drops Mining**: Enhanced the "Mine All" feature for Twitch Drops, prioritizing campaigns with existing progress and skipping already completed ones. Mining now starts with the drop closest to completion!
- **Profile**: 7TV users can now create accounts directly from the profile overlay. 
- **Video Player**: Added automatic closing of the subscription window after a successful subscription.

### 🐛 Bug Fixes
- Fixed an issue where the app window wouldn't focus after exiting Picture-in-Picture mode.
- Resolved an issue where the home screen tabs would reset after navigating from a category or search result.
- Fixed a bug where the Drops login window was not closed after successful authentication.
- Fixed DropsCenter logging and drop ID parsing

### ⚡ Performance
- Improved the Drops mining queue for faster and more efficient reward collection.

## [5.0.3] - 2025-12-11
### ✨ Features
- **Automatic Stream Recovery**: StreamNook can now automatically recover from common mining issues like offline streamers, stalled progress, and game category changes! Configure the new recovery settings to customize the behavior.
- **Improved Sidebar**: The sidebar's expand-on-hover mode is now smoother and prevents layout jumps.
- **Game Completion Status**: The Drops Center now shows when you've claimed all available drops for a game.

### 🐛 Bug Fixes
- Improved whisper error messages to be more specific about why a message failed to send.

## [5.0.2] - 2025-12-09
### ✨ Features
- **Smart Auto-Switch**: Improved auto-switching logic to prevent it from interrupting raid redirects. Now, StreamNook will wait a short period after a raid before switching channels.

### 🐛 Bug Fixes
- Resolved an issue where clicking a stream in the sidebar would unnecessarily toggle the home view.

## [5.0.1] - 2025-12-09
### ✨ Features
- **Drop Images**: Drops are now displayed with their images throughout the Drops Center, making it easier to identify the rewards you're earning.

### 🐛 Bug Fixes
- Fixed an issue where stopping drops mining would leave stale data in the UI.
- Improved game session tracking to ensure drops progress is correctly displayed when switching between games.

## [5.0.0] - 2025-12-09
### ✨ Features
- **Revamped Drops Center**: Experience a completely redesigned Drops Center with a sleek, user-friendly interface. Enjoy intuitive navigation, clear progress tracking, and comprehensive game information, making drops mining easier than ever.
- **Enhanced Drops Mining**: Improved drops mining system with more accurate progress tracking, real-time updates, and better channel selection for optimal rewards.
- **Improved Drop Claiming**: Resolved issues with automated drop claiming. The app now correctly identifies and claims earned drops, guaranteeing that you receive all your rewards.

### 🐛 Bug Fixes
- Resolved an issue where the stream would freeze when switching channels.
- The app will now automatically re-establish the stream connection if it is interupted by a momentary internet blip.
- Fixed problems with incorrect channel selection while mining.

### ⚡ Performance
- Improved the performance of loading emotes in chat, especially during peak hours.

## [4.9.6] - 2025-12-08
### ✨ Features
- **Notification Management**: You can now mark individual notifications as read, or mark all notifications as read within the notification center.
- **Improved Stream Controls**: The stream controls overlay (follow/subscribe) now appears on mouse movement and automatically hides after a short delay, even in fullscreen mode. This provides a cleaner viewing experience.

### 🐛 Bug Fixes
- **Whisper Import**: Improved whisper history import to correctly handle user ID resolution, ensuring imported conversations are properly linked and display correctly.

## [4.9.5] - 2025-12-08
### ✨ Features
- **Discord Rich Presence**: Improved the stream watching animation in Discord rich presence for a more engaging experience.

## [4.9.4] - 2025-12-08
### 🔧 Maintenance
- Updated the README with new screenshots and descriptions to better showcase StreamNook's features.

## [4.9.2] - 2025-12-08
### ✨ Features
- **Authentication**: Improved authentication process with a one-time data cleanup to ensure a fresh login experience.

### 🐛 Bug Fixes
- **Chat**: Improved chat auto-scrolling behavior to keep up with the latest messages even during resets.
- **Follow/Unfollow**: Added helpful error messages when following or unfollowing a channel fails. These messages suggest logging out and back in to re-authenticate.

## [4.9.1] - 2025-12-08
### ✨ Features
- **Whisper Import**: You can now import your entire Twitch whisper history directly into StreamNook! This feature runs automatically in the background after logging in and will allow you to access your private messages.
- **Custom Streamlink Path**: Added the ability to specify a custom path to your Streamlink installation. This resolves issues where the bundled Streamlink version fails to extract correctly and you can select from your drive a portable or manually installed version of the software.

### 🐛 Bug Fixes
- Fixed a conflict with Plyr's local storage interfering with configured app settings.

### ⚡ Performance
- Loading may take slightly longer with proxy enabled. A notification is now shown that provides an explanation and guidance on removing it.

### 🔧 Maintenance
- Login via the Twitch website is only required once to authorize the app. StreamNook will then attempt to re-authenticate silently in the background to avoid needing re-authorization.

## [4.9.0] - 2025-12-08
### ✨ Features
- **Automated Follow/Unfollow**: You can now follow and unfollow channels directly from StreamNook using a new automation feature. This uses your existing Twitch login and a hidden browser window to perform the action, so you don't have to leave the app!
- **In-App Drops Login**: The Drops login process now happens within the StreamNook app using a secure in-app browser window. This simplifies the login process and improves security.

### ⚡ Performance
- Optimized the process for checking if you're following a streamer to use a more efficient Twitch API endpoint.

## [4.8.3] - 2025-12-08
### 🐛 Bug Fixes
- **Sidebar**: Fixed a bug where the sidebar would sometimes incorrectly display the default profile image instead of the streamer's custom profile image. Also optimized sidebar rendering for improved performance.

### 🔧 Maintenance
- Removed some unused code and temporary files to improve build times and reduce the application's overall size.

## [4.8.2] - 2025-12-08
### ✨ Features
- **Raid Auto-Follow:** Automatically follow raids to the raided channel, ensuring you never miss the action (requires Twitch login).
- **Emoji Rendering**: Enjoy consistent emoji display across all platforms with new Apple-style emoji rendering in chat and stream titles.
- **In-App Notifications**: Notifications are now delivered directly within the StreamNook app, keeping you informed without relying on system notifications.
- **Jump to Live:** Added new video player setting to jump to the live edge of the stream on load.

### 🐛 Bug Fixes
- Moderators can now delete messages and apply timed-out or bans in chat, and these actions now reflected in the chat
- Toast (Pop-up) notifications now load emojis and are consistent with what's displayed in the in-app chat

## [4.8.1] - 2025-12-07
### ✨ Features
- **Browse Categories**: Improved browsing experience with infinite scroll for top games.
- **Chat Timestamps**: Added an option to display timestamps in chat, including optional seconds, for better message context.

### 🐛 Bug Fixes
- Resolved overflow issues with 7TV paint displays on user profiles.

### 🔧 Maintenance
- Improved user interface consistency by standardizing toggle switches in settings panels.
- Improved Changelog rendering and support for markdown

## [4.8.0] - 2025-12-07
### ✨ Features
- **Auto-Updating**: StreamNook now automatically checks for updates and installs them for you! You can enable or disable auto-updates in the settings.
- **Admin Dashboard**: Added a local analytics dashboard that admins can use to view usage statistics. Admins are detected via Twitch authentication.
- **Drops Mining in Chat**: You can now quickly start/stop mining drops directly from the chat window if the stream is playing a drops-enabled game.
- **Badge Quick Actions**: Badge details now include quick actions for drops campaigns, allowing you to easily view linked drops campaigns directly from a badge.
- **Persistent Video Dimensions**: The video player now preserves pixel dimensions as you adjust the chat size, ensuring that the displayed content is consistent.
- **Drops Search**: Added basic search to the Drops Overlay.

### 🐛 Bug Fixes
- Fixed stream auto-restart issue

## [4.7.9] - 2025-12-06
### ✨ Features
- Added support for animated 7TV emotes in chat, bringing more expressive communication to your viewing experience.
- Integrated the analytics dashboard directly into the StreamNook application. This eliminates the need for a separate resource folder and simplifies deployment.

## [4.7.8] - 2025-12-06
### ✨ Features
- Added an analytics dashboard to visualize usage data, providing insights into how StreamNook is used and helping guide future development. This dashboard is built with React/TypeScript and uses Supabase for data storage and access.  It is bundled during the release process.

## [4.7.7] - 2025-12-06
### ✨ Features
- Added Tauri Dialog plugin for native dialogs.

### 🔧 Maintenance
- Updated ACL manifests.

## [4.7.6] - 2025-12-05
### ✨ Features
- Updated README with screenshots and comprehensive feature list.

### 🐛 Bug Fixes
- Disabled "Auto Claim Channel Points" by default.

## [4.7.5] - 2025-12-05
### 🐛 Bug Fixes
- Fixed an issue where chat replies and optimistic message updates would fail when using JSON message format in addition to IRC string format.

## [4.7.4] - 2025-12-05
### ✨ Features
- Added analytics dashboard for admins (requires configuration of Supabase environment variables during build)
- Implemented basic Supabase analytics to track usage.
- Tracked number of messages sent in the chat.

### 🔧 Maintenance
- Updated build process to include Supabase environment variables.
- Added Supabase JavaScript library as a dependency.

## [4.7.3] - 2025-12-05
### ✨ Features
- Added dynamic layout configuration for chat messages, allowing for responsive text sizing.
- Implemented batch retrieval for cached items, improving performance when loading multiple resources.

### 🐛 Bug Fixes
- Fixed HTML entity decoding in badge metadata extraction, ensuring proper display of special characters.

## [4.7.2] - 2025-12-04
### ✨ Features
- Improved Changelog and Updates UI with formatted markdown support.
- Improved emote caching and preloading for faster loading.

## [4.7.1] - 2025-12-04
### ✨ Features
- Release notes are now displayed when updating.
- Improved emote caching and logging for better performance and debugging.
- Enhanced the 'Live' indicator in the video player with a pulsing effect.

### 🐛 Bug Fixes
- Improved Streamlink process killing and directory removal during updates to avoid errors.

### 🔧 Maintenance
- Clarified app data directory names for development and production environments.

## [4.7.0] - 2025-12-04
### ✨ Features
- Added file caching functionality for emotes and badges, improving performance and offline support.
- Chat messages now queue emotes for caching, enhancing loading times.
- Chat messages now use local URLs for badges, decreasing dependency on external requests.

### 🐛 Bug Fixes
- Fixed drops authentication issues, handling failures more gracefully and preventing campaign restarts.



## [4.6.3] - 2025-12-04
### ✨ Features
- Improved Updates Settings with component-specific changelogs.

### 🐛 Bug Fixes
- Fixed Streamlink update issues by forcing process termination.
- Removed redundant condition for showing session restore toast.


## [4.6.2] - 2025-12-04
### ✨ Features
- Added Picture-in-Picture (PIP) mode that auto-triggers when navigating to the home screen while a stream is playing.
- Improved error reporting, including stack traces and recent logs, to assist with debugging.

### 🐛 Bug Fixes
- Added error boundary around chat rendering to prevent the entire app from crashing due to chat parsing errors.

### 🔧 Maintenance
- Centralized handling of live stream notifications for better consistency and control.
- Removed unused CSS rules.

## [4.6.1] - 2025-12-04
### ✨ Features
- Added option to automatically download and install updates on startup.  This can be enabled in Settings > Updates.
- Added "Quick Update on Toast Click" option in Notification Settings. When enabled, clicking the update toast will immediately start the update process.

### 🐛 Bug Fixes
- Fixed missing icons within toasts.

## [4.6.0] - 2025-12-04
### ✨ Features
- Added a new home screen with support for browsing categories, searching channels, and picture-in-picture (PIP) mode.
- PIP mode allows you to continue watching the stream in a small window while browsing other content on the home screen.
### 🔧 Maintenance
- Removed the LiveOverlay and LiveStreamsOverlay components.

## [4.5.0] - 2025-12-04
### ✨ Features
- Implemented a new home screen with sections for followed and recommended streams.
- Added the ability to browse Twitch categories and view streams within those categories.
- Implemented a search functionality for finding Twitch channels.
- Added a picture-in-picture mode for watching streams while browsing the home screen.

## [4.4.0] - 2025-12-04
### ✨ Features
- Implemented a new home screen with stream browsing functionality, including followed streams, recommended streams, game categories, and search.
- The current stream can now be displayed in a mini-player on the home screen.
- Added a "Return to Stream" button to easily switch back to the full stream view.
- Improved Dynamic Island notifications for live streams.

## [4.3.4] - 2025-12-04
### ✨ Features
- Improved build process by using authenticated requests to the GitHub API to avoid rate limits during release.

### 🔧 Maintenance
- Removed the 'all' target from the Tauri build configuration, leaving the targets array empty.

## [4.3.3] - 2025-12-04
### Changes

- chore(release): bump version to 4.3.2
- chore(deps): update dependencies
- Merge branch 'dev'
- chore(deps)(deps): bump the rust-dependencies group across 1 directory with 3 updates (#20)
- chore(deps)(deps): bump cookie_store from 0.21.1 to 0.22.0 in /src-tauri (#10)
- chore(deps)(deps): bump warp from 0.3.7 to 0.4.2 in /src-tauri (#8)


## [4.3.2] - 2025-12-04
### 🐛 Bug Fixes
- Fixed an issue where the drops websocket would remain connected after deactivating manual mining.

### 🔧 Maintenance
- Updated dependencies.
- Standardized imports across services for better consistency.
- Fixed lifetime issues with warp 0.4.

## [4.3.1] - 2025-12-04
### ✨ Features
- Added React error boundaries for improved app stability.
- Improved badge date parsing to handle more formats.

### 🐛 Bug Fixes
- Prevented badge polling errors when Tauri invoke is not available.

### 🔧 Maintenance
- Added backdrop blur to sidebar.
- Added logging improvements for React error boundary errors.

## [4.3.0] - 2025-12-04
### ✨ Features
- Added new sidebar for stream navigation and discovery.
- Added interface settings tab with options for sidebar behavior.

### 🐛 Bug Fixes
- Improved reliability of ttvlol plugin detection for streaming.

## [4.2.1] - 2025-12-02
### ✨ Features
- Added a GitHub Actions workflow to automatically merge Dependabot pull requests for patch and minor version updates. Major version updates will require manual review.

## [4.2.0] - 2025-12-02
### ✨ Features
- Added support for desktop notifications.
- Added window focus and minimize checks to capabilities.

## [4.1.14] - 2025-12-02
### ✨ Features
- Improved Streamlink integration by checking for the ttvlol plugin's installation before using it.
- Added drops authentication check to the setup wizard to streamline initial configuration.

## [4.1.13] - 2025-12-02
### 🐛 Bug Fixes
- Prevent duplicate proxy arguments being passed to Streamlink when using the ttvlol plugin, resolving a potential error.

## [4.1.12] - 2025-12-02
### 🐛 Bug Fixes
- Fixed Streamlink executable path to use `streamlinkw.exe` for better GUI application compatibility (avoids unnecessary terminal window).

## [4.1.11] - 2025-12-02
### ✨ Features
- Added streamlink diagnostics to help debug stream starting issues.
- Added the ability to show points balance in the dynamic island.
- Enhanced streamlink error reporting to Discord for better troubleshooting.

### 🐛 Bug Fixes
- Fixed: Streamlink now uses `streamlink.exe` instead of `streamlinkw.exe` for better CLI compatibility.

## [4.1.10] - 2025-12-01
### ✨ Features
- Improved badge metadata parsing to handle various date formats.
- Enhanced logging for new badge metadata.
- Associated channel logins with channel IDs in channel points events for better identification.
- Improved badge availability date display in the UI, including support for abbreviated date ranges.

### 🐛 Bug Fixes
- Included the path, URL, and quality in Streamlink error messages for easier debugging.

## [4.1.9] - 2025-11-30
### 🐛 Bug Fixes
- Improved streamlink path resolution during development, searching in CWD and parent directory.

## [4.1.8] - 2025-11-30
### 🔧 Maintenance
- Standardized application bundle naming across build workflows and update checks to `StreamNook.7z`.
- Improved reliability of update checks by ensuring consistent bundle name matching.

## [4.1.7] - 2025-11-30
### 🔧 Maintenance
- Use the bundled Streamlink path within the application, ensuring consistent functionality regardless of installation location.

## [4.1.6] - 2025-11-30
### ✨ Features
- Replaced external 7z dependency with native `sevenz-rust` library for component bundle extraction.
- Improved update script to wait for app closure and ensure proper restart.

## [4.1.5] - 2025-11-30
### ✨ Features
- Added support for portable mode, bundling Streamlink within the application directory.
- Enhanced Dynamic Island with new notification settings and improved functionality, including update notifications, drops, and channel points.

## [4.1.4] - 2025-11-30
### ✨ Features
- Implemented device code flow for Twitch Drops login during setup.

## [4.1.3] - 2025-11-30
### 🐛 Bug Fixes
- Fixed an issue where Streamlink would not validate the user path correctly.

## [4.1.2] - 2025-11-30
### ✨ Features
- Improved bundle update check and component management.
- Moved 'Updates' tab in settings for better user experience.

## [4.1.1] - 2025-11-30
### 🔧 Maintenance
- Updated comment regarding clippy warnings suppression.

## [4.1.0] - 2025-11-30
### ✨ Features
- Implemented bundled distribution of Streamlink and TTV LOL plugin for simplified installation and updates.

## [4.0.2] - 2025-11-30
### ✨ Features
- Added first-time setup wizard to guide new users through the initial configuration.
- Improved WebSocket event handling for mining service, enhancing drop progress updates.

### 🐛 Bug Fixes
- Improved chat scroll and pause behavior, addressing issues with automatic pausing and scrolling to the bottom.



## [4.0.1] - 2025-11-29
### ✨ Features
- Redesigned the AboutWidget with tech stack icons and shoutouts to contributors and libraries.
- Enhanced the Dynamic Island with an updated notification badge and sound indicators.
- Implemented maximize/restore functionality in the TitleBar and updated relevant icons.

## [4.0.0] - 2025-11-29
### ✨ Features
- Added whisper functionality with message sending and receiving.
- Implemented whisper history retrieval using Twitch's undocumented GraphQL API.
- Added a whisper history scraper script for exporting data from the Twitch website.
- Added real-time whisper notifications using EventSub Websockets.

## [3.4.17] - 2025-11-29
### ✨ Features
- Added joke messages when clicking test notifications. Test notifications now have an `is_test` flag.

## [3.4.16] - 2025-11-29
### ✨ Features
- Added a "Test Notification" button in settings to trigger a sample notification.
- Implemented proper stream rotation for channel points farming, cycling through all followed live streams.
- Implemented notification sounds with customizable options.

### 🐛 Bug Fixes
- Stream watching loop now properly handles cases where no streams are live.

### 🔧 Maintenance
- Settings UI now has updates settings at the right spot.

## [3.4.15] - 2025-11-29
### ✨ Features
- Implemented drops websocket error reporting to the frontend.
- Improved offline detection logic in the video player, considering non-fatal errors and fragment stalling.
- Added activity tracking and user context (Twitch username, current stream) to error reports for better debugging.

### 🐛 Bug Fixes
- Fixed a bug where offline stream detection was too aggressive causing early auto-switch.

### 🔧 Maintenance
- Added user activity tracking to improve error context.
- Saved user and stream context to local storage for error reporting purposes.

## [3.4.14] - 2025-11-29
### ✨ Features
- Added a toggle to enable or disable anonymous error reporting to help improve StreamNook. The toggle is located in the settings under the 'Support' section.

## [3.4.13] - 2025-11-29
### ✨ Features
- Added a "Support" settings tab with a log viewer and bug report export functionality.
- Implemented automatic error reporting for easier debugging.

### 🐛 Bug Fixes
- Improved stream offline detection logic in the video player.

## [3.4.12] - 2025-11-28
### ✨ Features
- Added support for displaying Bits cheers in chat with animated icons and tier colors.
- Improved shared chat functionality, including fetching channel names and profile images.
- Integrated IVR user data (moderator, VIP, subscriber status) into the User Profile Card.

### 🐛 Bug Fixes
- Fixed issues with chat scrolling when historical messages are loaded, ensuring proper scrolling to the bottom.

### 🔧 Maintenance
- Updated badge display logic in User Profile Card to prioritize display badges and filter broadcaster badges when necessary.

## [3.4.12] - 2025-11-28
### ✨ Features
- Added support for displaying Bits cheers in chat with animated icons and tier colors.
- Improved shared chat functionality, including fetching channel names and profile images.
- Integrated IVR user data (moderator, VIP, subscriber status) into the User Profile Card.

### 🐛 Bug Fixes
- Fixed issues with chat scrolling when historical messages are loaded, ensuring proper scrolling to the bottom.

### 🔧 Maintenance
- Updated badge display logic in User Profile Card to prioritize display badges and filter broadcaster badges when necessary.

## [3.4.11] - 2025-11-28
### ✨ Features
- Added support for native emojis in chat messages.
- Implemented an emoji picker for easy emoji selection in the chat input.
- Added window `isMaximized` permission to prevent potential UI issues with glass morphism.

## [3.4.10] - 2025-11-28
### ✨ Features
- Implemented aspect ratio lock for the video player, with adjustments during window resize.
- Enhanced subscription and donation messages in chat with clickable usernames and cosmetics.

### 🔧 Maintenance
- Removed the unused `dark_mode` setting from chat design settings.

## [3.4.9] - 2025-11-28
### ✨ Features
- Penrose triangle colors now dynamically adjust based on the selected theme.
- Added new themes: Antidepressant's Tactical, prince0fdubai's OLED v2, GitHub Dark, Solarized Sand, Material Theme, Ayu Dark, Night Owl, Synthwave '84.

## [3.4.8] - 2025-11-28
### ✨ Features
- Implemented a new theming system, allowing users to customize the application's appearance. Users can now select from a variety of themes in the settings menu.

### 🔧 Maintenance
- Refactored the UI to support dynamic theme switching and persistent theme settings.

## [3.4.7] - 2025-11-28
### 🔧 Maintenance
- Added Dependabot configuration for automated dependency updates.
- Added `update-deps` script for interactive and automatic dependency updates using npm and cargo.

## [3.4.6] - 2025-11-28
### 🔧 Maintenance
- Updated the build date comment in the README.

## [3.4.5] - 2025-11-28
### ✨ Features
- Added React DevTools connection script for development.
- Added `react-devtools` and `concurrently` dependencies for debugging.
- Added `dev:debug` script to run React DevTools and Tauri concurrently.
- Set initial window size to 1600x1000, minimum size to 800x600, and centered the window.
- Skip aspect ratio adjustment when window is maximized.

## [3.4.4] - 2025-11-28
### Fixed
- Fixed stream caching issues by adding a timestamp to the stream URL.
- Added `client_secret` when refreshing Twitch token to keep the service running.

## [3.4.3] - 2025-11-27
### Fixed
- Fixes a rendering issue with chat messages overlapping one another.
- Resolved stability issues due to frequent re-renders. Improves ChatWidget performance.

### Changed
- Increased thumbnail resolution in LiveOverlay and LiveStreamsOverlay for better quality.
- Improved video player buffering for smoother playback.

### Added
- Added scroll anchoring to maintain stable scroll position when messages are removed from the chat.
- Badge click will now open a badge details overlay.

## [3.4.2] - 2025-11-27
### Added
- Implemented an auto-switch feature that automatically switches to another stream when the current stream goes offline.
  - Settings allow enabling/disabling auto-switch.
  - Option to switch to a stream in the same category or a followed stream.
  - Toggle notification for auto-switch events.
- Added commands `check_stream_online` and `get_streams_by_game_name` to check stream status and retrieve streams by game name.

### Improved
- Improved video player error handling for fatal network errors, now triggering auto-switch when appropriate.

## [3.4.1] - 2025-11-27
### Added
- Implemented stream switching with API refresh: If the current stream fails repeatedly, StreamNook will attempt to find a new one by refreshing the eligible channels from the API. This significantly improves reliability.
- Added toast notifications for stream switches and for when mining is stopped due to no available streams.

### Improved
- Overall channel switching logic and error handling for more reliable mining.

## [3.4.0] - 2025-11-27
### Added
- Manual channel selection for drops mining. Users can now choose a specific Twitch channel to watch for drops, providing more control over the mining process.

## [3.3.3] - 2025-11-27
### Added
- Implemented token refresh mechanism to automatically renew access tokens when they expire or are about to expire, ensuring uninterrupted access to Twitch services.
- Introduced a token health check API (`verify_token_health`) that validates the current token and proactively refreshes it on app startup, enhancing reliability.
- Added new Tauri commands (`verify_token_health`, `force_refresh_token`) for manual token management.
- Enhanced cookie and file storage to include refresh tokens and expiration times for persistence across sessions.
- Add token validation for drops authentication

### Changed
- Refactored token loading logic to prioritize file storage, fallback to cookies, and then keyring for redundancy.



## [3.3.2] - 2025-11-27
## v3.3.1

### Fixed
- **Discord Presence Reliability**: Implemented reconnection logic to handle Discord IPC socket failures, ensuring presence updates remain functional even if the initial connection is lost.
- **HLS.js Memory Leaks**: Fixed memory leaks by completely destroying the existing HLS instance when switching streams, ensuring a fresh instance is created each time.

### Improved
- **Discord Error Handling**: Downgraded Discord presence errors to warnings, preventing UI errors when Discord is not running. Stream Nook will not block if it cannot connect.

## [3.3.1] - 2025-11-27
## [3.3.0]

### Added
- Cache and forward user badges from IRC USERSTATE messages for accurate badge representation.
- Replace optimistic chat messages with server messages to ensure badge accuracy.
- Health checks to detect and recover from stale connections.

### Fixed
- Improved reconnection logic to handle abnormal closures and channel changes gracefully.
- Prevented duplicate message display.

## [3.3.0] - 2025-11-27
### Added
- Enhanced `BadgeDetailOverlay` with highlighted dates in the More Info section.
- Improved badge loading and metadata fetching process in `BadgesOverlay`.
  - Pre-load metadata from cache for instant sorting.
  - Background fetching of missing metadata.
  - Updated UI to reflect fetching status.

### Changed
- Improved logging clarity in `update-universal-cache.js`.

## [3.2.3] - 2025-11-27
### Added
- Ability to dynamically switch stream quality within the video player.
- Exposed additional Streamlink parameters within settings.

### Fixed
- More resilient drops URL parsing.
- Correctly chain opener function calls.
- More resilient date parsing.

## [3.2.2] - 2025-11-27
### Fixed
- Suppressed unused variable warning in HLS manifest parsed event in VideoPlayer component.

## [3.2.1] - 2025-11-27
## v3.2.0

### Changed
- Updated version to 3.2.0.

## [3.2.0] - 2025-11-27
### Added
- Implemented advanced Streamlink settings to allow configuring options such as low-latency mode, HLS live edge, and proxy settings.
- Added quality selection to the Plyr video player using HLS.js.

### Fixed
- Corrected Discord rich presence logo path.
- Optimized HLS.js settings for more stable playback and buffer management.

## [3.1.2] - 2025-11-26
### Fixed
- Improved live stream latency with dynamic playback adjustment based on buffer growth rate.

## [3.1.1] - 2025-11-26
## v3.1.0

### Changed
- Updated application version to 3.1.0.

## [3.1.0] - 2025-11-26
### Fixed
- Fixed unexpected video pausing during initial load and throughout playback.
- Fixed ChatWidget pausing when scrolling and added chat buffer.

### Changed
- Optimized chat history and set a fixed limit of 200 messages for improved performance and stability.

### Added
- Added Twitch user cosmetics and clickable usernames for system messages in chat.

## [3.0.2] - 2025-11-26
### Fixed
- Prevent `fetchBTTVEmotes` from crashing on undefined `channelName` by removing the paramater. This function is now called without any `channelName` argument.

## [3.0.1] - 2025-11-26
### Changes

- chore: update Cargo.lock after build


## [3.0.0] - 2025-11-26
### Added
- Replaced video.js with Plyr for a better streaming experience. This includes HLS support through HLS.js.
- Implemented theater mode, which automatically resizes the window to a 16:9 aspect ratio.
- Added a check for new versions on startup, displaying the changelog if the app has been updated.

### Changed
- Updated dependencies to their latest versions for improved stability and security.

### Removed
- Removed video.js and related dependencies as they are no longer needed.

## [2.9.2] - 2025-11-26
### Chore
- Added `openid` scope to Twitch authentication. This is needed for user identification.

## [2.9.1] - 2025-11-26
### Changed
- Refactor release notes fetching to parse `CHANGELOG.md` instead of using the GitHub API.
- Bumped version to 2.9.0

## [2.9.0] - 2025-11-26
### Fixed
- Improved robustness of app update installation by adding retries to file deletion in the batch script.
- Added cleanup logic to remove leftover update files (StreamNook_new.exe, update_streamnook.bat) on application startup, addressing potential issues from interrupted update processes.

## [2.8.0] - 2025-11-26
### Added
- Implemented automatic changelog display after app updates.  The changelog will now show on first launch after an update to inform users of new features and changes.

### Changed
- The app now checks for version changes on startup and displays the changelog if a new version is detected. This is powered by calls to GitHub releases API.



## [2.7.0] - 2025-11-26
### Changed
- Upgraded StreamNook version to 2.6.0

## [2.6.0] - 2025-11-26
## v2.5.0

### Changed
- Bumped application version to 2.5.0.

## [2.5.0] - 2025-11-26
## [2.4.0]

- Bump version to 2.4.0.

## [2.4.0] - 2025-11-26
### Changed
- Bumped version to 2.3.0

## [2.3.0] - 2025-11-26
## v2.2.0

### Changed
- Bumped version to 2.2.0 to include a new desktop release build.

### Added
- Desktop release build `StreamNook-Desktop-Setup.7z` and associated checksums.

# Changelog

## [2.2.0] - 2025-11-26
### Added
- Automated workflow to periodically update the universal badge cache.
- Ability to fetch and cache Twitch badge metadata from BadgeBase.
- Commands to force refresh global badges, get cache age, and check for new badges.

### Fixed
- Issue in calculating window aspect ratio when resizing with different chat placements.







