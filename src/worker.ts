/**
 * pyodide-tk worker.
 *
 * Runs Pyodide + Tcl/Tk + em-x11 host entirely off the main thread.
 * The main thread transfers an OffscreenCanvas via the 'init' message
 * and forwards mouse/keyboard events as plain data; this worker owns
 * everything else (Pyodide load, asset staging, side-module dlopen,
 * Tk widget tree, RAF-equivalent pump).
 *
 * Why a worker: the Tcl event loop must be driven by JS calling
 * `_bootstrap_app.dooneevent()` repeatedly (so the GIL is released
 * around each Tcl_DoOneEvent and Python callbacks like button -command
 * can re-enter the interpreter). On the main thread, a tight pump
 * starves the rendering pipeline -- gray square takes 14s, widgets
 * never finish their map chain. In a worker the JS pump runs on its
 * own thread; the main thread is free to schedule paints and route
 * input.
 */

import { Host } from '@emx11/host/index.js';
import { makeSideModuleSurface } from '@emx11/host/connection.js';
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
  MouseRelay,
  KeyRelay,
} from './worker-protocol.js';

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: WorkerOutboundMessage, transfer?: Transferable[]): void {
  if (transfer && transfer.length) ctx.postMessage(msg, transfer);
  else ctx.postMessage(msg);
}

function note(...parts: unknown[]): void {
  const line = parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ');
  post({ type: 'log', line });
}

let host: Host | null = null;
let booted = false;

ctx.addEventListener('message', (ev: MessageEvent<WorkerInboundMessage>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      if (booted) return;
      booted = true;
      void boot(msg.surface, msg.width, msg.height, msg.demoCode).catch((err) => {
        post({ type: 'error', message: String(err?.stack ?? err) });
      });
      break;
    case 'mousedown':
    case 'mouseup':
    case 'mousemove':
      onMouse(msg);
      break;
    case 'keydown':
    case 'keyup':
      onKey(msg);
      break;
  }
});

function onMouse(m: MouseRelay): void {
  if (!host) return;
  if (m.type === 'mousedown') {
    host.devices.pushMouseDown({ x: m.x, y: m.y, button: m.button, modifiers: m.modifiers });
  } else if (m.type === 'mouseup') {
    host.devices.pushMouseUp({ x: m.x, y: m.y, button: m.button, modifiers: m.modifiers });
  } else {
    host.devices.pushMouseMove({ x: m.x, y: m.y, modifiers: m.modifiers });
  }
}

function onKey(k: KeyRelay): void {
  if (!host) return;
  if (k.type === 'keydown') {
    host.devices.pushKeyDown({ keysym: k.keysym, modifiers: k.modifiers, hasFocus: k.hasFocus });
  } else {
    host.devices.pushKeyUp({ keysym: k.keysym, modifiers: k.modifiers, hasFocus: k.hasFocus });
  }
}

