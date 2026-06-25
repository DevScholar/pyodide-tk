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

## Experiment 13: Python tkwait override via createcommand (2026-06-25)

After Experiment 12a proved that `--wrap TkUnixDoOneXEvent` successfully
bypasses `WaitForConfigureNotify`, the remaining freeze point is `tkwait`
(`Tk_TkwaitObjCmd`). Experiment 12b showed that a C-level DONT_WAIT
replacement causes OOM. This experiment tries a **Python-level** replacement:
use `tk.createcommand('tkwait', ...)` to replace the C command with a Python
function that yields via `run_sync(asyncio.sleep(0.005))` — the same JSPI
mechanism the outer mainloop uses successfully.

The intended call chain (all Wasm, no JS frames):

```
Tcl (side module) → Tcl command dispatch
  → createcommand wrapper (_tkinter.so side module)
    → Python callback (main module)
      → run_sync(asyncio.sleep(0.005))
        → JS import → Promise → JSPI SUSPEND (same as outer mainloop)
```

Three modes implemented:
- **variable**: Tcl `trace variable name wu cb` + yielding loop
- **visibility**: Tk `<Map>` + `<Destroy>` bindings + `winfo ismapped` check
- **window**: Tk `<Destroy>` binding

The replacement is installed via a `Tk.__init__` monkey-patch (same pattern
as the tcldide bridge), so it runs after the Tcl interpreter is fully
initialized.

**Result**: `SuspendError: trying to suspend JS frames`

**Why (confirmed by stack trace)**: The Python tkwait callback is invoked from
Tcl's command dispatch (side module), which reaches Python via `trampoline_call`
— a JS stub created by Emscripten's dynamic linker for cross-module calls. The
stack trace confirms:

```
setTimeout → scheduleCallback → JsvFunction_CallBound (JS)
  → Wasm (main module: PyObject_Vectorcall, _PyEval_EvalFrameDefault, ...)
    → trampoline_call (JS: side-module import stub)
      → Wasm (side module: Tcl command dispatch → createcommand → Python callback)
        → run_sync(...) → JS import → Promise
          → JSPI walks stack → trampoline_call (JS frame) → ERROR
```

The same JS trampoline that blocked Experiment 10 (extern Python C API) is
present here. Even though the Python function *itself* runs in the main
module, the **call path** from Tcl to Python crosses a side-module-to-main-module
boundary with a JS trampoline. This is the same fatal issue as Experiment 10.

**Key takeaway**: The tkwait override was installed correctly (confirmed:
`info commands tkwait` shows the replacement), and the yielding logic is
identical to the working outer mainloop. The failure is not in the Python
code but in the call chain that reaches it — any Python function called
from Tcl (via `createcommand`, button `-command`, variable trace, etc.)
crosses a JS trampoline that blocks JSPI suspension.

This rules out ALL approaches that try to trigger JSPI from a Tcl callback
context, including:
- Replacing `tkwait` with a yielding Python function
- Making messagebox/filedialog call async Python code
- Using `after` callbacks to yield during dialog waits
- Any form of `run_sync` or `asyncio.sleep` from within Tcl→Python callbacks

## Experiment 12: Source-level function override via --wrap (2026-06-25)

Instead of modifying poll.c or worker.ts yield mechanisms, this approach
patches Tk itself at link time: use `-Wl,--wrap=<symbol>` to redirect
blocking Tk functions to non-blocking replacements. The patched `.so` is
compiled from source files in `src/patch/` (tracked by git), not by
modifying `ignored-area/` (untracked) or `tcldide/opt/` (shared).

### Experiment 12a: --wrap TkUnixDoOneXEvent

`TkUnixDoOneXEvent` (in `tkUnixEvent.c`) is the exported function that
`WaitForConfigureNotify` / `WaitForMapNotify` / `WaitForEvent` all call
to block waiting for WM responses. It calls `select()` with a timeout.

