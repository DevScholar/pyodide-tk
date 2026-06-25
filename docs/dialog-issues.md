# Why Tk Common Dialogs Freeze

## Symptom

Opening any standard Tk common dialog (`filedialog.askopenfilename()`,
`messagebox.showinfo()`, `colorchooser.askcolor()`, etc.) produces one of
two failures:

- **With ctypes yield callback active**: `SuspendError: trying to suspend JS frames`
- **With ctypes yield callback disabled**: the app freezes (thread blocked, no events processed)

Both share the same root cause: **the blocking `tkwait window` loop inside
the dialog needs to yield to the browser event loop via JSPI, and no
mechanism exists by which a side module can trigger JSPI suspension.**

## Background: JSPI suspension

In a JSPI build, the Wasm stack is suspended when a Wasm function calls a
JS import that returns a `Promise`. The JS engine freezes all Wasm frames,
unwinds to the top-level JS caller, and returns a Promise to JS. When that
Promise resolves, the engine restores the Wasm frames and continues
execution.

Critical rule: **JSPI can only save/restore Wasm frames.** If the call
stack contains a JS frame between Wasm frames, the suspension fails with
"trying to suspend JS frames."

## The call chain when a dialog opens

```
Python mainloop: run_sync(asyncio.sleep(0.005))  ← JSPI yield (works)
  → tkapp.dooneevent(2)                          ← Tcl_DoOneEvent(DONT_WAIT)
    → Tcl processes ButtonPress event
      → Python -command callback fires
        → filedialog.askopenfilename()
          → tkwait window
            → Tcl blocking event loop
              → select() → poll()                ← in libem_x11_libc_override.so
                → NEEDS TO YIELD HERE
```

At this point `poll()` must yield to the browser so events can arrive
and the dialog can render. The yield must suspend the Wasm stack via JSPI.

## Experiment 1: ctypes callback → run_sync

```python
_poll_yield_cb = CFUNCTYPE(None, c_int)(
    lambda ms: run_sync(asyncio.sleep(ms / 1000))
)
em_x11_poll_set_yield_fn(_poll_yield_cb)
```

**Result**: `SuspendError: trying to suspend JS frames`

**Why**: ctypes callbacks in Pyodide use `addFunction`, which creates a
Wasm table entry pointing to a JS wrapper. When C code (in the side module)
calls the function pointer:

```
Wasm (side module, poll.c) → call_indirect
  → Wasm (main module, addFunction stub)
    → JS wrapper frame                              ← CAN'T SAVE
      → Python lambda
        → run_sync(...) → JS import → Promise
          → JSPI walks stack, hits JS wrapper → ERROR
```

The JS wrapper frame sits between the side module's Wasm frames and the
Python callback's Wasm frames. JSPI can't save JS frames, so the suspension
fails.

## Experiment 2: emscripten_sleep / custom Promise import

Replaced the ctypes callback with a JS function injected into the main
module's `wasmImports`, then imported by the side module:

```typescript
wasmImports['em_x11_poll_yield'] = (ms: number) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
};
```

```c
// poll.c
em_x11_poll_yield((int)sleep_ms);
```

**Result**: freeze (no suspension, Promise discarded as `undefined`)

**Why**: Side modules loaded via Pyodide's `loadDynlib` do not have JSPI
suspending attributes on their JS imports. The engine treats the import as
a regular void function — the returned Promise is coerced to `undefined` and
discarded. No suspension occurs.

This is an **Emscripten dynamic linker limitation**: JSPI import attributes
are embedded in the Wasm binary at compile time. Pyodide's `loadDynlib`
creates the side module's Wasm instance without preserving or setting these
attributes, so no import can trigger suspension regardless of what it returns.

## Experiment 3: usleep() — Wasm-to-Wasm call chain

Used `usleep(sleep_ms * 1000)` (a POSIX function from musl libc, compiled
to Wasm and exported by the main module). The call chain should be pure
Wasm-to-Wasm through the dynamic linker, with no JS frames:

