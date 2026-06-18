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

/** Track the XIM-focused window so preedit messages (which carry no window
 *  field) can be routed to the correct InputBridge module. Updated by the
 *  textInputRemote.setFocus/clearFocus closures below. */
let imeFocusedWindow: number | null = null;

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
    case 'imePreeditStart':
      if (emX11 && imeFocusedWindow !== null)
        emX11._host.devices.pushPreeditStart(imeFocusedWindow);
      break;
    case 'imePreeditDraw':
      if (emX11 && imeFocusedWindow !== null && msg.text) {
        emX11._host.devices.pushPreeditDraw(
          imeFocusedWindow, msg.text, msg.caret, msg.chgFirst, msg.chgLength);
      }
      break;
    case 'imePreeditDone':
      if (emX11 && imeFocusedWindow !== null)
        emX11._host.devices.pushPreeditDone(imeFocusedWindow);
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
   * All pyodide-tk assets are bundled into two tarballs during staging
   * (see scripts/stage-assets.sh):
   *   libs.tar   — .so side modules + tcl8.6/ + tk8.6/ (extract to /usr/lib)
   *   python.tar — _tkinter.so + turtle.py + tkinter/ (extract to site-packages)
   *
   * Two fetches instead of 14+ eliminates HTTP/1.1 connection queueing.
   * They start alongside the pyodide.mjs import so the browser can
   * download everything concurrently with Pyodide's own pyodide.asm.wasm
   * (~9 MB) + python_stdlib.zip.
   */
  const fetchAB = (url: string): Promise<ArrayBuffer> =>
    fetch(url).then((r) => {
      if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
      return r.arrayBuffer();
    });
  const A = '/pyodide-tk-assets';
  const pyodideUrl = new URL('/pyodide/pyodide.mjs', ctx.location.origin).href;
  const indexURL = new URL('/pyodide/', ctx.location.origin).href;
  const pending = {
    pyodide:  import(/* @vite-ignore */ pyodideUrl),
    libsTar:  fetchAB(`${A}/libs.tar`),
    pythonTar:fetchAB(`${A}/python.tar`),
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
      setFocus: (window) => {
        imeFocusedWindow = window;
        post({ type: 'imeFocus', window });
      },
      clearFocus: () => {
        imeFocusedWindow = null;
        post({ type: 'imeClearFocus' });
      },
      setSpot: (window, spotX, spotY) =>
        post({ type: 'imeSpot', window, spotX, spotY }),
      positionHint: (absX, absY) =>
        post({ type: 'imePositionHint', absX, absY }),
      /* Preedit methods exist for interface completeness: in worker mode
       * preedit events flow main→worker through createDomTextInputBridge
       * callbacks, not through this remote. These are no-ops. */
      preeditStart: () => {},
      preeditDraw: () => {},
      preeditDone: () => {},
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

  /* libem_x11_event_queue.so provides strong poll/select overrides
   * (loaded {global:true} below). Tcl's default Unix notifier calls
   * select() which reaches our overridden poll(), which checks fd
   * readiness and yields via emscripten_sleep for blocking waits.
   * DONT_WAIT (timeout=0) returns immediately — no sleep, no JSPI unwind.
   *
   * wakePump stays a no-op: input messages that arrive before drain is
   * bound are harmless.  After boot, X events are picked up by the
   * Python mainloop's DONT_WAIT polling loop. */
  let drainRef: ((max: number) => number) | null = null;

  const pyi = pyodideInternals(py);

  /* --- Stage: unpack bundled tarballs into MEMFS ---
   *
   * libs.tar → /usr/lib/       (.so files + tcl8.6/ + tk8.6/)
   * python.tar → /lib/python3.14/site-packages/  (_tkinter.so + turtle.py + tkinter/)
   *
   * py.unpackArchive extracts in C, ~30x faster than per-file FS.writeFile.
   */
  py.FS.mkdirTree('/usr/lib');
  py.FS.mkdirTree('/lib/python3.14/site-packages');
  const [libsTarBuf, pythonTarBuf] = await Promise.all([pending.libsTar, pending.pythonTar]);
  py.unpackArchive(libsTarBuf,   'tar', { extractDir: '/usr/lib' });
  py.unpackArchive(pythonTarBuf, 'tar', { extractDir: '/lib/python3.14/site-packages' });

  /* --- Stage: load em-x11 split side modules ---
   *
   * libem_x11_event_queue.so provides strong poll/select overrides
   * and signal delivery.  Loaded {global:true} before libtcl8.6.so
   * so its poll/select symbols override Pyodide's builtin stubs.
   *
   * Tcl's default Unix notifier calls select() which reaches our
   * overridden poll(). DONT_WAIT (timeout=0) returns immediately;
   * blocking waits yield via emscripten_sleep under JSPI.
   *
   *   1. libem_x11_event_queue.so — poll/select overrides + signal delivery
   *   2. libtcl8.6.so             — Tcl interpreter (NEEDED on event_queue)
   *   3. libXft.so                — NEEDED cascade: libX11, libXrender,
   *                                  libfontconfig
   *
   * _tkinter (loaded last) pulls libtk8.6.so via NEEDED; libtk's X11
   * symbols resolve from the already-loaded X11 split modules.
   *
   * emscripten_sleep must be injected into wasmImports because
   * libem_x11_event_queue.so imports it (poll() blocking path).
   * Must happen BEFORE the first loadDynlib.
   */
  const wasmImports = pyi.memorySurface().LDSO.loadedLibsByName['__main__']?.exports;
  if (wasmImports) {
    wasmImports['emscripten_sleep'] = (ms: number) => {
      console.warn('[DIAG] worker.ts injected emscripten_sleep called, ms=', ms);
      return new Promise((resolve) => setTimeout(resolve, ms));
    };
    /* em_x11_drain_sab was the old SharedArrayBuffer-based ring-drain
     * function from the pre-JSPI channel/worker mode (removed 2026-05-07).
     * If a stale side module still imports it, provide a no-op stub so
     * Pyodide's dynamic linker doesn't fail. The symbol is never called
     * in the current DONT_WAIT polling path. */
    wasmImports['em_x11_drain_sab'] = () => {
      console.warn('[DIAG] worker.ts injected em_x11_drain_sab called unexpectedly');
    };
  }
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
   * Optional — if the .so wasn't built (sibling tcldide missing from
   * libs.tar), the prelude below catches the CDLL failure and no-ops. */
  try {
    await pyi.loadDynlib('/usr/lib/libtcldide.so', { global: true });
  } catch {
    // libtcldide not built — ::tcldide::dom / ::tcldide::jscall unavailable
  }

  /* --- Stage: worker-side Python prelude ---
   *
   * Patch -- tkinter.Misc.after(ms) sync sleep:
   * The no-callback variant of Misc.after lowers to Tcl's sync
   * `after delay`, which busy-loops Tcl_DoOneEvent(DONT_WAIT) until
   * the wall clock elapses — no JS yield, ~7s of CPU with nothing
   * painted.  Route the sync-sleep branch through
   * pyodide.ffi.run_sync(asyncio.sleep(...)) which suspends via JSPI.
   * Misc.after-with-callback paths fall through unchanged.
   *
   * Patch -- Misc.mainloop / tkinter.mainloop / Misc.quit:
   * Standard desktop tkinter / turtle / PySimpleGUI code assumes
   * `root.mainloop()` **blocks** until a callback invokes `root.quit()`.
   *
   * The mainloop pumps in a two-level loop:
   *   Inner: drain all queued events via dooneevent(2) (DONT_WAIT).
   *          Loop until the queue is empty or 256 cap, to avoid the
   *          one-event-per-frame stall that stretches widget realize/
   *          map/expose to seconds.
   *   Outer: yield to the browser event loop via
   *          run_sync(asyncio.sleep(0.005)) so rAF fires, input
   *          arrives, and the page stays responsive.  5ms matches
   *          typical rAF intervals; idle CPU is near zero.
   *
   * Quit detection is a Python-level counter bumped by a monkey-patched
   * `Misc.quit`; nested mainloops work because each level snapshots the
   * counter on entry and exits when it bumps.
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
            # Drain all pending events without blocking.
            # dooneevent(2) = TCL_DONT_WAIT.  Tcl's default Unix
            # notifier calls select(timeout=0), overridden by
            # libem_x11_event_queue.so — returns immediately.  Loop until the
            # queue is empty to avoid the one-event-per-frame stall
            # that stretches widget realize/map/expose to seconds.
            drained = 0
            while drained < 256:
                try:
                    got = tkapp.dooneevent(2)
                except Exception:
                    break
                if not got:
                    break
                drained += 1
            # Yield to the browser event loop so rAF fires, input
            # arrives, and the page stays responsive.  5ms matches
            # typical rAF intervals and keeps idle CPU near zero.
            run_sync(asyncio.sleep(0.005))
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
   * drain() calls dooneevent(DONT_WAIT) in a Python loop; the default
   * Unix notifier calls select(timeout=0) which returns immediately
   * via the overridden poll() in libem_x11_event_queue.so.
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
