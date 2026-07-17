import { X, ExternalLink, ChevronDown, Github, Heart } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ReleaseNotes } from '../types';
import { parseInlineMarkdown } from '../services/markdownService';
import { motion } from 'framer-motion';
import { Logger } from '../utils/logger';
import {
  fetchReleases,
  loadReleasesCache,
  saveReleasesCache,
  type GitHubRelease,
} from '../services/releasesService';

// Compare versions ignoring a leading "v" (tags and props mix both forms).
const normalizeTag = (t: string) => t.replace(/^v/i, '').trim();

const formatShortDate = (iso: string): string => {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '';
  }
};

interface ChangelogOverlayProps {
  version: string;
  onClose: () => void;
}

const CHANGELOG_URL = 'https://github.com/winters27/StreamNook/blob/main/CHANGELOG.md';
const GITHUB_ISSUE_URL = 'https://github.com/winters27/StreamNook/issues/new';
const COMMUNITY_DISCORD_INVITE = 'https://discord.gg/2xvuF9TES7';

// Softer-than-secondary blue tone for body copy so descriptions read clearly
// without feeling muted, while keeping the StreamNook accent tint.
const BODY_TEXT = 'color-mix(in srgb, var(--color-text-secondary) 70%, #ffffff)';

// Opens an external URL in the OS browser via Tauri's shell plugin (not the
// in-app WebView). Falls back to window.open if the plugin import fails.
const openExternal = async (url: string) => {
  try {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } catch (err) {
    Logger.error('Failed to open external URL:', err);
    window.open(url, '_blank');
  }
};

// Drop the appended download/installation boilerplate (the "grab the 7z…"
// section release_manager.ps1 tacks on). We only want the change notes.
const stripBoilerplate = (content: string): string => {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => {
    const t = l.trim();
    return (
      /^#{1,4}\s*(installation|install|bundle components|downloads?|how to (install|update))\b/i.test(t) ||
      /^installation$/i.test(t)
    );
  });
  return idx >= 0 ? lines.slice(0, idx).join('\n') : content;
};

