import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import ProfileCardPage from './pages/ProfileCardPage.tsx';
import MultiChatWindow from './components/multichat/MultiChatWindow.tsx';
// Side-effect import: registers `window.openMultiChatWindow` for popout spawning.
import './utils/multichatWindow';
// Side-effect import: listens for the tray's "Open MultiChat" menu event and
// spawns an empty popout from the main window.
import './utils/multichatTrayBridge';
// Fraunces (variable, italic, latin-only weight axis) — used by the StreamNook
// tier badge for the rank number. Provides the silky display-serif treatment
// that Satoshi can't deliver. Only the italic weights are loaded.
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

// Route based on URL hash. Profile-card windows and the new StreamNook
// MultiChat popout share the same bundle as the main App; main.tsx picks
// the root component to render.
const hash = window.location.hash;
const isProfileCard = hash.startsWith('#/profile');
const isMultiChat = hash.startsWith('#/multichat');

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {isMultiChat ? <MultiChatWindow /> : isProfileCard ? <ProfileCardPage /> : <App />}
  </React.StrictMode>
);
