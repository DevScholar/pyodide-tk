# pyodide-tk patches against upstream Tcl/Tk and CPython

This document describes how the source trees built by pyodide-tk
diverge from the upstream Tcl 8.6.15, Tk 8.6.15, and CPython 3.14.2
releases, **and** the runtime Python monkey-patches the worker
applies before user code runs.

The short version: **pyodide-tk applies no source-level patches.**
All three components are built unmodified from their official
tarballs. The wasm-specific behaviour comes from build flags, a post-
configure sed pass, the way the resulting archives are relinked
as Pyodide-style side modules, and a small set of runtime
monkey-patches against `tkinter` in the worker prelude. The points
below document those deltas so they can be reproduced and audited.

## Summary

| Component        | Upstream                | Source patches | Build-level changes |
|------------------|-------------------------|----------------|---------------------|
| Tcl 8.6.15       | tcl-core8.6.15-src      | none           | wasm-EH ABI, side-module relink, cross-compile cv overrides for strtoul/strstr/cpuid |
| Tk 8.6.15        | tk8.6.15-src            | none           | em-x11 X11 headers, fontconfig disabled, `--disable-xss`, side-module relink |
| CPython 3.14.2 `_tkinter` | Modules/_tkinter.c | none   | side-module compile against em-x11 + Pyodide xbuildenv `Python.h` |
| em-x11           | sibling repo            | none           | rebuilt under wasm-EH `-fPIC`, split side modules with proper NEEDED chains |
| `::tcldide::*` cmds | `../tcldide/opt/tcldide.c` | none           | sibling source compiled as `libtcldide.so` side module; `Tcldide_Init(interp)` invoked via ctypes on every `tkinter.Tk()` |
| `tkinter` Python | stdlib `Lib/tkinter`    | none           | runtime monkey-patches in worker prelude (`Misc.after`, `Misc.mainloop`, `tkinter.mainloop`, `Misc.quit`, `Tk.__init__`) — see "Runtime Python prelude patches" below |

Contrast with the sibling [tcldide](../../tcldide/docs/patch.md),
which inherits a Tcl source patch from the upstream wacl project.
pyodide-tk did not need that patch because its targets differ:

- Pyodide ships a known-good emscripten libc, so the `strstr` /
  `strtoul` / `strtod` runtime probes that tcldide deletes are bypassed
  via `cross_compiling=yes` plus the same
  `tcl_cv_str{toul,str}_unbroken=ok` / `ac_cv_func_strtoul=yes`
  cv overrides tcldide uses, instead of patching the source.
- The `tclUnixChan.c` / `tclUnixNotfy.c` `exceptfds` assertion that
  tcldide works around does not fire in the wasm-EH build path used
  here, since the notifier we end up using is em-x11's, not Tcl's
  default `select()` notifier.
- We do not embed extra C sources into `libtcl` — Pyodide's loader
  composes side modules at dlopen time, so the tcldide `opt/tcldide.c`
  injection point is unnecessary.

## Tcl 8.6.15 (build-level only)

Source: `wget` of `tcl-core8.6.15-src.tar.gz`, extracted under
`build/tcl/`. No `patch` step.

### Configure
```
emconfigure ./configure \
    --host=wasm32-unknown-emscripten \
    --prefix=$(PREFIX) \
    --disable-threads --disable-load --disable-shared \
    ac_cv_have_intrinsic_cpuid=no \
    ac_cv_func_strtoul=yes \
    tcl_cv_strtoul_unbroken=ok \
    tcl_cv_strstr_unbroken=ok \
    CFLAGS="-Oz -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -fPIC" \
    LDFLAGS="-fwasm-exceptions -sSUPPORT_LONGJMP=wasm"
```
Key choices:
- **wasm-EH ABI** (`-fwasm-exceptions -sSUPPORT_LONGJMP=wasm`) —
  matches Pyodide 314's `pyemscripten_2026_0` ABI. Mixing JS-EH and
  wasm-EH side modules in the same Pyodide instance fails at
  dlopen.
- `-fPIC` is mandatory for `-sSIDE_MODULE=1` relink.
- `--disable-threads --disable-load --disable-shared` — same
  rationale as tcldide.
