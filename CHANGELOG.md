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


























