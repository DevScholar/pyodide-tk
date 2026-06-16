import { defineConfig } from 'vite';
import type { Plugin, ResolvedServerUrls } from 'vite';
import { resolve, join } from 'node:path';
import { readdirSync, statSync, existsSync, createReadStream } from 'node:fs';

// pyodide-tk web examples. Mirrors em-x11's structure: each examples/<name>/
// is a single index.html with the Python in an inline
// `<script type="text/python">` and a one-liner that hands it to the
// shared harness in src/demo-harness.ts. The shared worker, harness,
// and worker-protocol live under src/.

function listExampleEntries(): { name: string; path: string }[] {
  const examplesDir = resolve(__dirname, 'examples');
  if (!existsSync(examplesDir)) return [];
  return readdirSync(examplesDir)
    .filter((name) => {
      const entry = resolve(examplesDir, name, 'index.html');
      return statSync(resolve(examplesDir, name)).isDirectory() && existsSync(entry);
    })
    .map((name) => ({ name, path: `/examples/${name}/` }));
}

function printExampleUrls(): Plugin {
  const examples = listExampleEntries();
  return {
    name: 'pyodide-tk-print-example-urls',
    configureServer(server) {
      const originalPrint = server.printUrls.bind(server);
      server.printUrls = () => {
        originalPrint();
        if (examples.length === 0) return;
        const urls: ResolvedServerUrls | null = server.resolvedUrls;
        const bases = urls ? [...urls.local, ...urls.network] : [];
        const base = bases[0]?.replace(/\/$/, '') ?? '';
        // eslint-disable-next-line no-console
        console.log('\n  \x1b[1mExamples\x1b[0m:');
        for (const ex of examples) {
          // eslint-disable-next-line no-console
          console.log(`    \x1b[36m${ex.name.padEnd(14)}\x1b[0m ${base}${ex.path}`);
        }
        // eslint-disable-next-line no-console
        console.log('');
      };
    },
  };
}

const mimeByExt: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.tar':  'application/x-tar',
  '.zip':  'application/zip',
  '.so':   'application/wasm',
};

function servePrecompressed(): Plugin {
  return {
    name: 'serve-precompressed',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' || !req.url) { next(); return; }
        const ae = req.headers['accept-encoding'] || '';
        if (!ae.includes('gzip')) { next(); return; }

        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;

        // Only compress large binary assets
        if (!/\.(wasm|tar|zip)$/i.test(pathname)) { next(); return; }

        const gzPath = join(server.config.publicDir || 'public', pathname + '.gz');
        let gzStat;
        try { gzStat = statSync(gzPath); } catch { next(); return; }
        if (!gzStat.isFile()) { next(); return; }

        const ext = pathname.slice(pathname.lastIndexOf('.')).toLowerCase();
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Type', mimeByExt[ext] || 'application/octet-stream');
        res.setHeader('Content-Length', gzStat.size);
        res.setHeader('Vary', 'Accept-Encoding');
        createReadStream(gzPath).pipe(res);
      });
    },
  };
}

export default defineConfig({
  root: '.',
  publicDir: 'public',

  plugins: [printExampleUrls(), servePrecompressed()],

  resolve: {
    alias: {
      // em-x11 is consumed via relative TS source so changes there are
      // picked up live; in production we'd publish em-x11 as a workspace
      // package.
      '@emX11': resolve(__dirname, '../em-x11/src'),
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
    // Top-level await in worker / examples; needs a target that supports it.
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: Object.fromEntries(
        [
          ['main', resolve(__dirname, 'index.html')],
          ...listExampleEntries().map(
            (ex) => [ex.name, resolve(__dirname, `examples/${ex.name}/index.html`)],
          ),
        ],
      ),
    },
  },
});