- `ac_cv_have_intrinsic_cpuid=no` — wasm32 has no GNU/x86 cpuid
  intrinsic; preempt the feature probe.
- `ac_cv_func_strtoul=yes` and
  `tcl_cv_str{toul,str}_unbroken=ok` — Tcl 8.6.15 ships
  `compat/str{toul,str}.c` and the cross-compile path defaults the
  unbroken-func cv vars to "unknown" (treated as broken). Without
  these overrides Tcl bundles its own copies and wasm-ld errors
  with "duplicate symbol" against emscripten libc at side-module
  link time.

Post-configure sed strips `-O2` so it does not override `-Oz`.

### Side-module relink
The static archive is then relinked as a Pyodide side module:
```
emcc -sSIDE_MODULE=1 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm \
    -o libtcl8.6.so \
    -Wl,--whole-archive libtcl8.6.a -Wl,--no-whole-archive
```
`--whole-archive` is required because `libtcl` exports many
symbols (`Tcl_Eval`, `Tcl_NewObj`, …) that no static caller
references at link time — without this flag, the linker drops
most of the archive.

## Tk 8.6.15 (build-level only)

Source: `wget` of `tk8.6.15-src.tar.gz`, extracted under
`build/tk/`. No `patch` step.

### Configure
```
PATH="$(CURDIR)/scripts:$$PATH" \
EMX11_INCLUDES="$(EMX11_INCLUDES)" \
EMX11_LIBDIR="$(LIBDIR)" \
XFT_CFLAGS="-I$(EMX11_INCLUDES)" \
XFT_LIBS="-L$(LIBDIR) -lemx11" \
ac_cv_lib_Xft_XftFontOpen=yes \
ac_cv_lib_fontconfig_FcFontSort=no \
ac_cv_lib_X11_XkbKeycodeToKeysym=yes \
cross_compiling=yes \
emconfigure ./configure \
    --host=wasm32-unknown-emscripten \
    --prefix=$(PREFIX) \
    --with-tcl=$(LIBDIR) \
    --x-includes=$(EMX11_INCLUDES) \
    --x-libraries=$(LIBDIR) \
    --disable-threads --disable-load --disable-shared \
    --disable-xss \
    CFLAGS="…" LDFLAGS="…"
```
Same em-x11 redirection trick tcldide uses: real `X11/*.h` headers
come from em-x11, but no Xlib `.so` is supplied — Tk's unresolved
X11 symbols stay in the archive and are resolved
against the em-x11 split side modules at the `_tkinter.so` link step.

Differences from tcldide's Tk configure:
- **`--disable-xss`** is passed explicitly. em-x11 stubs the
  XScreenSaver entry points, but at this build's snapshot Tk's
  feature detection picks them up incorrectly under
  `cross_compiling=yes`; disabling the screen-saver extension keeps
  the Tk build self-consistent.
- `EMX11_LIBDIR` points into the local `build/install/lib` rather
  than em-x11's own `build/artifacts`, so configure caches the
  link path that the side-module relink will consume.

Post-configure sed:
- strip `-O2` (preserves `-Oz` from `CFLAGS_X`).
- force `X11_INCLUDES = -I$(EMX11_INCLUDES)` so em-x11's headers
  win over anything the X probe inserted.

A `scripts/xft-config` shim on `PATH` answers `--cflags`/`--libs`
to satisfy Tk's Xft probe.

### Side-module relink
```
emcc -sSIDE_MODULE=1 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm \
    -o libtk8.6.so \
    -Wl,--whole-archive libtk8.6.a -Wl,--no-whole-archive \
    -sERROR_ON_UNDEFINED_SYMBOLS=0
```
`-sERROR_ON_UNDEFINED_SYMBOLS=0` lets the unresolved Xlib symbols
through; they bind at dlopen time when `_tkinter.so` pulls in the
em-x11 split side modules via NEEDED.

## CPython 3.14.2 `_tkinter` (build-level only)

`Modules/_tkinter.c`, `Modules/tkappinit.c`, `Modules/tkinter.h`,
and `Modules/clinic/_tkinter.c.h` are extracted from the upstream
`Python-3.14.2.tgz` and compiled **without modification** as a
SIDE_MODULE.

