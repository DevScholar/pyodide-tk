import { defineConfig } from 'vite';
import type { Plugin, ResolvedServerUrls } from 'vite';
import { resolve } from 'node:path';
import { readdirSync, statSync, existsSync } from 'node:fs';

// pyodide-tk web demos. Mirrors em-x11's structure: each demos/<name>/
// is a single index.html with the Python in an inline
// `<script type="text/python">` and a one-liner that hands it to the
// shared harness in src/demo-harness.ts. The shared worker, harness,
// and worker-protocol live under src/.

function listDemoEntries(): { name: string; path: string }[] {
  const demosDir = resolve(__dirname, 'demos');
  if (!existsSync(demosDir)) return [];
  return readdirSync(demosDir)
    .filter((name) => {
      const entry = resolve(demosDir, name, 'index.html');
      return statSync(resolve(demosDir, name)).isDirectory() && existsSync(entry);
    })
    .map((name) => ({ name, path: `/demos/${name}/` }));
}

function printDemoUrls(): Plugin {
  const demos = listDemoEntries();
  return {
    name: 'pyodide-tk-print-demo-urls',
    configureServer(server) {
      const originalPrint = server.printUrls.bind(server);
      server.printUrls = () => {
        originalPrint();
        if (demos.length === 0) return;
        const urls: ResolvedServerUrls | null = server.resolvedUrls;
        const bases = urls ? [...urls.local, ...urls.network] : [];
        const base = bases[0]?.replace(/\/$/, '') ?? '';
        // eslint-disable-next-line no-console
        console.log('\n  \x1b[1mDemos\x1b[0m:');
        for (const d of demos) {
          // eslint-disable-next-line no-console
          console.log(`    \x1b[36m${d.name.padEnd(14)}\x1b[0m ${base}${d.path}`);
        }
        // eslint-disable-next-line no-console
        console.log('');
      };
    },
  };
}

export default defineConfig({
  root: '.',
  publicDir: 'public',

  plugins: [printDemoUrls()],

  resolve: {
    alias: {
      // em-x11 is consumed via relative TS source so changes there are
      // picked up live; in production we'd publish em-x11 as a workspace
      // package.
      '@emx11': resolve(__dirname, '../em-x11/src'),
    },
  },

  server: {
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
    // Top-level await in worker / demos; needs a target that supports it.
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: Object.fromEntries(
        [
          ['main', resolve(__dirname, 'index.html')],
          ...listDemoEntries().map(
            (d) => [d.name, resolve(__dirname, `demos/${d.name}/index.html`)],
          ),
        ],
      ),
    },
  },
});
