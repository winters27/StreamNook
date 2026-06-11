# Drops and Points Farmer

A StreamNook plugin that farms Twitch channel points (and, in a later version, mines drops) in the background, across your followed live channels. It runs as a separate program that StreamNook starts and talks to. It lives outside the core app as an opt-in add-on, so the core stays lean and you run it only if you want it.

It does its own networking and uses your Twitch login, handed over by StreamNook's credential broker after you allow it, so it can watch and claim on your account.

## What it does

- Watches up to two of your followed live channels at a time to accrue channel points, rotating through the pool over time, the same way the former built-in farmer did.
- Sweeps for and claims bonus chests across your live channels every few minutes.
- The channel you are actively watching in StreamNook already earns points on its own (the core reports it), so this plugin farms the others.

It does all of its own networking and uses a Twitch login token that StreamNook's credential broker hands over only after you explicitly consent. The watch report uses the `sendSpadeEvents` GraphQL mutation.

## Settings

This plugin has no settings UI of its own. It is configured entirely from StreamNook's native Drops center (priority and excluded games, selection strategy, recovery, channel-points target list, and so on), which pushes its settings to the plugin through the `drops.configure` hook. The Drops center's mine, stop, and Mine All controls drive the plugin through the `drops.mine` / `drops.mine-auto` / `drops.stop` hooks, and the plugin reports live progress back through the `drops.status` slot.

## Building

```
cargo build --release
```

The host runs `target/release/drops-farmer.exe`, as declared in `plugin.toml`.

## Developing against StreamNook

In StreamNook open Settings, Plugins, Develop, and register this folder. Enabling it shows the capability consent once; the first time it needs your login token it asks again, specifically for that.