```
Side module Wasm → usleep → nanosleep → clock_nanosleep → __syscall_*
                                                          → JS import?
```

**Result**: freeze (no suspension)

**Why**: The entire musl libc sleep path (`usleep → nanosleep →
clock_nanosleep → __syscall_*`) is implemented **in Wasm** — it never
calls a JS import. No JS import = no Promise = no JSPI suspension. The
sleep is effectively a busy-wait loop inside Wasm.

There is no Wasm-exported function in `pyodide.asm.wasm` whose
implementation eventually calls a JS import that returns a Promise.

## Conclusion

**There is no path from a side module to JSPI suspension.** Every
possible approach has been tried:

| Approach | JS frames? | Hits JS import? | Result |
|----------|------------|-----------------|--------|
| ctypes callback → run_sync | YES (blocks JSPI) | YES | SuspendError |
| emscripten_sleep (side module import) | NO | YES (but no JSPI) | freeze |
| Custom Promise import | NO | YES (but no JSPI) | freeze |
| usleep (Wasm export) | NO | NO (pure Wasm) | freeze |
| Atomics.wait | NO | NO (sync block) | freeze |

The yield **must** originate from Python code running in the main module's
Wasm context, where `run_sync(asyncio.sleep(...))` triggers JSPI through the
main module's properly-configured suspending imports.

## Experiment 6: Python-level tkwait interception + poll() no-block

Two-part change:

**poll.c**: The blocking path sets `g_in_blocking_poll = 1`, immediately
clears it, and returns 0 — never sleeps, never calls `g_poll_yield_fn`,
never calls `emscripten_sleep`. poll() is effectively non-blocking for
all timeouts.

**worker.ts**: A Python `Tkapp.call` wrapper intercepts calls where
`args[0] == 'tkwait'` and replaces them with Python-level event loops
using `dooneevent(2)` (DONT_WAIT) + `run_sync(asyncio.sleep(0.005))`.

```python
_em_x11_tkapp.call = _em_x11_tkapp_call  # wraps tkwait window/visibility/variable
```

**Result**: freeze (button press hangs, dialog never appears)

**Why**: The interception point is at the wrong layer. Standard dialogs
call `tk.call('tk_getOpenFile', ...)` / `tk.call('tk_messageBox', ...)` —
Tcl commands that do `tkwait` **internally** in C/Tcl. The Python wrapper
only sees `('tk_getOpenFile', ...)`, never `('tkwait', ...)`.

The call chain during the freeze:

```
Python -command callback
  → filedialog.askopenfilename()
    → tk.call('tk_getOpenFile', ...)
      → [Tcl/C] tkwait window $w
        → Tcl_DoOneEvent(TCL_ALL_EVENTS) ← tight loop
          → poll() → return 0  ← never yields to browser
```

`tk.call('tk_getOpenFile', ...)` never returns, so the outer Python
mainloop never regains control. `run_sync(asyncio.sleep(...))` never
runs. The browser event loop never fires — no X11 events arrive, no
rAF fires, the canvas never paints. The dialog window is created but
invisible, and the tkwait loop spins forever because the window is
never destroyed.

The dialog never rendering is the key clue: unlike Experiment 1–4
where the dialog *appeared* before freezing, here the dialog doesn't
even appear. Reason: Experiments 1–4 did yield to JS (via ctypes
callback or emscripten_sleep), allowing the initial map/expose events
to arrive before hitting the SuspendError or dead-end. Experiment 6
never yields at all, so the dialog never gets past `Tk_MapWindow`.

## Experiment 7: Tcl-level tkwait replacement via createcommand

Renamed the C `tkwait` command to `tkwait_c` and defined a new Tcl proc
that loops with `update` + `_py_yield`, where `_py_yield` is a Tcl
command registered via `tk.createcommand` that calls
`run_sync(asyncio.sleep(0.005))`.

The intended call chain (all Wasm, no JS frames):

