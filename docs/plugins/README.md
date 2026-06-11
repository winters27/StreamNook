# StreamNook Plugin System

StreamNook supports opt-in plugins that run as separate programs and talk to the app over a small JSON-RPC interface. The core binary ships with zero plugins, contains none of their behavior, and provides them nothing beyond the narrow surface documented here.

## Why out-of-process

Plugins are separate executables with their own networking, not libraries loaded into the app:

- An OS process boundary is the strongest practical isolation. A crashing or misbehaving plugin cannot corrupt the app.
- The plugin's network traffic originates from the plugin's process, not the app's. The core never contains the endpoints, queries, or loops a plugin uses.
- Plugins can be written in any language that can read stdin and write stdout.

The deliberate omission that makes this work: the host exposes no generic HTTP method. A plugin that needs the network brings its own network stack. The host hands a plugin only events, a handful of read or display methods, and (with explicit per-use consent) a credential. That credential handoff is the single sensitive boundary crossing, and it is gated, logged, and revocable.

## Specification documents

| Document | Contents |
|---|---|
| [PROTOCOL.md](PROTOCOL.md) | Wire format, lifecycle, the full event and host-method list, error codes, versioning rules |
| [MANIFEST.md](MANIFEST.md) | The `plugin.toml` schema every plugin ships, and the risk-tier definitions |
| [CAPABILITIES.md](CAPABILITIES.md) | The capability vocabulary, what each grants, and the exact consent language shown to users |
| [SIGNING.md](SIGNING.md) | Artifact signing, the index document format, key pinning, and key rotation |
| [OFFICIAL.md](OFFICIAL.md) | What an official StreamNook plugin is, branding conventions, and what can never be official |

## Status

Protocol version 1. The surface described in these documents is frozen: breaking changes require a protocol version bump, additive changes (new events, new optional fields, new capability strings) do not. Both sides must ignore unknown fields.

## Vocabulary

- Host: the StreamNook app, which spawns and supervises plugins.
- Plugin: a separate executable described by a manifest, spawned by the host.
- Capability: a named permission a plugin declares in its manifest and a user grants at install. Anything not granted is denied by default.
- Credential broker: the host component that hands credentials to plugins, with first-use consent and an audit log.
- Index: a signed JSON document listing installable plugins. The official index lists safe tiers only; riskier plugins reach users only through community indexes the user adds explicitly.
