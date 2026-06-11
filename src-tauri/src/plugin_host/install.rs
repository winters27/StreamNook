//! Index fetching and plugin installation with full verification.
//! Order and rules are frozen in docs/plugins/SIGNING.md and MANIFEST.md.

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;

use super::manifest::{PluginManifest, Tier};
use super::registry::{self, GrantedCaps, InstalledPlugin, SourceEntry};
use super::signing;

/// The built-in StreamNook plugin index: the curated marketplace the app reads
/// out of the box. `(index url, operator public key)`. The app pins this
/// operator key from here (not trust-on-first-use) and seeds the source on
/// startup, so the catalog of approved plugins shows with no manual add. Every
/// listing is curated and operator-signed; per-plugin `official` marks the
/// first-party ones.
pub const OFFICIAL_INDEX: Option<(&str, &str)> = Some((
    "https://raw.githubusercontent.com/StreamNook/streamnook-plugins/main/index.json",
    "RWQjpDWje0/OzmnUXUjak7pAGJnNdqpz30FLjHzeTX8cP+rS8i5HCyvy",
));

/// Caps to keep a hostile index or artifact from filling the disk.
const MAX_INDEX_BYTES: usize = 5 * 1024 * 1024;
const MAX_ARTIFACT_BYTES: usize = 100 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
pub struct IndexDoc {
    pub format: u32,
    pub name: String,
    pub operator: String,
    pub operator_pubkey: String,
    #[serde(default)]
    pub previous_operator_pubkeys: Vec<String>,
    #[serde(default)]
    pub generated_at: Option<String>,
    #[serde(default)]
    pub plugins: Vec<IndexEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IndexEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub tier: String,
    pub description: String,
    #[serde(default)]
    pub homepage: Option<String>,
    pub host_min: String,
    #[serde(default)]
    pub released_at: Option<String>,
    pub author: IndexAuthor,
    pub artifact: IndexArtifact,
    // Marketplace metadata, all optional (additive index fields; see
    // SIGNING.md). Presentation only: none of it affects verification.
    #[serde(default)]
    pub icon_url: Option<String>,
    #[serde(default)]
    pub banner_url: Option<String>,
    /// Raw markdown the detail page renders (a GitHub raw README URL works).
    #[serde(default)]
    pub readme_url: Option<String>,
    #[serde(default)]
    pub downloads: Option<u64>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    /// First-party: built by StreamNook itself. Drives the "official" badge.
    /// Approved third-party plugins (curated into the index but authored by
    /// someone else) leave this false; being in the index is their approval.
    #[serde(default)]
    pub official: bool,
    /// Per-platform builds keyed by "<os>-<arch>" (windows-x86_64,
    /// macos-aarch64, macos-x86_64, linux-x86_64, ...). The bare `artifact`
    /// above is the windows-x86_64 build; other platforms go here. The app
    /// installs whichever matches the user's platform.
    #[serde(default)]
    pub platforms: HashMap<String, IndexArtifact>,
}

