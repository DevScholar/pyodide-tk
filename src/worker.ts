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
  // Phase timer: log how long each chunk of boot takes so we can target
  // optimisation at the actual bottleneck (Pyodide init? unpackArchive?
  // loadDynlib? Tk realize/map?). All times in ms, relative to boot start.
  const t0 = performance.now();
  let tPrev = t0;
  const phase = (label: string): void => {
    const now = performance.now();
    note(`[boot] +${(now - tPrev).toFixed(0).padStart(4)}ms  ${(now - t0).toFixed(0).padStart(5)}ms total  ${label}`);
    tPrev = now;
  };

  // 1. Install em-x11 host on this worker's globalThis BEFORE Pyodide
  //    loads libemx11.so -- the EM_JS bridges in libemx11 read
  //    globalThis.__EMX11__ synchronously from each X call.
  host = new Host({ surface, width, height });
  host.install();
  phase('host installed');

  // 2. Kick off ALL pyodide-tk asset downloads NOW, before we even import
  //    pyodide.mjs. The HTTP layer fetches them concurrently with Pyodide's
  //    own pyodide.asm.wasm (~9 MB) + python_stdlib.zip downloads, instead
  //    of waiting until loadPyodide() resolves. We bind ArrayBuffer
  //    promises here and `await` them later when staging to MEMFS.
  //    `<link rel="preload">` in index.html warms the connection earlier
  //    still; this turns the cache hit into actual parallel transfer.
  const fetchAB = (url: string): Promise<ArrayBuffer> =>
    fetch(url).then((r) => {
      if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
      return r.arrayBuffer();
    });
  const A = '/pyodide-tk-assets';
  const pending = {
    libtcl:    fetchAB(`${A}/lib/libtcl8.6.so`),
    libtk:     fetchAB(`${A}/lib/libtk8.6.so`),
    libemx11:  fetchAB(`${A}/lib/libemx11.so`),
    tkinterSo: fetchAB(`${A}/lib/_tkinter.so`),
    turtle:    fetchAB(`${A}/turtle.py`),
    tclLib:    fetchAB(`${A}/tcl-library.tar`),
    tkLib:     fetchAB(`${A}/tk-library.tar`),
    tkinterTar:fetchAB(`${A}/tkinter.tar`),
  };
  phase('asset fetches kicked off');

  // 3. Load Pyodide. In a worker we still resolve URLs against the page
  //    origin (same as main-thread path). importScripts is gone in
  //    type=module workers; use dynamic import.
  const pyodideUrl = new URL('/pyodide/pyodide.mjs', ctx.location.origin).href;
  const indexURL = new URL('/pyodide/', ctx.location.origin).href;
  const { loadPyodide } = await import(/* @vite-ignore */ pyodideUrl);
  phase('import(pyodide.mjs)');

  const py = await loadPyodide({
    indexURL,
    env: {
      TCL_LIBRARY: '/usr/lib/tcl8.6',
      TK_LIBRARY: '/usr/lib/tk8.6',
      DISPLAY: ':0',
      HOME: '/home/pyodide',
    },
  });
  phase('loadPyodide');

  // 4. Stage the prefetched bytes into Pyodide's MEMFS. .so files +
  //    turtle.py go via FS.writeFile; the tcl/tk/tkinter trees ship as
  //    one .tar each and are extracted via py.unpackArchive (in C, ~30x
  //    faster than 1000+ per-file FS.writeFile round-trips).
  py.FS.mkdirTree('/usr/lib');
  py.FS.mkdirTree('/lib/python3.14/site-packages');
  const writeFromBuf = (buf: ArrayBuffer, memPath: string): void => {
    py.FS.writeFile(memPath, new Uint8Array(buf));
  };
  writeFromBuf(await pending.libtcl,    '/usr/lib/libtcl8.6.so');
  writeFromBuf(await pending.libtk,     '/usr/lib/libtk8.6.so');
  writeFromBuf(await pending.libemx11,  '/usr/lib/libemx11.so');
  writeFromBuf(await pending.tkinterSo, '/lib/python3.14/site-packages/_tkinter.so');
  // turtle is a single-file stdlib module that imports tkinter; Pyodide
  // strips it from python_stdlib.zip alongside tkinter, so we stage the
  // CPython source copy next to _tkinter.so. Cheap (~150 KB) and lets
  // any demo `import turtle` regardless of whether it uses it.
  writeFromBuf(await pending.turtle,    '/lib/python3.14/site-packages/turtle.py');
  phase('stage .so + turtle.py');

  py.FS.mkdirTree('/usr/lib/tcl8.6');
  py.FS.mkdirTree('/usr/lib/tk8.6');
  py.FS.mkdirTree('/lib/python3.14/site-packages/tkinter');
  py.unpackArchive(await pending.tclLib,     'tar', { extractDir: '/usr/lib/tcl8.6' });
  phase('unpack tcl-library.tar');
  py.unpackArchive(await pending.tkLib,      'tar', { extractDir: '/usr/lib/tk8.6' });
  phase('unpack tk-library.tar');
  py.unpackArchive(await pending.tkinterTar, 'tar', { extractDir: '/lib/python3.14/site-packages/tkinter' });
  phase('unpack tkinter.tar');

  // 5. Load side modules. libemx11 is the bridge entry point -- nothing
  //    else NEEDs it, so load manually. Loading it pulls libtcl via
  //    libemx11's NEEDED entry (see Makefile $(LIBDIR)/libemx11.so step).
  //    _tkinter then pulls libtk via NEEDED, and libtk's Xlib refs
  //    resolve against the already-loaded libemx11.
  await py._api.loadDynlib('/usr/lib/libemx11.so', { global: true, allowUndefined: true });
  phase('loadDynlib libemx11');

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
  phase('loadDynlib _tkinter');

  // 5. Worker-side prelude: tkinter.Misc.after(ms) (the no-callback sync
  //    sleep variant) lowers to Tcl's `after delay` which busy-loops
  //    Tcl_DoOneEvent under wall-clock until the time elapses. In
  //    Pyodide that burns the JS event loop -- our libemx11/libtcl/libtk
  //    are built without Asyncify (Pyodide 314 uses JSPI instead), so
  //    emscripten_sleep(1) inside the em-x11 notifier is an unresolved
  //    no-op stub. Result: turtle.forward() at speed 3 stalls ~7s with
  //    zero frames painted.
  //
  //    Fix: monkey-patch tkinter.Misc.after to route the sync-sleep
  //    branch through pyodide.ffi.run_sync(asyncio.sleep(...)). run_sync
  //    suspends the Python wasm stack via JSPI, the JS event loop runs
  //    (browser paints frames), then resumes -- exactly the yielding
  //    semantics turtle's animation needs. All Tk's after-with-callback
  //    paths fall through unchanged. Standard turtle / tkinter / user
  //    code stays untouched; this patches the C-extension Python wrapper
  //    only, in our worker prelude.
  await py.runPythonAsync(`
import tkinter, asyncio
from pyodide.ffi import run_sync
_emx11_orig_after = tkinter.Misc.after
def _emx11_yielding_after(self, ms, func=None, *args):
    if func is None:
        run_sync(asyncio.sleep(ms / 1000))
        return None
    return _emx11_orig_after(self, ms, func, *args)
tkinter.Misc.after = _emx11_yielding_after
`);
  phase('install Misc.after JSPI yield patch');

  // 6. Run the user's app code via runPythonAsync so the wasm call stack
  //    is JSPI-suspendable (required for the run_sync inside the patched
  //    tkinter.Misc.after to actually suspend rather than fault).
  //
  //    Demo must still bind a module-level `root = tkinter.Tk()` (or
  //    `Screen()._root`); the drain helper below references it.
  await py.runPythonAsync(demoCode);
  phase('runPython demoCode (async)');

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
  let settleIters = 0;
  let settleDrained = 0;
  for (let i = 0; i < 20; i++) {
    const n = drain(1024);
    settleDrained += n;
    settleIters++;
    if (n === 0) break;
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  phase(`settle (${settleIters} iters, ${settleDrained} events drained)`);

  // 8. Start the long-running pump (one drain per setTimeout tick).
  function pump(): void {
    drain(256);
    setTimeout(pump, 8);
  }
  setTimeout(pump, 0);

  post({ type: 'ready' });
}