```
emcc -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -fPIC -sSIDE_MODULE=1 \
    -DWITH_APPINIT=1 -DPy_BUILD_CORE_BUILTIN=1 \
    -I $(PYINC) -I $(CPYTHON_SRC)/Include/internal -I $(CPYTHON_SRC) \
    -I $(INCDIR) -I $(INCDIR)/tk \
    -I $(EMX11_INCLUDES) \
    _tkinter.c tkappinit.c \
    libtk8.6.so libtcl8.6.so \
    libX11.so libXft.so libXrender.so libfontconfig.so \
    -sERROR_ON_UNDEFINED_SYMBOLS=0 \
    -o _tkinter.so
```
- `$(PYINC)` is `Python.h` from the Pyodide xbuildenv
  (`pyodide xbuildenv install 0.34.3`). Reusing the xbuildenv
  guarantees `_tkinter.so` is ABI-compatible with the CPython
  Pyodide loads at runtime.
- `-DPy_BUILD_CORE_BUILTIN=1` plus `Include/internal/` are required
  because CPython 3.14's `_tkinter.c` references private headers
  (e.g. `pycore_long.h`) under that gate.
- The trailing `libtk8.6.so libtcl8.6.so libX11.so libXft.so
  libXrender.so libfontconfig.so` add NEEDED entries; Pyodide's
  `loadDynlib` then auto-cascades dependencies through the X11
  split-module graph.

The Python-side `Lib/tkinter` and `turtle.py` are extracted only
to be staged separately by `scripts/stage-assets.sh`. Pyodide
strips `Lib/tkinter` from `python314.zip` so we re-stage it onto
MEMFS at runtime; this is asset packaging, not a CPython patch.

## em-x11 side-module relink

em-x11 ships as six standard X11 archives (`libX11.a`, `libXext.a`,
`libXrender.a`, `libfontconfig.a`, `libXft.a`, `libGLX.a`; see
em-x11 docs). pyodide-tk rebuilds them under the same wasm-EH
`-fPIC` flags, then relinks each static archive into its own
SIDE_MODULE with proper NEEDED dependency chains. GLX is excluded —
`_tkinter` doesn't use OpenGL and pulling `glx.c` in would drag the
legacy GL emulation entry points into the dlopen graph.

The dependency graph mirrors real X's NEEDED chain:

| Side module       | NEEDED deps                                              |
|-------------------|----------------------------------------------------------|
| `libX11.so`       | `libtcl8.6.so`                                           |
| `libXext.so`      | `libX11.so`, `libtcl8.6.so`                             |
| `libXrender.so`   | `libX11.so`, `libtcl8.6.so`                             |
| `libfontconfig.so`| `libX11.so`, `libtcl8.6.so`                             |
| `libXft.so`       | `libXrender.so`, `libfontconfig.so`, `libX11.so`, `libtcl8.6.so` |

Each `.so` is built with a recipe of the form:

```
emcc -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -Oz -sSIDE_MODULE=1 \
    -o libXXX.so \
    -Wl,--whole-archive libXXX.a -Wl,--no-whole-archive \
    <NEEDED .so files> \
    -sERROR_ON_UNDEFINED_SYMBOLS=0
```

The trailing `.so` arguments (e.g. `libtcl8.6.so` on every link line)
are load-bearing: they land on each module's NEEDED list. Pyodide's
`loadDynlib` auto-cascades through NEEDED entries at dlopen time, so
the worker only needs to load `libX11.so` and `libXft.so` explicitly —
the rest resolve recursively. `libtcl8.6.so` is loaded first with
`global: true` so `Tcl_SetNotifier` (in `libX11`, undefined at build
time) resolves against it via RTLD_GLOBAL.

`EMX11_HIDE_INTERNAL_SYMBOLS=OFF` is forced during the cmake build so
every Xlib symbol is visible for export at the side-module relink step.

## Asset staging (not a patch, but ABI-relevant)

After every native rebuild, `scripts/stage-assets.sh` copies the
fresh `.so`s, the `Lib/tkinter` tree, and Tcl/Tk's `library/` Tcl
scripts into `public/` for Vite to serve. Skipping this step
silently exposes stale `.so`s — a common debugging trap.

