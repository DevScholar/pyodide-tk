# Why Tk Common Dialogs Freeze

## Symptom

Opening any standard Tk dialog (filedialog, messagebox, colorchooser) either throws
`SuspendError: trying to suspend JS frames` or freezes the app. Both share the same
root cause: **JSPI suspension cannot be triggered from a side module.**

## Root Cause

Two contradictory requirements:

- To process X11 requests, the worker must yield to the browser event loop via JSPI.
- To yield via JSPI, the call stack must be contiguous Wasm frames — no JS frames between them.
- Side modules ALWAYS insert JS trampolines on every cross-module call (Emscripten's dynamic linker requires this). JSPI can't save JS frames → SuspendError.
- Side-module JS imports lack JSPI suspending attributes in Pyodide's `loadDynlib` path. A returned Promise is discarded → freeze.
- Blocking the worker without JSPI (spin, Atomics.wait) starves the em-x11 compositor — the main thread's request pipeline isn't autonomous; it depends on the worker yielding to run the browser event loop.

## Why tcldide Works

tcldide links Tcl, Tk, and poll.c into a single wasm module. `JSPI_EXPORTS` wraps entry
points with `WebAssembly.promising`, and the entire stack from entry to `emscripten_sleep`
is contiguous Wasm — no cross-module trampolines, no ctypes FFI.

pyodide-tk has 5+ separate `.so` instances. Every cross-module call inserts a JS trampoline.
Every ctypes FFI call creates a JS→Wasm boundary without `WebAssembly.promising`.

## Experiments by Approach

### Poll-level yield mechanisms

Attempted ctypes callback → run_sync, emscripten_sleep from side module, custom Promise
import, usleep, Atomics.wait, dlsym Tcl_Eval/PyRun_SimpleString, and extern Python C API.

All fail via one of three modes:

- **SuspendError (JS frame)**: ctypes addFunction creates a JS wrapper. dlsym at runtime
  creates JS trampolines. Even load-time `extern` side→main imports go through JS stubs.
  Every cross-module call path has a JS frame JSPI can't save.

- **Freeze (no JSPI attrs)**: Side-module `emscripten_sleep` returns a Promise, but
  Pyodide's `loadDynlib` doesn't preserve suspending attributes — the Promise is silently
  discarded. Verified identically across three separate experiments.

- **Freeze (no browser event loop)**: `usleep` is pure Wasm — never hits a JS import.
  `Atomics.wait` blocks the worker but the main thread's compositor isn't an autonomous
  rAF loop; it waits for worker signals. X11 requests written before the block sit
  unprocessed, so `WaitForConfigureNotify` loops forever.

### Tcl-level interception

Attempted Python `tk.call` wrapper, Tcl `createcommand` tkwait replacement, and Python
tkwait override via `createcommand` with `run_sync` yielding.

- Python tk.call wrapper: freeze. Standard dialogs call `tk_getOpenFile`/`tk_messageBox`
  which do `tkwait` internally in C/Tcl — the wrapper never sees `tkwait`.

- Tcl createcommand replacement: freeze. `WaitForConfigureNotify` blocks during
  `Tk_MapWindow` before `tkwait` is ever reached.

- Python tkwait via createcommand: SuspendError. The Tcl→Python call path crosses a
  side→main module boundary with a JS trampoline. Any Python function invoked from Tcl
  (createcommand, button -command, variable trace) has this JS frame — JSPI can't suspend
  through it.

### Link-time --wrap overrides

`-Wl,--wrap=TkUnixDoOneXEvent` replaced the blocking `select()` call with non-blocking
event drain + immediate return. **Success** — `WaitForConfigureNotify` no longer blocks;
the dialog proceeds past `Tk_MapWindow`. The mechanism cleanly patches exported Tk symbols
from tracked source files without touching upstream code.

`-Wl,--wrap=Tk_TkwaitObjCmd` replaced blocking `tkwait` with `TCL_DONT_WAIT` polling.
**OOM** — tens of thousands of iterations allocate Tcl event structures before timeout
elapses. Events never arrive anyway because the worker never yields to the browser loop.

### JSPI import wrapping

Injected `new WebAssembly.Suspending(fn)` into `wasmImports` so side-module imports
trigger JSPI suspension. **Partial progress**: JSPI now recognizes the suspending import
and attempts suspension (vs. silently ignoring the raw function). But `trampoline_call`
JS frames at every cross-module boundary still cause SuspendError.

Three follow-ons tried eliminating those trampolines: force JS trampoline fallback
(disable wasm trampoline module), direct `wasmTable.set` (bypass addFunction JS wrapper).
All produce the same SuspendError — JS frames come from multiple sources (import stubs,
proxyHandler.get, multiple trampoline crossings), not just one. The trampoline is a
fundamental component of Emscripten's dynamic linker; it can't be eliminated via runtime
patching.

### Main-module JSPI + GOT bridge

Compiled Pyodide main with `-sJSPI=1`, added `pyodide_poll_yield()` in the main module
calling `emscripten_sleep`. Side modules call it via Wasm GOT (pure Wasm→Wasm, no JS
boundary). **New error**: `SuspendError: trying to suspend without WebAssembly.promising`
(changed from "trying to suspend JS frames"). JSPI is active and the import wrapping
is correct. But ctypes FFI enters side-module Wasm as a raw function — without
`WebAssembly.promising`. The new JSPI spec requires promising on the immediate JS caller;
it's not transitive through intermediate JS→Wasm→JS→Wasm transitions.

## Fix Directions

**Proven viable:**
- `--wrap TkUnixDoOneXEvent` bypasses `WaitForConfigureNotify`. Clean, source-tracked.
  Only removes one blocking point — `tkwait` and other synchronous X11 roundtrips remain.

**Ruled out:**
- All JSPI-based approaches from side modules — architecturally impossible without
  redesigning Emscripten's dynamic linker.
- Non-blocking `tkwait` without a yield mechanism — tight spin exhausts memory.

**Remaining options:**
- **Browser-native dialogs**: Use `<input type="file">`, `window.confirm()`, etc. relayed
  to Python. No Tcl blocking event loop. Simplest and most reliable.
- **Atomics.wait + autonomous compositor**: Make the main thread's rAF loop drive the
  compositor independently of worker signals. Worker uses `Atomics.wait` in poll().
  Requires compositor architecture changes and SAB input ring.
- **SAB input ring + C-level tkwait with composeNow**: Worker calls `composeNow()`
  synchronously via EM_JS after each `Tcl_DoOneEvent(TCL_DONT_WAIT)`. Main thread writes
  input to SAB ring, C reads directly. Avoids both JSPI and compositor changes, but
  needs SAB plumbing.

## Current Status (2026-06-26)

### Blocker: Pyodide main module JSPI → SuspendError

All Pyodide npm packages (0.27.7 through 314.0.1) now ship the main module built
with `-sJSPI=1`.  `loadPyodide()` itself fails with
`SuspendError: trying to suspend without WebAssembly.promising` — before any side
module or em-x11 code loads.  This blocks **all** approaches, including Option C
(SAB ring).

Root cause: Emscripten's "sandwich problem" — JS frames (from ctypes, late-binding
symbols, function pointer casts) between `WebAssembly.promising()` entry and
`suspend` point cause SuspendError.

### Upstream dependencies

| Item | Status | Link |
|------|--------|------|
| Sandwich problem | Open | [emscripten#26758](https://github.com/emscripten-core/emscripten/issues/26758) |
| Late-binding symbols fix | Open | [emscripten#23619](https://github.com/emscripten-core/emscripten/pull/23619) |
| Side→main JSPI suspend | Merged | [emscripten#23581](https://github.com/emscripten-core/emscripten/pull/23581) |

After these land, Pyodide's `loadDynlib` will also need to wrap side-module
exports with `WebAssembly.promising` so ctypes→side module→suspend chains work.
At that point, `emscripten_sleep` in poll.c should work directly — no SAB ring
needed.  The SAB ring + Option C code can be reverted.
