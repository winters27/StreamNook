# Signing and Index Format v1

Two key roles exist: index operators sign index documents, plugin authors sign artifacts. The host verifies both before any plugin code runs. All keys are ed25519 in the minisign format, so authors can use the stock minisign tooling.

## Artifact

A plugin artifact is a zip file:

```
community.example-1.2.0.zip
├── plugin.toml          (manifest, at the root)
├── example.exe          (runtime.entry)
└── assets/              (anything else the plugin needs)
```

Alongside it, a detached minisign signature over the zip bytes:

```
community.example-1.2.0.zip.minisig
```

The signature is the author's. The manifest inside the artifact carries no signature material; pinning happens through the index plus trust-on-first-use, which avoids a self-referential artifact and keeps a single verification path.

## Index document

An index is a JSON document plus a detached minisign signature by the index operator:

```
index.json
index.json.minisig
```

```json
{
  "format": 1,
  "name": "Example Community Index",
  "operator": "examplecollective",
  "operator_pubkey": "RW...base64...",
  "generated_at": "2026-06-10T00:00:00Z",
  "previous_operator_pubkeys": [],
  "plugins": [
    {
      "id": "community.example",
      "name": "Example Plugin",
      "version": "1.2.0",
      "tier": "B",
      "description": "Short plain-language description.",
      "homepage": "https://example.org",
      "host_min": "8.0.0",
      "released_at": "2026-06-01T00:00:00Z",
      "author": {
        "name": "communityhandle",
        "pubkey": "RW...base64...",
        "previous_pubkeys": []
      },
      "artifact": {
        "url": "https://example.org/dl/community.example-1.2.0.zip",
        "sha256": "<hex>",
        "size": 1234567,
        "signature_url": "https://example.org/dl/community.example-1.2.0.zip.minisig"
      }
    }
  ]
}
```

Rules:

- `format` is the index schema version, currently 1. Hosts ignore unknown fields.
- Artifacts are hosted by their authors or the index operator, never by StreamNook's own distribution infrastructure.
- Any index may list any tier. Curation (what the operator approved into the index), not the tier, decides what appears.
- `tier` in the index is set by the index curator. The host rejects an artifact whose manifest tier disagrees with the index entry.

### Per-platform artifacts

An entry may ship a build per platform under `platforms`, keyed by `<os>-<arch>` (`windows-x86_64`, `macos-x86_64`, `macos-aarch64`, `linux-x86_64`, `linux-aarch64`); each value has the same shape as `artifact`:

```json
"platforms": {
  "windows-x86_64": { "url": "...", "sha256": "<hex>", "size": 123, "signature_url": "...zip.minisig" },
  "macos-aarch64":  { "url": "...", "sha256": "<hex>", "size": 123, "signature_url": "...zip.minisig" }
}
```

The host installs the build matching the user's platform: a `platforms` entry for the current `<os>-<arch>`, else the bare top-level `artifact` (which counts only as `windows-x86_64`). A plugin with no build for the running platform shows as unavailable rather than installing the wrong binary. Each platform's zip carries its own `plugin.toml` (the `runtime.entry` filename differs per platform); `id`, `version`, and `tier` must be identical across them and match the index entry. Each platform's zip is signed by the author the same way.

### Marketplace metadata (optional, additive)

A plugin entry may carry presentation fields the marketplace detail page uses. None of them participate in verification, all are optional, and hosts that predate a field ignore it:

| Field | Meaning |
|---|---|
| `icon_url` | Square icon shown on the entry and detail page (https) |
| `banner_url` | Wide banner image across the top of the detail page (https) |
| `readme_url` | Raw markdown rendered as the detail page body; a GitHub raw README URL is the expected shape. Rendered as plain markdown, never as HTML |
| `downloads` | Install count as the curator tracks it |
| `created_at`, `updated_at` | RFC 3339 timestamps shown in the detail footer |
| `author.verified` | Curator-asserted identity check, shown as a verified mark next to the author name. Worth exactly as much as the source operator's curation |

## Verification at install

In order, failing closed at the first mismatch:

1. Fetch `index.json` and `index.json.minisig`; verify the signature against the source's pinned operator key.
2. Fetch the artifact; verify its SHA-256 against `artifact.sha256`.
3. Fetch the detached signature; verify it against `author.pubkey`.
4. Enforce author key pinning (below).
5. Unpack to a temporary directory; validate the manifest per MANIFEST.md, including exact agreement of `id`, `version`, and `tier` with the index entry.
6. Show the consent dialog for the plugin's tier (CAPABILITIES.md).
7. Move into the plugins directory and register.

No plugin code executes before step 7 completes.

## Key pinning and trust-on-first-use

Operator keys:

- The official index's operator public key ships pinned inside the host binary.
- A community source's operator key is pinned when the user adds the source; the add-source dialog displays the key fingerprint (CAPABILITIES.md).
- An index whose signature stops matching the pinned key fails verification loudly. The user can re-pin only through an explicit, warning-labeled flow.

Author keys:

- The first install of any plugin by an author pins that author's public key locally, and the install dialog shows the fingerprint.
- Later installs and updates from the same author must verify against the pinned key.
- A key change is accepted automatically only with a rotation proof: the index entry lists the old key in `previous_pubkeys` and the artifact carries an additional detached signature by the old key (`<artifact>.minisig.prev`, fetched from `signature_url` with the `.prev` suffix). With proof, the host re-pins silently. Without proof, the update is blocked and the host shows a prominent warning naming both fingerprints; the user may re-pin manually through that warning flow.

Operator key rotation works the same way: `previous_operator_pubkeys` plus a second detached index signature by the old key (`index.json.minisig.prev`).

## Curation and removal

- Index operators are expected to verify author identity and declared tier before listing, and to delist plugins observed exceeding their declared capabilities (for example, networking despite `network = "none"`).
- The host refreshes indexes on a schedule and on demand. A delisted plugin stays installed locally (the user chose it) but is flagged in the plugins page with the delisting reason if the index provides one, and updates stop.
- Sigstore-style keyless signing in public CI is a possible later upgrade and intentionally out of scope for v1.
