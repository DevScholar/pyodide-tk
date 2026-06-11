/**
 * Shared example boot. Each example's index.html provides the Python source via a
 * `<script type="text/python" id="demo">` block. Two modes:
 *
 *   data-src="demo.py"   — fetch the .py file (preferred; single source of truth)
 *   inline content        — fallback for small examples that don't warrant a .py file
 *
 *   <script type="module" src="/examples/_shared/boot.ts"></script>
 */
import { runDemo } from '../../src/demo-harness.js';

const demoEl = document.getElementById('demo');
if (!demoEl) throw new Error('boot: missing <script id="demo">');

let code: string;
const src = demoEl.getAttribute('data-src');
if (src) {
  const resp = await fetch(new URL(src, window.location.href).href);
  if (!resp.ok) throw new Error(`boot: fetch ${src} failed (${resp.status})`);
  code = await resp.text();
} else {
  code = demoEl.textContent!;
}
if (!code) throw new Error('boot: no Python source');

const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
if (!canvas) throw new Error('boot: missing #canvas');

runDemo({ pythonCode: code, canvas });
