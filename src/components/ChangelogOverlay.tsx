import { X, Sparkles, ExternalLink, Bug, Wrench, Github } from 'lucide-react';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ReleaseNotes } from '../types';
import { parseInlineMarkdown } from '../services/markdownService';
import { Tooltip } from './ui/Tooltip';

import { Logger } from '../utils/logger';
interface ChangelogOverlayProps {
  version: string;
  onClose: () => void;
}

// Developer Discord ID — same value used by SupportSettings.tsx / AboutWidget.tsx.
const DEVELOPER_DISCORD_ID = '681989594341834765';
const GITHUB_ISSUE_URL = 'https://github.com/winters27/StreamNook/issues/new';
const DISCORD_DM_URL = `https://discord.com/users/${DEVELOPER_DISCORD_ID}`;

// Opens an external URL via Tauri's shell plugin (so it goes to the OS default
// browser, not inside the WebView). Falls back to window.open in case the
// plugin import fails — matches the pattern in SupportSettings.tsx.
const openExternal = async (url: string) => {
  try {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } catch (err) {
    Logger.error('Failed to open external URL:', err);
    window.open(url, '_blank');
  }
};

// Official Discord brand mark, sized to match lucide icons (14px default).
const DiscordIcon = ({ size = 14 }: { size?: number }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
  </svg>
);

/**
 * Friendly closing block appended to every release-notes popup.
 * Layout order: feedback line → centered buttons → italic sign-off.
 *
 *   - GitHub button: neutral chip (white/5 bg, white/10 border)
 *   - Discord button: matched chip styling, Discord brand mark in blurple
 *     so it pops visually without breaking the calm chip family.
 */
const FriendlyFooter = () => (
  <div className="mt-8 pt-6 border-t border-white/5 space-y-4">
    <p className="text-xs text-textSecondary leading-relaxed">
      As always, if you run into any bugs, annoyances, or have suggestions, feel free to reach out on Discord or open an issue on GitHub.
    </p>
    <div className="flex flex-wrap justify-center gap-2 pt-1">
      <button
        type="button"
        onClick={() => openExternal(GITHUB_ISSUE_URL)}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-xs text-textPrimary transition-colors"
      >
        <Github size={14} />
        Open a GitHub issue
      </button>
      <button
        type="button"
        onClick={() => openExternal(DISCORD_DM_URL)}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-xs text-textPrimary transition-colors"
      >
        <span className="text-[#5865F2]">
          <DiscordIcon size={14} />
        </span>
        DM me on Discord
      </button>
    </div>
    <p className="text-center text-xs text-textPrimary leading-relaxed italic pt-2">
      May your channel points always claim, your streams never buffer, your drops always finish, and your favorite streamer go live the moment you open the app. 💜
    </p>
  </div>
);

