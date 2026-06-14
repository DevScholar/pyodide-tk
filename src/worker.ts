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

import { createEmX11, type EmX11 } from '@emX11/index.js';
import { makeSideModuleSurface } from '@emX11/host/connection.js';
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
  MouseRelay,
  KeyRelay,
  WheelRelay,
  TextKeyRelay,
} from './worker-protocol.js';

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: WorkerOutboundMessage, transfer?: Transferable[]): void {
  if (transfer && transfer.length) ctx.postMessage(msg, transfer);
  else ctx.postMessage(msg);
}

function logToMain(line: string): void {
  post({ type: 'log', line });
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
    case 'wheel':
      onWheel(msg);
      break;
    case 'textKey':
      onTextKey(msg);
      break;
    case 'clipboardStage':
      onClipboardStage(msg.bytes);
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
  wakePump();
}

function onKey(k: KeyRelay): void {
  if (!emX11) return;
  if (k.type === 'keydown') {
    emX11.display.inject.keyDown({ keysym: k.keysym, keycode: k.keycode, modifiers: k.modifiers, hasFocus: k.hasFocus, text: k.text });
  } else {
    emX11.display.inject.keyUp({ keysym: k.keysym, keycode: k.keycode, modifiers: k.modifiers, hasFocus: k.hasFocus, text: k.text });
  }
  wakePump();
}

function onWheel(w: WheelRelay): void {
  if (!emX11) return;
  emX11.display.inject.wheel({ x: w.x, y: w.y, deltaY: w.deltaY, modifiers: w.modifiers });
  wakePump();
}

function onTextKey(t: TextKeyRelay): void {
  if (!emX11 || !t.text) return;
  emX11.display.inject.textKey(t.text);
  wakePump();
}

/** main → worker: clipboard bytes pre-fetched ahead of a paste action.
 *  libem_x11's em_x11_js_clipboard_read_begin reads
 *  globalThis.__emX11ClipboardBytes synchronously from this realm; the
 *  main thread can't touch the worker's globalThis so it has to relay
 *  via postMessage. */
function onClipboardStage(bytes: Uint8Array): void {
  /* Defensive copy: the Uint8Array we receive may be backed by a
   * transferred buffer; libem_x11 wants to mutate / null-out the cache
   * via _fetch, and the buffer must outlive the postMessage frame. */
  (globalThis as { __emX11ClipboardBytes?: Uint8Array | null }).__emX11ClipboardBytes =
    bytes && bytes.byteLength > 0 ? new Uint8Array(bytes) : null;
}

/* The pump's adaptive scheduler is installed by boot() once `drain` is
 * available. Until then wakePump is a no-op: input messages that arrive
 * before the user code finished loading just queue events in em-x11; the
 * post-settle pump kickoff drains them. */
let wakePump: () => void = () => {};

/* -------------------------------------------------------------------------
 * Pyodide private-API surface
 *
 * Pyodide does not yet expose `loadDynlib`, the in-memory exports table
 * (`_module.LDSO.loadedLibsByName`), or memory marshalling helpers
 * (`_malloc`/`stringToUTF8`) on its public surface. We need all three to
 * stand up libem_x11/_tkinter and to bind libem_x11's exports as the
 * em-x11 default module before _tkinter loads.
 *
 * Concentrating the casts here keeps the rest of boot() typed against
 * named local types -- when Pyodide adds public APIs (or renames the
 * internal slots in a minor release), this is the only block that needs
 * to move.
 * ------------------------------------------------------------------------- */

interface DynlibLoader {
  loadDynlib(path: string, opts: { global?: boolean; allowUndefined?: boolean }): Promise<void>;
}
interface PyMemorySurface {
  _malloc(size: number): number;
  _free(ptr: number): void;
  stringToUTF8(str: string, ptr: number, max: number): void;
  lengthBytesUTF8(str: string): number;
  LDSO: {
    loadedLibsByName: Record<string, { exports?: Record<string, unknown> } | undefined>;
  };
}
interface PyodideInternals {
  loadDynlib(path: string, opts?: { global?: boolean; allowUndefined?: boolean }): Promise<void>;
  loadedLibExports(path: string): Record<string, unknown> | undefined;
  memorySurface(): PyMemorySurface;
}