## Why no source patch was needed

The two Tcl-source issues that motivate tcldide's `tcldide.patch` are
both side-stepped here:

1. **Runtime autoconf probes** — bypassed by `cross_compiling=yes`
   plus explicit `ac_cv_*` overrides for Xft/fontconfig.
2. **`select(exceptfds)` assertion** — em-x11 supplies the Tcl
   notifier (`Tcl_SetNotifier`), so `tclUnixNotfy.c`'s default
   `select()` path is replaced wholesale. The patched select call
   would only run in a build that uses Tcl's stock notifier.

If a future Tcl/Tk version regresses one of these assumptions, the
fix should land here as a `.patch` file applied during `tclprep`/
`tkprep`, mirroring tcldide's structure.

## libtcldide side module

`libtcldide.so` is built from the **sibling** [`../tcldide/opt/tcldide.c`](../../tcldide/opt/tcldide.c)
(single source of truth — no copy). It contributes two Tcl commands
to every interpreter:

- **`::tcldide::dom action selector key val`** — query `document` via
  `EM_ASM_INT`, run `querySelectorAll(selector)`, set
  `attr` or `style.{key} = val` on each match. Returns the count
  of elements changed.
- **`::tcldide::jscall fcnPtr returnType argType ?args…?`** — invoke a
  function pointer (e.g. obtained via `Module.addFunction`) with the
  declared C signature, passing arguments coerced from Tcl through
  the listed type tags.

### Build
```make
TCLDIDE_SRC = $(CURDIR)/../tcldide/opt/tcldide.c

$(LIBDIR)/libtcldide.so: $(TCLDIDE_SRC) $(LIBDIR)/libtcl8.6.so
    emcc -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -fPIC -sSIDE_MODULE=1 \
        -I $(INCDIR) \
        $(TCLDIDE_SRC) $(LIBDIR)/libtcl8.6.so \
        -sERROR_ON_UNDEFINED_SYMBOLS=0 \
        -o $(LIBDIR)/libtcldide.so
```

`libtcl8.6.so` is on the link line so libtcldide's references to
`Tcl_CreateNamespace`, `Tcl_CreateObjCommand`, etc. land on
libtcldide's NEEDED entry — Pyodide's `loadDynlib` then auto-cascades
the dependency.

### Runtime wiring (worker.ts)

Loaded globally so its `Tcldide_Init` symbol is reachable via ctypes:
```ts
await pyi.loadDynlib('/usr/lib/libtcldide.so', { global: true });
```
(`allowUndefined: true` is injected by the `pyodideInternals` helper that wraps
`py._api.loadDynlib`; the worker calls `pyi.loadDynlib` rather than the raw API.)

Then a Python prelude monkey-patches `tkinter.Tk.__init__` so every
new root automatically registers `::tcldide::*`:
```python
import ctypes, tkinter
_tcldide = ctypes.CDLL('/usr/lib/libtcldide.so')
_tcldide.Tcldide_Init.argtypes = [ctypes.c_void_p]
_tcldide.Tcldide_Init.restype  = ctypes.c_int
_orig = tkinter.Tk.__init__
def _install(self, *a, **kw):
    _orig(self, *a, **kw)
    _tcldide.Tcldide_Init(self.tk.interpaddr())
tkinter.Tk.__init__ = _install
```

The `tkapp.interpaddr()` call returns the underlying `Tcl_Interp*`,
and `Tcldide_Init` registers its commands on that interpreter. Demo
code can then use them straight from `root.tk.call(...)` or, more
typically, via `root.tk.eval(...)`:
```python
root = tkinter.Tk()
root.tk.call('::tcldide::dom', 'css', '#status', 'color', 'red')
```

### Optional dependency

Both the build (`Makefile`) and the worker (`worker.ts`) tolerate a
missing libtcldide: `make` aborts with a clear message if
`../tcldide/opt/tcldide.c` isn't present, and the worker's fetch is
wrapped in `.catch(() => null)` so a missing
`pyodide-tk-assets/lib/libtcldide.so` skips the dynlib load and leaves
`tkinter.Tk` untouched. Standard tkinter still works in either case;
only `::tcldide::dom` / `::tcldide::jscall` become unavailable.

