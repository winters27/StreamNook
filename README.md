<div align="center">
<p align="center">
  <img src="src-tauri/images/logo.png" alt="Stream Nook Logo" width="200"/>
</p>
<div style="margin: 20px 0;">
  <h1>StreamNook</h1>
</div>

<div align="center">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 15px; padding: 25px; text-align: center;">
    <p>
      <a href='https://github.com/winters27/StreamNook'><img src='https://img.shields.io/badge/🔥Project-Page-00d9ff?style=for-the-badge&logo=github&logoColor=white&labelColor=1a1a2e'></a>
      <a href="https://github.com/winters27/StreamNook/stargazers"><img src='https://img.shields.io/github/stars/winters27/StreamNook?color=00d9ff&style=for-the-badge&logo=star&logoColor=white&labelColor=1a1a2e' /></a>
      <a href="https://github.com/winters27/StreamNook/releases/latest"><img src='https://img.shields.io/github/v/release/winters27/StreamNook?color=ff6b6b&style=for-the-badge&logo=github&logoColor=white&labelColor=1a1a2e' /></a>
    </p>
    <p>
      <img src="https://img.shields.io/badge/🦀Rust-orange?style=for-the-badge&logo=rust&logoColor=white&labelColor=1a1a2e">
      <img src="https://img.shields.io/badge/⚛️React-61DAFB?style=for-the-badge&logo=react&logoColor=white&labelColor=1a1a2e">
      <img src="https://img.shields.io/badge/⚡Tauri-FFC131?style=for-the-badge&logo=tauri&logoColor=white&labelColor=1a1a2e">
    </p>
    <p>
      <a href="https://github.com/winters27/StreamNook/issues"><img src="https://img.shields.io/badge/🐛Issues-ff6b6b?style=for-the-badge&logo=github&logoColor=white&labelColor=1a1a2e"></a>
      <a href="https://github.com/winters27/StreamNook/discussions"><img src="https://img.shields.io/badge/💬Discussions-4ecdc4?style=for-the-badge&logo=github&logoColor=white&labelColor=1a1a2e"></a>
    </p>
  </div>
</div>

</div>

<div align="center" style="margin: 30px 0;">
  <img src="https://user-images.githubusercontent.com/74038190/212284100-561aa473-3905-4a80-b561-0d28506553ee.gif" width="800">
</div>

---

## 🎯 The Problem

Let's be honest: you're grinding through your 47th hour of that indie roguelike, talking to yourself about optimal build paths, when you realize—*I need human voices*. But opening Twitch in a browser? That's like inviting a resource-hungry elephant to sit on your CPU. Your fans spin up, your frame rate tanks, and suddenly you're choosing between watching streams and actually playing games.

**StreamNook** is the answer to this very specific but deeply relatable problem.

Built from the ground up with Rust and React, StreamNook delivers a buttery-smooth Twitch experience that sips resources instead of chugging them. It's the cozy corner of the internet where you can watch streams, chat with communities, and track your favorite streamers—all without turning your PC into a space heater.

---

## Key Features

