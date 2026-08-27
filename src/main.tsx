import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { MotionScope } from './components/MotionScope.tsx';

// Route components are lazy so each window only downloads/parses the code it
// actually renders. The MultiChat / profile / plugin popouts no longer pull in
// App's whole tree (video player + hls.js/plyr, browse, settings) — a real
// footprint + startup cut for the chat-only popout.
const App = lazy(() => import('./App.tsx'));
const ProfileCardPage = lazy(() => import('./pages/ProfileCardPage.tsx'));
const MultiChatWindow = lazy(() => import('./components/multichat/MultiChatWindow.tsx'));
const PluginWindowHost = lazy(() => import('./plugins-ui/PluginWindowHost.tsx'));
// Side-effect import: registers `window.openMultiChatWindow` for popout spawning.
import './utils/multichatWindow';
// Side-effect import: listens for the tray's "Open MultiChat" menu event and
// spawns an empty popout from the main window.
import './utils/multichatTrayBridge';
// Fraunces (variable serif). The upright axis backs the "Serif" choice in
// Theme > Font, so its @font-face must exist at boot for users who chose it
// (the woff2 itself only downloads when rendered). The italic axis is only
// used by the tier-badge rank number and rides StreamNookBadge.tsx instead.
import '@fontsource-variable/fraunces';
// Plyr's CSS must load BEFORE globals.css: our `.video-player-container .plyr__*`
// overrides have EQUAL specificity to Plyr's own defaults, so whichever stylesheet
// loads last wins. The video player is lazy-loaded, so without this eager import
// Plyr's CSS injects AFTER globals.css at runtime and its default (tall, gradient)
// control bar overrides our styled one. Eager-importing it here (deduped with the
// lazy player's own import) restores the pre-lazy-load order so our overrides win.
import 'plyr/dist/plyr.css';
import './styles/globals.css';
import { initLogCapture } from './services/logService';

import { Logger } from './utils/logger';
// Initialize log capture early to capture all console messages
initLogCapture();
Logger.debug('[App] StreamNook starting...');

// Remove Plyr's localStorage - we manage player settings via Tauri backend
// Plyr has built-in localStorage persistence that conflicts with our settings management
localStorage.removeItem('plyr');

// Route based on URL hash. Profile-card windows, the StreamNook MultiChat
// popout, and ui-plugin popout windows share the same bundle as the main App;
// main.tsx picks the root component to render.
const hash = window.location.hash;
const isProfileCard = hash.startsWith('#/profile');
const isMultiChat = hash.startsWith('#/multichat');
const isPluginWindow = hash.startsWith('#/plugin/');

// Create the React root ONCE per container. The lazy route imports above can make
// React Fast Refresh re-execute this module instead of full-reloading, and a second
// createRoot() on the same #root mounts a competing React tree — which manifests as
// the "createRoot() on a container that has already been passed" warning AND erratic
// freezes (two roots fighting over the same DOM, e.g. a clip modal locking up).
// Caching the root on the container makes re-execution a re-render, not a new root.
const container = document.getElementById('root') as HTMLElement & {
  __snRoot?: ReactDOM.Root;
};
// Dev-only console hooks. `withGlobalTauri` is deliberately off, so devtools has
// no way to reach a Tauri command; this exposes the handful worth poking at by
// hand rather than opening the whole API surface to any script in the window.
// Stripped from production builds by the DEV guard.
if (import.meta.env.DEV) {
  // React devtools bridge. This used to live in index.html gated on hostname,
  // but tauri.localhost is the PRODUCTION origin on Windows, so shipped builds
  // were loading a script from a local port any process could bind. The DEV
  // guard strips it from release bundles entirely.
  const devtools = document.createElement('script');
  devtools.src = 'http://localhost:8097';
  document.head.appendChild(devtools);
  void import('@tauri-apps/api/core').then(({ invoke }) => {
    (window as unknown as Record<string, unknown>).sn = {
      /** One SABR round trip for a YouTube video id: mints a PO token, asks for
       *  media, and reports what came back. Watch the Rust log for the detail. */
      sabrProbe: (videoId: string) => invoke('youtube_sabr_probe', { videoId }),
    };
    // eslint-disable-next-line no-console
    console.info('[dev] window.sn ready: sn.sabrProbe("<videoId>")');
  });
}

const root = container.__snRoot ?? (container.__snRoot = ReactDOM.createRoot(container));
root.render(
  <React.StrictMode>
    <MotionScope>
      <Suspense fallback={null}>
        {isMultiChat ? <MultiChatWindow /> : isPluginWindow ? <PluginWindowHost /> : isProfileCard ? <ProfileCardPage /> : <App />}
      </Suspense>
    </MotionScope>
  </React.StrictMode>,
);