// Helper to format markdown text roughly (Matched with UpdatesSettings)
const FormatMarkdown = ({ content }: { content: string }) => {
  if (!content) return null;

  // Filter content to stop at "Bundle Components", "Installation", or separator
  const lines = content.split('\n');
  const filteredLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '---' || trimmed === 'Bundle Components' || trimmed === 'Installation') {
      break;
    }
    filteredLines.push(line);
  }

  return (
    <div className="space-y-1 text-xs text-textSecondary">
      {filteredLines.map((line, i) => {
        const cleanLine = line.trim();
        if (!cleanLine) return <div key={i} className="h-2" />;

        // Format version/date line: [4.7.1] - 2025-12-04
        // Note: In ChangelogOverlay, this might not be present in the body if it comes from GitHub release body directly,
        // but we include the logic just in case it is pasted there.
        const versionMatch = cleanLine.match(/^(?:##\s*)?\[.*?\]\s*-\s*(\d{4}-\d{2}-\d{2})/);
        if (versionMatch) {
          try {
            const date = new Date(versionMatch[1]);
            // Add timezone offset to prevent off-by-one error due to UTC conversion
            const userTimezoneOffset = date.getTimezoneOffset() * 60000;
            const adjustedDate = new Date(date.getTime() + userTimezoneOffset);

            const formattedDate = adjustedDate.toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric'
            });

            return (
              <div key={i} className="mb-6 mt-2">
                <span className="inline-block text-xs font-medium text-textSecondary bg-white/5 px-2.5 py-1 rounded-md border border-white/5">
                  {formattedDate}
                </span>
              </div>
            );
          } catch (e) {
            // If date parsing fails, just ignore this line or show as is
          }
        }

        // Replace emoji headers with Lucide icons
        if (cleanLine.includes('✨ Features')) {
          return (
            <div key={i} className="flex items-center gap-2 mt-4 mb-2">
              <Sparkles size={14} className="text-yellow-400" />
              <span className="text-sm font-semibold text-textPrimary">Features</span>
            </div>
          );
        }
        if (cleanLine.includes('🐛 Bug Fixes')) {
          return (
            <div key={i} className="flex items-center gap-2 mt-4 mb-2">
              <Bug size={14} className="text-red-400" />
              <span className="text-sm font-semibold text-textPrimary">Bug Fixes</span>
            </div>
          );
        }
        if (cleanLine.includes('🔧 Maintenance')) {
          return (
            <div key={i} className="flex items-center gap-2 mt-4 mb-2">
              <Wrench size={14} className="text-blue-400" />
              <span className="text-sm font-semibold text-textPrimary">Maintenance</span>
            </div>
          );
        }

        if (cleanLine.startsWith('# '))
          return <h3 key={i} className="text-sm font-bold text-textPrimary mt-4 mb-2">{parseInlineMarkdown(cleanLine.replace('# ', ''))}</h3>;
        if (cleanLine.startsWith('## '))
          return <h4 key={i} className="text-xs font-bold text-textPrimary mt-3 mb-1">{parseInlineMarkdown(cleanLine.replace('## ', ''))}</h4>;
        if (cleanLine.startsWith('### '))
          return <h5 key={i} className="text-xs font-semibold text-textPrimary mt-2">{parseInlineMarkdown(cleanLine.replace('### ', ''))}</h5>;
        if (cleanLine.startsWith('- ') || cleanLine.startsWith('* '))
          return (
            <div key={i} className="flex items-start gap-2 ml-2">
              <span className="text-textMuted mt-0.5">•</span>
              <span>{parseInlineMarkdown(cleanLine.replace(/^[-*]\s/, ''))}</span>
            </div>
          );

        return <p key={i}>{parseInlineMarkdown(line)}</p>;
      })}
    </div>
  );
};

const ChangelogOverlay = ({ version, onClose }: ChangelogOverlayProps) => {
  const [releaseNotes, setReleaseNotes] = useState<ReleaseNotes | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchReleaseNotes = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const notes = await invoke<ReleaseNotes>('get_release_notes', { version });
        setReleaseNotes(notes);
      } catch (err) {
        Logger.error('Failed to fetch release notes:', err);
        setError('Failed to load release notes');
      } finally {
        setIsLoading(false);
      }
    };

    fetchReleaseNotes();
  }, [version]);

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      {/* Background overlay - click to close */}
      <div className="absolute inset-0" onClick={onClose} />

      <div className="glass-panel p-6 w-[500px] max-w-[90vw] max-h-[80vh] shadow-2xl relative z-10 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-accent/20 rounded-lg">
              <Sparkles size={24} className="text-accent" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-textPrimary">
                What's New
              </h2>
              {releaseNotes?.published_at && (
                <div className="mt-1">
                  <span className="inline-block text-xs font-medium text-textSecondary bg-white/5 px-2.5 py-1 rounded-md border border-white/5">
                    {formatDate(releaseNotes.published_at)}
                  </span>
                </div>
              )}
            </div>
          </div>
          <Tooltip content="Close" side="bottom">
            <button
              onClick={onClose}
              className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded-lg transition-all duration-200"
            >
              <X size={20} />
            </button>
          </Tooltip>
        </div>

        {/* Divider */}
        <div className="h-px bg-borderSubtle mb-4" />

        {/* Content */}
        <div className="flex-1 overflow-y-auto custom-scrollbar pr-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
            </div>
          ) : (
            <>
              {error ? (
                <div className="text-center py-8">
                  <p className="text-textSecondary">{error}</p>
                  <p className="text-xs text-textSecondary mt-2">
                    You can view the full release notes on GitHub
                  </p>
                </div>
              ) : releaseNotes?.body ? (
                <FormatMarkdown content={releaseNotes.body} />
              ) : (
                <div className="text-center py-8">
                  <p className="text-textSecondary">No release notes available</p>
                </div>
              )}
              <FriendlyFooter />
            </>
          )}
        </div>

        {/* Footer */}
        <div className="mt-4 pt-4 border-t border-borderSubtle">
          <a
            href="https://github.com/winters27/StreamNook/blob/main/CHANGELOG.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-accent hover:text-accent/80 flex items-center gap-1 transition-colors"
          >
            View Full Changelog
            <ExternalLink size={12} />
          </a>
        </div>
      </div>
    </div>
  );
};

export default ChangelogOverlay;
