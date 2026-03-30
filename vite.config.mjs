import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-core': ['react', 'react-dom', 'zustand'],
          'vendor-hls': ['hls.js', 'plyr'],
          'vendor-motion': ['framer-motion'],
          'vendor-tauri': [
            '@tauri-apps/api', 
            '@tauri-apps/plugin-shell', 
            '@tauri-apps/plugin-deep-link', 
            '@tauri-apps/plugin-clipboard-manager', 
            '@tauri-apps/plugin-dialog', 
            '@tauri-apps/plugin-notification'
          ],
        }
      }
    }
  }
})
