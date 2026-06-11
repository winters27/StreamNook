# Plugin Manifest v1

Every plugin ships a `plugin.toml` at the root of its artifact. The manifest is the complete, machine-readable statement of what the plugin is and what it may ask the host for. Anything not declared here is denied at runtime.

## Example

```toml
id          = "community.drops-farmer"
name        = "Drops and Points Farmer"
version     = "1.2.0"
author      = "communityhandle"
tier        = "C"
description = "Background drops and channel-points farming."
homepage    = "https://example.org/drops-farmer"
host_min    = "8.0.0"

[runtime]
kind      = "process"
entry     = "drops-farmer.exe"
args      = []
transport = "stdio"

[capabilities]
events       = ["on_watch_tick", "on_followed_live", "on_channel_change"]
host_methods = ["get_followed_live", "notify", "log", "register_panel", "get_panel_values"]
credentials  = ["twitch.android"]
network      = "external"
ui           = ["panel"]
```

## Top-level fields

| Field | Type | Constraints |
|---|---|---|
| `id` | string | Reverse-DNS, globally unique, must match `^[a-z0-9]+(\.[a-z0-9-]+)+$`, max 64 chars. Never changes across versions |
| `name` | string | Display name, max 40 chars |
| `version` | string | Semver (`MAJOR.MINOR.PATCH`) |
| `author` | string | Author handle as listed in the index |
| `tier` | string | `"A"`, `"B"`, or `"C"`. See tier definitions below. Declared by the author, verified by the index curator; a plugin may not self-certify into a lower tier |
| `description` | string | Plain-language summary, max 200 chars, shown in the install dialog |
| `homepage` | string | Optional, `https` URL |
| `host_min` | string | Minimum StreamNook version (semver). Install is blocked on older hosts |

## `[runtime]`

| Field | Type | Constraints |
|---|---|---|
| `kind` | string | `"process"` (a separate executable) or `"ui"` (an in-app interface module, see UI_PLUGINS.md). `"wasm"` is reserved and rejected |
| `entry` | string | Path of the executable (`process`) or bundled JavaScript module (`ui`), relative to the plugin directory. Must not contain `..` or be absolute |
| `args` | string array | `process` only: arguments passed at spawn. Optional, default empty |
| `transport` | string | `process` only: `"stdio"` in v1. `"socket"` is reserved and rejected by the v1 host |

For `kind = "ui"` the `[capabilities]` and `[contributes]` blocks stay empty; the module contract in UI_PLUGINS.md is the complete surface. The `ui` kind was added after protocol v1 froze; it is additive (a `ui` plugin's `host_min` must be a version that knows the kind, and older hosts fail closed on the unknown value).

## `[capabilities]`

The whole permission contract. The consent dialog renders exactly this block in plain language (see CAPABILITIES.md for the vocabulary and the rendered strings).

| Field | Type | Meaning |
|---|---|---|
| `events` | string array | Events the plugin may subscribe to. Subset of the event list in PROTOCOL.md |
| `host_methods` | string array | Host methods the plugin may call. Note `get_credential` is governed by `credentials`, not by this list |
| `credentials` | string array | Credential kinds the broker may hand over, each requiring separate first-use consent. v1 vocabulary: `"twitch.android"` |
| `network` | string | `"none"` or `"external"`. Informational and surfaced in consent: the host cannot prevent a separate process from using the network, so this field exists to make the plugin's behavior explicit to the user. A plugin observed doing networking it declared it does not do is grounds for index removal |
| `ui` | string array | UI contributions. v1 vocabulary: `"panel"` |

Unknown capability strings cause install rejection in v1 hosts (fail closed), with one exception: index metadata may carry forward-looking strings for newer hosts, and the install dialog of an older host shows them as "requires a newer StreamNook".

## `[contributes]`

Optional. The named hooks the plugin fills so the native UI can delegate to it. See HOOKS.md for the full mechanism.

```toml
[contributes]
actions  = ["drops.mine", "drops.stop"]   # actions the plugin handles when the UI invokes them
status   = ["drops.status"]               # status slots the plugin pushes into for the UI to show
provides = ["drops.mining"]               # feature flags the host uses to light up matching controls
```

Each entry is a namespaced id (`feature.name`), defined by the host feature that exposes the hook. Non-namespaced ids are rejected at install.

## Signing fields

The manifest itself carries no signature block. Signatures are detached and live alongside the artifact; the author's public key is pinned through the index and the first-install flow. This avoids a self-referential artifact (the manifest travels inside the signed artifact) and keeps one verification path. See SIGNING.md.

## Tiers

A neutral capability-scope label and curation metadata. It is not a risk rating.

| Tier | Label | Scope | Examples | Distribution |
|---|---|---|---|---|
| A | Standard | Official APIs, local-only features, read-only integrations, ordinary user actions | Theme packs, layout tools, local stats | Official index |
| B | Extended | Additional Twitch and third-party interfaces; user-initiated actions with no official equivalent | Alternate emote providers, community badge sources | Official index |
| C | Advanced | Power-user add-ons that run their own background work and may use the user's login | Drops or points farming, ad bypass | Community sources |

The tier is curation metadata: it determines where a plugin may be listed (SIGNING.md). Its user-facing presentation is a neutral badge; the consent flow (CAPABILITIES.md) is the same calm, capability-focused dialog for every tier. The official index lists the curated A and B tiers; heavier or specialized add-ons live in community sources.

## Validation order at install

1. Artifact hash matches the index entry.
2. Detached signature verifies against the author key (pinned via the index and trust-on-first-use).
3. Manifest parses, all constraints above hold.
4. Manifest `id`, `version`, and `tier` exactly match the index entry. Any mismatch blocks install.
5. `host_min` is satisfied and `runtime.kind` plus `runtime.transport` are supported.
6. The consent dialog is shown; the user grants capabilities (possibly a subset).
7. The plugin is unpacked into its own directory and registered.

A failure at any step blocks install with a specific reason. There is no partial install.