impl IndexEntry {
    /// The artifact to install on the running platform, or None when the plugin
    /// ships no build for it. Prefers a matching `platforms` entry; the bare
    /// `artifact` counts only as the windows-x86_64 build.
    pub fn artifact_for_platform(&self) -> Option<&IndexArtifact> {
        let target = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
        self.platforms
            .get(&target)
            .or_else(|| (target == "windows-x86_64").then_some(&self.artifact))
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IndexAuthor {
    pub name: String,
    pub pubkey: String,
    #[serde(default)]
    pub previous_pubkeys: Vec<String>,
    /// Curator-asserted identity check, shown as a verified mark next to the
    /// author. Meaningful exactly as far as the source operator is trusted.
    #[serde(default)]
    pub verified: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IndexArtifact {
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub size: Option<u64>,
    pub signature_url: String,
}

async fn http_get_bytes(url: &str, cap: usize) -> Result<Vec<u8>> {
    let response = crate::services::http::client()
        .get(url)
        .send()
        .await
        .map_err(|e| anyhow!("fetch failed for {url}: {e}"))?;
    if !response.status().is_success() {
        bail!("fetch failed for {url}: HTTP {}", response.status());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| anyhow!("read failed for {url}: {e}"))?;
    if bytes.len() > cap {
        bail!("{url} exceeds the {cap} byte limit");
    }
    Ok(bytes.to_vec())
}

async fn http_get_text(url: &str, cap: usize) -> Result<String> {
    let bytes = http_get_bytes(url, cap).await?;
    String::from_utf8(bytes).map_err(|_| anyhow!("{url} is not valid UTF-8"))
}

/// Fetches marketplace README markdown for the detail page (1 MiB cap,
/// https only). Presentation only; rendered client side as plain markdown.
pub async fn fetch_readme(url: &str) -> Result<String> {
    if !url.starts_with("https://") {
        bail!("readme_url must be an https URL");
    }
    http_get_text(url, 1024 * 1024).await
}

/// Fetches and verifies an index document. With `pinned_operator_key` set,
/// the signature must verify against that key, accepting a key rotation only
/// with proof (previous key listed, second signature by it). Returns the doc
/// and the operator key now in effect (so the caller can re-pin).
pub async fn fetch_index(
    url: &str,
    pinned_operator_key: Option<&str>,
) -> Result<(IndexDoc, String)> {
    let body = http_get_bytes(url, MAX_INDEX_BYTES).await?;
    let signature = http_get_text(&format!("{url}.minisig"), 64 * 1024).await?;
    let doc: IndexDoc =
        serde_json::from_slice(&body).map_err(|e| anyhow!("index parse error: {e}"))?;
    if doc.format != 1 {
        bail!("unsupported index format {}", doc.format);
    }

    match pinned_operator_key {
        None => {
            // First contact: trust-on-first-use against the self-declared key.
            signing::verify_minisign(&body, &signature, &doc.operator_pubkey)?;
            Ok((doc.clone(), doc.operator_pubkey.clone()))
        }
        Some(pinned) if doc.operator_pubkey == pinned => {
            signing::verify_minisign(&body, &signature, pinned)?;
            Ok((doc.clone(), pinned.to_string()))
        }
        Some(pinned) => {
            // Key changed: accept only with a rotation proof.
            if !doc.previous_operator_pubkeys.iter().any(|k| k == pinned) {
                bail!(
                    "the source's signing key changed without a rotation proof. \
                     Remove and re-add the source only if you trust the new key \
                     (fingerprint {})",
                    signing::key_fingerprint(&doc.operator_pubkey)
                );
            }
            let prev_sig = http_get_text(&format!("{url}.minisig.prev"), 64 * 1024)
                .await
                .map_err(|_| {
                    anyhow!(
                        "the source rotated its signing key but provides no \
                         second signature by the old key"
                    )
                })?;
            signing::verify_minisign(&body, &prev_sig, pinned)?;
            signing::verify_minisign(&body, &signature, &doc.operator_pubkey)?;
            Ok((doc.clone(), doc.operator_pubkey.clone()))
        }
    }
}

/// Adds a source after a successful first fetch. Returns the entry plus the
/// operator key fingerprint for the consent dialog.
pub async fn probe_source(url: &str) -> Result<(SourceEntry, String)> {
    let (doc, operator_key) = fetch_index(url, None).await?;
    let entry = SourceEntry {
        url: url.to_string(),
        name: doc.name.clone(),
        operator: doc.operator.clone(),
        operator_pubkey: operator_key.clone(),
        official: false,
    };
    Ok((entry, signing::key_fingerprint(&operator_key)))
}

pub struct PreparedInstall {
    pub record: InstalledPlugin,
    /// Author key to pin (author handle, key) once the install is accepted.
    pub pin_author_key: (String, String),
    /// New operator key if the index rotated (caller updates the source).
    pub repin_operator_key: Option<String>,
    /// Where the verified artifact is unpacked while consent is pending.
    /// Commit moves it over the live pkg dir; cancel just deletes it, so an
    /// aborted update never disturbs the installed version.
    pub staging: PathBuf,
}

/// Downloads, verifies, and unpacks one plugin from a source. Does NOT touch
/// the registry; the caller consents the user first, then registers the
/// returned record. No plugin code runs in here.
pub async fn prepare_install(
    source: &SourceEntry,
    plugin_id: &str,
    pinned_author_key: Option<&str>,
) -> Result<PreparedInstall> {
    let (doc, operator_key) = fetch_index(&source.url, Some(&source.operator_pubkey)).await?;
    let repin_operator_key =
        (operator_key != source.operator_pubkey).then_some(operator_key.clone());

    let entry = doc
        .plugins
        .iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| anyhow!("plugin '{plugin_id}' is not listed by this source"))?;

    // Validate the declared tier is a known value. All tiers may be listed in
    // any index; curation (what the operator approved into the index), not the
    // tier, decides what appears. The manifest tier must still match below.
    Tier::parse(&entry.tier)?;

    // Pick the build for this platform, then download and verify it.
    let meta = entry
        .artifact_for_platform()
        .ok_or_else(|| anyhow!("'{plugin_id}' has no build for this platform"))?;
    let artifact = http_get_bytes(&meta.url, MAX_ARTIFACT_BYTES).await?;
    signing::check_sha256(&artifact, &meta.sha256)?;
    let signature = http_get_text(&meta.signature_url, 64 * 1024).await?;

    // Author key pinning (trust-on-first-use, rotation with proof).
    let author_key = match pinned_author_key {
        None => entry.author.pubkey.clone(),
        Some(pinned) if pinned == entry.author.pubkey => pinned.to_string(),
        Some(pinned) => {
            if !entry.author.previous_pubkeys.iter().any(|k| k == pinned) {
                bail!(
                    "the author's signing key changed without a rotation proof \
                     (new fingerprint {}). Install blocked",
                    signing::key_fingerprint(&entry.author.pubkey)
                );
            }
            let prev_sig =
                http_get_text(&format!("{}.prev", meta.signature_url), 64 * 1024)
                    .await
                    .map_err(|_| {
                        anyhow!(
                            "the author rotated their signing key but provides no \
                             second signature by the old key"
                        )
                    })?;
            signing::verify_minisign(&artifact, &prev_sig, pinned)?;
            entry.author.pubkey.clone()
        }
    };
    signing::verify_minisign(&artifact, &signature, &author_key)?;

    // Unpack into staging and validate the manifest against the index entry.
    // The live pkg dir is untouched until the consented commit.
    let staging = staging_dir(plugin_id)?;
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }
    std::fs::create_dir_all(&staging)?;
    zip::ZipArchive::new(Cursor::new(&artifact))
        .map_err(|e| anyhow!("artifact is not a valid zip: {e}"))?
        .extract(&staging)
        .map_err(|e| anyhow!("artifact unpack failed: {e}"))?;

    let manifest_text = std::fs::read_to_string(staging.join("plugin.toml"))
        .map_err(|_| anyhow!("artifact has no plugin.toml at its root"))?;
    let manifest = PluginManifest::parse(&manifest_text)?;
    if manifest.id != entry.id || manifest.version != entry.version || manifest.tier != entry.tier
    {
        std::fs::remove_dir_all(&staging).ok();
        bail!("the artifact's manifest does not match the index entry (id, version, or tier)");
    }
    manifest.check_host_min(env!("CARGO_PKG_VERSION"))?;
    if !staging.join(&manifest.runtime.entry).exists() {
        std::fs::remove_dir_all(&staging).ok();
        bail!("the artifact does not contain its declared entry '{}'", manifest.runtime.entry);
    }
    if let Some(ui_entry) = &manifest.runtime.ui_entry {
        if !staging.join(ui_entry).exists() {
            std::fs::remove_dir_all(&staging).ok();
            bail!("the artifact does not contain its declared ui_entry '{ui_entry}'");
        }
    }

    let record = record_from_manifest(&manifest, &source.url, &live_pkg_dir(plugin_id)?);
    Ok(PreparedInstall {
        record,
        pin_author_key: (entry.author.name.clone(), author_key),
        repin_operator_key,
        staging,
    })
}

/// Registers a plugin straight from a local folder containing plugin.toml.
/// Development affordance: no signature chain exists, so the source is marked
/// "local-dev" and the UI labels it accordingly. Consent still applies.
pub fn prepare_local_install(dir: &str) -> Result<InstalledPlugin> {
    let dir_path = std::fs::canonicalize(dir).map_err(|e| anyhow!("folder not found: {e}"))?;
    let manifest_text = std::fs::read_to_string(dir_path.join("plugin.toml"))
        .map_err(|_| anyhow!("no plugin.toml in {dir}"))?;
    let manifest = PluginManifest::parse(&manifest_text)?;
    manifest.check_host_min(env!("CARGO_PKG_VERSION"))?;
    if !dir_path.join(&manifest.runtime.entry).exists() {
        bail!("the folder does not contain the declared entry '{}'", manifest.runtime.entry);
    }
    if let Some(ui_entry) = &manifest.runtime.ui_entry {
        if !dir_path.join(ui_entry).exists() {
            bail!("the folder does not contain the declared ui_entry '{ui_entry}'");
        }
    }
    Ok(record_from_manifest(&manifest, "local-dev", &dir_path))
}

fn record_from_manifest(
    manifest: &PluginManifest,
    source: &str,
    dir: &PathBuf,
) -> InstalledPlugin {
    // Enabling the plugin is the grant: the install (or first-enable) consent
    // already discloses the credential, so allow handover without re-prompting
    // every session. The user can still revoke it per plugin from its details.
    let credential_consent = manifest
        .capabilities
        .credentials
        .iter()
        .map(|k| (k.clone(), "always".to_string()))
        .collect();
    InstalledPlugin {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        author: manifest.author.clone(),
        tier: manifest.tier.clone(),
        description: manifest.description.clone(),
        homepage: manifest.homepage.clone(),
        enabled: false,
        source: source.to_string(),
        kind: manifest.runtime.kind.clone(),
        dir: dir.to_string_lossy().to_string(),
        entry: manifest.runtime.entry.clone(),
        ui_entry: manifest.runtime.ui_entry.clone(),
        args: manifest.runtime.args.clone(),
        granted: GrantedCaps {
            events: manifest.capabilities.events.clone(),
            host_methods: manifest.capabilities.host_methods.clone(),
            credentials: manifest.capabilities.credentials.clone(),
            network: manifest.capabilities.network.clone(),
            ui: manifest.capabilities.ui.clone(),
            actions: manifest.contributes.actions.clone(),
            status: manifest.contributes.status.clone(),
            provides: manifest.contributes.provides.clone(),
        },
        credential_consent,
    }
}

fn staging_dir(plugin_id: &str) -> Result<PathBuf> {
    Ok(registry::plugin_state_dir(plugin_id)?.join("pkg-staging"))
}

pub fn live_pkg_dir(plugin_id: &str) -> Result<PathBuf> {
    Ok(registry::plugin_state_dir(plugin_id)?.join("pkg"))
}

/// Moves a consented staging unpack over the live pkg directory.
pub fn promote_staging(staging: &PathBuf, plugin_id: &str) -> Result<()> {
    let live = live_pkg_dir(plugin_id)?;
    if live.exists() {
        std::fs::remove_dir_all(&live)?;
    }
    std::fs::rename(staging, &live)
        .map_err(|e| anyhow!("failed to move the verified artifact into place: {e}"))?;
    Ok(())
}
