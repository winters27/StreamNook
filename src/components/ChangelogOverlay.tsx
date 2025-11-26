import { X, Sparkles, Calendar, ExternalLink, Plus, Wrench, Zap, Trash2, Shield, FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ReleaseNotes } from '../types';

interface ChangelogOverlayProps {
  version: string;
  onClose: () => void;
}

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

  // Parse markdown-style content into formatted sections
  const parseBody = (body: string) => {
    const lines = body.split('\n');
    const sections: { title: string; items: string[] }[] = [];
    let currentSection: { title: string; items: string[] } | null = null;

    for (const line of lines) {
      const trimmedLine = line.trim();
      
      // Skip empty lines
      if (!trimmedLine) continue;
      
      // Check for section headers (### Added, ### Fixed, etc.)
      if (trimmedLine.startsWith('###') || trimmedLine.startsWith('##')) {
        if (currentSection && currentSection.items.length > 0) {
          sections.push(currentSection);
        }
        const title = trimmedLine.replace(/^#+\s*/, '');
        currentSection = { title, items: [] };
      }
      // Check for list items
      else if (trimmedLine.startsWith('-') || trimmedLine.startsWith('*')) {
        const item = trimmedLine.replace(/^[-*]\s*/, '');
        if (currentSection) {
          currentSection.items.push(item);
        } else {
          // Create a default section if none exists
          currentSection = { title: 'Changes', items: [item] };
        }
      }
      // Regular text that's not a list item
      else if (currentSection) {
        // Append to the last item if it exists, otherwise add as new item
        if (currentSection.items.length > 0) {
          currentSection.items[currentSection.items.length - 1] += ' ' + trimmedLine;
        } else {
          currentSection.items.push(trimmedLine);
        }
      }
    }

    // Don't forget the last section
    if (currentSection && currentSection.items.length > 0) {
      sections.push(currentSection);
    }

    return sections;
  };

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

  const getSectionIcon = (title: string) => {
    const lowerTitle = title.toLowerCase();
    if (lowerTitle.includes('added') || lowerTitle.includes('new')) {
      return <Plus size={16} className="text-green-400" />;
    }
    if (lowerTitle.includes('fixed') || lowerTitle.includes('bug')) {
      return <Wrench size={16} className="text-blue-400" />;
    }
    if (lowerTitle.includes('changed') || lowerTitle.includes('improved')) {
      return <Zap size={16} className="text-yellow-400" />;
    }
    if (lowerTitle.includes('removed') || lowerTitle.includes('deprecated')) {
      return <Trash2 size={16} className="text-red-400" />;
    }
    if (lowerTitle.includes('security')) {
      return <Shield size={16} className="text-purple-400" />;
    }
    return <FileText size={16} className="text-textSecondary" />;
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
                {isLoading ? 'Loading...' : releaseNotes?.name || `Version ${version}`}
              </h2>
              {releaseNotes?.published_at && (
                <p className="text-xs text-textSecondary flex items-center gap-1">
                  <Calendar size={12} />
                  {formatDate(releaseNotes.published_at)}
                </p>
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
        <div className="flex-1 overflow-y-auto pr-2 space-y-4">
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
            parseBody(releaseNotes.body).map((section, index) => (
              <div key={index} className="space-y-2">
                <h3 className="text-sm font-semibold text-textPrimary flex items-center gap-2">
                  {getSectionIcon(section.title)}
                  {section.title}
                </h3>
                <ul className="space-y-1.5 pl-6">
                  {section.items.map((item, itemIndex) => (
                    <li
                      key={itemIndex}
                      className="text-sm text-textSecondary leading-relaxed list-disc marker:text-textSecondary/50"
                    >
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <div className="text-center py-8">
              <p className="text-textSecondary">No release notes available</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-4 pt-4 border-t border-borderSubtle flex items-center justify-between">
          <a
            href={`https://github.com/winters27/StreamNook/releases/tag/v${version}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-accent hover:text-accent/80 flex items-center gap-1 transition-colors"
          >
            View on GitHub
            <ExternalLink size={12} />
          </a>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-accent hover:bg-accent/90 text-white text-sm font-medium rounded-lg transition-all"
          >
            Got it!
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChangelogOverlay;
