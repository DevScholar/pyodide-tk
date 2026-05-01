import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// pyodide-tk web demo. Imports em-x11's host TS source via relative path
// so changes there are picked up live; in production we'd publish em-x11
// as a workspace package.
export default defineConfig({
  root: '.',
  publicDir: 'public',

  resolve: {
    alias: {
      '@emx11': resolve(__dirname, '../em-x11/src'),
    },
  },

  server: {
    port: 5174,
    fs: {
      // Serve from sibling em-x11 source for the host TS imports.
      allow: ['.', '../em-x11'],
    },
    headers: {
      // Pyodide uses SharedArrayBuffer (optional) and may want isolation.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },

  optimizeDeps: {
    // Pyodide's ESM glue does runtime fetch/import that pre-bundling breaks.
    exclude: ['pyodide'],
  },

  build: {
    // Top-level await in src/main.ts; needs a target that supports it.
    target: 'esnext',
  },
});
