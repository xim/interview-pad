import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const backend = process.env.BACKEND ?? 'http://127.0.0.1:8000';

export default defineConfig({
  base: './',
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC') },
  build: { chunkSizeWarningLimit: 4096 }, // Monaco
  worker: { format: 'es' },
  // loads its wasm via new URL(..., import.meta.url), which pre-bundling breaks
  optimizeDeps: { exclude: ['@yowasp/clang'] },
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
    // as the backend sends (server/app.py), for clangd's threads
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    proxy: {
      '/api': backend,
      '/ws': { target: backend, ws: true },
    },
  },
});