// Official Discord brand mark, sized to match the lucide icons around it.
const DiscordIcon = ({ size = 14 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
  </svg>
);

// Sign-off + community links, themed to the accent. Sits at the foot of the
// change notes.
const ConnectFooter = () => (
  <div>
    <p className="text-[13px] text-textSecondary text-center leading-snug">
      Run into a bug or have an idea? Reach out and let us know.
    </p>
    <div className="flex justify-center gap-2 mt-2">
      <button
        type="button"
        onClick={() => openExternal(GITHUB_ISSUE_URL)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] text-textSecondary hover:text-textPrimary hover:bg-accent/10 active:bg-accent/15 transition-colors"
      >
        <Github size={14} />
        GitHub
      </button>
      <button
        type="button"
        onClick={() => openExternal(COMMUNITY_DISCORD_INVITE)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] text-textSecondary hover:text-textPrimary hover:bg-accent/10 active:bg-accent/15 transition-colors"
      >
        <DiscordIcon size={14} />
        Discord
      </button>
    </div>
    <p className="flex items-center justify-center gap-1 mt-2.5 text-[11px] text-textMuted italic text-center leading-snug">
      May your points always claim, your streams never buffer, and your drops always finish.
      <Heart size={11} className="inline-block text-accent shrink-0" fill="currentColor" />
    </p>
  </div>
);

// A changelog body is rendered in DOCUMENT ORDER as a list of typed blocks, so
// a description or image always shows where it was written (an earlier version
// bucketed loose paragraphs into a "notes" group that rendered at the very
// bottom, which is why a lead blurb could jump to the end).
type Block =
  | { t: 'hero'; title: string; desc: string }   // ## 🎉 New: <headline> + > <blurb>
  | { t: 'image'; url: string; alt: string }      // ![alt](url)
  | { t: 'header'; label: string }                // ### <section>
  | { t: 'item'; title: string; desc: string }    // - **Title**: description
  | { t: 'note'; desc: string };                  // a plain paragraph

// Turn a release-notes markdown body into ordered blocks. release_manager.ps1
// emits an optional "## 🎉 New: <headline>" + "> <blurb>" lead, then
// "### <section>" blocks of "- **Title**: description" bullets; images and loose
// paragraphs are also supported and render in place.
const parseChangelog = (content: string): Block[] => {
  const blocks: Block[] = [];
  let hero: { title: string; desc: string[] } | null = null;

  const flushHero = () => {
    if (hero) {
      blocks.push({ t: 'hero', title: hero.title, desc: hero.desc.join(' ').trim() });
      hero = null;
    }
  };

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    // Version/date line — the header/bar already show the version, so drop it.
    if (/^#{0,3}\s*\[.*?\]\s*-\s*\d{4}-\d{2}-\d{2}/.test(line)) {
      flushHero();
      continue;
    }
    // Image — ![alt](url). Rendered as a preview where it appears.
    const img = line.match(/^!\[(.*?)\]\((.+?)\)\s*$/);
    if (img) {
      flushHero();
      blocks.push({ t: 'image', alt: img[1], url: img[2] });
      continue;
    }
    // Section heading (### ✨ Features) — a styled header in place.
    if (/^###\s+/.test(line)) {
      flushHero();
      const label = line.replace(/^###\s+/, '').replace(/^[^A-Za-z0-9]+/, '').trim();
      blocks.push({ t: 'header', label });
      continue;
    }
    // Headline (## 🎉 New: ...) becomes the lead hero; strip the emoji + "New:".
    if (/^##\s+/.test(line)) {
      flushHero();
      const title = line
        .replace(/^##\s+/, '')
        .replace(/^[^A-Za-z0-9]*\bNew:\s*/i, '')
        .replace(/^[^A-Za-z0-9]+/, '')
        .trim();
      hero = { title, desc: [] };
      continue;
    }
    // Blockquote — the hero's description, or a standalone note in place.
    if (line.startsWith('>')) {
      const t = line.replace(/^>\s?/, '');
      if (hero) hero.desc.push(t);
      else blocks.push({ t: 'note', desc: t });
      continue;
    }
    // Horizontal rule — drop it.
    if (line === '---') {
      flushHero();
      continue;
    }
    // Bullet — "**Title**: description" splits into title + description.
    if (/^[-*]\s+/.test(line)) {
      flushHero();
      const text = line.replace(/^[-*]\s+/, '');
      const m = text.match(/^\*\*(.+?)\*\*\s*[:—-]?\s*(.*)$/);
      blocks.push({ t: 'item', title: m ? m[1] : text, desc: m ? m[2] : '' });
      continue;
    }
    // Anything else — a plain paragraph, in place.
    flushHero();
    blocks.push({ t: 'note', desc: line });
  }
  flushHero();
  return blocks;
};

// A single change: bold title, readable description. No icon, no bullet.
const ChangeItem = ({ title, desc, lead }: { title: string; desc: string; lead?: boolean }) => (
  <div>
    <div className={`${lead ? 'text-lg' : 'text-base'} font-semibold text-textPrimary`}>
      {parseInlineMarkdown(title)}
    </div>
    {desc && (
      <div className="text-[15px] mt-1 leading-relaxed" style={{ color: BODY_TEXT }}>
        {parseInlineMarkdown(desc)}
      </div>
    )}
  </div>
);

const ReleaseBody = ({ content }: { content: string }) => {
  const blocks = parseChangelog(stripBoilerplate(content));
  if (blocks.length === 0) return null;

  return (
    <div className="text-left">
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'hero':
            return (
              <div key={i} className="first:mt-0 mt-6">
                <ChangeItem title={b.title} desc={b.desc} lead />
              </div>
            );
          case 'image':
            return (
              <div key={i} className="first:mt-0 mt-5 rounded-xl overflow-hidden border border-borderSubtle bg-black/20">
                <img src={b.url} alt={b.alt} className="block w-full h-auto" loading="lazy" />
              </div>
            );
          case 'header':
            return (
              <div key={i} className="first:mt-0 mt-8 mb-4">
                <div className="text-xs font-bold uppercase tracking-[0.14em] text-accent">
                  {b.label}
                </div>
                <div className="h-[2px] w-7 rounded-full bg-accent/60 mt-1.5" />
              </div>
            );
          case 'item':
            return (
              <div key={i} className="first:mt-0 mt-4">
                <ChangeItem title={b.title} desc={b.desc} />
              </div>
            );
          case 'note':
            return b.desc ? (
              <p key={i} className="first:mt-0 mt-4 text-[15px] leading-relaxed" style={{ color: BODY_TEXT }}>
                {parseInlineMarkdown(b.desc)}
              </p>
            ) : null;
        }
      })}
    </div>
  );
};

