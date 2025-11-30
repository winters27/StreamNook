import { X, Github } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

interface AboutWidgetProps {
  onClose: () => void;
}

const AboutWidget = ({ onClose }: AboutWidgetProps) => {
  const [appVersion, setAppVersion] = useState('1.0.0');
  const [appName, setAppName] = useState('Stream Nook');

  useEffect(() => {
    // Fetch app version from Cargo.toml
    invoke<string>('get_app_version')
      .then(version => setAppVersion(version))
      .catch(err => console.error('Failed to get app version:', err));

    invoke<string>('get_app_name')
      .then(name => setAppName(name))
      .catch(err => console.error('Failed to get app name:', err));
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm group">
      {/* Hover-sensitive background overlay */}
      <div
        className="absolute inset-0 group-hover:pointer-events-none"
        onClick={onClose}
      />

      <div className="glass-panel p-6 w-96 max-w-[90vw] shadow-2xl relative z-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-textPrimary">About Stream Nook</h2>
          <button
            onClick={onClose}
            className="p-1 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all duration-200"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="space-y-4 text-textSecondary text-sm">
          {/* Logo Section */}
          <div className="flex justify-center mb-4">
            <svg
              viewBox="0 0 526.364 477.037"
              className="w-20 h-20"
            >
              <g transform="translate(-91.424,-253.587)">
                {/* Top/Right piece - White */}
                <path
                  d="M 312.324,254.293 L 497.878,584.552 L 291.613,584.667 L 252.049,655.38 L 617.267,655.437 L 394.465,254.087 L 312.324,254.293 z"
                  fill="#97b1b9"
                  stroke="#000000"
                  strokeWidth="1"
                  strokeLinecap="butt"
                  strokeLinejoin="round"
                />

                {/* Left piece - Gray */}
                <path
                  d="M 312.314,254.266 L 91.924,655.372 L 132.33,728.103 L 315.168,396.773 L 417.193,584.662 L 498.005,584.662 L 312.314,254.266 z"
                  fill="#8aa3ac"
                  stroke="#000000"
                  strokeWidth="1"
                  strokeLinecap="butt"
                  strokeLinejoin="round"
                />

                {/* Bottom piece - Black */}
                <path
                  d="M 315.21,396.836 L 355.501,471.055 L 251.873,655.434 L 617.288,655.624 L 578.817,730.124 L 132.346,728.077 L 315.21,396.836 z"
                  fill="#6b8a94"
                  stroke="#000000"
                  strokeWidth="1"
                  strokeLinecap="butt"
                  strokeLinejoin="round"
                />
              </g>
            </svg>
          </div>

          {/* Description */}
          <div className="text-center">
            <p className="leading-relaxed text-textPrimary">
              A modern Twitch streaming companion for an enhanced viewing experience.
            </p>
          </div>

          {/* Made with love */}
          <div className="text-center py-2">
            <p className="text-textPrimary italic">
              Made by{' '}
              <a
                href="https://discord.com/users/681989594341834765"
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold hover:text-[#5865F2] transition-colors underline decoration-dotted"
              >
                Winters
              </a>{' '}
              with <span className="text-red-400">♥</span>
            </p>
          </div>

          {/* Special Thanks */}
          <div className="text-center py-2 px-4 bg-glass/30 rounded-lg">
            <p className="text-textSecondary text-xs mb-2">Special thanks and love to</p>
            <div className="flex items-center justify-center gap-3 flex-wrap">
              <a
                href="https://7tv.app"
                target="_blank"
                rel="noopener noreferrer"
                className="text-textPrimary hover:text-[#00A8FC] transition-colors font-medium text-sm"
                title="7TV"
              >
                7TV
              </a>
              <span className="text-textSecondary">•</span>
              <a
                href="https://betterttv.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-textPrimary hover:text-[#D50014] transition-colors font-medium text-sm"
                title="BetterTTV"
              >
                BTTV
              </a>
              <span className="text-textSecondary">•</span>
              <a
                href="https://www.frankerfacez.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-textPrimary hover:text-[#52A747] transition-colors font-medium text-sm"
                title="FrankerFaceZ"
              >
                FFZ
              </a>
              <span className="text-textSecondary">•</span>
              <a
                href="https://www.twitch.tv"
                target="_blank"
                rel="noopener noreferrer"
                className="text-textPrimary hover:text-[#9146FF] transition-colors font-medium text-sm"
                title="Twitch"
              >
                Twitch
              </a>
            </div>
          </div>

          {/* Tech Stack */}
          <div>
            <p className="text-textPrimary font-semibold mb-3 text-center">Built With</p>
            <div className="flex flex-wrap justify-center gap-2">
              {/* Tauri */}
              <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-glass rounded-full text-xs">
                <svg className="w-3.5 h-3.5" viewBox="0 0 120 120" fill="none">
                  <path d="M88.5 28.5L31.5 28.5C31.5 41.4787 42.0213 52 55 52L65 52C77.9787 52 88.5 62.5213 88.5 75.5C88.5 88.4787 77.9787 99 65 99L55 99C42.0213 99 31.5 88.4787 31.5 75.5" stroke="#FFC131" strokeWidth="8" strokeLinecap="round" />
                </svg>
                <span className="text-[#FFC131] font-medium">Tauri</span>
              </span>

              {/* React */}
              <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-glass rounded-full text-xs">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="2" fill="#61DAFB" />
                  <ellipse cx="12" cy="12" rx="8" ry="3" stroke="#61DAFB" strokeWidth="1.5" fill="none" />
                  <ellipse cx="12" cy="12" rx="8" ry="3" stroke="#61DAFB" strokeWidth="1.5" fill="none" transform="rotate(60 12 12)" />
                  <ellipse cx="12" cy="12" rx="8" ry="3" stroke="#61DAFB" strokeWidth="1.5" fill="none" transform="rotate(120 12 12)" />
                </svg>
                <span className="text-[#61DAFB] font-medium">React</span>
              </span>

              {/* TypeScript */}
              <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-glass rounded-full text-xs">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                  <rect width="24" height="24" rx="3" fill="#3178C6" />
                  <path d="M14 8h3v1.5h-1.5V18H14V8zm-3.75 2.5V9H7v1.5h1.5V18h1.5v-7.5H10z" fill="white" />
                </svg>
                <span className="text-[#3178C6] font-medium">TypeScript</span>
              </span>

              {/* Rust */}
              <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-glass rounded-full text-xs">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" fill="#CE422B" />
                  <path d="M12 7l2.5 5h-5L12 7z M7 16h10" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="text-[#CE422B] font-medium">Rust</span>
              </span>

              {/* Tailwind */}
              <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-glass rounded-full text-xs">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                  <path d="M12 6C9.33 6 7.67 7.33 7 10c1-1.33 2.17-1.83 3.5-1.5.76.19 1.3.74 1.9 1.35.98 1 2.12 2.15 4.6 2.15 2.67 0 4.33-1.33 5-4-1 1.33-2.17 1.83-3.5 1.5-.76-.19-1.3-.74-1.9-1.35C15.62 7.15 14.48 6 12 6zM7 12c-2.67 0-4.33 1.33-5 4 1-1.33 2.17-1.83 3.5-1.5.76.19 1.3.74 1.9 1.35.98 1 2.12 2.15 4.6 2.15 2.67 0 4.33-1.33 5-4-1 1.33-2.17 1.83-3.5 1.5-.76-.19-1.3-.74-1.9-1.35C10.62 13.15 9.48 12 7 12z" fill="#06B6D4" />
                </svg>
                <span className="text-[#06B6D4] font-medium">Tailwind</span>
              </span>

              {/* Twitch API */}
              <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-glass rounded-full text-xs">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                  <path d="M4 2L2 6v14h5v2h3l2-2h4l6-6V2H4zm16 11l-3 3h-4l-2 2v-2H7V4h13v9z" fill="#9146FF" />
                  <rect x="14" y="7" width="2" height="5" fill="white" />
                  <rect x="10" y="7" width="2" height="5" fill="white" />
                </svg>
                <span className="text-[#9146FF] font-medium">Twitch API</span>
              </span>
            </div>
          </div>

          {/* Version & Links */}
          <div className="pt-4 border-t border-borderSubtle">
            <div className="flex items-center justify-between">
              <p className="text-xs text-textSecondary">
                Version {appVersion}
              </p>
              <a
                href="https://github.com/winters27"
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all duration-200"
                title="View on GitHub"
              >
                <Github size={18} />
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AboutWidget;