function pyodideInternals(py: unknown): PyodideInternals {
  const anyPy = py as { _api: DynlibLoader; _module: PyMemorySurface };
  return {
    loadDynlib(path, opts = {}) {
      return anyPy._api.loadDynlib(path, { allowUndefined: true, ...opts });
    },
    loadedLibExports(path) {
      return anyPy._module.LDSO.loadedLibsByName[path]?.exports;
    },
    memorySurface() {
      return anyPy._module;
    },
  };
}

async function boot(
  surface: OffscreenCanvas,
  width: number,
  height: number,
  demoCode: string,
): Promise<void> {
  /* --- Stage: parallel asset prefetch + pyodide.mjs import ---
   *
   * Kick off ALL pyodide-tk asset downloads AND the pyodide.mjs import
   * in one parallel group, before we await any of them. The HTTP layer
   * fetches everything concurrently with Pyodide's own pyodide.asm.wasm
   * (~9 MB) + python_stdlib.zip downloads (those start once we await
   * loadPyodide below). Including the dynamic import in this group --
   * rather than awaiting it after the fetches start -- lets the browser
   * begin downloading pyodide.mjs alongside the assets instead of after
   * the asset fetch() calls have all been issued. `<link rel="preload">`
   * in index.html warms the connection earlier still; this turns the
   * cache hit into actual parallel transfer.
   */
  const fetchAB = (url: string): Promise<ArrayBuffer> =>
    fetch(url).then((r) => {
      if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
      return r.arrayBuffer();
    });
  const fetchOptional = (url: string): Promise<ArrayBuffer | null> =>
    fetch(url).then((r) => {
      if (r.status === 404) return null;
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
    libEvQueue: fetchAB(`${A}/lib/libem_x11_event_queue.so`),
    libX11:    fetchAB(`${A}/lib/libX11.so`),
    libXft:    fetchAB(`${A}/lib/libXft.so`),
    libXrender:fetchAB(`${A}/lib/libXrender.so`),
    libfontconfig: fetchAB(`${A}/lib/libfontconfig.so`),
    libtcldide:    fetchOptional(`${A}/lib/libtcldide.so`),
    tkinterSo: fetchAB(`${A}/lib/_tkinter.so`),
    turtle:    fetchAB(`${A}/turtle.py`),
    tclLib:    fetchAB(`${A}/tcl-library.tar`),
    tkLib:     fetchAB(`${A}/tk-library.tar`),
    tkinterTar:fetchAB(`${A}/tkinter.tar`),
  };

  /* --- Stage: load Pyodide ---
   *
   * In a worker we still resolve URLs against the page origin (same as
   * main-thread path). importScripts is gone in type=module workers;
   * use dynamic import.
   */
  const { loadPyodide } = await pending.pyodide;

  const py = await loadPyodide({
    indexURL,
    env: {
      TCL_LIBRARY: '/usr/lib/tcl8.6',
      TK_LIBRARY: '/usr/lib/tk8.6',
      DISPLAY: ':0',
      HOME: '/home/pyodide',
    },
    /* Surface Python stderr (and traceback output) to main so it lands in
     * the harness log instead of the worker's hidden console. We don't
     * redirect stdout -- demo print() noise stays in DevTools. */
    stderr: (line: string) => logToMain(line),
  });

  /* Register the canvas through Pyodide's official canvas API so
   * SDL-based packages and user code that check pyodide.canvas or
   * Module.canvas find it. We pass the same surface directly to
   * createEmX11 so em-x11 paints into Pyodide's single source of truth. */
  (surface as unknown as Record<string,unknown>).id = 'canvas';
  py.canvas.setCanvas2D(surface as unknown as HTMLCanvasElement);

  /* --- Stage: em-x11 host (must precede libX11.so dlopen) ---
   *
   * The EM_JS bridges in libX11 read Module['emX11Host'] synchronously
   * from each X call; createEmX11/connection.open sets this slot.
   *
   * textInputRemote: forward XSetICFocus / Tk_SetCaretPos commands
   * to main, which owns the hidden <textarea> the OS IME anchors to.
   * Without this the worker's TextInputOverlay no-ops (no DOM in a
   * worker realm) and the OS IME has no anchor element -- shift can't
   * flip Chinese/English, no candidate window appears.
   */
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

  /* Tk wrote to CLIPBOARD: libem_x11's em_x11_js_clipboard_write_utf8
   * reads Module['emX11Host'].clipboardWriteRemote. Worker realm has
   * no reliable navigator.clipboard.writeText (no user activation
   * across the thread boundary), so we post the bytes back to main
   * where the DOM holds the permission. Install the hook on the
   * Host object that the bridge already reads. */
  (emX11._host as unknown as Record<string, unknown>).clipboardWriteRemote =
    (bytes: Uint8Array): void => {
      const snapshot = new Uint8Array(bytes);
      post({ type: 'clipboardWrite', bytes: snapshot });
    };

  /* Cursor bridge: em-x11's InputBridge.applyCursorFor() normally
   * writes el.style.cursor on the canvas DOM element. In a worker
   * (OffscreenCanvas) that path bails out. Install a remote so the
   * resolved CSS cursor is posted to main, which owns the visible
   * <canvas> and applies it there. Sent on XDefineCursor / CWCursor
   * changes and on every mouse move. */
  emX11._host.devices.setCursorRemote((css: string) => {
    post({ type: 'cursorChange', css });
  });

  /* With libX11.so loaded before libtcl8.6.so, Tcl's default Unix
   * notifier (tclUnixNotfy.c) calls select() which resolves to em-x11's
   * strong poll.c override. The override uses JSPI emscripten_sleep() for
   * blocking and adaptive polling (1-10ms) for "infinite" timeout. No
   * custom Tcl_SetNotifier is needed — the JS pump only operates during
   * the settle phase (before mainloop) where it calls dooneevent(DONT_WAIT)
   * in a synchronous Python loop.
   *
   * wakePump stays a no-op: input messages that arrive before drain is
   * bound are harmless. After boot, X events are picked up by the
   * C-driven poll() adaptive loop inside mainloop's blocking dooneevent. */
  let drainRef: ((max: number) => number) | null = null;

  const pyi = pyodideInternals(py);

  /* --- Stage: stage prefetched bytes into MEMFS ---
   *
   * .so files + turtle.py go via FS.writeFile; the tcl/tk/tkinter trees
   * ship as one .tar each and are extracted via py.unpackArchive (in C,
   * ~30x faster than 1000+ per-file FS.writeFile round-trips).
   *
   * Wait for all asset arrivals together before issuing the writes; the
   * write order itself is fixed, but the network fetches are independent.
   */
  py.FS.mkdirTree('/usr/lib');
  py.FS.mkdirTree('/lib/python3.14/site-packages');
  const [
    libtclBuf, libtkBuf, libEvQueueBuf, libX11Buf, libXftBuf, libXrenderBuf, libfontconfigBuf, libtcldideBuf, tkinterSoBuf,
    turtleBuf, tclLibBuf, tkLibBuf, tkinterTarBuf,
  ] = await Promise.all([
    pending.libtcl, pending.libtk, pending.libEvQueue, pending.libX11, pending.libXft, pending.libXrender, pending.libfontconfig,
    pending.libtcldide, pending.tkinterSo,
    pending.turtle, pending.tclLib, pending.tkLib, pending.tkinterTar,
  ]);
  const writeFromBuf = (buf: ArrayBuffer, memPath: string): void => {
    py.FS.writeFile(memPath, new Uint8Array(buf));
  };
  writeFromBuf(libtclBuf,       '/usr/lib/libtcl8.6.so');
  writeFromBuf(libtkBuf,        '/usr/lib/libtk8.6.so');
  writeFromBuf(libEvQueueBuf,   '/usr/lib/libem_x11_event_queue.so');
  writeFromBuf(libX11Buf,       '/usr/lib/libX11.so');
  writeFromBuf(libXftBuf,       '/usr/lib/libXft.so');
  writeFromBuf(libXrenderBuf,   '/usr/lib/libXrender.so');
  writeFromBuf(libfontconfigBuf,'/usr/lib/libfontconfig.so');
  if (libtcldideBuf) writeFromBuf(libtcldideBuf, '/usr/lib/libtcldide.so');
  writeFromBuf(tkinterSoBuf,    '/lib/python3.14/site-packages/_tkinter.so');
  /* turtle is a single-file stdlib module that imports tkinter; Pyodide
   * strips it from python_stdlib.zip alongside tkinter, so we stage the
   * CPython source copy next to _tkinter.so. Cheap (~150 KB) and lets
   * any demo `import turtle` regardless of whether it uses it. */
  writeFromBuf(turtleBuf,    '/lib/python3.14/site-packages/turtle.py');

  py.FS.mkdirTree('/usr/lib/tcl8.6');
  py.FS.mkdirTree('/usr/lib/tk8.6');
  py.FS.mkdirTree('/lib/python3.14/site-packages/tkinter');
  py.unpackArchive(tclLibBuf,     'tar', { extractDir: '/usr/lib/tcl8.6' });
  py.unpackArchive(tkLibBuf,      'tar', { extractDir: '/usr/lib/tk8.6' });
  py.unpackArchive(tkinterTarBuf, 'tar', { extractDir: '/lib/python3.14/site-packages/tkinter' });

  /* --- Stage: load em-x11 split side modules ---
   *
   * libem_x11_event_queue.so provides strong poll/select/ppoll/pselect
   * and signal delivery.  It is loaded BEFORE libtcl8.6.so so Tcl's
   * default Unix notifier resolves select() to the JSPI-capable override.
   * No custom Tcl_SetNotifier is needed.
   *
   *   1. libem_x11_event_queue.so — poll/select overrides + signal delivery
   *   2. libtcl8.6.so             — select() import → strong override from (1)
   *   3. libXft.so                — NEEDED cascade: libX11 (which NEEDED
   *                                  libem_x11_event_queue, already loaded),
   *                                  libXrender, libfontconfig
   *
   * _tkinter (loaded last) pulls libtk8.6.so via NEEDED; libtk's X11
   * symbols resolve from the already-loaded X11 split modules.
   */
  await pyi.loadDynlib('/usr/lib/libem_x11_event_queue.so', { global: true });
  await pyi.loadDynlib('/usr/lib/libtcl8.6.so', { global: true });
  await pyi.loadDynlib('/usr/lib/libXft.so', { global: true });

  /* Pre-bind libX11's exports as the default module for ANY future
   * XOpenDisplay. Doing this BEFORE _tkinter loads means tkinter.Tk()'s
   * very first XOpenDisplay picks up the surface automatically -- we
   * don't need a manual `_tkinter.create` bootstrap call (which would
   * create a second redundant Tk root that ends up obscuring the real
   * widgets).
   */
  const libX11Exports = pyi.loadedLibExports('/usr/lib/libX11.so');
  const moduleSurface = makeSideModuleSurface(
    libX11Exports as Record<string, (...args: unknown[]) => unknown>,
    pyi.memorySurface(),
  );
  emX11._host.connection.setDefaultModule(moduleSurface);

  await pyi.loadDynlib('/lib/python3.14/site-packages/_tkinter.so', { global: false });

  /* libtcldide: ::tcldide::dom and ::tcldide::jscall Tcl commands. Loaded
   * globally so its Tcldide_Init export is reachable via ctypes.CDLL.
   * Optional -- if the .so is missing (sibling tcldide not built),
   * we skip silently and the prelude below no-ops. */
  if (libtcldideBuf) {
    await pyi.loadDynlib('/usr/lib/libtcldide.so', { global: true });
  }

  /* --- Stage: worker-side Python prelude ---
   *
   * Patch -- tkinter.Misc.after(ms) sync sleep:
   * The no-callback variant of Misc.after lowers to Tcl's sync
   * `after delay`, which busy-loops Tcl_DoOneEvent(DONT_WAIT) until
   * the wall clock elapses — it never calls select() so it never
   * yields via JSPI. Without a yield, turtle's per-step
   * _cv.after(delay) burns ~7s of CPU while painting nothing.
   * Routing the sync-sleep branch through
   * pyodide.ffi.run_sync(asyncio.sleep(...)) suspends the wasm stack
   * via JSPI, the JS event loop runs (browser composites a frame),
   * then resumes — exactly the yielding semantics turtle needs.
   * Misc.after-with-callback paths fall through unchanged.
   *
   * Patch -- Misc.mainloop / tkinter.mainloop / Misc.quit:
   * Standard desktop tkinter / turtle / PySimpleGUI code assumes
   * `root.mainloop()` **blocks** until a callback invokes `root.quit()`.
   *
   * With libX11.so loaded before libtcl8.6.so, Tcl's default Unix
   * notifier calls select() which resolves to em-x11's strong poll()
   * override. poll() blocks via JSPI emscripten_sleep() until an
   * event arrives or a Tcl timer expires — same semantics as a real
   * Linux X11 client. The Python-level mainloop loop calls
   * `tkapp.dooneevent(0)` (plain TCL_ALL_EVENTS, no DONT_WAIT) which
   * suspends the wasm stack until Tcl has an event to dispatch.
   * X events landing during sleep are picked up by poll.c's adaptive
   * polling (1-10ms). Quit detection is a Python-level counter bumped
   * by a monkey-patched `Misc.quit`; nested mainloops work because
   * each level snapshots the counter on entry and exits when it bumps.
   *
   * Note: we deliberately do NOT patch Misc.update / Misc.update_idletasks
   * to yield. Those are "flush pending events" not "show now" -- the
   * next yield (a Misc.after sleep, or mainloop's batch yield) will
   * composite the post-update state. Yielding inside update() makes
   * turtle's _Screen.setup() show its default-sized scroll area for
   * a frame before the geometry resize lands.
   */
  await py.runPythonAsync(`
import tkinter, asyncio, js, ctypes
from pyodide.ffi import run_sync, create_once_callable

# Emscripten has no LANG/LC_ALL; Tcl defaults to iso8859-1.
# Pin system encoding to utf-8 so msgcat-sourced .msg files
# (zh_cn.msg etc.) decode correctly.
tkinter.Tcl().eval('encoding system utf-8')

# tcldide bridge: ::tcldide::dom and ::tcldide::jscall Tcl commands. The .so is
# loaded globally above; bind Tcldide_Init via ctypes and call it on every
# Tk root immediately after construction so examples can use the commands
# without any setup boilerplate. If libtcldide wasn't shipped (sibling
# tcldide not built), the CDLL load fails and we leave Tk.__init__
# alone -- standard tkinter still works, ::tcldide::* just isn't there.
try:
    _tcldide = ctypes.CDLL('/usr/lib/libtcldide.so')
    _tcldide.Tcldide_Init.argtypes = [ctypes.c_void_p]
    _tcldide.Tcldide_Init.restype  = ctypes.c_int
    _tcldide_orig_tk_init = tkinter.Tk.__init__
    def _tcldide_install_on_tk(self, *a, **kw):
        _tcldide_orig_tk_init(self, *a, **kw)
        try:
            _tcldide.Tcldide_Init(self.tk.interpaddr())
        except Exception as e:
            import sys
            print('tcldide: Tcldide_Init failed:', e, file=sys.stderr)
    tkinter.Tk.__init__ = _tcldide_install_on_tk
except OSError:
    pass

async def _em_x11_yield_frame():
    fut = asyncio.get_event_loop().create_future()
    # create_once_callable: keep the Python callback alive until JS
    # actually fires it. A bare lambda would be a borrowed proxy that
    # Pyodide auto-destroys when js.setTimeout returns.
    js.setTimeout(create_once_callable(lambda: fut.set_result(None)), 0)
    await fut

_em_x11_orig_after = tkinter.Misc.after
def _em_x11_yielding_after(self, ms, func=None, *args):
    if func is None:
        run_sync(asyncio.sleep(ms / 1000))
        return None
    return _em_x11_orig_after(self, ms, func, *args)
tkinter.Misc.after = _em_x11_yielding_after

# Quit accounting. Stock tkinter.Misc.quit calls into Tcl-side
# Tkapp_Quit, which sets a static flag inside _tkinter.c that the
# bundled Tkapp_MainLoop reads. We don't run that mainloop, so we mirror
# the flag in pure Python: every quit() bumps the counter, our mainloop
# snapshots it on entry and exits when it bumps. Counter (not bool)
# preserves nested-mainloop semantics: a modal dialog calling mainloop
# inside an outer mainloop pops exactly one level per quit.
_em_x11_quit_count = [0]
_em_x11_orig_quit = tkinter.Misc.quit
def _em_x11_quit(self):
    _em_x11_quit_count[0] += 1
    try:
        _em_x11_orig_quit(self)
    except Exception:
        # On a destroyed interpreter the Tcl call can raise; the Python
        # counter is what our mainloop reads, so the bump is what matters.
        pass
tkinter.Misc.quit = _em_x11_quit

def _em_x11_misc_mainloop(self, n=0):
    target = _em_x11_quit_count[0]
    tkapp = self.tk
    try:
        while _em_x11_quit_count[0] == target:
            try:
                # dooneevent(0) calls Tcl_DoOneEvent(TCL_ALL_EVENTS).
                # Tcl's default Unix notifier calls select() which
                # resolves to em-x11's poll() override. poll() blocks
                # via JSPI emscripten_sleep() until an event arrives
                # or the next Tcl timer deadline elapses. Adaptive
                # polling (1-10ms) picks up X events that land while
                # sleeping. On return, Python-level quit checks run.
                tkapp.dooneevent(0)
            except Exception:
                break
    finally:
        if _em_x11_quit_count[0] > target:
            _em_x11_quit_count[0] -= 1
tkinter.Misc.mainloop = _em_x11_misc_mainloop

def _em_x11_module_mainloop(n=0):
    root = tkinter._default_root
    if root is None:
        return None
    return _em_x11_misc_mainloop(root, n)
tkinter.mainloop = _em_x11_module_mainloop
`);

  /* --- Stage: run the user's app ---
   *
   * runPythonAsync so the wasm call stack is JSPI-suspendable (required
   * for the run_sync inside the patched tkinter.Misc.after and the
   * shallow-suspend mainloop to actually park rather than fault).
   * Standard desktop tkinter / turtle / PySimpleGUI code is supported
   * unchanged: if the demo ends with `root.mainloop()`, this `await`
   * blocks here until a callback calls `root.quit()`, exactly as on
   * desktop. Post-mainloop Python (if any) then runs, and finally
   * control falls through to the JS-side pump below to keep widgets
   * alive after the demo function returns.
   */
  post({ type: 'ready' });
  await py.runPythonAsync(demoCode);

  /* --- Stage: drain helper ---
   *
   * Going through tkinter.Tk()'s tkapp.dooneevent is mandatory for GIL
   * safety: Tkapp_DoOneEvent wraps Tcl_DoOneEvent with ENTER_TCL/LEAVE_TCL
   * which set _tkinter's `tcl_tstate` global so Tcl callbacks (button
   * -command, default <Configure> bindings, etc.) can re-enter Python via
   * PyEval_RestoreThread. Calling Tcl_DoOneEvent directly via ccall
   * fatals on the first such callback ("PyEval_RestoreThread: GIL is
   * released, current Python thread state is NULL"). Drain inside Python
   * so we pay only one PyProxy crossing per tick. Use tkinter._default_root
   * so the demo doesn't have to expose anything -- standard `tkinter.Tk()`
   * / `turtle.Screen()` both set _default_root automatically.
   */
  py.runPython(`
import js as _js
def _em_x11_drain(max_n=256):
    root = tkinter._default_root
    if root is None:
        return 0
    n = 0
    while n < max_n:
        got = root.tk.dooneevent(2)
        if not got:
            break
        n += 1
    return n
`);
  const drain = py.runPython(`_em_x11_drain`) as (max: number) => number;
  drainRef = drain;

  /* --- Stage: settle ---
   *
   * Tk's realize/map/expose chain contains many `after 0` callbacks.
   * drain() calls dooneevent(DONT_WAIT) in a Python loop; Tcl's default
   * Unix notifier + em-x11 poll.c override process these synchronously.
   * Multiple passes account for callbacks that queue new callbacks.
   */
  const SETTLE_MAX_PASSES = 20;
  let settled = false;
  for (let i = 0; i < SETTLE_MAX_PASSES; i++) {
    const n = drain(1024);
    if (n === 0) { settled = true; break; }
  }
  if (!settled) {
    logToMain(`settle: still draining after ${SETTLE_MAX_PASSES} passes`);
  }
}
