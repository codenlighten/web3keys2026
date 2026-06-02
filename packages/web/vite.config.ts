import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build to dist/ (served by the API server via WEB_DIR). In dev, proxy API + paymail
// calls to the local server on :3000 so the SPA and API share an origin.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000',
      '/.well-known': 'http://127.0.0.1:3000',
    },
  },
});
