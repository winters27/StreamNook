# StreamNook Modular Architecture Audit and Plugin Proposal

Status: planning document with decisions resolved. No code changes accompany this document.
Scope: feature inventory, ToS risk classification, and a plugin architecture that pulls behaviorally risky features out of the shipped core binary into opt-in, community-distributed plugins.
Facts in the inventory were checked against the working tree on 2026-06-09 (v7.8.5 dev plus uncommitted low-latency and Lists work). The direction decisions in Section 5 were resolved with the owner on 2026-06-09. Twitch internals (persisted-query hashes, client IDs, endpoints) drift, so re-verify version-sensitive items before acting.

---

## 0. How to read this document

The goal is a core binary that is a strong, feature-rich Twitch client containing nothing likely to get the app or its users in trouble with Twitch. Everything that crosses into farming, automation, or ad circumvention keeps existing, but as separate opt-in plugins that the core neither contains nor distributes.

Four sections follow:

1. Existing work this builds on, plus the risk framework and its provenance.
2. Full feature inventory with tier, justification, and verdict per feature, and an explicit statement of how core watch reporting, points, and drops behave versus what crosses into farming.
3. Plugin architecture options, the chosen approach, and the concrete system design.
4. Migration plan with an ordered checklist, followed by the decision log and remaining open items.

The transport (GQL, IRC, EventSub, 7TV, BTTV, FFZ) is treated as a fact to document, not as a problem in itself. The line that matters is behavioral: a normal viewer using the app normally is fine even over unofficial transport; farming and automation are not, regardless of transport.

---

## 1. Existing work located and reused

### 1.1 What was found

Prior analysis exists and is reused here rather than re-derived:

