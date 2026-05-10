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

import { createEmX11, type EmX11 } from '@emx11/index.js';
import { makeSideModuleSurface } from '@emx11/host/connection.js';
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
  MouseRelay,
  KeyRelay,
  TextKeyRelay,
} from './worker-protocol.js';

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: WorkerOutboundMessage, transfer?: Transferable[]): void {
  if (transfer && transfer.length) ctx.postMessage(msg, transfer);
  else ctx.postMessage(msg);
}

let emX11: EmX11 | null = null;
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
    case 'textKey':
      onTextKey(msg);
      break;
  }
});

function onMouse(m: MouseRelay): void {
  if (!emX11) return;
  if (m.type === 'mousedown') {
    emX11.display.inject.mouseDown({ x: m.x, y: m.y, button: m.button, modifiers: m.modifiers });
  } else if (m.type === 'mouseup') {
    emX11.display.inject.mouseUp({ x: m.x, y: m.y, button: m.button, modifiers: m.modifiers });
  } else {
    emX11.display.inject.mouseMove({ x: m.x, y: m.y, modifiers: m.modifiers });
  }
}

function onKey(k: KeyRelay): void {
  if (!emX11) return;
  if (k.type === 'keydown') {
    emX11.display.inject.keyDown({ keysym: k.keysym, modifiers: k.modifiers, hasFocus: k.hasFocus, text: k.text });
  } else {
    emX11.display.inject.keyUp({ keysym: k.keysym, modifiers: k.modifiers, hasFocus: k.hasFocus, text: k.text });
  }
}

function onTextKey(t: TextKeyRelay): void {
  if (!emX11 || !t.text) return;
  emX11.display.inject.textKey(t.text);
}

