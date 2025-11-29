import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import ProfileCardPage from './pages/ProfileCardPage.tsx';
import './styles/globals.css';
import { initLogCapture } from './services/logService';

// Initialize log capture early to capture all console messages
initLogCapture();
console.log('[App] StreamNook starting...');

// Check if this is a profile card window based on URL hash
const isProfileCard = window.location.hash.startsWith('#/profile');

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {isProfileCard ? <ProfileCardPage /> : <App />}
  </React.StrictMode>
);
