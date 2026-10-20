import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const backend = process.env.BACKEND ?? 'http://127.0.0.1:8000';

export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 4096 }, // Monaco
  resolve: {
    alias: {
      // y-monaco imports a path that monaco-editor >= 0.55's exports map no longer resolves
      'monaco-editor/esm/vs/editor/editor.api.js': fileURLToPath(
        new URL('node_modules/monaco-editor/esm/vs/editor/editor.api.js', import.meta.url),
      ),
    },
  },
  server: {
    proxy: {
      '/api': backend,
      '/ws': { target: backend, ws: true },
    },
  },
});
