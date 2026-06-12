# Ad Bypass

A StreamNook plugin that resolves live streams through community playlist proxies so they play without stitched ads. It runs as a separate program that StreamNook starts and talks to.

## What it does

Streams you are already entitled to watch ad-free (Twitch Turbo, or a subscription to that channel) play directly and never touch this plugin. For everything else:

- When you start a stream, StreamNook invokes this plugin's `playback.resolve` hook. The plugin races a pool of community playlist proxies in its own process, over its own networking, and answers with the winning master playlist for the app's relay to serve.
- Anonymous proxy masters top out at 1080p, so when you are signed in the plugin merges the 1440p+ tiers from your own master back in (the splice).
- If an ad leaks through mid-stream, the plugin detects it in its own process (polling the playlist it resolved) and re-resolves through a different region, swapping the relay's upstream via `set_upstream`. The core app never scans for ads.

If every proxy is down the plugin declines, and StreamNook falls back to its own direct resolution (ads may appear). No login token is needed; the plugin requests no credentials.

## Settings

A rich panel on the Plugins page: an on/off toggle for proxy resolution, a preferred region, the high-tier splice toggle, and an add-and-remove list of custom proxy URLs tried before the bundled pool.

## Building

```
cargo build --release
```
