import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Backend URL is overridable so the UI can be pointed at another instance
// (e.g. VITE_API_TARGET=http://localhost:3100 npm run dev).
const target = process.env.VITE_API_TARGET || 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy API calls to the Express backend, so no CORS setup is needed in dev.
    proxy: {
      '/reports': target,
      '/health':  target,
      '/auth':    target,
      '/admin':   target,
    },
  },
});
