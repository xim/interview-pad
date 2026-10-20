import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const backend = process.env.BACKEND ?? 'http://127.0.0.1:8000';

export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 4096 }, // Monaco
  worker: { format: 'es' },
  resolve: {
    alias: [
      // y-monaco and monaco-vim import monaco-editor/esm/vs/... paths that monaco-editor 0.57's exports map no longer resolves
      {
        find: /^monaco-editor\/esm\/vs\/(.*?)(\.js)?$/,
        replacement: fileURLToPath(new URL('node_modules/monaco-editor/esm/vs/$1.js', import.meta.url)),
      },
    ],
  },
  server: {
    proxy: {
      '/api': backend,
      '/ws': { target: backend, ws: true },
    },
  },
});
