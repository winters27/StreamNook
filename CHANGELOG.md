## [6.4.0] - 2026-01-05
### ✨ Features
- **Enhanced Drops Mining Resilience**: The Drops mining feature is now more robust. If all streams for a campaign go offline, StreamNook will intelligently attempt to switch to the next campaign in your "Mine All" queue or notify you if no streams are available.

### 🐛 Bug Fixes
- Fixed an issue where the stream would freeze when switching channels.
- Correctly handle reserved streams going offline, returning the watch token to the general rotation pool and notifying the user.

### 🔧 Maintenance
- Updated internal dependencies to improve build performance and compatibility.
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

