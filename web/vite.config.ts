import { defineConfig } from 'vite';

const backend = process.env.BACKEND ?? 'http://127.0.0.1:8000';

export default defineConfig({
  base: './',
  server: {
    proxy: {
      '/api': backend,
      '/ws': { target: backend, ws: true },
    },
  },
});
