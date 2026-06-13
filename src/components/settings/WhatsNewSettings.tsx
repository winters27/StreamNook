import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, Github, ChevronDown, ChevronRight, AlertCircle, Sparkles, Bug, Wrench, Package, RefreshCw } from 'lucide-react';
import { parseInlineMarkdown } from '../../services/markdownService';
import { Logger } from '../../utils/logger';
import { Tooltip } from '../ui/Tooltip';
import {
    fetchReleases,
    loadReleasesCache,
    saveReleasesCache,
    type GitHubRelease,
} from '../../services/releasesService';

const formatPublishedDate = (iso: string): string => {
    try {
        return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
        return iso;
    }
};

/** Render a single release body. Handles the section headers used by
 *  release_manager.ps1 (Features / Bug Fixes / Maintenance / Bundle
 *  Components) and falls back to inline markdown for the rest. Strips the
 *  boilerplate Installation section since it's not relevant in-app. */
const ReleaseBody = ({ content }: { content: string }) => {
    if (!content) return <p className="text-xs italic text-textMuted">No release notes.</p>;

    // Truncate at the boilerplate Installation section if present.
    const allLines = content.split('\n');
    const installIdx = allLines.findIndex((l) => /^#+\s*Installation\b/i.test(l.trim()) || l.trim().toLowerCase() === 'installation');
    const lines = installIdx >= 0 ? allLines.slice(0, installIdx) : allLines;

    return (
        <div className="space-y-2 text-sm text-textSecondary leading-relaxed">
            {lines.map((line, i) => {
                const trimmed = line.trim();
                if (!trimmed) return <div key={i} className="h-3" />;

                if (trimmed === '---') return <div key={i} className="h-px bg-borderSubtle my-4" />;

                if (trimmed.match(/^(?:##\s*)?\[.*?\]\s*-\s*\d{4}-\d{2}-\d{2}/)) return null;

                if (trimmed.includes('✨ Features') || /^#+\s*Features\b/i.test(trimmed)) {
                    return (
                        <div key={i} className="flex items-center gap-2.5 mt-6 mb-3">
                            <Sparkles size={16} className="text-yellow-400" />
                            <span className="text-base font-semibold text-textPrimary">Features</span>
                        </div>
                    );
                }
                if (trimmed.includes('🐛 Bug Fixes') || /^#+\s*Bug Fixes\b/i.test(trimmed)) {
                    return (
                        <div key={i} className="flex items-center gap-2.5 mt-6 mb-3">
                            <Bug size={16} className="text-red-400" />
                            <span className="text-base font-semibold text-textPrimary">Bug Fixes</span>
                        </div>
                    );
                }
                if (trimmed.includes('🔧 Maintenance') || /^#+\s*Maintenance\b/i.test(trimmed)) {
                    return (
                        <div key={i} className="flex items-center gap-2.5 mt-6 mb-3">
                            <Wrench size={16} className="text-blue-400" />
                            <span className="text-base font-semibold text-textPrimary">Maintenance</span>
                        </div>
                    );
                }
                if (/^#+\s*Bundle Components\b/i.test(trimmed)) {
                    return (
                        <div key={i} className="flex items-center gap-2.5 mt-6 mb-3">
                            <Package size={16} className="text-purple-400" />
                            <span className="text-base font-semibold text-textPrimary">Bundle Components</span>
                        </div>
                    );
                }

                if (trimmed.startsWith('# ')) return <h3 key={i} className="text-base font-bold text-textPrimary mt-6 mb-3">{parseInlineMarkdown(trimmed.replace('# ', ''))}</h3>;
                // ## is the "banner / headline" level used at the top of a release
                // body to call out a major launch. Renders larger than the
                // ### section headers below so the eye lands here first.
                if (trimmed.startsWith('## ')) return <h4 key={i} className="text-lg font-bold text-textPrimary mt-6 mb-3">{parseInlineMarkdown(trimmed.replace('## ', ''))}</h4>;
                if (trimmed.startsWith('### ')) return <h5 key={i} className="text-sm font-semibold text-textPrimary mt-4 mb-1">{parseInlineMarkdown(trimmed.replace('### ', ''))}</h5>;
                // Blockquotes (>) render as a left-bordered subtle callout. Used
                // to set off the body of a release headline from the regular
                // bullets that follow.
                if (trimmed.startsWith('> ')) {
                    return (
                        <div key={i} className="border-l-2 border-accent/40 pl-4 py-1 my-2 text-textSecondary">
                            {parseInlineMarkdown(trimmed.replace('> ', ''))}
                        </div>
                    );
                }
                if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
                    return (
                        <div key={i} className="flex items-start gap-3 ml-2">
                            <span className="text-textMuted mt-1">•</span>
                            <span className="flex-1">{parseInlineMarkdown(trimmed.replace(/^[-*]\s/, ''))}</span>
                        </div>
                    );
                }

                return <p key={i}>{parseInlineMarkdown(line)}</p>;
            })}
        </div>
    );
};

const ReleaseCard = ({
    release,
    initiallyOpen,
}: {
    release: GitHubRelease;
    initiallyOpen: boolean;
}) => {
    const [isOpen, setIsOpen] = useState(initiallyOpen);
    const version = release.tag_name.startsWith('v') ? release.tag_name : `v${release.tag_name}`;

    return (
        <div>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="w-full flex items-center justify-between py-5 transition-colors text-left group"
            >
                <div className="flex items-center gap-4">
                    <span className="text-base font-semibold text-textPrimary group-hover:text-accent transition-colors">
                        {version}
                    </span>
                    <span className="text-sm text-textMuted">{formatPublishedDate(release.published_at)}</span>
                    {release.prerelease && (
                        <span className="text-[11px] uppercase tracking-wide text-yellow-400">
                            Pre-release
                        </span>
                    )}
                </div>
                {isOpen ? <ChevronDown size={16} className="text-textMuted" /> : <ChevronRight size={16} className="text-textMuted" />}
            </button>

            {isOpen && (
                <div className="pb-6">
                    <ReleaseBody content={release.body} />
                    <div className="mt-6 flex justify-end">
                        <a
                            href={release.html_url}
                            onClick={(e) => {
                                e.preventDefault();
                                invoke('open_browser_url', { url: release.html_url });
                            }}
                            className="inline-flex items-center gap-1.5 text-sm text-textMuted hover:text-accent transition-colors"
                        >
                            <Github size={14} />
                            View on GitHub
                        </a>
                    </div>
                </div>
            )}
        </div>
    );
};

const WhatsNewSettings = () => {
    const initialCache = loadReleasesCache();
    const [releases, setReleases] = useState<GitHubRelease[] | null>(initialCache?.releases ?? null);
    const [isLoading, setIsLoading] = useState(!initialCache);
    const [error, setError] = useState<string | null>(null);
    const [isRefreshing, setIsRefreshing] = useState(false);

    useEffect(() => {
        const controller = new AbortController();
        (async () => {
            const result = await fetchReleases({ signal: controller.signal });
            if (controller.signal.aborted) return;
            if (result.ok) {
                if (result.kind === 'fresh') {
                    setReleases(result.releases);
                    saveReleasesCache({ fetchedAt: Date.now(), etag: result.etag, releases: result.releases });
                }
                // 304 not-modified: keep cached state, nothing to do
                setError(null);
            } else {
                Logger.warn('Failed to load releases:', result.error);
                if (!releases) setError(result.error);
                else setError('refresh-failed');
            }
            setIsLoading(false);
        })();
        return () => controller.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Manual refresh bypasses the ETag so users can force a true re-pull if
    // they suspect their cache is stale (CDN lag, deleted release not yet
    // propagated). Normal mount-time fetches use the ETag for free freshness.
    const handleRefresh = async () => {
        setIsRefreshing(true);
        const result = await fetchReleases({ bypassEtag: true });
        if (result.ok && result.kind === 'fresh') {
            setReleases(result.releases);
            saveReleasesCache({ fetchedAt: Date.now(), etag: result.etag, releases: result.releases });
            setError(null);
        } else if (!result.ok) {
            Logger.warn('Refresh failed:', result.error);
            setError('refresh-failed');
        }
        setIsRefreshing(false);
    };

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between gap-3">
                <p className="text-sm text-textMuted flex-1">
                    Release history for StreamNook and its bundled components (Streamlink, TTV LOL PRO).
                </p>
                <Tooltip content="Refetch from GitHub">
                <button
                    onClick={handleRefresh}
                    disabled={isRefreshing || isLoading}
                    className="inline-flex items-center gap-1.5 text-xs text-textSecondary hover:text-textPrimary disabled:opacity-50 transition-colors"
                >
                    <RefreshCw size={13} className={isRefreshing ? 'animate-spin' : ''} />
                    Refresh
                </button>
                </Tooltip>
            </div>

            {isLoading && !releases && (
                <div className="flex items-center justify-center py-8">
                    <div className="flex items-center gap-3 text-textSecondary">
                        <Loader2 size={20} className="animate-spin" />
                        <span className="text-sm">Loading releases...</span>
                    </div>
                </div>
            )}

            {error && !releases && (
                <div className="flex items-center gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-xl">
                    <AlertCircle size={20} className="text-red-400 flex-shrink-0" />
                    <p className="text-sm text-red-400">Could not load releases: {error}</p>
                </div>
            )}

            {error === 'refresh-failed' && releases && (
                <div className="flex items-center gap-2 text-xs text-amber-400">
                    <AlertCircle size={12} />
                    <span>Couldn't reach GitHub. Showing cached list.</span>
                </div>
            )}

            {releases && releases.length === 0 && (
                <p className="text-sm text-textMuted text-center py-8">No releases published yet.</p>
            )}

            {releases && releases.length > 0 && (
                <div className="divide-y divide-borderSubtle">
                    {releases.map((release, idx) => (
                        <ReleaseCard key={release.tag_name} release={release} initiallyOpen={idx === 0} />
                    ))}
                </div>
            )}
        </div>
    );
};

export default WhatsNewSettings;
