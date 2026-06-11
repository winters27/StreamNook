# Chat Logger

A StreamNook plugin that saves chat to plain text log files as you watch. It runs as a separate program that StreamNook starts and talks to; it makes no network connections of its own.

## What it does

Every chat message in a channel you have open is appended to a log file, including messages you send. Files are organized as one folder per channel with one file per day:

```
<log folder>\somechannel\2026-06-11.log
```

Lines look like this:

```
[14:03:21] SomeChatter: hello
[14:03:24] * SomeChatter waves
[14:03:30] OtherPerson subscribed at Tier 1. They've subscribed for 11 months!
```

Subscriptions, raids, and announcements are logged as readable notice lines, and can be turned off if you only want regular messages.

## Settings

- **Log folder**: where files are written. Defaults to the plugin's data folder; pick any folder you like.
- **Only log these channels**: a channel picker that limits logging to the channels you choose. Leave it empty to log everything you open.
- **Timestamps** and **event notices** can each be toggled.

## Building

```
cargo build --release
```

The host runs `target/release/chat-logger.exe`, as declared in `plugin.toml`.

## Developing against StreamNook

In StreamNook open Settings, Plugins, Develop, and register this folder. Logging starts as soon as the plugin is enabled and a chat is open.
