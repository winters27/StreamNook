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
  // The spell-check worker is bundled as an ES module so its `import` of the
  // vendored dictionary resolves the same way it does on the main thread.
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // Vite's dependency scanner walks the HTML entry and the modules it reaches
    // — it does NOT crawl worker files. nspell is only imported from the worker,
    // so without this it gets discovered mid-session and forces a re-optimize
    // (which shows up in dev as a 504 on the worker chunk).
    include: ['nspell'],
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
