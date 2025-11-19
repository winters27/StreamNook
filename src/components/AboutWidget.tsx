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
          <div>
            <p className="text-textPrimary font-semibold mb-2">
              Stream Nook
            </p>
            <p className="leading-relaxed">
              A modern Twitch streaming application built with Tauri and React. 
              Stream Nook provides a seamless viewing experience with integrated chat, 
              drops tracking, badges, and more.
            </p>
          </div>

          {/* Features */}
          <div>
            <p className="text-textPrimary font-semibold mb-2">Features</p>
            <ul className="list-disc list-inside space-y-1 leading-relaxed">
              <li>Live stream viewing with high-quality playback</li>
              <li>Interactive Twitch chat with emotes</li>
              <li>Drops and channel points tracking</li>
              <li>Global badges collection</li>
              <li>Discord Rich Presence integration</li>
              <li>Customizable settings</li>
            </ul>
          </div>

          {/* Tech Stack */}
          <div>
            <p className="text-textPrimary font-semibold mb-2">Built With</p>
            <div className="flex flex-wrap gap-2">
              <span className="px-2 py-1 bg-glass rounded text-xs">Tauri</span>
              <span className="px-2 py-1 bg-glass rounded text-xs">React</span>
              <span className="px-2 py-1 bg-glass rounded text-xs">TypeScript</span>
              <span className="px-2 py-1 bg-glass rounded text-xs">Rust</span>
              <span className="px-2 py-1 bg-glass rounded text-xs">Tailwind CSS</span>
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