### Why a side module instead of patching CPython's tkappinit.c

`Modules/tkappinit.c` is the natural hook for "run something after
`Tcl_Init`". Putting `Tcldide_Init` there would make the bridge
automatic with no Python prelude. We chose the side-module route
to preserve the project's no-source-patch invariant — `_tkinter.c`
and `tkappinit.c` remain literally byte-identical to upstream
CPython 3.14.2. The cost is a few lines of Python wiring; the
benefit is that bumping CPython is `tar -x` away with no rebase.

## Runtime Python prelude patches

These are monkey-patches the worker applies to `tkinter` via
`pyodide.runPythonAsync` **before** the user demo runs. They are not
source patches against CPython's `Lib/tkinter` — the on-disk
`tkinter.tar` staged into MEMFS is byte-identical to the
`Python-3.14.2.tgz` `Lib/tkinter/` tree. The patches live in the
prelude string inside [`src/worker.ts`](../src/worker.ts) and only
take effect inside the worker realm pyodide-tk runs.

The worker also installs a JS-side pair to back the prelude:

- **`globalThis._emx11_park()`** returns a `Promise<void>` that
  resolves on the next notifier wake (Tcl timer expiry, alert) or
  main-thread input message. Used by the mainloop patch as its
  per-iteration idle point.
- **`globalThis._emx11_set_mainloop_active(bool)`** gates the
  JS-side adaptive pump (`runDrain`) so it does not race the
  Python-side mainloop on `dooneevent`.

### `tkinter.Tk.__init__` — auto-register `::tcldide::*`

**Patch shape.** Wrap `Tk.__init__` so every new root, immediately
after the original constructor returns, gets `Tcldide_Init(interp)`
called on its underlying `Tcl_Interp*` via `ctypes.CDLL`.

**Why.** `libtcldide.so` exposes the `::tcldide::dom` and `::tcldide::jscall`
Tcl commands. Stock CPython has no place to register them between
`Tcl_Init` and the first Python-visible Tcl call; doing it in
`_tkinter.c`'s `tkappinit.c` would require a source patch we
explicitly forbid (see "Why a side module instead of patching
CPython's tkappinit.c" above). Hooking `Tk.__init__` from Python is
the smallest equivalent.

**Failure mode.** If `libtcldide.so` isn't shipped (sibling tcldide not
built), the `ctypes.CDLL` call raises `OSError`; the patch swallows
it and leaves `Tk.__init__` untouched. Plain tkinter still works,
`::tcldide::*` just isn't registered.

### `tkinter.Misc.after(ms)` (no-callback form) — yield via JSPI

**Patch shape.** Intercept the one-argument form
`root.after(ms)`. When `func` is `None`, replace the Tcl-side sync
`after delay` with `run_sync(asyncio.sleep(ms / 1000))`. The
two-argument form (`root.after(ms, callback)`) falls through
unchanged.

**Why.** The Tcl-level sync `after delay` busy-loops
`Tcl_DoOneEvent` against wallclock until the time elapses. Our
libemx11/libtcl/libtk are built without Asyncify (Pyodide 314 ships
JSPI instead), so emscripten's `emscripten_sleep(1)` inside em-x11's
notifier resolves to a no-op stub — the busy loop never yields to
JS, the browser never composites, and turtle's per-step
`_cv.after(delay)` burns ~7 s of CPU painting nothing. Routing
through `pyodide.ffi.run_sync(asyncio.sleep(...))` suspends the wasm
stack via JSPI, lets one JS turn run (timers fire, frame composites),
and resumes. This is exactly the yielding semantics turtle's
animation loop expects.

