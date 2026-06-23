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
              → select() → poll()                ← in libem_x11_event_queue.so
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

## Updated conclusion

| Approach | Yields to JS? | Dialog renders? | Result |
|----------|--------------|----------------|--------|
| ctypes callback → run_sync | YES (JS frame blocks) | YES (then error) | SuspendError |
| emscripten_sleep (side module) | NO (no JSPI attrs) | NO | freeze |
| Custom Promise import | NO (no JSPI attrs) | NO | freeze |
| usleep (Wasm export) | NO (pure Wasm) | NO | freeze |
| Python tkwait intercept + poll no-block | NO (never reached) | NO | freeze |
| Tcl-level tkwait replace + createcommand yield | NO (freeze before tkwait) | NO | freeze |

All seven approaches fail. The core problem: **from a side module,
nothing can trigger JSPI suspension.** But the freeze point is broader
than originally thought — it's not just `tkwait`:

- `tkwait window/variable` — Tcl event loop, blocks in `Tcl_DoOneEvent`
- `WaitForConfigureNotify` — Tk internal, blocks in `Tcl_DoOneEvent`
- `WaitForMapNotify` — same pattern
- Any synchronous X11 operation waiting for a server reply

All these loop calling `Tcl_DoOneEvent(TCL_ALL_EVENTS)` which calls
`select/poll`. Without JSPI yield from the side module, none can make
progress — events never arrive from the browser.

The `auto_index` array is empty in this build, meaning dialog commands
like `tk_getOpenFile`, `tk_messageBox`, `tk_chooseColor` are pre-loaded
(not autoloaded on demand). This is fine — the commands exist and are
callable. The freeze is in their *execution*, not their loading.

## Fix direction

The yield **must** originate from Python code running in the main
module's Wasm context, where `run_sync(asyncio.sleep(...))` triggers
JSPI through the main module's properly-configured suspending imports.

Approaches ruled out by these experiments:

- **ctypes callback → run_sync**: JS frames between Wasm frames block JSPI
- **Side module JS import returning Promise**: no JSPI attributes on side module imports
- **Wasm-to-Wasm call chain**: musl sleep is pure Wasm, never hits a JS import
- **Python tkwait interception**: can't intercept Tcl-internal tkwait calls
- **Tcl-level tkwait replacement**: freeze happens before tkwait is reached

Open directions (untested):

- **Custom Tcl notifier**: Replace the default Unix notifier with one
  that calls back into Python for blocking waits. This would intercept
  `Tcl_WaitForEvent` (the function called by `Tcl_DoOneEvent` when no
  events are available), not just `tkwait`. All blocking paths
  (`tkwait`, `WaitForConfigureNotify`, `WaitForMapNotify`) go through
  `Tcl_WaitForEvent` → `select/poll`. A custom notifier could call a
  Python callback (via `createcommand` or other Wasm-only path) that does
  `run_sync(asyncio.sleep(...))`. Whether the `run_sync` path works from
  within a notifier callback is unknown — Experiment 7's `createcommand`
  → `run_sync` chain never actually reached `run_sync` because the freeze
  happened earlier.
- **Browser-native dialogs**: Use `<input type="file">`,
  `window.confirm()`, etc. from JS and relay the results to Python.
  Only works for the standard dialog types, not custom dialogs.
- **Asynchronous dialog API**: Change the Python API so dialogs are
  `await`-able instead of blocking. This would require rewriting the
  `tkinter.filedialog` / `messagebox` / `colorchooser` modules to use
  async/await, and the demo code would need to change.