### Native Video Playback
- Built-in player powered by Video.js and Streamlink
- Adaptive quality selection (because your internet isn't always cooperating)
- Picture-in-picture support for true multitasking
- Low-latency streaming that keeps you in sync with chat

### First-Class Chat Experience
- Full Twitch chat integration with native IRC support
- 7TV, BetterTTV, and FrankerFaceZ emote support (all the emotes, all the time)
- Badge rendering for subs, mods, and VIPs
- Third-party badge integration (show off those achievements)
- Smooth scrolling and message rendering that doesn't stutter

### Automated Farming & Rewards
- **Auto Channel Points Mining** - Automatically collect channel points from your favorite streamers
- **Auto Drops Farming** - Never miss a Twitch Drop again with automated campaign tracking
- **Channel Points Leaderboard** - Track your channel points across all streamers you watch
- **Twitch Inventory Viewer** - View and manage all your earned drops and rewards in one place
- Set it and forget it - StreamNook handles the grinding while you sleep

### Live Notifications
- Get notified when your favorite streamers go live
- Customizable notification settings
- Stream preview thumbnails
- Quick-launch to any live channel

### Rich Integrations
- Discord Rich Presence (flex what you're watching)
- Profile cards with detailed streamer stats
- Subscribe overlay for easy sub management
- Badge collection and display system
- 7TV cosmetics support

### Power User Features
- Universal caching system for blazing-fast load times
- Granular settings for every aspect of the app
- Custom quality presets

### Lightweight Architecture
- Built with Rust for maximum performance
- React frontend for smooth, responsive UI
- Native desktop integration via Tauri
- Minimal memory footprint (~500MB vs. browser's 1.5GB+)
- No Electron bloat in sight

---

## Screenshots

<div align="center">

### Main Interface
<img src="src-tauri/images/watching.jpg" alt="Watching a stream" width="800">

### Live Following
<img src="src-tauri/images/following_live.jpg" alt="Live Following" width="800">

### Drops & Inventory Management
<p>
  <img src="src-tauri/images/drops.png" alt="Drops" width="400">
  <img src="src-tauri/images/drops_inventory.png" alt="Drops Inventory" width="400">
</p>
<p>
    <img src="src-tauri/images/drops_stats.png" alt="Drops Stats" width="800">
</p>

### Badges
<p>
    <img src="src-tauri/images/badges.png" alt="Badges" width="400">
    <img src="src-tauri/images/badges_info.png" alt="Badge Info" width="400">
</p>

</div>

---

## Installation

### Prerequisites

**Streamlink** - Required for stream playback
- Download from [streamlink.github.io](https://streamlink.github.io/)

### Quick Start

1. Download the latest release from the [Releases page](https://github.com/winters27/StreamNook/releases/latest)
2. Extract and run the application
3. Sign in with your Twitch account
4. Start watching streams

That's it. No configuration files to edit, no command-line wizardry required.

---

## Tech Stack

StreamNook is built on a modern, performance-first stack:

### Frontend
- **React 18** - UI framework
- **TypeScript** - Type safety and developer experience
- **Vite** - Lightning-fast build tooling
- **Tailwind CSS** - Utility-first styling
- **Video.js** - Professional-grade video playback
- **Zustand** - Lightweight state management

### Backend
- **Rust** - Systems programming language for performance
- **Tauri** - Native desktop framework (Electron's cooler cousin)
- **Tokio** - Async runtime for concurrent operations
- **Reqwest** - HTTP client for API calls
- **Serde** - Serialization/deserialization

### Services & APIs
- **Twitch API** - Stream data, user info, and Drops
- **Twitch IRC** - Real-time chat integration
- **Twitch EventSub** - Live notifications via WebSocket
- **Streamlink** - Stream URL resolution and quality selection
- **7TV API** - Extended emote support
- **Discord RPC** - Rich presence integration

---

## Roadmap

We're constantly improving StreamNook. Here's what's on the horizon:

### In Progress
- Multi-stream viewing (watch multiple streams simultaneously)
- VOD playback with chat replay
- Suite of shortcuts
- Moderation tools

### Planned
- Clip creation and management
- Custom themes and UI customization
- Predictions and polls integration (already auto-farm with channel points mining though)
- Stream analytics and statistics

### Recently Completed
- Drops automation and tracking
- Channel points automation
- Inventory management system
- Channel points leaderboard

---

## Contributing

StreamNook is open source and we welcome contributions! Whether it's bug reports, feature requests, documentation improvements, or code contributions—we'd love to have you involved.

---

## Credits

StreamNook stands on the shoulders of giants:

- **[Streamlink](https://github.com/streamlink/streamlink)** - The backbone of our streaming infrastructure
- **[Tauri](https://tauri.app/)** - Making native desktop apps not suck
- **[Video.js](https://videojs.com/)** - Professional video playback
- **[7TV](https://7tv.app/)** - Extended emote support
- **[Twitch](https://dev.twitch.tv/)** - For having a (mostly) decent API

Special thanks to the open-source community for making projects like this possible.

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

<div align="center" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 15px; padding: 30px; margin: 30px 0;">
  <div>
    <img src="https://user-images.githubusercontent.com/74038190/212284100-561aa473-3905-4a80-b561-0d28506553ee.gif" width="500">
  </div>
  <div style="margin-top: 20px;">
    <a href="https://github.com/winters27/StreamNook" style="text-decoration: none;">
      <img src="https://img.shields.io/badge/⭐%20Star%20us%20on%20GitHub-1a1a2e?style=for-the-badge&logo=github&logoColor=white">
    </a>
    <a href="https://github.com/winters27/StreamNook/issues" style="text-decoration: none;">
      <img src="https://img.shields.io/badge/🐛%20Report%20Issues-ff6b6b?style=for-the-badge&logo=github&logoColor=white">
    </a>
    <a href="https://github.com/winters27/StreamNook/discussions" style="text-decoration: none;">
      <img src="https://img.shields.io/badge/💬%20Discussions-4ecdc4?style=for-the-badge&logo=github&logoColor=white">
    </a>
  </div>
</div>

<div align="center">
  <div style="width: 100%; max-width: 600px; margin: 20px auto; padding: 20px; background: linear-gradient(135deg, rgba(0, 217, 255, 0.1) 0%, rgba(0, 217, 255, 0.05) 100%); border-radius: 15px; border: 1px solid rgba(0, 217, 255, 0.2);">
    <p align="center">
      <sub>StreamNook is not affiliated with Twitch Interactive, Inc.</sub>
    </p>
  </div>
</div>