```
Tcl (side module) → Tcl command dispatch
  → _tkinter.so PythonCmd (side module)
    → PyEval_CallObject (main module)
      → Python lambda → run_sync(asyncio.sleep(...))
        → JS import → Promise → JSPI SUSPEND
```

**Result**: freeze (same as Experiment 6 — button press hangs, no dialog)

**Why (suspected)**: The tkwait replacement runs in the Python prelude,
BEFORE the demo code creates `tkinter.Tk()`. At that point
`tkinter._default_root` is `None`, so `tkinter._default_root.tk` raises
`AttributeError`. The `try/except` catches it silently and prints to
stderr, which goes to the browser console (not visible in the app).

Since the Tcl `tkwait` command was never replaced, the original C
`tkwait` runs, calls `Tcl_DoOneEvent(TCL_ALL_EVENTS)` in a loop,
`poll()` returns 0 immediately, and the tight spin freezes exactly as
in Experiment 6.

**Follow-up**: Moved the tkwait replacement into a `Tk.__init__`
monkey-patch so it runs after the Tk root exists. Retested — same
result: freeze, no dialog.

Further diagnostics revealed the actual freeze point is NOT in `tkwait`
at all, but in Tk's internal wait loop **before** `tkwait` is ever
reached. Diagnostic findings:

- `auto_index(tk_getOpenFile)` = 0 (autoload index is empty)
- `info commands tk_getOpenFile` = `tk_getOpenFile` (BUT the command IS
  already defined — dialogs are pre-loaded, not autoloaded on demand)
- `info commands tkwait` = `tkwait` (our Tcl proc IS visible)
- When a dialog button is clicked, `filedialog.askopenfilename` is
  entered, but our `tkwait` proc is never called

The actual freeze chain:

```
tk_getOpenFile → create dialog toplevel → Tk_MapWindow
  → WaitForConfigureNotify (Tk internal)
    → while (!done) { Tcl_DoOneEvent(TCL_ALL_EVENTS); }
      → select/poll(timeout) → our poll() returns 0 immediately
      → no ConfigureNotify arrives (JS never runs, host can't deliver)
      → infinite loop — never reaches tkwait window $w
```

Tk's `WaitForConfigureNotify` (in `tkWm.c`) waits for a
`ConfigureNotify` event with the correct serial. It loops calling
`Tcl_DoOneEvent(TCL_ALL_EVENTS)` until the event arrives. With our
poll() returning 0 immediately and no JSPI yield, the browser event
loop never runs, the ConfigureNotify response from the X11 host never
arrives, and the loop spins forever.

This is another instance of the same root cause: **any blocking
X11 operation that waits for a server response via
Tcl_DoOneEvent/poll will freeze** because poll() can't yield to JS
from a side module. `tkwait window` was just one such operation;
`WaitForConfigureNotify` is another. There are likely many more
(e.g., `WaitForMapNotify`, `Tk_SendVirtualEvent` → `Tk_HandleEvent`,
any synchronous X11 roundtrip).

Additional discovery: `tk.call` is a read-only attribute on
`_tkinter.tkapp` in Pyodide — it cannot be monkey-patched from Python.
This rules out any approach that wraps `tk.call`.

## Experiment 8: poll.c Tcl_Eval yield via dlsym (2026-06-25)

Instead of replacing the entire Tcl notifier, modify only poll.c's
blocking-path yield mechanism. Add a new option that calls
`Tcl_Eval("_py_yield N")` — a pure-Wasm path through the dynamic linker —
instead of the ctypes callback (JS frames → SuspendError) or
`emscripten_sleep` (side-module imports lack JSPI attrs → freeze).

The call chain:

```
poll() blocking loop (side module, libem_x11_libc_override.so)
  → Tcl_Eval(g_poll_interp, "_py_yield N")
    → Tcl command dispatch (libtcl8.6.so, Wasm)
      → PythonCmd (_tkinter.so side module, Wasm)
        → PyEval_CallObject (main module import, Wasm)
          → Python run_sync(asyncio.sleep(N/1000))
            → JS import → Promise → JSPI SUSPEND
```

