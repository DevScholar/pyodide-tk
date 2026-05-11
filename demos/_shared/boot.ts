/**
 * Shared demo boot. Each demo's index.html ships a `<script type="text/python"
 * id="demo">` block with a standard desktop tkinter / turtle program. This
 * module reads it and hands it to runDemo. Demos load this via:
 *
 *   <script type="module" src="/demos/_shared/boot.ts"></script>
 *
 * Anything demo-specific (preload tags, page title, headline copy, the
 * Python source itself) stays in the per-demo index.html.
 */
import { runDemo } from '../../src/demo-harness.js';

const demoEl = document.getElementById('demo');
if (!demoEl) throw new Error('boot: missing <script id="demo">');
const code = demoEl.textContent;
if (!code) throw new Error('boot: <script id="demo"> is empty');

runDemo({ pythonCode: code });