- Cross-platform and modular groundwork: the port analysis covering desktop and mobile feasibility, the verified Tauri and store-policy facts, and the chained risk loop (mobile cannot spawn subprocesses, so resolution must be native, which enables ad stripping, which gets the app rejected from stores). The load-bearing conclusion reused here: the Tier C behaviors (background farming, ad bypass) are already desktop-only and effectively impossible on mobile (no iOS background execution, near-certain store rejection for ad bypass). A desktop-only plugin mechanism for the risky tier therefore costs nothing on mobile, because the risky tier cannot run there anyway.
- Ad architecture: the playback pipeline, the entitlement-first idea (use the user's own Turbo or subscription to get a clean master and skip the proxy), and the free in-band ad detection path.
- Login architecture: the finding that there are multiple credential surfaces, not one (official Helix app and OAuth, the web cookie auth-token read from the live webview, the anonymous web client ID for private GQL reads, and an Android-client GQL credential for mutations), and that the split is forced by client-integrity and token-to-client-ID binding.
- Background automation notes: the central background service, its two-concurrent-stream channel-points rotation, the five-minute bonus-chest claim poll, the reserved-slot mechanism, and the WebSocket pooling.
- Drops endpoint history: the legacy `spade.twitch.tv/track` path no longer credits drops (it does still credit channel points, see 2.2); the documented working path for drops is the `sendSpadeEvents` GraphQL mutation.

### 1.2 Framework provenance

No independently written "Tier A/B/C" document predates this audit. The framework was reconstructed on 2026-06-08 from the risk material above, then re-keyed by the owner on 2026-06-09: the grading axis is realistic enforcement risk, not strict web-player parity. That re-key is decision 1 in Section 5 and is reflected below.

### 1.3 The framework

Grading principle. Every feature is graded on one question: would this plausibly get the app or its users in trouble with Twitch? Strict web-player parity is not the bar for what ships in core. A feature with no web-player analog (MultiNook is the canonical example) can still be a safe core feature when it is user-present, the video genuinely renders, and a reasonable observer would not call it abuse. Parity survives in one scoped place: it is the design target for the core's own watch-reporting telemetry (see 2.6).

Tiers:

- Tier A (green): no realistic concern. Official APIs, local-only features, read-only integrations, ordinary user actions.
- Tier B (gray): unofficial transport or private APIs, or user-initiated actions with no official equivalent. Realistically tolerated: the behavior is what a normal user does even if the wire path is not the official one. Default home: CORE, documented.
- Tier C (red): real enforcement exposure. Watching-without-watching (drops or points farming, headless mining, auto-claim on a timer), ad stripping or circumvention, hidden-browser automation against Twitch. Default home: PLUGIN (opt-in, community-distributed) or removed.

Watch-reporting parity (scoped). The core's own telemetry should mimic the official web player for the channel the user is actually watching: one minute-watched heartbeat for the focused stream while it plays, points accrue there, drop progress advances there, and claims are user clicks. Multi-tile viewing is a safe core feature; core telemetry still reports single-focus (2.6).

Verdicts:

- CORE: ships in the main binary.
- PLUGIN: opt-in, extracted out of the binary.
- NEEDS-DECISION: now resolved for all items; see the decision log in Section 5.

---

## 2. Feature inventory and risk audit

Streamlink is gone. Stream resolution is native Rust: GQL `PlaybackAccessToken` (web client ID `kimne78kx3ncx6brgo4mv6wki5h1ko`, `platform=site`, `playerType=embed`) to `usher.ttvnw.net` to a local HLS relay. Clips use an inline `VideoAccessToken_Clip` query, VODs use the same token operation with `isVod=true`.

Tables are grouped by domain. Files are under `src-tauri/src/` unless noted. The Tier column carries the one-line justification.

### 2.1 Playback, latency, and ad pipeline

| Feature | What it does | Files | Surfaces | Tier (why) | Verdict |
|---|---|---|---|---|---|
| Native live resolver | GQL `PlaybackAccessToken` then `usher.ttvnw.net` master, selects variant, returns media-playlist URL | `services/twitch_resolver.rs` (`resolve_live`), `services/auth_proxy.rs` | GQL, usher, web client ID | A (same call sequence as the web player) | CORE |
| Native VOD resolver | Same token op with `isVod=true`, then `usher.ttvnw.net/vod/{id}` | `services/twitch_resolver.rs` (`resolve_vod`) | GQL, usher | A (normal VOD viewing) | CORE |
| Clip resolver | Inline `VideoAccessToken_Clip` query, returns signed MP4 | `services/twitch_resolver.rs` (`resolve_clip`) | GQL | A (normal clip viewing) | CORE |
| Master parser and quality select | Local parse of legacy and modern (IVS) masters, closest-match quality fallback | `services/twitch_resolver.rs`, `services/quality.rs` | Local only | A (local math) | CORE |
| Local HLS relay | Localhost warp server that fetches the resolved playlist and segments and serves them to the embedded player (CORS bridge) | `services/stream_server.rs` (`start_proxy_server`) | localhost, Twitch CDN | A (a pipe, not a behavior) | CORE |
| LL-HLS origin | Converts Twitch's chunked CMAF delivery into a real LL-HLS origin: splits the in-progress segment into `EXT-X-PART` entries with blocking playlist reload, so hls.js can ride about 2s from live instead of a full segment behind. Consumes the same prefetch hints the official low-latency player uses. Sends no telemetry. | `services/ll_origin.rs`, wired per stream in `stream_server.rs` and per tile in `multi_nook_server.rs`, probed by the player via `get_stream_low_latency` | Twitch CDN (reads), localhost (serves) | A (latency parity with the official player, read-only) | CORE |
| Live-latency governor | Client-side playback-rate trim that keeps the forward buffer near target on the non-LL path, where hls.js's own catch-up is disabled. Stands down when the user sets a manual speed. | `src/utils/liveLatencyGovernor.ts`, wired in `src/components/VideoPlayer.tsx` | None (local video element) | A (local playback mechanics) | CORE |
| Latency readout | Wall-clock latency display preferring `PROGRAM-DATE-TIME` of the on-screen frame, matching Twitch's own "latency to broadcaster" metric | `src/components/PlayerStatsOverlay.tsx` | None (reads served playlist metadata) | A (display only) | CORE |
| Targetduration rewrite | Lowers over-declared targetduration to real max so the player can ride closer to the live edge | `services/ad_detect.rs` (`retarget_playlist`) | Local only | A (local playlist math) | CORE |
| Prefetch promotion | Converts low-latency prefetch hints into real segments, translates the prefetch discontinuity marker into a standard one for hls.js stability, gated off while an ad is detected, disabled in MultiNook | `services/ad_detect.rs` (`promote_prefetch`) | Local only | A (latency, not ad behavior) | CORE |
| Ad detection (read-only) | Scans the playlist for stitched-ad markers and exposes detection state to the UI, including a per-tile `ad_snapshot` for MultiNook | `services/ad_detect.rs` (`scan`), `commands/streaming.rs` (`get_ad_detection`), `commands/multi_nook.rs` (`ad_snapshot`) | Local only | A (observing, not evading) | CORE |
| Web token extraction | Reads the user's own `auth-token` and `unique_id` cookies from the embedded WebView2 via COM, 5-minute cache, used to authenticate the user's own requests | `services/twitch_auth_service.rs` | WebView2 COM, twitch.tv cookies | B (own cookie, own requests) | CORE |
| Entitlement-first ad routing | Checks `hasTurbo` and `subscriptionBenefit`; if entitled, uses the authenticated clean master directly and skips the proxy | `services/auth_proxy.rs` (`account_has_turbo`, `is_subscribed`) | Private GQL fields | B (uses a benefit the user paid for) | CORE |
| MultiNook concurrent playback | Up to 25 concurrent stream tiles, each a full resolve through the same pipeline, plus a spotlight mode that fills the grid with one stream | `services/multi_nook_server.rs`, `commands/multi_nook.rs`, `src/components/multi-nook/` | Per-tile resolve | B (user-present multi-view over gray transport; video genuinely renders; realistically tolerated, like N open tabs) | CORE |
| Proxy racing (ad bypass) | When not entitled and the proxy is enabled, races region-shifted TTV-LOL-compatible proxies and returns the first valid anonymous master, which Twitch SSAI does not inject ads into | `services/auth_proxy.rs` (`fetch_ttvlol_with_fallback`, `fetch_ttvlol_master_racing`) | Third-party proxy endpoints | C (ad circumvention) | PLUGIN |
| High-tier splice | Grafts the above-1080p variants from the authenticated master onto the anonymous proxy master | `services/auth_proxy.rs` (`splice`, `extract_high_tier_blocks`) | Both masters | C (extends the bypass) | PLUGIN |
| In-relay ad segment filter | Actively strips stitched-ad, `X-TV-TWITCH-AD-*`, and Amazon-titled segments from the served playlist before the player sees them; runs ungated on every relay path including the entitled one | `services/ad_detect.rs` (`filter_ad_segments`), `services/stream_server.rs`, `services/multi_nook_server.rs` | Raw HLS | C (active ad removal) | PLUGIN |
| Ad auto-pivot | When a proxy region serves an all-ad window, automatically re-resolves through a different region and hot-swaps the relay URL (proxy path only) | `services/stream_server.rs` (`maybe_trigger_pivot`, `do_pivot`) | Re-resolve via proxy | C (automated evasion) | PLUGIN |
| Proxy health check | Pings the 12 bundled proxies, measures latency, selects the fastest healthy one | `services/proxy_health.rs` | HEAD to proxy endpoints | C (serves the bypass) | PLUGIN |
| Proxy auto-optimizer | On first launch force-enables `use_proxy`, runs the health check, configures the fastest proxy, and silently re-optimizes on later launches (respects a later user opt-out) | `src/services/proxyAutoOptimizer.ts` | Proxy commands | C (bypass on by default) | PLUGIN |

Notes. The ad-bypass stack is layered, not one switch: anonymous region-shifted master, then segment strip for anything that leaks through, then automatic region pivot when a region goes all-ad, then a first-launch auto-optimizer that turns the whole thing on by default. The in-relay strip is not gated by entitlement, so it also runs on the Turbo or subscription path where the master is already clean. All of it extracts to the ad-bypass plugin per decision 4; the core relay becomes ad-neutral. MultiNook is resolved as a core feature under the risk-grading framework: it is a viewing feature the user is present for, and once the ad stack is extracted its tiles resolve the same neutral way solo playback does. Its watch-reporting behavior is defined in 2.6. The low-latency work (LL-HLS origin, governor, prefetch handling, PDT readout) is pure playback mechanics: it sends nothing, claims nothing, and evades nothing.

### 2.2 Drops, channel points, and background farming

The most ToS-sensitive domain. The vendored Python projects under `drops/` (TwitchDropsMiner, Twitch-Channel-Points-Miner-v2) are reference implementations only: no `Command::new` or link into them exists, StreamNook reimplemented the logic natively in Rust, and the Python names appear only in attribution comments.

| Feature | What it does | Files | Surfaces | Tier (why) | Verdict |
|---|---|---|---|---|---|
| Channel-points watch loop (rotation) | Background tokio loop, every 60s sends minute-watched for up to 2 concurrent followed channels, rotating all followed live channels every 15 minutes by least-recently-watched | `services/background_service.rs:247-593`, `services/channel_points_service.rs` | `spade.twitch.tv/track` x2 per tick | C (multi-channel farming, user absent) | PLUGIN |
| Reserved slot | Locks one of the 2 farming slots to a user-chosen channel; the other slot keeps farming the rotation pool | `services/background_service.rs:619-641`, `commands/drops.rs` | Same as above | C (bundled with a farm slot) | PLUGIN |
| Bonus-chest auto-claim | Every 5 minutes polls `ChannelPointsContext` for every live followed channel and claims any bonus via `ClaimCommunityPoints`, gated on `auto_claim_channel_points` | `services/background_service.rs:163-237`, `services/channel_points_service.rs` | GQL `ChannelPointsContext`, `ClaimCommunityPoints` | C (auto-claim on a timer) | PLUGIN |
| Drops auto-mining | Headless loop selects a campaign and an eligible live channel, sends minute-watched every 60s, auto-switches channels on failure, claims on completion, no video rendered | `services/mining_service.rs` | GQL `DropCampaigns`, Helix `GetStreams`, `sendSpadeEvents`, `DropsPage_ClaimDropRewards` | C (headless mining) | PLUGIN |
| Channel-specific mining | User picks a campaign or channel, but the watch is synthetic (no video) and the watchdog still auto-switches on failure | `services/mining_service.rs` | Same as above | C (synthetic watch) | PLUGIN |
| Drop auto-claim | When progress reaches the requirement and `auto_claim_drops` is on, fires `DropsPage_ClaimDropRewards` automatically | `services/drops_service.rs:1553-1597` | GQL `DropsPage_ClaimDropRewards` | C (auto-claim) | PLUGIN |
| Whisper DOM scraper | Opens an invisible webview to `twitch.tv/messages`, injects JS to scroll and extract conversations, returns them over IPC | `commands/automation.rs:29-83` | Headless DOM automation | C (browser automation against Twitch) | REMOVE (after GQL verification, decision 8) |
| Mass PubSub monitoring | Connects PubSub (`wss://pubsub-edge.twitch.tv`) to every followed live channel at startup, up to about 100, for points and drop events | `services/channel_points_websocket_service.rs`, `services/drops_websocket_service.rs`, wired from `background_service.rs:98-155` | PubSub edge | B (reads at farming scale) | PLUGIN |
| Drops auth (Android device code) | Authenticates with the Android app's device-code flow and stores the token, used by all mining and CP services | `services/drops_auth_service.rs` | Twitch device-code, Android client ID | B (legit flow, farming-adjacent purpose) | PLUGIN |
| Drop campaign and inventory fetch | Reads active campaigns and inventory progress | `services/drops_service.rs` | GQL `DropCampaigns`, `Inventory` | B (read-only, serves the miner) | PLUGIN |
| Manual drop claim | The Claim button claims one drop, user-initiated | `commands/drops.rs`, `services/drops_service.rs` | GQL `DropsPage_ClaimDropRewards` | A (same click the web client requires) | CORE |
| Channel-points balance display | Reads the balance and available claim for the current channel | `services/channel_points_service.rs:79-295` | GQL `ChannelPointsContext` | A (read-only for the watched channel) | CORE |
| Predictions and redemptions | Place a prediction, redeem a reward, highlight a message, unlock an emote, user-initiated | `commands/drops.rs` | Corresponding GQL mutations | A (user actions with parity analogs) | CORE |
| Watch streak check and share | Reads shareable streak on the watched channel and shares it on user action | `commands/watch_streak.rs` | GQL `RewardList`, `ShareMilestone` | A (user action) | CORE |

Heartbeat reality (verified). Two watch-reporting paths coexist. The drops miner uses the `sendSpadeEvents` GraphQL mutation (`mining_service.rs:3489-3549`); its own comment states the legacy `spade.twitch.tv/track` endpoint still returns 204 and still credits channel points, but no longer credits drops. The background channel-points farmer still posts to that legacy endpoint (`channel_points_service.rs:19`, `SPADE_URL`) and cites mining_service as proof it works. So the CP farmer probably still credits points, but the codebase has forked watch-reporting paths, one of them on a legacy endpoint that is already dead for drops. Per decision 2, the core parity heartbeat standardizes on `sendSpadeEvents` and the legacy path retires with the farming extraction.

Defaults (verified, `models/drops.rs:252-259`): `auto_claim_drops` defaults true, `auto_claim_channel_points` defaults true, `auto_mining_enabled` defaults false. Per decision 12, the `auto_claim_channel_points` default flips to false in the next release, ahead of the plugin system.

### 2.3 Chat, emotes, and cosmetics

Almost entirely Tier A or read-only Tier B. There are no Tier C items here.

| Feature | What it does | Files | Surfaces | Tier (why) | Verdict |
|---|---|---|---|---|---|
| IRC chat | Standard IRC client, join/part/receive, bridged to the frontend over a local WebSocket | `services/irc_service.rs`, `services/chat_service.rs` | `irc.chat.twitch.tv` | A (normal chat client) | CORE |
| MultiChat | Multiple chat panes, one IRC join per channel, send only on user action | `services/irc_service.rs`, frontend chat panes | IRC | A (N chat tabs is normal user behavior) | CORE |
| Send message | Helix `POST /helix/chat/messages` primary, IRC fallback, slash commands over IRC, one message per action | `services/chat_service.rs`, `services/twitch_service.rs:1312` | Helix, IRC | A (official API, user-initiated) | CORE |
| Twitch emotes | User-accessible emotes via Helix, read-only | `services/emote_service.rs` | Helix emotes | A (official, read-only) | CORE |
| 7TV, BTTV, FFZ emotes | Public unauthenticated read-only emote fetch and disk cache | `services/emote_service.rs`, `services/emote_set_cache.rs` | 7tv.io, betterttv.net, frankerfacez.com | B (unofficial but public read-only) | CORE |
| AFK emote prefetch | While AFK, pre-downloads emote images with bounded concurrency | `services/emote_prefetch_service.rs` | Provider CDNs | B (CDN asset fetch) | CORE |
| 7TV EventAPI | Shared WebSocket for live emote-set updates plus a passive presence post (same as the 7TV extension) | `services/seventv_eventapi.rs` | events.7tv.io | B (matches 7TV's own extension) | CORE |
| Twitch badges | Global and channel badges via Helix | `services/badge_service.rs` | Helix badges | A (official, read-only) | CORE |
| Third-party badges | Public read-only badge lists from about seven community sources | `services/badge_service.rs`, `services/badge_polling_service.rs` | FFZ, BTTV, Chatterino, others | B (public read-only) | CORE |
| Private GQL badge lookup | `ViewerCard` and global badge collection via the web client ID for profile overlays, read-only | `services/badge_service.rs:703-895` | GQL `gql.twitch.tv` | B (private API, read-only) | CORE |
| BTTV Pro badge | On profile open, an undocumented BTTV socket `broadcast_me` trick to resolve a Pro badge, read-only, 2.5s timeout | `services/bttv_pro_service.rs` | BTTV socket (`wss://sockets.betterttv.net/ws`) | B (undocumented but read-only, third party) | CORE |
| 7TV own cosmetics | Equip or unequip the user's own paint and badge via authenticated 7TV mutations | `services/seventv_auth_service.rs:537-603` | 7TV v4 GQL `SetActivePaint`, `SetActiveBadge` | B (own account, user-initiated) | CORE |
| 7TV editor actions | Add, remove, rename emotes, manage sets and editors on channels where the user has 7TV editor rights, using the user's captured 7TV JWT, all user-initiated | `src/services/seventvEditorService.ts`, `commands/seventv_cosmetics.rs` | 7TV v4 GQL mutations | B (7TV ToS surface, not Twitch; user-initiated, same capability 7TV's own UI ships) | CORE (decision 5) |
| IVR profile data | Account age, follow date, ban status, sub age from ivr.fi, read-only | `src/services/ivrService.ts` | api.ivr.fi | B (community API, read-only) | CORE |
| Recent-message backfill | Last messages on join from a community service | `src/services/ivrService.ts`, `services/user_message_history_service.rs` | recent-messages.robotty.de | B (community API, read-only) | CORE |

### 2.4 Auth, identity, moderation, EventSub, whispers

| Feature | What it does | Files | Surfaces | Tier (why) | Verdict |
|---|---|---|---|---|---|
| Primary login | Device-code flow in a per-account webview | `services/twitch_service.rs`, `commands/twitch.rs` | Helix OAuth | A (official flow) | CORE |
| Add secondary account | Loopback listener on `127.0.0.1:3000`, auth-code with CSRF state | `utils/oauth_server.rs:35`, `commands/accounts.rs` | Helix OAuth, loopback | A (official flow) | CORE |
| Multi-account registry | Stores N accounts, per-account token files, isolated webview profiles | `services/account_store.rs` | File system, keyring | B (legit feature; the abuse vector lives in the farming code, which is leaving) | CORE (decision 6) |
| EventSub (stream and moderation) | Official EventSub WebSocket for raid, online/offline, channel update, hype train, whispers, and `channel.moderate` v2 | `services/eventsub_service.rs`, `services/eventsub_moderation.rs` | Official EventSub | A (official API) | CORE |
| Whisper send and receive | Receive over EventSub, send one at a time via Helix, no bulk path | `services/whisper_service.rs`, `commands/twitch.rs` | EventSub, Helix whispers | A (official, rate-natural) | CORE |
| Whisper history | Reads the user's own whisper history via private web-client GQL | `services/whisper_history_service.rs` | GQL web client | B (private API, own data, read-only) | CORE (becomes the only history path once the DOM scraper is removed) |
| Moderation actions | Ban, unban, mod, vip, timeout, delete, relayed one at a time to Helix on user action (including keybinding-triggered focused-message actions, mod-gated) | `commands/twitch.rs:1211-1294`, `src/keybindings/chatModController.ts` | Helix moderation | A (official, user-initiated) | CORE |
| Chat badge select (GQL) | `ChatSettings_SelectGlobalBadge` via the Android client | `commands/chat_identity.rs` | GQL, Android client | B (private mutation, user-initiated, parity analog exists) | CORE (credential per decision 7) |
| Chat badge select (DOM fallback) | Hidden webview that injects JS to click Twitch's badge UI when the GQL path fails | `commands/chat_identity.rs` | DOM automation | C (browser automation against Twitch) | REMOVE (after GQL verification, decision 8) |
| Subscriptions and resub share | Read own subs, share a resub, via the Android client, user-initiated | `commands/subscriptions.rs`, `commands/resub.rs` | GQL, Android client | B (own data, user action, parity analog) | CORE (credential per decision 7) |
| Hype train status | Anonymous read via the web client | `commands/hype_train.rs` | GQL web client | B (read-only for the watched channel) | CORE |
| Justlog and chat history | Mod-gated GQL plus community log services | `commands/justlog.rs` | GQL, logs.ivr.fi | B (read-only, mod tooling) | CORE |
| Live clip creation | Creates a clip of the live stream via official Helix | `commands/twitch.rs:49`, `services/twitch_service.rs:1138` | Helix `clips` | A (official API, user action) | CORE |
| VOD clipping and clip editor | Clips from VODs and edits clip bounds via the web GQL raw-media flow (`CreateRawMedia`, then `ClipCreation_CreateClipFromRawMedia`), reusing the Android-client no-integrity pattern; Helix has no VOD-clip or clip-edit equivalent | `commands/twitch.rs:80-567` | GQL, Android client | B (private mutation pipeline, user-initiated, parity analog in the web UI) | CORE (credential per decision 7) |
| StreamNook identity | Reads and writes the app's own cross-client badge identity on its own backend | `commands/identity.rs:20` | streamnook.app API | A (own backend) | CORE |

Auth model map (four credential surfaces):

- Helix app client ID plus user OAuth token: all official Helix calls (streams, users, chat send, moderation, whisper send, EventSub registration, raids, live clips) and login.
- Web auth-token, read from the embedded webview via COM: stream resolution and the proxy path only, never Helix.
- Web client ID (`TWITCH_WEB_CLIENT_ID`): private GQL reads (whisper history, hype train, badge lookups).
- Android client ID plus its own device-code token: GQL mutations the web client cannot do without integrity (chat badge select, subscriptions, resub, VOD clipping) and all drops and channel-points mining.

The Android credential is farming-adjacent: it exists primarily to enable the mining surfaces, but a handful of Tier B user actions also depend on it today. Per decision 7, a credential spike tests each of those features (resub share, VOD clipping and editing, chat badge select, subscription reads) against the normal login surfaces (Helix token, web credential) before deciding whether the Android credential stays in core in a reduced role or leaves entirely with the farming plugin. The prior login-architecture analysis found the split is forced by client-integrity and token-to-client-ID binding, so expect some features to genuinely require it; the spike replaces assumption with a per-feature answer.

Security note, relevant to the plugin credential broker: tokens at rest are XOR-obfuscated with a hardcoded key (`account_store.rs:45,120-125`), and the cookie mirror files `cookies.json` and `cookies_drops.json` are plaintext (`services/cookie_jar_service.rs:13-14`). XOR with a fixed key is not encryption. The OS keyring backup is the only genuinely protected copy. Whisper text is cached in plaintext. This matters because plugins will request credential handoff, and the broker that hands out tokens should be the one hardened path, not a set of weakly obfuscated files on disk.

### 2.5 App shell, utilities, and control surfaces

| Feature | What it does | Files | Tier (why) | Verdict |
|---|---|---|---|---|
| App shell and startup | Window, tray, deep-link, spawns background services | `main.rs` | A | CORE |
| Self-updater | User-initiated from the What's New tab, downloads `StreamNook.7z` from GitHub Releases, swaps the exe and restarts | `commands/settings.rs`, `commands/components.rs` | A | CORE |
| Announcements and universal cache | Reads operator notices and asset manifests from the repo, asset-only | `commands/announcements.rs`, `services/universal_cache_service.rs` | A | CORE |
| Discord rich presence | Local Discord IPC, shows a watching activity, user-toggled | `services/discord_service.rs` | A | CORE |
| Screen capture (share) | On-demand region capture for the profile share, no background capture | `commands/screen_capture.rs` | A | CORE |
| Lists | User-curated reference lists (e.g. ban evaders, command snippets, giveaway winners) in a panel or popout window; localStorage only, cross-window sync via a local Tauri event, zero network | `src/components/ListsPanel.tsx`, `src/components/lists/`, `src/stores/listStore.ts`, `src/utils/listsWindow.ts` | A (local-only) | CORE |
| Link previews | OGP metadata fetch for links posted in chat | `commands/link_preview.rs` | B (generic web fetch, not a Twitch surface) | CORE |
| Settings and diagnostics | Local config persistence and local-only verbose logging | `commands/settings.rs`, `commands/diagnostic_logging.rs` | A | CORE |
| Support plumbing | Roughly two dozen further services and commands that are caches, local storage, layout, notifications, and fetch helpers: profile cache, layout service, live notifications (EventSub `stream.online`), emoji metadata, mod-log storage, whisper storage, channel panels (Helix read), cosmetics caches, shared HTTP pool, log export | `services/`, `commands/` (various) | A/B (read-only or local; nothing automates) | CORE |

Startup behavior, the important finding. `BackgroundService::start()` is spawned unconditionally at launch (`main.rs:315-318`). It opens the PubSub pool to all followed channels, starts the 5-minute bonus-claim loop, and starts the 60-second watch loop. The last two are gated at runtime on `auto_claim_channel_points`, which defaults true. So for any user who has completed drops auth, channel-points farming (watch payloads to two channels plus bonus claims across all followed live channels) begins on first launch with no explicit enable action. Per decision 12 this flips in the next release: default false, startup gated, one-time notice for existing users. Drops auto-mining is already correctly opt-in (`auto_mining_enabled` defaults false). The proxy auto-optimizer has the same on-by-default posture for ad bypass and extracts with the ad plugin.

Control surfaces the migration must relocate:

- `src/components/DropsCenter.tsx`, the overlay hosting the games, inventory, stats, and settings tabs.
- `src/components/drops/DropsSettingsTab.tsx`, the toggles for `auto_claim_drops`, `auto_claim_channel_points`, and `auto_mining_enabled`, plus priority and excluded games and watch-token allocation.
- `src/components/settings/DropsSettings.tsx`, a parallel settings surface with the same controls.
- `src/components/TitleBar.tsx`, the gift icon whose state reflects `auto_claim_channel_points` (lines 381, 415).
- `src/stores/AppStore.ts`, where a stream start calls `start_drops_monitoring` (line 1629) and reads the reserved-token setting.
- Proxy controls in player or integrations settings, driven by `proxyAutoOptimizer.ts` on launch.

### 2.6 Core watch reporting, points, and drops: what core does vs what crosses into farming

Watch reporting:
- Core: one minute-watched heartbeat for the channel the user is actually watching, only while it is actually playing, using the user's own credential, triggered by the player, on the documented working `sendSpadeEvents` path. In MultiNook, the working default is that only the focused or spotlit tile heartbeats, so core telemetry always says "this user is watching one channel", which is true. (Widening to all visible tiles is possible later; see remaining opens.)
- Farming (plugin): the background two-channel rotation, the reserved-slot-plus-second-farm-slot, any heartbeat for a channel that is not on screen, and any headless mining heartbeat with no video.
- Current state: there is no clean player-driven heartbeat today; the only heartbeats in the codebase are the farming loops. Core needs a new minimal heartbeat extracted from the existing services. This is the central piece of new core work, and until it lands, watching in core earns nothing (same as today with farming disabled).

Channel points:
- Core: points accrue passively because the watched channel is heartbeated. The balance display is read-only. Claiming a bonus chest is a user click, the same as the web client.
- Farming (plugin): the 5-minute timer that auto-claims bonus chests across all followed live channels with no user present.

Drops:
- Core: drop progress advances on the watched channel because it is being watched. Progress and inventory display are read-only. Claiming a finished drop is a user click.
- Farming (plugin): the headless miner that selects channels, sends synthetic heartbeats with no video, auto-switches on failure, and auto-claims on completion.

In one line: core watches real channels with real video and reports the one the user is focused on; the plugins watch channels nobody is looking at and claim things on a timer.

### 2.7 The genuinely confrontational items (not paranoia)

Actually confrontational, extracted or removed:

- Drops farming: the headless miner, channel auto-switch, and drop auto-claim.
- Channel-points farming: the two-channel rotation, the reserved second slot, and the bonus auto-claim timer.
- Ad circumvention: the proxy racing, the high-tier splice, the in-relay ad-segment strip, the auto-pivot, the proxy health check, and the first-launch auto-optimizer.
- Background and headless watching: the unconditional background service and the invisible mining webviews.
- Browser DOM automation against Twitch: the whisper scraper and the chat-badge DOM fallback (removed once the GQL paths are verified to stand alone).

Fine even though unofficial, stays in core:

- All the read-only third-party integrations (7TV, BTTV, FFZ, ivr.fi, recent messages, community badges).
- Private GQL reads via the web client ID for profile and badge data.
- The web token extraction (the user's own cookie, used to authenticate the user's own requests).
- Native resolution over GQL and usher (identical call sequence to the web player).
- Entitlement-first ad routing (uses the user's own Turbo or subscription; the opposite of circumvention).
- MultiNook and MultiChat (user-present viewing features; video and chat genuinely render).
- 7TV editor actions and own-cosmetics (user-initiated, 7TV's own surface).
- The entire low-latency stack, Lists, link previews, and the support plumbing.

---

## 3. Plugin architecture

### 3.1 The hard problem

The core is a compiled binary and most logic is Rust, but the goal is community-submitted plugins that can be enabled, disabled, installed, and updated at runtime, and crucially that keep the risky code out of the shipped binary. The four realistic options for a Tauri and Rust host, scored on sandboxing, ToS-distancing (does the risky code stay out of the binary, and ideally out of the host process), distribution, dev ergonomics, and cross-platform reach.

### 3.2 Options

Option 1: dynamic libraries via libloading over a stable C ABI.
- Sandboxing: none. Native code runs in-process with full access to memory, the file system, the network, and the user's tokens. A bad plugin is a full compromise.
- ToS-distancing: weak. The shared library is not in your binary, but it runs inside your process, under your process identity, sharing your memory and credentials. Rust has no stable ABI, so the boundary must be hand-built with `extern "C"` and `#[repr(C)]` and opaque pointers. Since Rust 1.81 a panic escaping an `extern "C"` function is a defined abort rather than undefined behavior (use `extern "C-unwind"` plus `catch_unwind` to survive it), which removes the worst footgun but still means a panicking plugin kills the host. A plugin built against a different compiler or dependency version can still silently corrupt state through any non-frozen type. Helper crates exist (`abi_stable` is in low-activity maintenance, `stabby` is actively maintained) but both still build on the C ABI; they reduce boilerplate, not risk class.
- Distribution: a native binary per platform and architecture, signing as the only safety, all-or-nothing.
- Dev ergonomics: plugin authors must use Rust or another C-ABI language and match the ABI exactly. Painful.
- Cross-platform: shared libraries on desktop. iOS forbids loading non-bundled native libraries (App Review Guideline 2.5.2: apps may not download or execute code that changes functionality), Android is awkward and policy-sensitive. Effectively desktop-only and fragile there.
- Verdict: reject. Worst sandbox, weakest distancing, worst ergonomics.

Option 2: WASM plugins (wasmtime, or Extism on top of it).
- Sandboxing: strong. Capability-based with no ambient authority. A module can only do what the host imports into it: no file system, network, or syscalls unless granted. Memory-isolated.
- ToS-distancing: medium to strong on the out-of-binary axis (the module is a separate artifact you neither compile nor ship), but the module runs inside your process and has no networking of its own. To let a farming module call Twitch, the host must grant an HTTP capability (an Extism host function or a WASI HTTP import), and every risky request then originates from your process, under your process identity. The Twitch-specific logic lives in the module, but the network mechanism and the process making the calls are yours.
- Distribution: small portable modules, content-addressed, easy to sign and verify. Extism adds a bundle format and host SDKs, and is actively maintained (1.x series, wasmtime-based; no component-model adoption yet).
- Dev ergonomics: good. Extism PDKs cover Rust, JS, Go, Python, C#, AssemblyScript, Zig, and C/C++. Debugging is harder than native.
- Performance for a heartbeat workload: trivial. A once-per-60-seconds control loop is nowhere near any limit. Video never touches WASM; it stays native.
- Cross-platform: wasmtime's first-class platforms are Windows, macOS, and Linux. iOS and Android targets exist but are Tier 3 (no CI, build-it-yourself); on iOS, JIT is forbidden, so modules run via the Pulley interpreter (Tier 2) or Cranelift AOT precompilation. This is still the only option with any mobile path at all.
- Verdict: best for sandboxed, cross-platform, in-process Tier A and B extension points (custom emote and badge providers, chat renderers, overlays, filters) that consume host data and do not need their own networking. Not the cleanest vehicle for Tier C, because the network capability and the calling process remain yours.

Option 3: embedded scripting (Rhai, mlua, or a JS runtime).
- Sandboxing: Rhai is pure Rust and sandboxed by construction (no IO unless exposed), mlua embeds C Lua (faster but a C dependency and weaker isolation), a JS runtime is heavier. In all cases the script calls only what you bind.
- ToS-distancing: weak, and worse than WASM for this goal. The script is only logic; every primitive (HTTP, token access) is a host binding you write and ship. The risky mechanism stays entirely in your binary and the plugin supplies only policy. That is the inverse of the goal.
- Distribution: trivial (a text file), which also means trivially modifiable, and signing a script is awkward.
- Dev ergonomics: easiest for simple hooks, one language per engine, no compile step.
- Cross-platform: pure-Rust engines run everywhere including mobile.
- Verdict: good for lightweight safe customization (themes, chat filters, command macros), not a vehicle for ToS-risky behavior. Reject as the Tier C primary.

Option 4: out-of-process plugins over IPC (LSP-style, stdio or local socket).
- Sandboxing: strongest practical isolation. An OS process boundary, separate address space, separate crash domain. The child can be further confined (Windows job objects, Linux seccomp or landlock, macOS sandbox-exec), but even without that it cannot corrupt host memory.
- ToS-distancing: strongest, and this is the decisive point. The risky binary is a completely separate program: separately authored, built, and distributed, with its own networking. The core never contains the spade endpoint, the proxy list, the mining loop, or the `sendSpadeEvents` mutation, and the risky network calls happen under the plugin's process, not the host's. This is the cleanest "I do not ship, host, or even run Tier C code inside my binary" story, and it maps naturally onto "the user installs a separate community program that StreamNook talks to."
- Distribution: the plugin is a downloadable executable (or a script with its own interpreter). The registry hosts manifests, signatures, and hashes, ideally on infrastructure separate from the core's distribution.
- Dev ergonomics: plugins in any language. JSON-RPC 2.0 over stdio with `Content-Length` framing is the LSP convention, simple and supported everywhere. Slightly more boilerplate than in-process (process lifecycle, framing, reconnection).
- Cross-platform: all desktop OSes. Not mobile: Tauri's shell plugin on iOS and Android can only open URLs, not spawn processes. Acceptable, because the Tier C behaviors are already desktop-only and impossible on mobile, so losing out-of-process plugins there costs nothing for the risky tier.
- Verdict: primary for Tier C and the heavier Tier B plugins.

### 3.3 The chosen approach

Primary: out-of-process plugins over IPC for the risky tier. Strongest isolation, cleanest ToS-distancing (the risky code is a separate program with its own networking, not just a separate file inside your process). Desktop-only is the right tradeoff because the risky tier cannot run on mobile anyway.

Complement (later): WASM via Extism for sandboxed in-process Tier A and B extension points (emote and badge providers, chat renderers, overlays, message filters), where capability sandboxing and cross-platform reach matter and the plugin does not need its own networking.

Rejected: libloading (no sandbox, no ABI stability, weak distancing) and embedded scripting as the Tier C vehicle (keeps the risky mechanism in the binary). Scripting and WASM remain fine for safe customization.

Ad-bypass plugin shape (decision 4, resolved): the plugin owns resolution. It performs the risky work (proxy racing, splice, region pivot) in its own process and hands the core an upstream playlist URL via `set_upstream`; the core relay stays a full-featured but ad-neutral pipe (detection stays, stripping never runs in core, on any path). On an ad window the core emits `on_ad_window` and the plugin answers with a new upstream. No per-segment IPC, and the LL-HLS machinery is not duplicated. Accepted cost: leak-through ad segments play as ads in core (the proxy master is the real mechanism; the strip was a second line of defense). The plugin-owns-relay shape remains documented as the maximal-distancing alternative if this ever needs revisiting.

Farming plugin implementation (decision 11, resolved): a Rust sidecar wrapping the existing native mining code as a separate binary speaking the plugin protocol. No Python runtime to distribute, and the logic is the current, battle-tested implementation. The vendored Python miners stay reference-only.

### 3.4 Plugin manifest

A plugin ships a manifest (`plugin.toml` or `plugin.json`) alongside its executable.

```
id            = "community.drops-farmer"      # reverse-DNS, globally unique
name          = "Drops and Points Farmer"
version       = "1.2.0"                         # semver
author        = "community handle"
tier          = "C"                             # A | B | C, drives the consent flow
description   = "Background drops and channel-points farming."
homepage      = "https://..."
host_min      = "8.0.0"                          # minimum core version

# How the core runs it.
[runtime]
kind       = "process"                           # process | wasm
entry      = "drops-farmer.exe"                  # or a wasm module path
args       = []
transport  = "stdio"                             # stdio | socket

# Everything the plugin is allowed to ask the host for. Anything not listed is denied.
[capabilities]
events = ["on_channel_change", "on_stream_start", "on_stream_stop",
          "on_followed_live", "on_watch_tick", "on_ad_window", "on_settings_change"]
host_methods = ["get_followed_live", "set_upstream", "log", "notify"]
credentials = ["twitch.android"]                 # which credential the broker may hand over
network = "external"                             # informational: the plugin does its own networking
ui = ["panel"]                                   # may contribute a settings panel

# Integrity.
[signature]
algorithm = "ed25519"
public_key = "..."
signature  = "..."                               # over the artifact hash
```

The `tier` field is declared by the author and verified by the registry curator (not self-certified into a lower tier). The `capabilities` block is the whole contract: the host answers only what is listed, and the consent UI renders exactly this block in plain language.

### 3.5 Host and plugin API

Transport: JSON-RPC 2.0 over stdio with `Content-Length` framing (the LSP convention). A local socket is the alternative for plugins the user runs independently (the core connects rather than spawns), the most hands-off distribution model.

The host emits events the plugin subscribed to:

- `on_stream_start { channel_id, login, display_name }`
- `on_stream_stop { channel_id }`
- `on_channel_change { channel_id, login }` (the active, on-screen channel changed)
- `on_watch_tick { active_channel_id, ts }` (a periodic tick the plugin can hang its own loop on)
- `on_followed_live { channels: [...] }`
- `on_ad_window { stream_id, state }` (read-only ad detection state, for the ad-bypass plugin to act on)
- `on_settings_change { keys: [...] }`

The plugin calls host methods, each gated by a capability:

- `get_followed_live() -> [channels]` (capability `host_methods: get_followed_live`)
- `set_upstream(stream_id, playlist_url)` (capability `host_methods: set_upstream`; how the ad-bypass plugin feeds the ad-neutral core relay)
- `get_credential(kind) -> token` (capability `credentials: <kind>`, plus per-session user consent; the broker is the only path to a token)
- `notify(level, text)` and `log(text)` (UI and diagnostics)
- `register_panel(schema)` (capability `ui: panel`, contributes a settings panel rendered by the host from a constrained schema)

The deliberate omission: there is no `http_request` host method for Tier C plugins. The risky plugin does its own networking in its own process. The host provides events and, on consent, a credential, and nothing else. That is what keeps the spade endpoint, the proxy list, and the mining mutations out of the core binary entirely. The only sensitive thing crossing the boundary is the credential handoff, which is exactly where the consent gate sits.

A plugin registers hooks at handshake:

```
-> initialize { host_version, capabilities_granted }
<- initialized { hooks: ["on_watch_tick", "on_followed_live"] }
```

For the farming plugin specifically: the host emits `on_followed_live` and `on_watch_tick`, the plugin asks the broker for the Twitch credential (consent required), and the plugin runs its own rotation and heartbeat loop over its own network stack. The core contains none of that logic.

### 3.6 Capability and permission model

- Default deny. A plugin gets only what its manifest lists and the user grants.
- Capabilities are coarse and readable, because the consent dialog shows them verbatim: read your followed channels, read the active channel, use your Twitch login token, contribute a settings panel, and an informational note that the plugin makes its own network requests.
- Credential capability is special. Even when granted at install, handing over a token requires a separate, explicit consent the first time it is requested, and the grant is revocable from the plugins page. The broker logs every handover.
- The host enforces by simply not answering ungranted RPCs and never emitting unsubscribed events.

### 3.7 Registry, trust, and not hosting Tier C code

Decision 10 (resolved): the two-index model.

- The core ships with zero bundled plugins and, by default, points only at an official index that lists Tier A and B plugins (safe extensions). The core's own distribution (the GitHub Releases the updater already uses) never carries a Tier C artifact.
- Tier C plugins live in community-run indexes that the user adds explicitly through an "add a source" flow. Adding a source is itself a consented action with a clear warning. The core fetches manifests from a source the user chose; it does not curate or host that source.
- An index is a simple signed JSON document: a list of plugin manifests with artifact URLs, hashes, tiers, and author public keys. Artifacts are hosted by their authors or the community index, not by the core's infrastructure.
- Signing and verification: authors sign artifacts with an ed25519 key (minisign-compatible is the pragmatic choice for an indie registry; sigstore keyless signing in public CI is a credible later upgrade, not a day-one requirement). The index carries the public key and the artifact hash. On install the host verifies the signature and the hash before the artifact ever runs, and shows the author, the tier, and the capability list in the consent dialog. A failed signature or hash blocks install.
- Trust on first use for community authors: the first time a user installs from an author, the host shows the author key fingerprint; later updates from the same author must be signed by the same key, and a key change is surfaced loudly.

This gives a clean liability story: the shipped binary contains no risky behavior, the official index lists only safe extensions, and risky behavior reaches a user only after the user adds a third-party source and consents to a specific Tier C plugin.

### 3.8 Enable, disable, install UX

A Plugins (or Extensions) page in the React settings, parallel to the existing settings tabs:

- Installed list: each plugin as a card with its name, author, version, a tier badge (A green, B amber, C red), an enable toggle, an expandable capability summary, and a link to its settings panel if it contributes one.
- Sources: the official index plus any community sources the user added, each with an add or remove control and a visible warning on the community ones.
- Browse and install: from a source, a plugin shows its manifest details and a clear Install action that triggers signature and hash verification, then the consent dialog.
- Per-plugin settings: rendered by the host from the plugin's registered schema, so the plugin does not get arbitrary UI access. The existing DropsCenter controls move here, under the farming plugin's panel, when that extraction lands.

The page belongs next to Integrations in the settings dialog, and the existing drops and proxy controls migrate into the relevant plugin panels rather than living in core settings.

### 3.9 Consent and warning flow

Enabling a Tier C plugin is an explicit, informed, reversible choice:

- A modal names the plugin and author, states the tier in plain language, lists the capabilities verbatim (reads your followed channels, uses your Twitch login token, makes its own network requests to Twitch), and states the risk plainly: this plugin automates watching or claiming, which Twitch's Terms of Service prohibit and which can result in account suspension; StreamNook's core does not include this behavior; you are enabling community code that runs as a separate program.
- The action requires an explicit checkbox acknowledging the risk plus a confirm, never a single click.
- The grant persists and is revocable from the plugins page, and the first credential handover prompts again.
- Tier A and B plugins get a lighter consent (capability list and author, no risk warning), scaled to what they actually do.

---

## 4. Migration plan

### 4.1 Target home for each current feature

| Feature group | Target |
|---|---|
| Native resolution (live, VOD, clip), master parsing, quality select, local relay, LL-HLS origin, latency governor, targetduration rewrite, prefetch promotion, ad detection display | Stays core |
| Web token extraction, entitlement-first routing | Stays core |
| MultiNook, MultiChat, spotlight | Stays core (focused-tile heartbeat per 2.6) |
| Single active-channel heartbeat | New core work (extract a minimal version) |
| Chat, send message, emotes and badges (Twitch and third-party, read-only), 7TV EventAPI, prefetch, private GQL reads, IVR, recent messages, BTTV Pro badge | Stays core |
| 7TV own-cosmetics equip, 7TV editor actions | Stays core |
| Login, add account, multi-account, EventSub (stream and moderation), whisper send/receive/history, moderation actions, subscriptions and resub, hype train, justlog, live clip creation, VOD clipping, StreamNook identity | Stays core (Android-credential features pending the spike, decision 7) |
| App shell, updater, announcements, universal cache, Discord RPC, screen capture, Lists, link previews, settings, diagnostics, support plumbing | Stays core |
| Channel-points rotation, reserved second slot, bonus auto-claim timer | Extract to the farming plugin (Rust sidecar) |
| Drops auto-mining, channel auto-switch, drop auto-claim | Extract to the farming plugin (Rust sidecar) |
| Manual drop claim, points balance display, predictions, redemptions, watch streak | Stays core |
| Mass PubSub monitoring, drops auth (Android device code) | Move with the farming plugin |
| Ad proxy racing, high-tier splice, in-relay ad strip, auto-pivot, proxy health, proxy auto-optimizer | Extract to the ad-bypass plugin (plugin-owns-resolution) |
| Whisper DOM scraper, chat-badge DOM fallback | Remove, after verifying the GQL paths stand alone |

### 4.2 Ordered checklist

Phase 0, immediate posture fix (decision 12; ships in the next release, independent of everything else):

> Superseded 2026-06-10 by decision 13: no intermediate posture release ships. The default flip and the farming removal reach users together with the extraction (Phase 4), and the migration notice becomes part of that release. The checklist below is retained for the record only.

- [ ] Flip the `auto_claim_channel_points` default to false and gate `BackgroundService` startup so no farming loop runs unless explicitly enabled.
- [ ] One-time migration notice for existing users explaining the change and how to re-enable manually (until the plugin exists) or via the farming plugin (once it does).

Phase 1, foundations (no behavior change):

- [x] Freeze and document the host and plugin JSON-RPC protocol, the event and host-method list, and the manifest schema. (docs/plugins/, commit bb6adc2)
- [x] Define the capability vocabulary and the consent copy for each tier. (docs/plugins/CAPABILITIES.md)
- [x] Set up the signing scheme (minisign-style ed25519) and the index document format. (docs/plugins/SIGNING.md; marketplace metadata added additively later)

Phase 2, host runtime and UI (still no risky behavior moved):

- [x] Build the plugin host in core: process supervisor (spawn, health, restart, shutdown), the JSON-RPC transport with framing, the event dispatcher, the capability broker, and the credential broker with consent and logging. (src-tauri/src/plugin_host/, commit adaff8e)
- [x] Build the React Plugins page, the sources model, install with signature and hash verification, the consent and warning flow, and host-rendered plugin panels. (plus marketplace detail pages, commit b840a50)
- [x] Ship with zero plugins and an official index that is empty or lists only Tier A and B samples. (index scaffolded at github.com/winters27/streamnook-plugins, empty; the in-app pin stays unset until the operator key exists)

Phase 3, core parity heartbeat:

- [x] Extract a single active-channel minute-watched heartbeat tied to the player: one channel, only while it is actually rendering and playing, using the user's own credential, on the working `sendSpadeEvents` path (not the legacy endpoint). (services/watch_heartbeat_service.rs; playback gated by player playing and pause events; offline and VOD self-guard via the live broadcast-id check)
- [x] In MultiNook, heartbeat only the focused or spotlit tile. (the heartbeat target rides the active-channel chokepoints, which already follow the focused chat; playback state is optimistic on target change since grid tiles always autoplay)
- [ ] Confirm that with no plugins enabled, points accrue and drop progress advances on the watched channel only, and nothing is sent for any other channel. (runtime verification pending: needs a live watch session and balance observation by the owner)

Phase 4, first extraction (drops and points farming, as a Rust sidecar):

Done in increments so the app and the sidecar both stay buildable throughout; core-side removal is last, after the sidecar is verified, so the fallback is never broken before the replacement is proven.

Increment 1 (done): the sidecar exists and farms channel points.
- [x] Stand up the farming sidecar as a standalone Rust binary crate (`plugins/drops-farmer/`) speaking the plugin protocol over stdio. Channel-points logic ported: up to two concurrent channels, least-recently-watched rotation every 15 minutes, priority-channel preference (replaces the reserved-slot concept; core's parity heartbeat already covers the actively watched channel), and a bonus-chest claim sweep every 5 minutes.
- [x] The plugin does its own GQL and watch reporting over its own `reqwest` stack, using the `twitch.android` credential handed over through the broker on consent. It standardizes on `sendSpadeEvents` (no legacy `spade.twitch.tv/track`). Client ids: the public web client id is a constant for context reads; the Android client id comes from the credential handover.
- [x] Handshake, panel registration, panel values, and the credential request verified against a host-style protocol harness; the sidecar fails gracefully on a bad token.

Increment 2 (done): drops auto-mining ported into the sidecar (`plugins/drops-farmer/src/mining.rs`). Fetches active campaigns (`DropCampaigns`), ranks them by `priority_games`, `excluded_games`, and `priority_mode` (PriorityOnly / EndingSoonest / LowAvailFirst), picks an eligible live channel (allow-listed channels first, else the most-watched `DROPS_ENABLED` stream of the game via `GameStreams`), reports minute-watched on the same `sendSpadeEvents` path to advance the drop, recovers from stalls / offline / game-category change (blacklist plus switch, gated by `recovery_mode` and `detect_game_change`), and claims completed drops (`DropsPage_ClaimDropRewards`). The mined channel counts as one of the two concurrent watch slots, so points farming gets the rest. All of it surfaces in the plugin's panel (Drops mining + Recovery sections). Two deliberate deviations from the old settings, both noted for the owner: `watch_interval_seconds` is not exposed because the watch cadence is the one-per-minute `sendSpadeEvents` tick (the correct minute-watched rate); and a couple of fine-grained recovery durations (blacklist length, deprioritize, status-poll interval) are internal defaults rather than panel knobs. The headline recovery controls (mode, stall timeout, game-change switching) are exposed.

Increment 3 (pending), core-side removal, only after the sidecar is verified live. Per decision 14 this removes ONLY the abuse-automation services and KEEPS the overlays and the watched-channel behavior:
- [ ] Remove the background-automation services: the `BackgroundService` rotation farm and timer bonus sweep, the `mining_service` headless miner, the mass-PubSub websocket pools, and the unconditional startup spawn / `auto_claim_channel_points` gate.
- [ ] KEEP in core: the DropsCenter overlay and the channel-points display, drop/inventory/balance reads, the watched-channel heartbeat (Phase 3), auto-claim of the actively-watched drop, `favorite_games`, manual claim buttons. The drops auth credential stays in core for these reads pending the Phase 6 spike; the plugin obtains its own via the broker.
- [ ] Confirm the core emits `on_followed_live`, `on_watch_tick`, and channel events (already wired in Phase 3) and contains none of the background mining loops or the spade / `sendSpadeEvents` farming calls (the watched-channel heartbeat's single `sendSpadeEvents` stays).
- [ ] Retire the legacy `spade.twitch.tv/track` path with the extracted farmer.
- [ ] In the DropsCenter settings tab, remove only the automation toggles (auto-mining, background farm, mass auto-claim) and point them at the plugin's panel; keep the display-and-collection settings. Remove the duplicated `settings/DropsSettings.tsx` surface.
- [ ] Verify the core binary no longer contains the background farming endpoints or loops, while the overlays and watched-channel earn/claim still work.

Phase 5, second extraction (ad bypass, plugin-owns-resolution):

- [x] Move the proxy racing, high-tier splice, auto-pivot, proxy health, and the first-launch auto-optimizer into the ad-bypass plugin (`plugins/ad-bypass/`, id `community.ad-bypass`). The shape refined in implementation: at stream start core invokes the plugin's `playback.resolve` action (non-entitled only) and the plugin answers with a proxy-resolved master playlist body, core's own master riding along in the args so the plugin splices the above-1080p tiers; `set_upstream` is the mid-stream path, answered to `on_ad_window` with a fresh media-playlist URL after re-resolving a clean region. Contract documented in docs/plugins/HOOKS.md (hook catalog).
- [x] Make the core relay ad-neutral: `filter_ad_segments` deleted outright (decision 4's accepted cost: a leak-through segment plays as an ad), the auto-pivot machinery removed, ad detection (read-only) stays and now feeds `on_ad_window` on every transition, solo and per tile. `resolve_live` is entitlement-first then direct, and works anonymously again (the proxy used to cover logged-out viewers).
- [x] Remove the bundled proxy list and the auto-optimizer default from core (proxy_health service and commands deleted, proxyAutoOptimizer.ts and ProxyHealthChecker.tsx removed, `use_proxy`/`proxy_playlist`/optimizer settings keys dropped from StreamlinkSettings; the player badge gains a "plugin" mode in place of "proxy").
- [ ] Verify MultiNook per-tile upstreams work with the plugin-supplied resolution. (Runtime verification pending: per-tile resolve delegation and `set_upstream` are wired; a tile upstream swap has no frontend reload handler yet, so a mid-stream tile pivot relies on hls.js error recovery until that lands.)
- [ ] Close the LL-origin ad-detection blind spot: when the LL-HLS origin is active it owns the served playlist, so the relay's pull-through ad scan never runs and `on_ad_window` never fires for that stream (the plugin cannot pivot there). Parity with the removed auto-pivot, which had the same blind spot, but the fix belongs in the origin's own playlist reader (scan + `notify_ad_window`) once the in-flight low-latency work lands.

Phase 6, credential spike and DOM-automation removal:

- [ ] Credential spike (decision 7): for each Android-credential feature (resub share, VOD clipping and clip editor, chat badge select, subscription reads), test whether it works with the normal login surfaces (Helix token, web credential). Produce a per-feature matrix.
- [ ] If everything works without it, remove the Android credential from core entirely (the farming plugin obtains its own through the broker or its own device-code flow). If some features require it, keep it in core reduced to exactly those features.
- [ ] Verify whisper history works standalone via the GQL service, then remove the whisper DOM scraper.
- [ ] Verify the chat-badge GQL path is reliable standalone, then remove the DOM fallback.

Phase 7, hardening:

- [ ] Replace the XOR token obfuscation and the plaintext cookie mirrors with OS-keyring or DPAPI-backed storage, and route all plugin credential access through the broker rather than files on disk.

### 4.3 Risks and watch-items

- The ad pipeline sits in the hot playback path. Plugin-owns-resolution keeps per-segment work in core and limits IPC to playlist-URL handoffs, but the pivot handoff (ad window detected, new upstream applied) needs care to avoid visible stalls.
- The Rust sidecar shares mining code with today's core; carve it as a separate crate so the plugin and any future maintenance don't drift from a copy-paste fork.
- Twitch internals drift (persisted hashes, client IDs, spade and `sendSpadeEvents` behavior). Whatever lands in the parity heartbeat should be the documented working path and easy to update.
- The community index needs a key-management story before any Tier C plugin is distributed (see remaining opens).
- The Phase 0 default flip changes behavior existing users may rely on; the migration notice matters, and expect some support noise in the gap before the farming plugin exists.
- The credential spike may find that most Android-credential features fail on other logins (the prior login-architecture analysis predicts this); be ready for the "keep it reduced" outcome rather than forcing removal.

---

## 5. Decision log (2026-06-09) and remaining opens

Resolved with the owner:

1. Framework: re-keyed from strict web-player parity to realistic risk grading. Green = safe core (including MultiNook and MultiChat: user-present viewing features, not something Twitch would realistically act on). Gray = unofficial transport or private APIs used the way a normal user would; fine in core, documented. Red = watching-without-watching, ad circumvention, hidden-browser automation; opt-in plugins only. Parity survives as the design target for core watch telemetry specifically.
2. Heartbeat endpoint: core standardizes on `sendSpadeEvents`; the legacy `spade.twitch.tv/track` path (which still credits points but not drops) retires with the farming extraction.
3. MultiNook: core. Working default for telemetry: heartbeat the focused or spotlit tile only.
4. Ad-bypass extraction shape: plugin-owns-resolution; the core relay becomes fully ad-neutral (the strip never runs in core, including on the entitled path).
5. 7TV editor actions: core (user-initiated, 7TV's own surface, same capability 7TV ships in its web UI).
6. Multi-account: core, unchanged surfacing (the abuse vector was the farming code, which is leaving).
7. Android credential: spike first. Test each dependent feature against the normal login surfaces; remove the credential from core if everything works without it, otherwise keep it reduced to exactly the features that need it. The farming plugin gets its own credential either way.
8. DOM automation (whisper scraper, chat-badge fallback): remove both, gated on verifying the GQL paths stand alone first.
9. Token-at-rest hardening: proceed (keyring or DPAPI, plus the credential broker as the only handout path).
10. Distribution: two-index model. Official index lists safe plugins only; red-tier plugins live in community-run indexes the user adds explicitly. Signing: minisign-style ed25519.
11. Farming plugin implementation: Rust sidecar from the existing native mining code; the vendored Python miners stay reference-only.
12. Defaults: flip `auto_claim_channel_points` to false and gate the background service in the next release, ahead of the plugin system, with a one-time notice.
14. (2026-06-10) Core keeps the full drops and channel-points UI and the normal user-present behavior; only the abuse automation becomes the plugin. This refines the verdicts in 2.2 and 2.6 and the 4.1 target table, which under-counted what stays in core. Stays in CORE: the entire DropsCenter overlay (games, inventory, the user's collection, stats, progress) and the channel-points display (balances, the user's points collection and rank); watch-to-earn on the actively watched channel (the Phase 3 heartbeat); auto-claim of the DROP for the stream the user is actively watching when it completes (the user must actually watch to earn it, which is the point); `favorite_games` (UI sort); the watched-channel presence settings; drop and points notifications; the manual claim buttons. Moves to the PLUGIN with full 1:1 settings parity, nothing dropped: the background multi-channel points farm (rotation over channels the user is not watching), the timer bonus-chest sweep across all followed channels, the headless drops miner (campaign selection, eligible-channel pick, channel auto-switch, synthetic no-video watch) and its drop auto-claim, mass PubSub, and every setting that configured them (`auto_mining_enabled`, `priority_games`, `excluded_games`, `priority_mode`, `watch_interval_seconds`, `priority_farm_channels`, `recovery_settings`). Q1 resolved (2026-06-10): core gets an opt-in "auto-claim channel points" setting for the actively watched channel (auto-claim while the user is present and genuinely watching is not abuse). It lives in chat settings, defaults OFF, and is scoped to the watched channel only (not a background sweep, which is the plugin's job). When it is OFF, core surfaces a clickable claim affordance on the channel-points display so the user can claim the chest themselves. So core owns: the watched-channel chest detection, the opt-in auto-claim, and the manual clickable claim. The plugin owns: the background sweep across channels the user is not watching.

15. (2026-06-10) Positioning. The plugin system's stated rationale is a lean, focused core, not Twitch-rule avoidance. Plugins are opt-in add-ons that keep heavier or niche behavior out of the core binary so it stays light and users run only what they choose. Persisted and user-facing artifacts (UI copy, consent dialogs, plugin descriptions, READMEs, docs, code comments, commit messages) use that framing. Drop the self-incriminating language everywhere these surfaces appear: no "abuse," "Twitch prohibits," "Terms of Service," "account suspension," "we do not endorse," or risk-tier alarm. Capability-based consent stays (what a plugin can do, that it runs as a separate program, and a plain note when it uses the user's login) because that is informed consent about access, not editorializing about enforcement. The internal `tier` field remains as quiet curation metadata (which index may list a plugin); its user-facing presentation is neutral, not an "account risk" badge. This supersedes the tone of Sections 1.3 and 2.7 and the consent copy in 3.9 and CAPABILITIES.md; the underlying capability and curation rules are unchanged.

13. (2026-06-10) Phase 0 will not ship as an intermediate release; decision 12's timing is superseded. The owner directed skipping straight to the migration in the dedicated working tree, so the default flip and the farming extraction reach users together, and the one-time notice becomes the migration notice of the extraction release ("farming moved to an opt-in plugin, here is how to get it"). Two findings from the abandoned Phase 0 work that Phase 4 must account for: (a) `BackgroundService` holds its own clone of `Settings` taken at construction and nothing updates it at runtime, so toggling `auto_claim_channel_points` off today does not stop the running farming loops until the app restarts; the carve-out must not replicate that pattern, and the bug exists in the shipping app today. (b) The frontend assumes the old default in several `?? true` fallbacks (`DropsCenter.tsx` default settings object, `settings/DropsSettings.tsx`, which also appears to be an orphaned surface no longer imported anywhere); these go away with the control-surface relocation.

16. (2026-06-11) Owner intent, framing correction. The load-bearing rationale for the whole plugin pivot is: (a) the core app with no plugins installed is unambiguously legitimate, a lean alternative Twitch client with nothing that could get the app or its users in trouble; (b) the sensitive capabilities continue to exist, but only as marketplace plugins each user explicitly installs, owning that choice for their own account; (c) the marketplace enables community-authored plugins without core updates. The "the plugin's network traffic originates from the plugin's process, not the app's" property described in Section 3 is NOT a goal in itself: a service cannot observe process boundaries on the user's machine, and requests look identical either way. Out-of-process remains the right engineering home for background behavior (reliability independent of the interface, own networking stack, any-language authoring), but process separation must not be cited as the purpose, in this document's successors or anywhere user-facing.

17. (2026-06-11) Second runtime kind: in-app UI plugins (`runtime.kind = "ui"`, spec in docs/plugins/UI_PLUGINS.md). A single JavaScript module the app loads into its interface; it can contribute real UI (title bar buttons, root overlays, named slots, command palette rows, bindable shortcuts, popout OS windows) through a host api object, sharing the host's React instance. Same manifest, marketplace, signing chain, install and consent flow as process plugins. Chosen over an in-process WASM engine because interface contribution in a webview app is delivered by JavaScript; WASM cannot draw UI. Rule of thumb: background behavior = process plugin, interface features = ui plugin. Pilot: Lists extracted from core into `app.streamnook.lists` (plugins/lists), removing the feature's code from the shipped app entirely; user data carries over via unchanged localStorage keys.

Remaining open (small, none block Phase 0 or 1):

- Credential spike outcomes: which Android-credential features survive on normal logins (Phase 6 produces the matrix).
- GQL standalone verification outcomes for whisper history and chat badge select (gates the two removals).
- MultiNook heartbeat widening: focused-tile-only is the working default; widening to all visible tiles (the N-tabs argument) can be revisited once the parity heartbeat exists.
- Official index operations: where the index lives, who holds the signing key, and the key-rotation story. Needed before Phase 2 ships the sources UI.