async function boot(
  surface: OffscreenCanvas,
  width: number,
  height: number,
  demoCode: string,
): Promise<void> {
  // 1. Install em-x11 host on this worker's globalThis BEFORE Pyodide
  //    loads libemx11.so -- the EM_JS bridges in libemx11 read
  //    globalThis.__EMX11__ synchronously from each X call.
  host = new Host({ surface, width, height });
  host.install();

  // 2. Load Pyodide. In a worker we still resolve URLs against the page
  //    origin (same as main-thread path). importScripts is gone in
  //    type=module workers; use dynamic import.
  const pyodideUrl = new URL('/pyodide/pyodide.mjs', ctx.location.origin).href;
  const indexURL = new URL('/pyodide/', ctx.location.origin).href;
  const { loadPyodide } = await import(/* @vite-ignore */ pyodideUrl);

  const py = await loadPyodide({
    indexURL,
    env: {
      TCL_LIBRARY: '/usr/lib/tcl8.6',
      TK_LIBRARY: '/usr/lib/tk8.6',
      DISPLAY: ':0',
      HOME: '/home/pyodide',
    },
  });

  // 3. Stage all assets from /pyodide-tk-assets/ into Pyodide's MEMFS.
  //    Side modules (.so) are 4 small files — fetch directly. Script
  //    libraries (tcl ~832 / tk ~170 / tkinter ~13 files) ship as a
  //    single .tar each; py.unpackArchive extracts them in C, which is
  //    ~30x faster than 1000+ per-file fetch+writeFile round-trips.
  async function fetchBytes(url: string): Promise<Uint8Array> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  async function stageFile(srcUrl: string, memPath: string): Promise<void> {
    const bytes = await fetchBytes(srcUrl);
    const dir = memPath.replace(/\/[^/]+$/, '');
    if (dir) py.FS.mkdirTree(dir);
    py.FS.writeFile(memPath, bytes);
  }
  async function stageTar(srcUrl: string, extractDir: string): Promise<void> {
    py.FS.mkdirTree(extractDir);
    const r = await fetch(srcUrl);
    if (!r.ok) throw new Error(`fetch ${srcUrl}: ${r.status}`);
    const buf = await r.arrayBuffer();
    py.unpackArchive(buf, 'tar', { extractDir });
  }

  py.FS.mkdirTree('/usr/lib');
  py.FS.mkdirTree('/lib/python3.14/site-packages');
  await stageFile('/pyodide-tk-assets/lib/libtcl8.6.so', '/usr/lib/libtcl8.6.so');
  await stageFile('/pyodide-tk-assets/lib/libtk8.6.so',  '/usr/lib/libtk8.6.so');
  await stageFile('/pyodide-tk-assets/lib/libemx11.so',  '/usr/lib/libemx11.so');
  await stageFile('/pyodide-tk-assets/lib/_tkinter.so',  '/lib/python3.14/site-packages/_tkinter.so');

  await stageTar('/pyodide-tk-assets/tcl-library.tar', '/usr/lib/tcl8.6');
  await stageTar('/pyodide-tk-assets/tk-library.tar', '/usr/lib/tk8.6');
  await stageTar('/pyodide-tk-assets/tkinter.tar', '/lib/python3.14/site-packages/tkinter');

  // 4. Load side modules. libemx11 is the bridge entry point -- nothing
  //    else NEEDs it, so load manually. Loading it pulls libtcl via
  //    libemx11's NEEDED entry (see Makefile $(LIBDIR)/libemx11.so step).
  //    _tkinter then pulls libtk via NEEDED, and libtk's Xlib refs
  //    resolve against the already-loaded libemx11.
  await py._api.loadDynlib('/usr/lib/libemx11.so', { global: true, allowUndefined: true });

  // 4b. Install browser-friendly Tcl notifier BEFORE Tk_Init runs.
  const libemx11Exports = py._module.LDSO.loadedLibsByName['/usr/lib/libemx11.so']?.exports;
  if (!libemx11Exports?.emx11_install_browser_notifier) {
    throw new Error('emx11_install_browser_notifier not found in libemx11 exports');
  }
  (libemx11Exports.emx11_install_browser_notifier as () => void)();

  // 4c. Pre-bind libemx11's exports as the default module for ANY
  //     future XOpenDisplay. Doing this BEFORE _tkinter loads means
  //     tkinter.Tk()'s very first XOpenDisplay picks up the surface
  //     automatically -- we don't need a manual `_tkinter.create`
  //     bootstrap call (which would create a second redundant Tk root
  //     that ends up obscuring the real widgets).
  const moduleSurface = makeSideModuleSurface(
    libemx11Exports as unknown as Record<string, (...args: unknown[]) => unknown>,
  );
  host.connection.setDefaultModule(moduleSurface);

  await py._api.loadDynlib('/lib/python3.14/site-packages/_tkinter.so', { global: false, allowUndefined: true });

  // 5. Run the user's app code. It must create a `root = tkinter.Tk()`
  //    binding in __main__; the drain helper below references it. The
  //    very first XOpenDisplay picks up the surface via the defaultModule
  //    set above -- no manual `_tkinter.create` bootstrap needed (which
  //    would create a second redundant Tk root that obscures the real
  //    widgets).
  py.runPython(demoCode);

  // 6. Define the drain helper. Going through tkinter.Tk()'s
  //    tkapp.dooneevent is mandatory for GIL safety: Tkapp_DoOneEvent
  //    wraps Tcl_DoOneEvent with ENTER_TCL/LEAVE_TCL which set
  //    _tkinter's `tcl_tstate` global so Tcl callbacks (button -command,
  //    default <Configure> bindings, etc.) can re-enter Python via
  //    PyEval_RestoreThread. Calling Tcl_DoOneEvent directly via
  //    ccall fatals on the first such callback ("PyEval_RestoreThread:
  //    GIL is released, current Python thread state is NULL"). Drain
  //    inside Python so we pay only one PyProxy crossing per tick.
  py.runPython(`
def _emx11_drain(max_n=256):
    n = 0
    while n < max_n and root.tk.dooneevent(2):
        n += 1
    return n
`);
  const drain = py.runPython(`_emx11_drain`) as (max: number) => number;

  // 7. Settle: Tk's realize/map/expose chain contains many `after 0`
  //    callbacks. Drain → setTimeout(0) → drain until quiescent so
  //    those timers fire (the browser-friendly Tcl notifier translates
  //    them to real setTimeout(0)s).
  for (let i = 0; i < 20; i++) {
    if (drain(1024) === 0) break;
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  // 8. Start the long-running pump (one drain per setTimeout tick).
  function pump(): void {
    drain(256);
    setTimeout(pump, 8);
  }
  setTimeout(pump, 0);

  post({ type: 'ready' });
}
