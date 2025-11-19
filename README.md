# StreamNook

> The Twitch companion that doesn't eat your RAM for breakfast

---

## Overview

Let's be honest: you're grinding through your 47th hour of that indie roguelike, talking to yourself about optimal build paths, when you realize—*I need human voices*. But opening Twitch in a browser? That's like inviting a resource-hungry elephant to sit on your CPU. Your fans spin up, your frame rate tanks, and suddenly you're choosing between watching streams and actually playing games.

**StreamNook** is the answer to this very specific but deeply relatable problem.

Built from the ground up with Rust and React, StreamNook delivers a buttery-smooth Twitch experience that sips resources instead of chugging them. It's the cozy corner of the internet where you can watch streams, chat with communities, and claim those precious Drops—all without turning your PC into a space heater.

---

## Features

### Native Video Playback
Built-in video player powered by Video.js and Streamlink with adaptive quality selection, picture-in-picture support, and low-latency streaming that keeps you in sync with chat.

### First-Class Chat Experience
Full Twitch chat integration with native IRC support, 7TV/BetterTTV/FrankerFaceZ emote support, badge rendering for subs/mods/VIPs, and smooth scrolling that doesn't stutter.


### Live Notifications
Get notified when your favorite streamers go live with customizable notification settings, stream preview thumbnails, and quick-launch to any live channel.

### Rich Integrations
Discord Rich Presence integration, profile cards with detailed streamer stats, subscribe overlay for easy sub management, and a comprehensive badge collection system.

### Power User Features
Universal caching system for blazing-fast load times, granular settings for every aspect of the app, custom quality presets, chat filters and moderation tools, plus keyboard shortcuts for everything.

### Lightweight Architecture
Built with Rust for maximum performance, React frontend for smooth UI, native desktop integration via Tauri, and a minimal memory footprint (~100MB vs. browser's 1GB+). No Electron bloat in sight.

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

## Getting Started

### Prerequisites
- **Streamlink** - Required for stream playback
  - Download from [streamlink.github.io](https://streamlink.github.io/)

### Installation

1. **Download the latest release** from the [Releases page](https://github.com/winters27/StreamNook/releases/latest)
2. **Extract and run** the application
3. **Sign in** with your Twitch account
4. **Start watching** - search for a channel or browse your followed streams

That's it. No configuration files to edit, no command-line wizardry required.

---

## Roadmap

We're constantly improving StreamNook. Here's what's cooking:

- Drops automation and tracking
- Channel points automation
- Multi-stream viewing (watch multiple streams simultaneously)
- Clip creation and management
- VOD playback with chat replay
- Custom themes and UI customization
- Stream recording capabilities
- Predictions and polls integration
- Mobile companion app

---

## Contributing

StreamNook is open source and we welcome contributions! Whether it's bug reports, feature requests, documentation improvements, or code contributions—we'd love to have you involved.

Check out our [Contributing Guide](CONTRIBUTING.md) to get started.

---

## Screenshots

*Coming soon - we're too busy building features to take pretty pictures*

---

## Credits & Acknowledgments

StreamNook stands on the shoulders of giants:

- **[Streamlink](https://github.com/streamlink/streamlink)** - The backbone of our streaming infrastructure
- **[Tauri](https://tauri.app/)** - Making native desktop apps not suck
- **[Video.js](https://videojs.com/)** - Professional video playback
- **[7TV](https://7tv.app/)** - Extended emote support
- **[Twitch](https://dev.twitch.tv/)** - For having a (mostly) decent API

Special thanks to the open-source community for making projects like this possible.

---

## License

StreamNook is licensed under the MIT License. See [LICENSE](LICENSE) for details.

---

## Support & Community

- **Issues**: [GitHub Issues](https://github.com/winters27/StreamNook/issues)
- **Discussions**: [GitHub Discussions](https://github.com/winters27/StreamNook/discussions)
- **Discord**: *Coming soon*

---

<p align="center">
  Made with ☕ and questionable life choices
</p>

<p align="center">
  <sub>StreamNook is not affiliated with Twitch Interactive, Inc.</sub>
</p>