async function boot(
  surface: OffscreenCanvas,
  width: number,
  height: number,
  demoCode: string,
): Promise<void> {
  // 1. Construct em-x11 BEFORE Pyodide loads libemx11.so -- the EM_JS
  //    bridges in libemx11 read globalThis.emX11 synchronously from
  //    each X call, and createEmX11 mirrors itself onto that slot.
  //
  //    textInputRemote: forward XSetICFocus / Tk_SetCaretPos commands
  //    to main, which owns the hidden <textarea> the OS IME anchors to.
  //    Without this the worker's TextInputOverlay no-ops (no DOM in a
  //    worker realm) and the OS IME has no anchor element -- shift can't
  //    flip Chinese/English, no candidate window appears.
  emX11 = await createEmX11({
    canvas: surface,
    width,
    height,
    textInputRemote: {
      setFocus: (window) => post({ type: 'imeFocus', window }),
      clearFocus: () => post({ type: 'imeClearFocus' }),
      setSpot: (window, spotX, spotY) =>
        post({ type: 'imeSpot', window, spotX, spotY }),
      positionHint: (absX, absY) =>
        post({ type: 'imePositionHint', absX, absY }),
    },
  });

  // 2. Kick off ALL pyodide-tk asset downloads AND the pyodide.mjs import
  //    in one parallel group, before we await any of them. The HTTP layer
  //    fetches everything concurrently with Pyodide's own pyodide.asm.wasm
  //    (~9 MB) + python_stdlib.zip downloads (those start once we await
  //    loadPyodide below). Including the dynamic import in this group --
  //    rather than awaiting it after the fetches start -- lets the browser
  //    begin downloading pyodide.mjs alongside the assets instead of after
  //    the asset fetch() calls have all been issued. `<link rel="preload">`
  //    in index.html warms the connection earlier still; this turns the
  //    cache hit into actual parallel transfer.
  const fetchAB = (url: string): Promise<ArrayBuffer> =>
    fetch(url).then((r) => {
      if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
      return r.arrayBuffer();
    });
  const A = '/pyodide-tk-assets';
  const pyodideUrl = new URL('/pyodide/pyodide.mjs', ctx.location.origin).href;
  const indexURL = new URL('/pyodide/', ctx.location.origin).href;
  const pending = {
    pyodide:   import(/* @vite-ignore */ pyodideUrl),
    libtcl:    fetchAB(`${A}/lib/libtcl8.6.so`),
    libtk:     fetchAB(`${A}/lib/libtk8.6.so`),
    libemx11:  fetchAB(`${A}/lib/libemx11.so`),
    libwacl:   fetchAB(`${A}/lib/libwacl.so`).catch(() => null),
    tkinterSo: fetchAB(`${A}/lib/_tkinter.so`),
    turtle:    fetchAB(`${A}/turtle.py`),
    tclLib:    fetchAB(`${A}/tcl-library.tar`),
    tkLib:     fetchAB(`${A}/tk-library.tar`),
    tkinterTar:fetchAB(`${A}/tkinter.tar`),
  };

  // 3. Load Pyodide. In a worker we still resolve URLs against the page
  //    origin (same as main-thread path). importScripts is gone in
  //    type=module workers; use dynamic import.
  const { loadPyodide } = await pending.pyodide;

  const py = await loadPyodide({
    indexURL,
    env: {
      TCL_LIBRARY: '/usr/lib/tcl8.6',
      TK_LIBRARY: '/usr/lib/tk8.6',
      DISPLAY: ':0',
      HOME: '/home/pyodide',
    },
  });

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
  const libwaclBuf = await pending.libwacl;
  if (libwaclBuf) writeFromBuf(libwaclBuf, '/usr/lib/libwacl.so');
  writeFromBuf(await pending.tkinterSo, '/lib/python3.14/site-packages/_tkinter.so');
  // turtle is a single-file stdlib module that imports tkinter; Pyodide
  // strips it from python_stdlib.zip alongside tkinter, so we stage the
  // CPython source copy next to _tkinter.so. Cheap (~150 KB) and lets
  // any demo `import turtle` regardless of whether it uses it.
  writeFromBuf(await pending.turtle,    '/lib/python3.14/site-packages/turtle.py');

  py.FS.mkdirTree('/usr/lib/tcl8.6');
  py.FS.mkdirTree('/usr/lib/tk8.6');
  py.FS.mkdirTree('/lib/python3.14/site-packages/tkinter');
  py.unpackArchive(await pending.tclLib,     'tar', { extractDir: '/usr/lib/tcl8.6' });
  py.unpackArchive(await pending.tkLib,      'tar', { extractDir: '/usr/lib/tk8.6' });
  py.unpackArchive(await pending.tkinterTar, 'tar', { extractDir: '/lib/python3.14/site-packages/tkinter' });

  // 5. Load side modules. libemx11 is the bridge entry point -- nothing
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
  //
  //     em-x11's public API doesn't yet expose this binding directly
  //     (it's specific to the Pyodide-loads-libemx11-itself flow), so
  //     reach through emX11._host. TODO: lift this into a public method
  //     such as emX11.dlopen('/usr/lib/libemx11.so') auto-binding the
  //     resulting export table.
  const moduleSurface = makeSideModuleSurface(
    libemx11Exports as unknown as Record<string, (...args: unknown[]) => unknown>,
    py._module as unknown as {
      _malloc(size: number): number;
      _free(ptr: number): void;
      stringToUTF8(str: string, ptr: number, max: number): void;
      lengthBytesUTF8(str: string): number;
    },
  );
  emX11._host.connection.setDefaultModule(moduleSurface);

  await py._api.loadDynlib('/lib/python3.14/site-packages/_tkinter.so', { global: false, allowUndefined: true });

  // 4d. libwacl: ::wacl::dom and ::wacl::jscall Tcl commands. Loaded
  //     globally so its Wacl_Init export is reachable via ctypes.CDLL.
  //     Optional -- if the .so is missing (sibling wacl-tk not built),
  //     we skip silently and the prelude below no-ops.
  if (libwaclBuf) {
    await py._api.loadDynlib('/usr/lib/libwacl.so', { global: true, allowUndefined: true });
  }

  // 5. Worker-side prelude.
  //
  //    Patch 1 -- tkinter.Misc.after(ms) sync sleep:
  //    The no-callback variant of Misc.after lowers to Tcl's sync
  //    `after delay`, which busy-loops Tcl_DoOneEvent under wallclock
  //    until the time elapses. libemx11/libtcl/libtk are built without
  //    Asyncify (Pyodide 314 uses JSPI instead) so emscripten_sleep(1)
  //    inside em-x11's notifier resolves to a no-op stub. Without a
  //    yield, turtle's per-step _cv.after(delay) burns ~7s of CPU
  //    while painting nothing. Routing the sync-sleep branch through
  //    pyodide.ffi.run_sync(asyncio.sleep(...)) suspends the wasm stack
  //    via JSPI, the JS event loop runs (browser composites a frame),
  //    then resumes -- exactly the yielding semantics turtle needs.
  //    Misc.after-with-callback paths fall through unchanged.
  //
  //    Patch 2 -- Misc.mainloop / tkinter.mainloop JSPI loop:
  //    Standard desktop tkinter / turtle code ends with `root.mainloop()`
  //    or `turtle.done()` (which calls `tkinter.mainloop()`). The C
  //    Tkapp_MainLoop calls Tcl_DoOneEvent(0) in a tight loop with no
  //    yield to JS, so the browser never composites and the worker is
  //    wedged. Replace both entry points with an async loop that drains
  //    via dooneevent(2) (TCL_DONT_WAIT) and yields a frame between
  //    batches via JSPI run_sync. Loop exits naturally when the interp
  //    is deleted (root.destroy()), at which point tk.dooneevent raises.
  //
  //    Note: we deliberately do NOT patch Misc.update / Misc.update_idletasks
  //    to yield. Those are "flush pending events" not "show now" -- the
  //    next yield (a Misc.after sleep, or mainloop's batch yield) will
  //    composite the post-update state. Yielding inside update() makes
  //    turtle's _Screen.setup() show its default-sized scroll area for
  //    a frame before the geometry resize lands.
  //
  //    Standard turtle / tkinter / user code stays untouched -- we
  //    only patch the C-extension Python wrappers, here in the worker
  //    prelude.
  await py.runPythonAsync(`
import tkinter, asyncio, js, ctypes
from pyodide.ffi import run_sync, create_once_callable

# wacl bridge: ::wacl::dom and ::wacl::jscall Tcl commands. The .so is
# loaded globally above; bind Wacl_Init via ctypes and call it on every
# Tk root immediately after construction so demos can use the commands
# without any setup boilerplate. If libwacl wasn't shipped (sibling
# wacl-tk not built), the CDLL load fails and we leave Tk.__init__
# alone -- standard tkinter still works, ::wacl::* just isn't there.
try:
    _wacl = ctypes.CDLL('/usr/lib/libwacl.so')
    _wacl.Wacl_Init.argtypes = [ctypes.c_void_p]
    _wacl.Wacl_Init.restype  = ctypes.c_int
    _wacl_orig_tk_init = tkinter.Tk.__init__
    def _wacl_install_on_tk(self, *a, **kw):
        _wacl_orig_tk_init(self, *a, **kw)
        try:
            _wacl.Wacl_Init(self.tk.interpaddr())
        except Exception as e:
            print('wacl: Wacl_Init failed:', e)
    tkinter.Tk.__init__ = _wacl_install_on_tk
except OSError:
    pass

async def _emx11_yield_frame():
    fut = asyncio.get_event_loop().create_future()
    # create_once_callable: keep the Python callback alive until JS
    # actually fires it. A bare lambda would be a borrowed proxy that
    # Pyodide auto-destroys when js.setTimeout returns.
    js.setTimeout(create_once_callable(lambda: fut.set_result(None)), 0)
    await fut

_emx11_orig_after = tkinter.Misc.after
def _emx11_yielding_after(self, ms, func=None, *args):
    if func is None:
        run_sync(asyncio.sleep(ms / 1000))
        return None
    return _emx11_orig_after(self, ms, func, *args)
tkinter.Misc.after = _emx11_yielding_after

# Misc.mainloop / tkinter.mainloop replacement.
#
# Why not run an asyncio-based event loop here:
#
#    Pyodide's WebLoop wakes via MessageChannel.postMessage, and JSPI
#    resume re-enters wasm through _pyproxy_apply_promising. Each
#    iteration of an async loop that registers a setTimeout-backed
#    future stacks one more JSPI resume frame on the V8 native stack
#    before the previous one fully unwinds (Chrome treats the
#    MessageChannel callback as a microtask-ish continuation, not a
#    fresh task). Tk keypress handlers fire many short Tcl callbacks,
#    so a few seconds of typing is enough to exhaust the 5 MB native
#    stack -- the Pyodide RecursionError "in comparison" out of
#    webloop.call_later is the symptom.
#
# Standard desktop tkinter code ends with root.mainloop() (or
# turtle.done() which calls tkinter.mainloop()). We just need that
# call to return so runPythonAsync() resolves -- the JS-side
# setTimeout(pump, 8) loop in worker.ts then drives Tcl_DoOneEvent at
# a steady ~125 Hz, which is enough for entries, animations, and
# turtle. No JSPI suspends per tick, no stack accumulation.
def _emx11_misc_mainloop(self, n=0):
    return None
tkinter.Misc.mainloop = _emx11_misc_mainloop

def _emx11_module_mainloop(n=0):
    return None
tkinter.mainloop = _emx11_module_mainloop
`);

  // 6. Run the user's app code via runPythonAsync so the wasm call stack
  //    is JSPI-suspendable (required for the run_sync inside the patched
  //    tkinter.Misc.after / mainloop to actually suspend rather than
  //    fault). Standard desktop tkinter / turtle code is supported
  //    unchanged: if the demo ends with `root.mainloop()` or
  //    `turtle.done()`, our patched mainloop drives events forever via
  //    JSPI yields, and runPythonAsync never returns. If the demo just
  //    paints once and exits, control falls through to the JS pump
  //    below, which keeps draining for any background events.
  post({ type: 'ready' });
  await py.runPythonAsync(demoCode);

  // 6. Define the drain helper. Going through tkinter.Tk()'s
  //    tkapp.dooneevent is mandatory for GIL safety: Tkapp_DoOneEvent
  //    wraps Tcl_DoOneEvent with ENTER_TCL/LEAVE_TCL which set
  //    _tkinter's `tcl_tstate` global so Tcl callbacks (button -command,
  //    default <Configure> bindings, etc.) can re-enter Python via
  //    PyEval_RestoreThread. Calling Tcl_DoOneEvent directly via
  //    ccall fatals on the first such callback ("PyEval_RestoreThread:
  //    GIL is released, current Python thread state is NULL"). Drain
  //    inside Python so we pay only one PyProxy crossing per tick.
  //    Use tkinter._default_root so the demo doesn't have to expose
  //    anything -- standard `tkinter.Tk()` / `turtle.Screen()` both set
  //    _default_root automatically.
  py.runPython(`
def _emx11_drain(max_n=256):
    root = tkinter._default_root
    if root is None:
        return 0
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
    const n = drain(1024);
    if (n === 0) break;
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  // 8. Start the long-running pump (one drain per setTimeout tick).
  function pump(): void {
    drain(256);
    setTimeout(pump, 8);
  }
  setTimeout(pump, 0);
}
