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

  /* Install the Tcl notifier wake target. libem_x11's notifier.c
   * (real_SetTimer / real_AlertNotifier) forwards Tcl's standardised
   * setTimerProc + alertNotifierProc here. The pump is then purely
   * event-driven: drain only when woken (by an X event from input,
   * a Tcl timer expiring at its exact deadline, or an explicit alert),
   * with zero scheduled work in between. This mirrors a Linux X11
   * client sitting at select() with no fds ready -- the JS engine
   * parks the worker thread instead of polling.
   *
   * The handlers below are wired up early but the actual pumping
   * helpers (`requestPump`, `pumpStopped`) only become real later in
   * boot, once `drain` is bound. Until then we just record the
   * latest timer ms; any alerts that arrive before drain is bound
   * are absorbed by the post-settle pump kickoff. */
  let pumpStopped = false;
  let wakeScheduled = false;
  let pendingTimerId: ReturnType<typeof setTimeout> | null = null;
  let drainRef: ((max: number) => number) | null = null;
  /* mainloopActive: set while Python is inside our patched Misc.mainloop.
   * Mainloop runs its own drain-and-park loop (see Python prelude below);
   * the JS-side pump would just race it with redundant dooneevent calls.
   * Keep the pump's wake path warm for *post*-mainloop life (e.g. user
   * called root.quit() but the canvas should remain interactive while
   * post-mainloop Python is still running), but make runDrain a no-op
   * while mainloop owns the event source. */
  let mainloopActive = false;
  /* parkResolvers: Python-side mainloop awaits parkUntilWake() to idle
   * efficiently. Any wake source (notifier timer fired, notifier alert,
   * input message from main) resolves all pending parkers in addition to
   * its normal requestPump() call. setTimeout(0) parking would burn CPU
   * at the browser's nested-timer floor (~250 Hz on Chromium); resolving
   * a promise on real wakes keeps idle CPU at 0% like the post-mainloop
   * pump does. */
  let parkResolvers: Array<() => void> = [];
  const wakeParked = (): void => {
    if (parkResolvers.length === 0) return;
    const rs = parkResolvers;
    parkResolvers = [];
    for (const r of rs) r();
  };
  const parkUntilWake = (): Promise<void> =>
    new Promise<void>((resolve) => { parkResolvers.push(resolve); });

  const requestPump = (): void => {
    if (pumpStopped || wakeScheduled || !drainRef) return;
    wakeScheduled = true;
    setTimeout(runDrain, 0);
  };
  const runDrain = (): void => {
    wakeScheduled = false;
    if (pumpStopped || !drainRef || mainloopActive) return;
    let n: number;
    try {
      n = drainRef(256);
    } catch (err) {
      pumpStopped = true;
      logToMain(`pump stopped: ${String((err as Error)?.message ?? err)}`);
      return;
    }
    if (n > 0) requestPump();
  };

  emX11.display.installEventLoopWake({
    onTimer: (ms: number): void => {
      if (pendingTimerId !== null) {
        clearTimeout(pendingTimerId);
        pendingTimerId = null;
      }
      if (ms < 0 || pumpStopped) return;
      pendingTimerId = setTimeout(() => {
        pendingTimerId = null;
        requestPump();
        wakeParked();
      }, ms);
    },
    onAlert: (): void => { requestPump(); wakeParked(); },
  });
  wakePump = (): void => { requestPump(); wakeParked(); };

  /* Expose the park primitive and the mainloop-active flag setter on the
   * worker global so the Python prelude can reach them via `js.<name>`.
   * Kept attached to the typed `ctx` (DedicatedWorkerGlobalScope) cast,
   * not bare `self`, to keep TS happy. */
  (ctx as unknown as Record<string, unknown>)._em_x11_park = parkUntilWake;
  (ctx as unknown as Record<string, unknown>)._em_x11_set_mainloop_active = (v: boolean): void => {
    mainloopActive = v;
    if (!v) requestPump();
  };

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
    libtclBuf, libtkBuf, libX11Buf, libXftBuf, libXrenderBuf, libfontconfigBuf, libtcldideBuf, tkinterSoBuf,
    turtleBuf, tclLibBuf, tkLibBuf, tkinterTarBuf,
  ] = await Promise.all([
    pending.libtcl, pending.libtk, pending.libX11, pending.libXft, pending.libXrender, pending.libfontconfig,
    pending.libtcldide, pending.tkinterSo,
    pending.turtle, pending.tclLib, pending.tkLib, pending.tkinterTar,
  ]);
  const writeFromBuf = (buf: ArrayBuffer, memPath: string): void => {
    py.FS.writeFile(memPath, new Uint8Array(buf));
  };
  writeFromBuf(libtclBuf,       '/usr/lib/libtcl8.6.so');
  writeFromBuf(libtkBuf,        '/usr/lib/libtk8.6.so');
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
   * Load order mirrors real X's NEEDED graph but we drive it explicitly
   * so Tcl_SetNotifier (in libX11, undefined at build time) resolves
   * against the already-loaded libtcl8.6.so via RTLD_GLOBAL.
   *
   *   1. libtcl8.6.so     — Tcl symbols available to all subsequent loads
   *   2. libX11.so        — Tcl_SetNotifier resolves from (1)
   *   3. libXft.so        — NEEDED cascade: libXrender → libX11,
   *                          libfontconfig → libX11 (both already loaded)
   *
   * _tkinter (loaded last) pulls libtk8.6.so via NEEDED; libtk's X11
   * symbols resolve from the already-loaded X11 split modules.
   */
  await pyi.loadDynlib('/usr/lib/libtcl8.6.so', { global: true });
  await pyi.loadDynlib('/usr/lib/libX11.so', { global: true });
  await pyi.loadDynlib('/usr/lib/libXft.so', { global: true });

  /* Browser-friendly Tcl notifier must be installed BEFORE Tk_Init. */
  const libX11Exports = pyi.loadedLibExports('/usr/lib/libX11.so');
  if (!libX11Exports?.em_x11_install_browser_notifier) {
    throw new Error('em_x11_install_browser_notifier not found in libX11 exports');
  }
  (libX11Exports.em_x11_install_browser_notifier as () => void)();

  /* Pre-bind libX11's exports as the default module for ANY future
   * XOpenDisplay. Doing this BEFORE _tkinter loads means tkinter.Tk()'s
   * very first XOpenDisplay picks up the surface automatically -- we
   * don't need a manual `_tkinter.create` bootstrap call (which would
   * create a second redundant Tk root that ends up obscuring the real
   * widgets).
   */
  const moduleSurface = makeSideModuleSurface(
    libX11Exports as unknown as Record<string, (...args: unknown[]) => unknown>,
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
   * `after delay`, which busy-loops Tcl_DoOneEvent under wallclock
   * until the time elapses. libem_x11/libtcl/libtk are built without
   * Asyncify (Pyodide 314 uses JSPI instead) so emscripten_sleep(1)
   * inside em-x11's notifier resolves to a no-op stub. Without a
   * yield, turtle's per-step _cv.after(delay) burns ~7s of CPU
   * while painting nothing. Routing the sync-sleep branch through
   * pyodide.ffi.run_sync(asyncio.sleep(...)) suspends the wasm stack
   * via JSPI, the JS event loop runs (browser composites a frame),
   * then resumes -- exactly the yielding semantics turtle needs.
   * Misc.after-with-callback paths fall through unchanged.
   *
   * Patch -- Misc.mainloop / tkinter.mainloop / Misc.quit:
   * Standard desktop tkinter / turtle / PySimpleGUI code assumes
   * `root.mainloop()` (and `Window.read()` which calls it under the
   * hood) **blocks** until a callback invokes `root.quit()`. Returning
   * immediately, as the previous patch did, broke any caller relying
   * on the "code after mainloop runs only after the user closes the
   * window" contract -- most notably PySimpleGUI's
   * `while True: event = window.read(); ...` pattern, which spun a
   * useless 1e9-iteration loop reading empty events.
   *
   * The reason it returned immediately was that CPython's
   * `Tkapp_MainLoop` calls `Tcl_DoOneEvent(0)` (no `TCL_DONT_WAIT`),
   * which on a real OS blocks the thread in `select()` until a file
   * descriptor / timer fires. In a worker the only event source is JS
   * itself, so blocking the wasm thread there freezes the universe.
   * Naive workaround -- `pyodide.ffi.run_sync(loop.run_forever())` --
   * works once, but the suspended continuation keeps the entire
   * asyncio.run_forever frame chain alive in V8; every nested `await`
   * inside callbacks piles on. Native-stack snapshots grew to ~5 MB
   * and OOM'd the worker within a few hundred ticks (see the
   * project_pyodide_tk_jspi_stack memory).
   *
   * Shallow-suspend fix: keep the outer "block until quit" loop as
   * plain Python, drain everything pending via
   * `dooneevent(TCL_DONT_WAIT)` until the queue empties, then suspend
   * exactly *once* per iteration on `js._em_x11_park()` -- a Promise
   * that resolves the next time the JS-side notifier wake fires
   * (timer expiry, alert, or main-thread input message). Each
   * suspended continuation is shallow (one Python frame, one
   * `run_sync` host frame) and resolves on the next macrotask, so V8
   * holds at most one snapshot at a time. Idle CPU is 0% -- the
   * worker thread parks the same way a Linux X11 client parks in
   * `select()`. Quit detection is a Python-level counter bumped by a
   * monkey-patched `Misc.quit`; nested mainloops work because each
   * level snapshots the counter on entry and exits when it bumps.
   *
   * The JS pump (see `runDrain` above) is gated off via
   * `_em_x11_set_mainloop_active` while mainloop owns the event loop,
   * so the two don't race on `dooneevent`. After mainloop returns,
   * the gate is released and the pump resumes for any post-mainloop
   * Python work that still wants live widgets.
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
# Tk root immediately after construction so demos can use the commands
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

