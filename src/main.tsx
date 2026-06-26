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
// Fraunces (variable serif). Italic powers the StreamNook tier-badge rank
// number; the upright axis backs the "Serif" choice in Theme > Font.
import '@fontsource-variable/fraunces';
import '@fontsource-variable/fraunces/wght-italic.css';
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
