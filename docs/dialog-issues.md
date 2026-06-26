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

## Experiment 14: emscripten_sleep third verification + poll.c comment fix (2026-06-26)

After Experiment 13 confirmed the JS trampoline is unavoidable for Tcl→Python
calls, one question remained: poll.c's comment claimed `emscripten_sleep` from
side modules "JSPI suspends correctly (verified June 2026)", which directly
contradicted Experiments 2 and 12c.

To eliminate the possibility that the ctypes callback was somehow interfering
(e.g. callback throws, side-module state corrupted), the ctypes
`g_poll_yield_fn` registration in worker.ts was completely disabled. With
no callback set, poll()'s blocking path falls through to the raw
`emscripten_sleep()` import.

**Result**: **Freeze (confirmed for the third time).** Dialog hangs,
buttons unresponsive, same as Experiments 2 and 12c. The side module's
`emscripten_sleep` import returns a Promise but JSPI does NOT suspend —
Emscripten 5.0.3's JSPI wrappers only cover the main module's imports.

**Action taken**: Updated poll.c's comment to reflect the actual situation:
in a standalone JSPI build, `emscripten_sleep` works; in Pyodide's
side-module context, neither `emscripten_sleep` nor ctypes callback can
trigger JSPI suspension. The comment now correctly documents the limitation.

**Key takeaway**: The contradiction between poll.c and worker.ts comments
is now resolved — worker.ts was right all along. `emscripten_sleep` from
side modules does NOT suspend in Emscripten 5.0.3 + Pyodide. Both poll.c
suspend paths are dead in the Pyodide worker context.

## Experiment 15: WebAssembly.Suspending wrapper on wasmImports (2026-06-26)

**Hypothesis**: The side module's `emscripten_sleep` import lacks JSPI
suspending attributes because Pyodide's `loadDynlib` → `loadWebAssemblyModule`
→ `proxyHandler.get()` returns `wasmImports[prop]` directly, without
`WebAssembly.Suspending()` wrapping. If we inject a `new WebAssembly.Suspending(fn)`
into `wasmImports` BEFORE loading side modules, the proxy would return the
Suspending-wrapped function, and JSPI should suspend when the side module calls it.

The side modules are compiled with `-sJSPI=1` (Makefile line 64), so their
wasm binaries SHOULD declare `emscripten_sleep` as a suspending import.

**Change (worker.ts line 354)**:

```typescript
// Before (freeze):
wasmImports['emscripten_sleep'] = (ms: number) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
};

// After (Experiment 15):
wasmImports['emscripten_sleep'] = new WebAssembly.Suspending((ms: number) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
});
```

### Phase 1: Minimal Node.js test (ctypes path)

Used `py.runPythonAsync()` (promising entry) with ctypes to call `poll()` from
`libem_x11_libc_override.so` with empty fd set and 100ms timeout. The
`g_poll_yield_fn` callback was set to `None` so poll() falls through to
`emscripten_sleep`.

**Result: `SuspendError: trying to suspend JS frames`**

Stack trace:
```
wasm-function[26] (side module: emscripten_sleep import call)
  → ffi_call_js (JS: ctypes FFI trampoline)
    → wasm-function[5354] (main module: CPython)
```

The ctypes path has `ffi_call_js` between main/side module wasm frames —
expected to fail. But critically: JSPI now RECOGNIZES the suspending import
and ATTEMPTS to suspend. Before this change, the raw function was silently
ignored (freeze). This confirms the Suspending wrapper is correct.

Side modules loaded OK — no WebAssembly type mismatch on instantiation. The
Suspending wrapper matches the side module's JSPI import declaration.

### Phase 2: Browser test (real dialog path)

Tested in browser with Widget Gallery demo. Clicked a button that opens
`filedialog.askopenfilename()`.

**Result: `SuspendError: trying to suspend JS frames`** (repeated 277 times
in console, followed by OOM after prolonged freeze). The SuspendError is
fatal (`pyodide_fatal_error: true`), crashing the Pyodide runtime.