Every link is Wasm-to-Wasm through the dynamic linker. The sole JS import
at the end belongs to the main module where JSPI wrappers are properly
installed. No JS frames between Wasm frames.

**Changes**:
- `poll.c`: `g_poll_interp` + `em_x11_poll_set_interp()`. Blocking path
  uses `dlsym(RTLD_DEFAULT, "Tcl_Eval")` at first call to resolve `Tcl_Eval`,
  with result cached. Falls back to `emscripten_sleep` if `dlsym` fails.
- `worker.ts`: `_py_yield` Tcl command registered via `tk.createcommand()`
  on each new Tk root. `em_x11_poll_set_interp()` called to wire poll.c.

**Attempt 8a (extern Tcl_Eval)**: `extern int Tcl_Eval(...)` created an
import in libem_x11_libc_override.so. Since libtcl8.6.so isn't loaded yet
when this .so loads (NEEDED chain is depth-first), the Emscripten dynamic
linker created a lazy stub. At first call, the stub's internal
`dlsym(RTLD_DEFAULT, "Tcl_Eval")` failed with "cannot resolve symbol."

**Attempt 8b (dlsym Tcl_Eval from C)**: Removed `extern Tcl_Eval`. Instead,
poll.c calls `dlsym(RTLD_DEFAULT, "Tcl_Eval")` directly from C code.
**Result: freeze** — `dlsym` returned NULL. Pyodide's dlsym doesn't search
side-module exports; only main-module symbols are findable.

**Confirmed**: `Tcl_Eval` IS exported from libtcl8.6.so (func index 358,
verified by wasm binary parsing). The issue is NOT missing exports.

## Experiment 9: dlsym Python C API (2026-06-25)

Since dlsym can find main-module exports (confirmed: PyRun_SimpleString,
PyGILState_Ensure are both findable), use dlsym to get Python C API
function pointers at runtime.

```c
typedef int (*PyRun_SimpleString_t)(const char*);
PyRun_SimpleString_t PyRun_SimpleString_ptr =
    (PyRun_SimpleString_t)dlsym(RTLD_DEFAULT, "PyRun_SimpleString");
PyRun_SimpleString_ptr("_py_yield_ms(5)");
```

**Result**: `SuspendError: trying to suspend JS frames`

**Why**: `dlsym()` at runtime creates JS trampolines for cross-module
function pointers. Even when the symbol is found (in the main module),
calling through the returned pointer adds a JS frame:

```
Wasm (side module, poll.c) → JS trampoline (dlsym wrapper)
  → Wasm (main module, PyRun_SimpleString)
    → ... Python eval ...
      → run_sync → JS import → Promise → JSPI walks stack → JS trampoline → ERROR
```

**Confirmed**: dlsym at runtime creates JS trampolines. Load-time
resolution (extern) is the only way to get direct Wasm function pointers.

## Experiment 10: extern Python C API (2026-06-25)

Replace dlsym with `extern` declarations for PyGILState_Ensure,
PyRun_SimpleString, and PyGILState_Release. Load-time resolution
should create direct Wasm function pointers — the same mechanism
_tkinter.so uses for Python C API calls.

```c
extern int PyGILState_Ensure(void);
extern int PyRun_SimpleString(const char *command);
extern void PyGILState_Release(int);

int gstate = PyGILState_Ensure();
PyRun_SimpleString("_py_yield_ms(5)");
PyGILState_Release(gstate);
```

**Result**: `SuspendError: trying to suspend JS frames`

**Why (confirmed by stack trace)**: Even load-time-resolved extern imports
from a side module to the main module go through JS stubs. The stack trace
shows:

```
JsvFunction_CallBound @ pyodide.asm.mjs:1       ← JS frame (JSPI can't cross)
$PyObject_Vectorcall @ pyodide.asm.wasm:0xbb58a
$_PyEval_EvalFrameDefault @ pyodide.asm.wasm:0x1c10fb
...
$trampoline_call @ 63d3739a:0x93                 ← Side-module JS trampoline
$func5198 @ pyodide.asm.wasm:0x25ef25
$_PyObject_MakeTpCall @ pyodide.asm.wasm:0xbad58
...
PostMessage                                      ← Outer JS frame
```