**Changes**:
- Created `src/patch/tkUnixEvent_wrap.c` — defines `__wrap_TkUnixDoOneXEvent`
  that calls `Tcl_ServiceEvent(TCL_ALL_EVENTS)` (drains queued events
  without blocking) and returns 0 ("timeout") immediately if no events.
- Makefile: compiles wrapper `.o`, links into `libtk8.6.so` with
  `-Wl,--wrap=TkUnixDoOneXEvent`. wasm-ld renames the original to
  `__real_TkUnixDoOneXEvent` and redirects all call sites to the wrapper.

**Result**: **Success — freeze moved.** `WaitForConfigureNotify` no longer
blocks; Tk proceeds past `Tk_MapWindow` without WM synchronization. The
dialog continues to the next blocking point (`tkwait`). This proves the
`--wrap` override mechanism works for exported Tk symbols.

**Why this works**: `WaitForConfigureNotify` can be safely skipped in em-x11.
It exists to synchronize with a real X window manager. em-x11 has no WM,
so the sync is unnecessary. Skipping it lets window creation proceed.

### Experiment 12b: --wrap Tk_TkwaitObjCmd

`Tk_TkwaitObjCmd` (in `tkCmds.c`) is the C implementation of the `tkwait`
Tcl command. It calls `Tcl_DoOneEvent(0)` (blocking) in a loop waiting for
a variable write, window destruction, or visibility change. All standard
dialogs (`tk_messageBox`, `filedialog`, `colorchooser`) depend on `tkwait`
to block execution until the user interacts with the dialog.

**Changes**:
- Created `src/patch/tkCmds_wrap.c` — defines `__wrap_Tk_TkwaitObjCmd`
  that re-implements the same logic but with `Tcl_DoOneEvent(TCL_DONT_WAIT)`
  (non-blocking) + a 100ms timeout (via `emscripten_get_now()`).
- Makefile: `-Wl,--wrap=Tk_TkwaitObjCmd` added.

**Result**: **OOM crash.** The 100ms window contains tens of thousands of
`Tcl_DoOneEvent(TCL_DONT_WAIT)` iterations, each allocating Tcl event
structures. Memory exhausts before 100ms elapses. More fundamentally,
even without the OOM, events never arrive — the main thread's compositor
never processes X11 requests because the worker never yields to the
browser event loop.

**Why this fails**: `tkwait` is fundamentally different from
`WaitForConfigureNotify`. The latter can be skipped (no functional impact
in em-x11's WM-less environment). `tkwait` MUST wait for user interaction —
skipping it breaks the API contract (callers expect the dialog result to
be set after `tkwait` returns). Making it non-blocking without a working
yield mechanism creates a tight spin that exhausts memory.

### Experiment 12c: emscripten_sleep from side module (re-verified)

The ctypes callback (`g_poll_yield_fn`) was disabled so poll() would fall
through to `emscripten_sleep()`. The poll.c comment (June 2026) claims
`emscripten_sleep` works for JSPI from side modules.

**Result**: **Freeze (confirmed).** Same as Experiment 2. The side module's
import of `emscripten_sleep` lacks JSPI suspending attributes, so the
returned Promise is discarded. The poll() loop spins without yielding.

This contradicts the poll.c comment — `emscripten_sleep` from side modules
does NOT work, at least in Pyodide's `loadDynlib` path with Emscripten
5.0.3.

### Key finding: --wrap mechanism is viable

The `--wrap` infrastructure works. It allows patching individual exported
Tk functions from source files in the pyodide-tk repo, without touching
`ignored-area/` or `tcldide/`. The approach cleanly separates patched
code from upstream Tcl/Tk source.

However, the `tkwait` experiment shows that simply converting blocking
calls to non-blocking is not sufficient — the underlying event delivery
pipeline (em-x11 compositor → ring buffer → worker) requires the browser
event loop to run, which requires a real yield mechanism that side modules
cannot provide.

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
| 11 | EM_JS Atomics.wait | Sync JS blocking, no JSPI | freeze (compositor not autonomous) |
| 12a | **--wrap TkUnixDoOneXEvent** | **Link-time function override** | **freeze moved (infra works!)** |
| 12b | --wrap Tk_TkwaitObjCmd (TCL_DONT_WAIT) | Link-time + non-blocking loop | OOM (tight spin, no events arrive) |
| 12c | emscripten_sleep re-verified | Side-module import → JSPI | freeze (confirmed: no JSPI attrs) |
| 13 | **Python tkwait override via createcommand** | **Tcl cmd → Python yield** | **SuspendError (JS trampoline in call path)** |

## Root cause (final)

After 13 experiments, the root cause of dialog freeze is established at
two levels:

**Level 1 (JSPI)**: From a side module, no mechanism can trigger JSPI
suspension. Every conceivable path has been tried and fails:
- ctypes callbacks → JS frame (SuspendError)
- side-module JS imports returning Promise → no JSPI attributes (freeze)
- side-module-to-main-module calls → JS trampoline (SuspendError)
- side-module-to-side-module calls → Tcl_Eval can't be found by dlsym
- Python C API via extern → JS trampoline (SuspendError)
- **Python tkwait via createcommand → JS trampoline (SuspendError)** (Experiment 13)
- EM_JS Atomics.wait → compositor not autonomous (freeze)

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

## Fix direction (updated after Experiment 13)

The yield **must** originate from Python code that is called directly from the
main module's JS event loop (e.g. `callPyObjectMaybePromising` → setTimeout →
JSPI resume), NOT from a Tcl callback context. Any Python function invoked
via Tcl command dispatch (button `-command`, `createcommand`, variable trace,
`tk.call`) crosses a side-module-to-main-module boundary with a JS trampoline,
which blocks JSPI suspension.