Browser stack trace:
```
pyodide.asm.wasm (main module: _pyproxy_apply_promising)
  → trampoline_call @ 63d3739a:0xa7        ← JS frame (side-module import stub)
    → pyodide.asm.wasm (main module: PyObject_Call, _PyEval_EvalFrameDefault, ...)
      → trampoline_call @ 63d3739a:0xa7    ← JS frame (side-module import stub)
        → pyodide.asm.wasm (main module: _pyproxy_apply)
          → JsvFunction_CallBound → scheduleCallback → postMessage → setTimeout
```

**Why it still fails**: Emscripten's dynamic linker inserts a `trampoline_call`
JS frame on EVERY cross-module call. The real dialog path is NOT pure
wasm-to-wasm as previously assumed:

```
Before assumption:
  Python → _tkinter → Tcl → poll → emscripten_sleep
  (all wasm-to-wasm function table calls)

Actual reality:
  Python → trampoline_call(JS) → _tkinter → trampoline_call(JS) → Tcl
    → trampoline_call(JS) → poll → emscripten_sleep(Suspending)
    → JSPI walks stack → finds trampoline_call JS frame → SuspendError
```

Each `.so` file has its own wasm module instance with its own function table.
Cross-module calls go through JS trampolines that translate function table
indices. These JS frames are compiled INTO each side module by Emscripten
(`-sSIDE_MODULE=1`). They cannot be bypassed at the import/export level.

### Key takeaway

The `WebAssembly.Suspending` wrapper on `wasmImports` IS correct and WORKS —
JSPI now recognizes the suspending import and attempts to suspend. This is
progress from Experiments 2/12c/14 where the raw function was silently ignored.

However, the JS trampolines inherent in Emscripten's dynamic linker
architecture are the NEXT blocker. Even with a properly JSPI-wrapped import,
suspension fails because the wasm stack between the promising entry and the
suspending import is NOT contiguous — it's split by `trampoline_call` JS
frames at every cross-module boundary.

This rules out ALL approaches that rely on JSPI from side modules, regardless
of import wrapping technique.

## Experiment 16: Force JS trampoline — isolate trampoline module (2026-06-26)

Experiment 15 showed `trampoline_call @ 63d3739a:0xa7` in the browser stack
trace. This is a **wasm trampoline module** — a separate `WebAssembly.Instance`
created by `getPyEMTrampolinePtr()` from a hardcoded hex wasm binary. It sits
between main-module and side-module frames. Since it's NOT compiled with
`-sJSPI=1`, JSPI might treat it as non-JSPI wasm and reject suspension.

**Hypothesis**: The wasm trampoline module (separate instance, no JSPI) is the
specific blocker. If we force Pyodide to use the JS trampoline instead (a JS
function that does `wasmTable.get(func)(arg1, arg2, arg3)`), the stack would
have a JS frame — equally fatal for JSPI, but for a *different reason*
("trying to suspend JS frames" vs "non-JSPI wasm in middle"). If the error
changes, the trampoline module is the addressable blocker.

**Change (`pyodide.asm.mjs`, `getPyEMTrampolinePtr`)**:

Forced the function to return 0 immediately, which causes Pyodide to fall
back to `_PyEM_TrampolineCall_JS` — a JS function that does raw
`wasmTable.get(func)(arg1, arg2, arg3)`. This eliminates the wasm trampoline
instance from the call chain entirely.

**Result: `SuspendError: trying to suspend JS frames`** — same error, same
message. Whether the trampoline is:
- JS function (`_PyEM_TrampolineCall_JS`): "trying to suspend JS frames"
- Wasm module (`trampoline_call @ 63d3739a`): "trying to suspend JS frames"

Both produce identical failures. The trampoline module is NOT the uniquely
addressable blocker — the very concept of cross-module calls (which Emscripten's
dynamic linker fundamentally requires) creates a non-suspendable boundary.

**The two trampoline mechanisms in Pyodide**:

| Mechanism | What it is | JSPI-compatible? |
|-----------|-----------|------------------|
| `_PyEM_TrampolineCall_JS` | JS function: `wasmTable.get(func)(args)` | No — JS frame |
| `trampoline_call` (wasm) | Separate `WebAssembly.Instance` from hex | No — not compiled with `-sJSPI=1` |