**Why not yield from `Misc.update` / `Misc.update_idletasks` too?**
Those are "flush pending events" not "show now". Yielding inside
`update()` makes turtle's `_Screen.setup()` show its default-sized
scroll area for a frame before the geometry resize lands. The next
yield point downstream (a `Misc.after` sleep, or mainloop's park)
composites the post-update state.

### `tkinter.Misc.mainloop` / `tkinter.mainloop` — blocking shallow-suspend loop

**Patch shape.** Replace both entry points with a Python loop that
- snapshots `_emx11_quit_count[0]` as `target`,
- sets `_emx11_set_mainloop_active(True)`,
- repeatedly drains `tkapp.dooneevent(TCL_DONT_WAIT)` until the
  queue empties or a callback bumps the quit counter,
- on each outer iteration suspends exactly **once** via
  `run_sync(_emx11_park())` until the JS notifier or an input
  message wakes the worker,
- exits when `_emx11_quit_count[0] != target`,
- on exit decrements the counter (consuming the quit level) and
  clears `_emx11_set_mainloop_active(False)`.

**Why this specific shape.** Two failure modes had to be avoided:

- *Returning immediately* (the previous patch's behaviour) broke any
  caller assuming "code after `mainloop()` runs only after the user
  closes the window". Most painfully, PySimpleGUI's
  `while True: event = window.read(); ...` pattern — `read()`
  internally calls `mainloop()` then returns the last button click —
  spun a tight loop reading empty events.
- *Blocking via `run_sync(loop.run_forever())`* worked in principle
  but kept the entire `asyncio.run_forever` frame chain alive inside
  a single never-resolving JSPI continuation. Every nested `await`
  inside a callback piled on; V8's native-stack snapshot grew to
  ~5 MB and OOM'd the worker within a few hundred ticks. See the
  `project_pyodide_tk_jspi_stack` memory.

The shallow-suspend loop sidesteps both. The outer `while not quit`
is plain Python — no JSPI suspension across iterations. Only the
inner `run_sync(_emx11_park())` suspends, and that continuation
resolves on the next macrotask (the next JS notifier wake or input
message), so V8 holds at most one continuation snapshot at any
moment. Idle CPU is 0% — the worker parks the same way a Linux X11
client parks in `select()`.

**Quit accounting.** Stock `tkinter.Misc.quit()` calls into
`Tkapp_Quit`, which sets a static flag inside `_tkinter.c` that the
bundled `Tkapp_MainLoop` reads. We don't run that mainloop, so the
patch installs `_emx11_quit_count` as a Python-level mirror and
wraps `Misc.quit` to bump it. Using a counter (not a bool) preserves
nested-mainloop semantics: a modal dialog calling `mainloop()`
inside an outer `mainloop()` pops exactly one level per `quit()`.

**`tkinter.mainloop()` (module-level)** delegates to the patched
`Misc.mainloop` on `tkinter._default_root`. `turtle.done()` reaches
this path; the blocking behaviour now matches desktop tkinter.

### `tkinter.Misc.quit` — bump the Python-level quit counter

**Patch shape.** Wrap `Misc.quit` so each call increments
`_emx11_quit_count[0]` before delegating to the original. Exceptions
from the original (e.g. on a destroyed interpreter) are swallowed —
the counter bump is what our mainloop loop reads.

**Why.** Already covered above under "Quit accounting"; listed
separately here because it is its own monkey-patch and a future
maintainer searching for `Misc.quit` should find an entry.

### JS-side pump gating

Not a Python patch, but tightly coupled to `Misc.mainloop`. While
`_emx11_set_mainloop_active(True)` is in effect, `runDrain` returns
early so the JS-side adaptive pump does not race the Python loop on
`dooneevent`. The flag clears when mainloop exits, and `runDrain` is
kicked once to handle any events that queued during teardown. This
keeps the post-mainloop world (any Python that runs after
`root.mainloop()` returns) interactive without the user re-arming a
pump.

### Why these live in the worker prelude instead of in `Lib/tkinter`

The on-disk `Lib/tkinter` tree is staged as
`pyodide-tk-assets/tkinter.tar` and is byte-identical to upstream
CPython 3.14.2. Patching it on disk would (a) silently complicate
ABI / version-bump comparisons against upstream, and (b) make the
patches invisible to anyone reading `worker.ts` to understand the
runtime. Keeping them as a prelude string means everything that
makes pyodide-tk's `tkinter` behave the way it does — the
yielding `after`, the blocking-but-shallow mainloop, the tcldide
auto-install — is reachable from one place. The cost is that a
demo that does `del tkinter.Misc.mainloop` could regress to the
default `Tkapp_MainLoop` (which would wedge the worker); we accept
that as out of scope.