The `$trampoline_call @ 63d3739a:0x93` is the side module's import stub
for calling into the main module. It's a JS frame that sits between the
side module's Wasm and the main module's Wasm. JSPI can only suspend
contiguous Wasm blocks — the JS trampoline splits the block, causing
SuspendError.

This is **not a load-order or dlsym issue**. Every side-module-to-main-module
call, regardless of resolution mechanism (extern, dlsym, ctypes), inserts a
JS trampoline. The Emscripten dynamic linker fundamentally requires JS
stubs for cross-module Wasm calls.

## Experiment 11: Atomics.wait in poll.c (2026-06-25)

**Fundamental insight**: JSPI cannot be triggered from a side module.
Every side-module-to-main-module call inserts a JS trampoline, and
JSPI can't save JS frames. This is an architectural constraint of
Emscripten's dynamic linker, not a bug.

**New approach**: Bypass JSPI entirely. Use `Atomics.wait()` — a
synchronous JS-level blocking primitive — inside an EM_JS function in
poll.c. The call chain:

```
Wasm (poll.c, side module)
  → EM_JS import → JS (EM_JS body) → Atomics.wait(timeout)
      → Worker thread blocked at OS level (NOT JSPI suspension)
      → Main thread runs freely: rAF → X11 processing → ring buffer write
      → Atomics.wait timeout expires
  → EM_JS returns → Wasm continues → poll_check → events found!
```

Key differences from all JSPI-based approaches:
- **No JSPI suspension**: Atomics.wait blocks synchronously at the JS/OS
  level, not via JSPI. No SuspendError possible.
- **Main thread runs freely**: The worker is genuinely blocked (not
  spinning), so the browser scheduler runs the main thread.
- **JS frame is harmless**: The EM_JS import creates a JS frame, but
  since JSPI is never triggered, there's nothing trying to save it.
- **No cross-module call**: The EM_JS function is embedded in the side
  module itself, not calling into the main module.

**Changes**:
- `poll.c`: Remove `extern PyGILState_Ensure/PyRun_SimpleString/PyGILState_Release`.
  Add `EM_JS` function `em_x11_atomics_sleep(ms)` that calls
  `Atomics.wait()`. Blocking path calls `em_x11_atomics_sleep(sleep_ms)`
  instead of Python C API.
- `worker.ts`: Remove `_py_yield_ms` Python definition (no longer needed).

**Attempt 1**: EM_JS body cached the Int32Array on the function name:
`em_x11_atomics_sleep._ia`. **Result**: `ReferenceError: em_x11_atomics_sleep
is not defined` — Pyodide's `addEmJs` doesn't create a name binding for the
function, so the body can't reference itself by name.

**Attempt 2**: Changed cache to `Module._em_x11_atomics_sab_ia`.
**Result**: **freeze** — button press hangs, dialog never appears, no logs.

**Why**: The main thread's em-x11 compositor is NOT an autonomous rAF loop.
It's driven by worker-side signals — when the worker's Xlib calls XFlush or
writes to the ring buffer, the main thread processes requests and sends
responses. When the worker is blocked in `Atomics.wait`, the main thread's
compositor has nothing to do. Even though the worker DID write X11 requests
(XMapWindow, etc.) BEFORE entering poll(), those requests sit in the ring
buffer unprocessed because the main thread isn't being signalled to read them.

This is the same outcome as Experiment 6 (poll returning 0). Contrast with
Experiments 1-4 where JSPI/ctypes yields DID let the main thread process the
initial MapWindow → ConfigureNotify — the dialog *appeared* then. The JSPI
suspension runs the browser event loop for BOTH threads, which is what the
X11 request pipeline needs.