Neither can be fixed at runtime. Recompiling the wasm trampoline with
`-sJSPI=1` would require modifying Pyodide's build system; making cross-module
calls direct (without trampolines) would require merging all side modules into
a single wasm instance — neither is achievable via runtime patching of
`pyodide.asm.mjs`.

**Key takeaway**: Approach B (消灭 trampoline_call) is infeasible. The
trampoline is a fundamental architectural component of Emscripten's dynamic
linker, not a bug or oversight that can be patched at the JS level.

This rules out ALL approaches that rely on JSPI from side modules, regardless
of import wrapping technique.

## Experiment 17: Bypass addFunction — direct wasmTable.set (2026-06-26)

After full decode of the 493-byte trampoline wasm module, the root cause of
the JS frame is identified: **NOT the trampoline module itself, but
`addFunction()` in `getPyEMTrampolinePtr`**.

### Trampoline module architecture

The decoded trampoline module:
- 5 function types: `(i32,i32,i32)→i32`, `(i32,i32)→i32`, `(i32)→i32`,
  `()→i32`, `(i32,i32,i32,i32,i32)→i32`
- Imports only `env.memory` and `env.__indirect_function_table` — **no JS
  function imports**
- Exports `trampoline_call` — uses `br_table` dispatch + `call_indirect` to
  normalize function pointer signatures (handles bad C function pointer casts)
- Contains no suspending imports — recompiling with `-sJSPI=1` would change
  zero bytes in the wasm binary

### Where the JS frame actually comes from

```js
// getPyEMTrampolinePtr() in pyodide.asm.mjs:
return addFunction(trampolineInstance.exports.trampoline_call);
```

`addFunction()` wraps the wasm export in a JS function and places the JS
wrapper in `wasmTable`. When C code does `call_indirect` through this table
entry, the call chain is:

```
Wasm (main/side module) → call_indirect → JS wrapper (addFunction) → trampoline wasm
```

The JS wrapper IS the JS frame that JSPI can't save. The trampoline wasm
module itself is pure wasm — it's the `addFunction` mechanism that introduces
the JS frame.

### Hypothesis

Replace `addFunction()` with direct `wasmTable.grow()` + `wasmTable.set()`:

```js
const idx = wasmTable.length;
wasmTable.grow(1);
wasmTable.set(idx, trampolineInstance.exports.trampoline_call);
return idx;
```

This places the wasm export directly in the table (no JS wrapper). `call_indirect`
through this entry would be pure wasm→wasm. If this eliminates the JS frame, JSPI
should be able to suspend through the trampoline.

### Caveat

Even if this works for the trampoline, side modules still have JS import stubs
(`proxyHandler.get` returns JS functions). The trampoline is just ONE of several
JS frames in the cross-module call chain. This is a necessary but potentially
insufficient fix.

**Changes**:
-  (): replaced  with:
  
  This places the wasm export directly in the table (no JS wrapper). Fallback to
   if grow/set fails.
-  (line 354):  wrapped in 
  (re-applied from Experiment 15 — needed so JSPI recognizes the suspending import)

**Status**: **FAILED — same SuspendError**

Browser test result: `SuspendError: trying to suspend JS frames`, identical to
Experiments 15 and 16.

**Why**: Eliminating the `addFunction` JS wrapper on the trampoline entry was
necessary but insufficient. The JS frames that block JSPI come from multiple
sources in the cross-module call chain, not just the trampoline:

1. **`proxyHandler.get()`** in `loadWebAssemblyModule` returns `wasmImports[prop]`
   directly — which is a JS function. When a side module calls an import like
   `emscripten_sleep`, this JS→wasm boundary creates a JS frame.
2. **Side-module import stubs** — each `.so` has Emscripten-generated JS stubs
   for cross-module calls. These are compiled into every side module.
3. **Multiple trampoline crossings** — the browser stack trace (Experiment 15)
   shows TWO `trampoline_call` frames. Even with one fixed, the other remains.

The trampoline's `addFunction` wrapper was ONE JS frame among several. Removing
it doesn't eliminate the fundamental problem: Emscripten's dynamic linker
architecturally requires JS frames at every module boundary.

