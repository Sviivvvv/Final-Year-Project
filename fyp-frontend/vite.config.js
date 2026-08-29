import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy API calls to the Express backend — no CORS headers needed in dev
    proxy: {
      '/reports': 'http://localhost:3000',
      '/health':  'http://localhost:3000',
      '/auth':    'http://localhost:3000',
    },
  },
});