**Key insight**: The em-x11 request pipeline depends on the worker yielding
to the browser event loop (via JSPI). Any approach that blocks the worker
without running the browser event loop — tight spin, Atomics.wait, etc. —
prevents X11 request processing and freezes before `Tk_MapWindow` completes.

**Status**: failed (freeze). All 11 experiments failed.

## Experiment results summary

| # | Approach | Mechanism | Result |
|---|----------|-----------|--------|
| 1 | ctypes callback → run_sync | JSPI via addFunction | SuspendError (JS frame) |
| 2 | emscripten_sleep (side module import) | JSPI via side-module import | freeze (no JSPI attrs) |
| 3 | Custom Promise import | JSPI via custom import | freeze (no JSPI attrs) |
| 4 | usleep (Wasm export) | Pure Wasm sleep | freeze (never hits JS import) |
| 5 | Atomics.wait | Sync blocking | freeze (no ring buffer wake) |
| 6 | Python tkwait intercept + poll no-block | Non-blocking poll | freeze (JS never runs) |
| 7 | Tcl-level tkwait replace + createcommand | Non-blocking tkwait | freeze (freeze before tkwait) |
| 8a | extern Tcl_Eval → Tcl yield | Load-time side-module import | freeze (unresolved symbol) |
| 8b | dlsym Tcl_Eval → Tcl yield | Runtime dlsym lookup | freeze (symbol not found) |
| 9 | dlsym PyRun_SimpleString | Runtime dlsym → Python yield | SuspendError (JS trampoline) |
| 10 | extern PyRun_SimpleString | Load-time import → Python yield | SuspendError (JS trampoline) |
| 11 | **EM_JS Atomics.wait** | **Sync JS blocking, no JSPI** | **freeze (compositor not autonomous)** |

## Root cause (final)

After 11 experiments, the root cause of dialog freeze is established at
two levels:

**Level 1 (JSPI)**: From a side module, no mechanism can trigger JSPI
suspension. Every conceivable path has been tried and fails:
- ctypes callbacks → JS frame (SuspendError)
- side-module JS imports returning Promise → no JSPI attributes (freeze)
- side-module-to-main-module calls → JS trampoline (SuspendError)
- side-module-to-side-module calls → Tcl_Eval can't be found by dlsym
- Python C API via extern → JS trampoline (SuspendError)

**Level 2 (Atomics/blocking)**: Blocking the worker without JSPI doesn't
work either. The main thread's em-x11 compositor is NOT an autonomous rAF
loop — it depends on the worker yielding to the browser event loop to
drive the X11 request pipeline. When the worker blocks (spin or
Atomics.wait), X11 requests are never processed, and
`WaitForConfigureNotify` loops forever.

The two requirements are contradictory:
- To process X11 requests: worker must yield via JSPI (run browser event loop)
- To yield via JSPI: call chain must have no JS frames between Wasm blocks
- Side modules ALWAYS insert JS frames on cross-module calls
- Therefore: **a side module can never trigger JSPI suspension**

## Fix direction

The yield **must** originate from Python code running in the main
module's Wasm context, where `run_sync(asyncio.sleep(...))` triggers
JSPI through the main module's properly-configured suspending imports.
This means the blocking call must unwind back to Python's mainloop,
not be intercepted inside poll().

Approaches ruled out:
- All 11 poll.c-level yield mechanisms

Remaining options:
- **Browser-native dialogs**: Use `<input type="file">`, `window.confirm()`,
  etc. from JS and relay results to Python. No Tcl blocking event loop
  involved.
- **Asynchronous dialog API**: Rewrite `tkinter.filedialog`/`messagebox`/
  `colorchooser` to use async/await instead of blocking `tkwait window`.
- **Tcl/Tk source patching**: Modify Tk's internal blocking waits
  (`WaitForConfigureNotify`, `WaitForMapNotify`, `tkwait`) to return to
  Python's mainloop instead of calling `Tcl_DoOneEvent(TCL_ALL_EVENTS)`.
  This is large scope but would fix all blocking paths at once.
