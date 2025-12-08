import { X, Sparkles, ExternalLink, Bug, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ReleaseNotes } from '../types';
import { parseInlineMarkdown } from '../services/markdownService';

interface ChangelogOverlayProps {
  version: string;
  onClose: () => void;
}

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
        console.error('Failed to fetch release notes:', err);
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
          <button
            onClick={onClose}
            className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded-lg transition-all duration-200"
            title="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Divider */}
        <div className="h-px bg-borderSubtle mb-4" />

        {/* Content */}
        <div className="flex-1 overflow-y-auto custom-scrollbar pr-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
            </div>
          ) : error ? (
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
