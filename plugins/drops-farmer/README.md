# Drops and Points Farmer

A StreamNook plugin that farms Twitch channel points (and, in a later version, mines drops) in the background, across your followed live channels. It runs as a separate program that StreamNook starts and talks to; the StreamNook core contains none of this behavior.

This is a Tier C plugin: it automates watching, which Twitch's Terms of Service prohibit and which can put your account at risk. StreamNook does not ship, host, or endorse it. You install and enable it deliberately.

## What it does

- Watches up to two of your followed live channels at a time to accrue channel points, rotating through the pool over time, the same way the former built-in farmer did.
- Sweeps for and claims bonus chests across your live channels every few minutes.
- The channel you are actively watching in StreamNook already earns points on its own (the core reports it), so this plugin farms the others.

It does all of its own networking and uses a Twitch login token that StreamNook's credential broker hands over only after you explicitly consent. The watch report uses the `sendSpadeEvents` GraphQL mutation.

## Settings

Configured from the plugin's panel in StreamNook (Settings, Plugins):

- Farming active: pause without uninstalling.
- Channels at once: one or two (Twitch credits points on up to two at a time).
- Priority channels: logins to farm first; the rest fill remaining slots.

## Building

```
cargo build --release
```

The host runs `target/release/drops-farmer.exe`, as declared in `plugin.toml`.

## Developing against StreamNook

In StreamNook open Settings, Plugins, Develop, and register this folder. Enabling the plugin runs you through the Tier C consent flow; the first time it needs your token it asks again, specifically for that.
