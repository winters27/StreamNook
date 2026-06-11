# Drops and Points Farmer

A StreamNook plugin that farms Twitch channel points (and, in a later version, mines drops) in the background, across your followed live channels. It runs as a separate program that StreamNook starts and talks to. It lives outside the core app as an opt-in add-on, so the core stays lean and you run it only if you want it.

It does its own networking and uses your Twitch login, handed over by StreamNook's credential broker after you allow it, so it can watch and claim on your account.

## What it does

Enabling the plugin starts nothing on its own. It makes drops mining and optional background points farming available, and you choose what runs:

- Drops mining: click a drop in the Drops center and it mines that drop headlessly, no watching required. Stop or switch by clicking another. (Mine All auto-mines through your campaigns by the priority you set.)
- Background channel points farming is opt-in (off by default): turn it on in the plugin settings to farm points on your other followed channels. The channel you are actively watching always earns on its own.

It does all of its own networking and uses a Twitch login token that StreamNook's credential broker hands over only after you explicitly consent. The watch report uses the `sendSpadeEvents` GraphQL mutation.

## Settings

Settings are a rich host-rendered panel, declared from generic field types (a Twitch channel picker, add-and-remove game lists, sliders, selects, toggles), so StreamNook renders the screen without importing or naming anything specific to this plugin. The panel appears under the plugin on the Plugins page. The Drops center's mine, stop, and Mine All controls drive the plugin through the `drops.mine` / `drops.mine-auto` / `drops.stop` hooks, and the plugin reports live progress back through the `drops.status` slot.

## Building

```
cargo build --release
```

The host runs `target/release/drops-farmer.exe`, as declared in `plugin.toml`.

## Developing against StreamNook

In StreamNook open Settings, Plugins, Develop, and register this folder. Enabling it shows the capability consent once; the first time it needs your login token it asks again, specifically for that.
