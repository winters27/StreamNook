import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import ProfileCardPage from './pages/ProfileCardPage.tsx';
import MultiChatWindow from './components/multichat/MultiChatWindow.tsx';
import ListsWindow from './components/lists/ListsWindow.tsx';
import { MotionScope } from './components/MotionScope.tsx';
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

// Route based on URL hash. Profile-card windows and the new StreamNook
// MultiChat popout share the same bundle as the main App; main.tsx picks
// the root component to render.
const hash = window.location.hash;
const isProfileCard = hash.startsWith('#/profile');
const isMultiChat = hash.startsWith('#/multichat');
const isListsWindow = hash.startsWith('#/lists');

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <MotionScope>
      {isMultiChat ? <MultiChatWindow /> : isListsWindow ? <ListsWindow /> : isProfileCard ? <ProfileCardPage /> : <App />}
    </MotionScope>
  </React.StrictMode>
);