# TCL_DONT_WAIT = 2; passing only this flag means "process any ready
# event of any type, do not block" (Tcl_DoOneEvent docs: "If no event
# type flags are given, all event types are processed").
_EM_X11_TCL_DONT_WAIT = 2

async def _em_x11_park():
    # Resolved by worker.ts on the next notifier wake or input message.
    # Returns a Promise; await it to suspend the Python stack via JSPI.
    await js._em_x11_park()

def _em_x11_misc_mainloop(self, n=0):
    target = _em_x11_quit_count[0]
    tkapp = self.tk
    js._em_x11_set_mainloop_active(True)
    try:
        while _em_x11_quit_count[0] == target:
            # Drain everything Tcl has queued without sleeping. Callbacks
            # (button -command, <Key> bind) re-enter Python here; if one
            # calls Misc.quit, the counter bumps and the outer while exits.
            try:
                while tkapp.dooneevent(_EM_X11_TCL_DONT_WAIT):
                    if _em_x11_quit_count[0] != target:
                        break
            except Exception:
                # Interpreter went away (root.destroy) -- treat as quit.
                break
            if _em_x11_quit_count[0] != target:
                break
            # One shallow JSPI suspend per iteration. Park until the JS
            # side gets a real wake (notifier timer, alert, input msg).
            run_sync(_em_x11_park())
    finally:
        # Consume one quit level so a future mainloop call starts from
        # the same baseline. If the loop exited because the interpreter
        # was destroyed (no quit bump), don't underflow.
        if _em_x11_quit_count[0] > target:
            _em_x11_quit_count[0] -= 1
        js._em_x11_set_mainloop_active(False)
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
   * Drain → setTimeout(0) → drain until quiescent so those timers fire
   * (the browser-friendly Tcl notifier translates them to real
   * setTimeout(0)s).
   */
  const SETTLE_MAX_PASSES = 20;
  let settled = false;
  for (let i = 0; i < SETTLE_MAX_PASSES; i++) {
    const n = drain(1024);
    if (n === 0) { settled = true; break; }
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  if (!settled) {
    logToMain(`settle: still draining after ${SETTLE_MAX_PASSES} passes; starting pump anyway`);
  }

  /* --- Stage: hand off to event-driven pump ---
   *
   * From here on, the pump only runs when something signals it:
   *   - libem_x11 notifier setTimerProc -> onTimer(ms) -> scheduled wake
   *     at exactly the Tcl deadline (cursor blink, animation frame,
   *     after-callback). Mirrors a real X client's select() timeout.
   *   - libem_x11 notifier alertNotifierProc -> onAlert -> immediate wake.
   *   - main-thread input messages -> wakePump() -> immediate wake.
   *
   * If none of those fire, the worker is idle: no setTimeout pending,
   * no rAF, no polling. The JS engine parks the thread and CPU is 0,
   * exactly like a Linux X11 client blocked in select().
   *
   * Kick off one final drain so any events queued during settle but
   * after the last pass (or any input messages that landed before
   * drain was bound) flow through.
   */
  requestPump();
}