**Key takeaway from Experiments 15–17**: All three experiments attempted to fix
JSPI suspension from different angles (import wrapping, trampoline elimination,
direct table manipulation). All three produced the same `SuspendError`. JSPI
from side modules is impossible without redesigning Emscripten's dynamic linker.
This approach is conclusively dead.

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
| 14 | **emscripten_sleep third verification + poll.c fix** | **Side-module import, ctypes off** | **freeze (confirmed yet again; poll.c comment corrected)** |
| 15 | **WebAssembly.Suspending on wasmImports** | **JSPI-wrapped import from side module** | **SuspendError (trampoline_call JS frames between modules)** |
| 16 | **Force JS trampoline (disable wasm trampoline)** | **Isolate trampoline module as blocker** | **SuspendError (both trampolines equally fatal)** |
| 17 | **Direct wasmTable.set (bypass addFunction)** | **Eliminate addFunction JS wrapper** | **SuspendError (JS frames at every module boundary, not just trampoline)** |

## Root cause (final)

After 17 experiments, the root cause of dialog freeze is established at
two levels:

**Level 1 (JSPI)**: From a side module, no mechanism can trigger JSPI
suspension. Every conceivable path has been tried and fails:
- ctypes callbacks → JS frame (SuspendError)
- side-module JS imports returning Promise → no JSPI attributes (freeze)
- side-module-to-main-module calls → JS trampoline (SuspendError)
- side-module-to-side-module calls → Tcl_Eval can't be found by dlsym
- Python C API via extern → JS trampoline (SuspendError)
- **Python tkwait via createcommand → JS trampoline (SuspendError)** (Experiment 13)
- **WebAssembly.Suspending on wasmImports → trampoline_call JS frames (SuspendError)** (Experiment 15)
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

**Experiment 15 refined this understanding**: The `trampoline_call` JS frame
is NOT just for side-module→main-module calls — it appears on EVERY
cross-module boundary, including side-module→side-module calls. Each `.so`
has its own wasm module instance with its own function table, and
Emscripten compiles JS trampolines into each side module to handle
cross-instance function table calls. These trampolines are a fundamental
part of Emscripten's dynamic linker architecture and cannot be bypassed
at the import/export level (Experiment 15) or the symbol resolution level
(Experiments 8–10, 13).

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
- **WebAssembly.Suspending wrapper on wasmImports (Experiment 15)**:
  SuspendError — JSPI recognizes the suspending import and attempts to
  suspend, but `trampoline_call` JS frames at every cross-module boundary
  split the wasm stack into non-contiguous blocks. The import wrapping is
  correct; the dynamic linker's JS trampolines are the unfixable blocker.
- **Force JS trampoline / disable wasm trampoline module (Experiment 16)**:
  SuspendError — both trampoline mechanisms (JS function and separate wasm
  module instance) produce the same failure. The trampoline module is NOT
  the uniquely addressable blocker; Emscripten's cross-module call
  architecture as a whole is incompatible with JSPI suspension.
- **Direct wasmTable.set bypass addFunction (Experiment 17)**:
  SuspendError — eliminating the `addFunction` JS wrapper on the trampoline
  is insufficient. JS frames come from multiple sources (import stubs,
  proxyHandler.get, multiple trampoline crossings). Removing one leaves
  the others intact. Approach B (消灭 trampoline_call) is conclusively
  infeasible without redesigning Emscripten's dynamic linker.

Approaches proven viable:
- `--wrap TkUnixDoOneXEvent` (Experiment 12a): successfully bypassed
  `WaitForConfigureNotify`. Clean source separation (patches in `src/patch/`,
  tracked by git, no modification to `ignored-area/` or `tcldide/`).

Approaches conclusively ruled out:
- **Approach B: 消灭 trampoline_call (Experiments 15–16)**: The trampoline
  is a fundamental architectural component of Emscripten's dynamic linker.
  Both trampoline mechanisms (JS function and separate wasm module instance)
  produce the same SuspendError. Cannot be eliminated via runtime patching
  of `pyodide.asm.mjs` — would require recompiling Pyodide's trampoline
  module with `-sJSPI=1` or merging all wasm modules into a single instance.

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