Approaches ruled out:
- All 11 poll.c-level yield mechanisms (Experiments 1–5, 8–11)
- Python-level `tk.call` interception (Experiment 6): wrong layer — Tcl
  commands like `tk_messageBox` call `tkwait` internally, invisible to Python
- Tcl-level `tkwait` replacement via `createcommand` (Experiment 7): freeze
  occurs before `tkwait` is reached — `WaitForConfigureNotify` blocks first
- Non-blocking `Tk_TkwaitObjCmd` replacement (Experiment 12b): OOM + no events
  arrive — `tkwait` MUST block per Tk API contract, and tight spin without
  yield is not viable
- **Python tkwait override via createcommand + run_sync (Experiment 13)**:
  SuspendError — JS trampoline in the Tcl→Python call path blocks JSPI
- Any approach that calls `run_sync`/`asyncio.sleep` from a Tcl callback
  context (button `-command`, variable trace, `createcommand`, etc.) — the
  side-module→main-module JS trampoline is unavoidable

Approaches proven viable:
- `--wrap TkUnixDoOneXEvent` (Experiment 12a): successfully bypassed
  `WaitForConfigureNotify`. Clean source separation (patches in `src/patch/`,
  tracked by git, no modification to `ignored-area/` or `tcldide/`).

Remaining options:
- **Browser-native dialogs**: Use `<input type="file">`, `window.confirm()`,
  etc. from JS and relay results to Python. No Tcl blocking event loop
  involved. Simplest and most reliable approach — no JSPI, no C changes.
- **Atomics.wait + autonomous compositor** (refined Plan A): Make the main
  thread's rAF loop drive the compositor independently (not gated on worker
  signals). Worker uses `Atomics.wait` in poll() (not JSPI). Requires changes
  in em-x11 compositor architecture and a SAB-based input ring buffer for
  delivering mouse/key events during worker blocking. Complex, but keeps
  standard Tk dialog APIs working.
- **SAB input ring + C-level tkwait with compose**: Worker's tkwait loop
  calls `composeNow()` synchronously (via EM_JS) after each
  `Tcl_DoOneEvent(TCL_DONT_WAIT)`. Main thread writes input events to a SAB
  ring buffer that C code reads directly (bypassing postMessage). This avoids
  both JSPI and em-x11 compositor changes, but requires SAB plumbing.