const ChangelogOverlay = ({ version, onClose }: ChangelogOverlayProps) => {
  // The release list carries every version's body, so switching is instant once
  // it's loaded. Seed from cache so a known list shows without waiting.
  const [releases, setReleases] = useState<GitHubRelease[] | null>(
    () => loadReleasesCache()?.releases ?? null,
  );
  const [selectedTag, setSelectedTag] = useState<string>(() => normalizeTag(version));
  // Single-version fallback when the GitHub list can't be reached at all.
  const [fallbackBody, setFallbackBody] = useState<string | null>(null);
  const [fallbackVersion, setFallbackVersion] = useState<string>(version);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  // Set once the user picks a version from the switcher, so the auto-default
  // below stops overriding their choice.
  const userPickedRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const result = await fetchReleases({ signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.ok && result.kind === 'fresh') {
        setReleases(result.releases);
        saveReleasesCache({ fetchedAt: Date.now(), etag: result.etag, releases: result.releases });
        setIsLoading(false);
      } else if (result.ok && result.kind === 'not-modified') {
        setIsLoading(false); // cached releases already in state
      } else if (releases && releases.length) {
        setIsLoading(false); // fetch failed but we have a cached list
      } else {
        // No list at all — fall back to the single-version notes from the backend
        // so the changelog still shows something (no switcher in this case).
        try {
          const notes = await invoke<ReleaseNotes>('get_release_notes', { version });
          if (!controller.signal.aborted) {
            setFallbackBody(notes.body);
            setFallbackVersion(notes.version || version);
          }
        } catch (err) {
          Logger.error('Failed to fetch release notes:', err);
          if (!controller.signal.aborted) setError('Failed to load release notes');
        }
        if (!controller.signal.aborted) setIsLoading(false);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  // Default the open changelog to what you just updated to (the `version` prop is
  // the installed version, i.e. the most recent release). If that exact tag isn't
  // in the fetched list, fall back to the newest release available. Re-evaluates
  // whenever the list changes — crucially when the fresh fetch replaces a stale
  // cache — so a stale cache can't pin the popup to an older release. Skips once
  // the user has manually picked a version from the switcher.
  useEffect(() => {
    if (userPickedRef.current || !releases || !releases.length) return;
    const wanted = normalizeTag(version);
    const hasWanted = releases.some((r) => normalizeTag(r.tag_name) === wanted);
    setSelectedTag(hasWanted ? wanted : normalizeTag(releases[0].tag_name));
  }, [releases, version]);

  // Close the version menu on an outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const currentRelease = releases?.find((r) => normalizeTag(r.tag_name) === selectedTag);
  const body = currentRelease?.body ?? fallbackBody;
  const displayVersion = currentRelease
    ? normalizeTag(currentRelease.tag_name)
    : normalizeTag(fallbackVersion);
  const hasSwitcher = !!releases && releases.length > 1;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/25"
    >
      {/* Background overlay - click to close */}
      <div className="absolute inset-0" onClick={onClose} />

      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 12 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
        className="glass-modal relative z-10 w-[640px] max-w-[94vw] h-[820px] max-h-[92vh] flex flex-col"
      >
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 p-1.5 text-textMuted hover:text-textPrimary rounded-lg transition-colors duration-200"
        >
          <X size={18} />
        </button>

        {/* Title */}
        <h2 className="text-[28px] font-bold text-textPrimary text-center pt-10 pb-7 px-10">
          What's New
        </h2>

        {/* Body */}
        <div className="flex-1 overflow-y-auto custom-scrollbar px-10">
          {isLoading && !body ? (
            <div className="flex items-center justify-center py-10">
              <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-accent" />
            </div>
          ) : error && !body ? (
            <div className="text-center py-10">
              <p className="text-sm text-textSecondary">{error}</p>
            </div>
          ) : body ? (
            <ReleaseBody content={body} />
          ) : (
            <div className="text-center py-10">
              <p className="text-sm text-textSecondary">No release notes available</p>
            </div>
          )}

          <div className="flex justify-center pt-7 pb-4">
            <button
              type="button"
              onClick={() => openExternal(CHANGELOG_URL)}
              className="inline-flex items-center gap-1.5 text-xs text-accent hover:text-accent/80 transition-colors"
            >
              <ExternalLink size={13} />
              View full changelog
            </button>
          </div>
        </div>

        {/* Bottom bar — the whole sign-off (prompt, links, blessing) pinned
            above the version switcher + Continue */}
        <div className="px-6 pt-5 pb-4 border-t border-borderSubtle">
          <ConnectFooter />
          <div className="flex items-center justify-between mt-5">
            {hasSwitcher ? (
            <div className="relative" ref={switcherRef}>
              <button
                onClick={() => setMenuOpen((o) => !o)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-textSecondary hover:text-textPrimary px-2.5 py-1.5 rounded-md bg-white/5 hover:bg-white/10 border border-white/5 transition-colors"
              >
                v{displayVersion}
                <ChevronDown
                  size={12}
                  className={`transition-transform duration-200 ${menuOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {menuOpen && (
                <div
                  className="absolute bottom-full left-0 mb-2 w-52 max-h-64 overflow-y-auto custom-scrollbar rounded-lg border border-borderSubtle shadow-xl py-1"
                  style={{
                    background: 'color-mix(in srgb, var(--color-background-tertiary) 98%, transparent)',
                  }}
                >
                  {releases!.map((r) => {
                    const tag = normalizeTag(r.tag_name);
                    const active = tag === selectedTag;
                    return (
                      <button
                        key={r.tag_name}
                        onClick={() => {
                          userPickedRef.current = true;
                          setSelectedTag(tag);
                          setMenuOpen(false);
                        }}
                        className={`w-full flex items-center justify-between gap-3 px-3 py-2 text-left transition-colors ${
                          active
                            ? 'bg-accent/15 text-textPrimary'
                            : 'text-textSecondary hover:bg-white/5 hover:text-textPrimary'
                        }`}
                      >
                        <span className="text-xs font-medium">v{tag}</span>
                        <span className="text-[10px] text-textMuted">
                          {formatShortDate(r.published_at)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <span className="text-xs font-medium text-textMuted px-2.5 py-1 rounded-md bg-white/5 border border-white/5">
              v{displayVersion}
            </span>
          )}
            <button
              onClick={onClose}
              className="glass-button px-6 py-2 text-sm font-semibold text-textPrimary rounded-full"
            >
              Continue
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
};

export default ChangelogOverlay;
