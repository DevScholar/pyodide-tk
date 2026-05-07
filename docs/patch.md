# pyodide-tk patches against upstream Tcl/Tk and CPython

This document describes how the source trees built by pyodide-tk
diverge from the upstream Tcl 8.6.6, Tk 8.6.6, and CPython 3.14.2
releases.

The short version: **pyodide-tk applies no source-level patches.**
All three components are built unmodified from their official
tarballs. The wasm-specific behaviour comes from build flags, a post-
configure sed pass, and the way the resulting archives are relinked
as Pyodide-style side modules. The points below document those
deltas so they can be reproduced and audited.

## Summary

| Component        | Upstream                | Source patches | Build-level changes |
|------------------|-------------------------|----------------|---------------------|
| Tcl 8.6.6        | tcl-core8.6.6-src       | none           | wasm-EH ABI, side-module relink, `strtod.o` removal |
| Tk 8.6.6         | tk8.6.6-src             | none           | em-x11 X11 headers, fontconfig disabled, `--disable-xss`, side-module relink |
| CPython 3.14.2 `_tkinter` | Modules/_tkinter.c | none   | side-module compile against em-x11 + Pyodide xbuildenv `Python.h` |
| em-x11           | sibling repo            | none           | rebuilt under wasm-EH `-fPIC`, relinked to `libemx11.so` with NEEDED entry |
| `::wacl::*` cmds | `../wacl-tk/opt/wacl.c` | none           | sibling source compiled as `libwacl.so` side module; `Wacl_Init(interp)` invoked via ctypes on every `tkinter.Tk()` |

Contrast with the sibling [wacl-tk](../../wacl-tk/docs/patch.md),
which inherits a Tcl source patch from the upstream wacl project.
pyodide-tk did not need that patch because its targets differ:

- Pyodide ships a known-good emscripten libc, so the `strstr` /
  `strtoul` / `strtod` runtime probes that wacl deletes are bypassed
  via `cross_compiling=yes` instead.
- The `tclUnixChan.c` / `tclUnixNotfy.c` `exceptfds` assertion that
  wacl works around does not fire in the wasm-EH build path used
  here, since the notifier we end up using is em-x11's, not Tcl's
  default `select()` notifier.
- We do not embed extra C sources into `libtcl` — Pyodide's loader
  composes side modules at dlopen time, so the wacl `opt/wacl.c`
  injection point is unnecessary.

## Tcl 8.6.6 (build-level only)

Source: `wget` of `tcl-core8.6.6-src.tar.gz`, extracted under
`build/tcl/`. No `patch` step.

### Configure
```
emconfigure ./configure \
    --host=wasm32-unknown-emscripten \
    --prefix=$(PREFIX) \
    --disable-threads --disable-load --disable-shared \
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
  rationale as wacl-tk.

Post-configure sed strips `-O2` so it does not override `-Oz`.

### Side-module relink
The static archive is then relinked as a Pyodide side module:
```
emar d $(LIBDIR)/libtcl8.6.a strtod.o
emcc -sSIDE_MODULE=1 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm \
    -o libtcl8.6.so \
    -Wl,--whole-archive libtcl8.6.a -Wl,--no-whole-archive
```
Two non-obvious bits:
- `--whole-archive` is required because `libtcl` exports many
  symbols (`Tcl_Eval`, `Tcl_NewObj`, …) that no static caller
  references at link time — without this flag, the linker drops
  most of the archive.
- **`emar d … strtod.o`** removes the Tcl-supplied `strtod`
  replacement before the relink. Tcl's `configure` flags
  emscripten's libc as having a "buggy strtod" (a false positive in
  the cross-compile) and substitutes `compat/strtod.c`. Under
  `--whole-archive` this collides with `tclStrToD.c`'s canonical
  `TclStrToD`/`fixstrtod` symbols. Dropping the `strtod.o` object
  lets the canonical implementation through.

## Tk 8.6.6 (build-level only)

Source: `wget` of `tk8.6.6-src.tar.gz`, extracted under
`build/tk/`. No `patch` step.

### Configure
```
PATH="$(CURDIR)/scripts:$$PATH" \
EMX11_INCLUDES="../em-x11/native/include" \
EMX11_LIBDIR="$(LIBDIR)" \
ac_cv_lib_Xft_XftFontOpen=yes \
ac_cv_lib_fontconfig_FcFontSort=no \
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
Same em-x11 redirection trick wacl-tk uses: real `X11/*.h` headers
come from em-x11, but no Xlib `.so` is supplied — Tk's unresolved
X11 symbols stay in the archive and are linked against
`libemx11.so` at the side-module relink step.

Differences from wacl-tk's Tk configure:
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
through; they bind at the next layer when `_tkinter.so` (or the
demo loader) lists `libemx11.so` after `libtk8.6.so`.

## CPython 3.14.2 `_tkinter` (build-level only)

`Modules/_tkinter.c`, `Modules/tkappinit.c`, `Modules/tkinter.h`,
and `Modules/clinic/_tkinter.c.h` are extracted from the upstream
`Python-3.14.2.tgz` and compiled **without modification** as a
SIDE_MODULE.

```
emcc -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -fPIC -sSIDE_MODULE=1 \
    -DWITH_APPINIT=1 -DPy_BUILD_CORE_BUILTIN=1 \
    -I $(PYINC) -I $(CPYTHON_SRC)/Include/internal -I $(CPYTHON_SRC) \
    -I $(INCDIR) -I $(INCDIR)/tk -I $(EMX11_INCLUDES) \
    _tkinter.c tkappinit.c \
    libtk8.6.so libtcl8.6.so libemx11.so \
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
- The trailing `libtk8.6.so libtcl8.6.so libemx11.so` add NEEDED
  entries; Pyodide's `loadDynlib` then auto-cascades dependencies.

The Python-side `Lib/tkinter` and `turtle.py` are extracted only
to be staged separately by `scripts/stage-assets.sh`. Pyodide
strips `Lib/tkinter` from `python314.zip` so we re-stage it onto
MEMFS at runtime; this is asset packaging, not a CPython patch.

## em-x11 side-module relink

em-x11 already builds `libemx11.a` (see em-x11 docs). pyodide-tk
rebuilds it under the same wasm-EH `-fPIC` flags and relinks:

```
emcc -sSIDE_MODULE=1 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm \
    -o libemx11.so \
    -Wl,--whole-archive libemx11.a -Wl,--no-whole-archive \
    libtcl8.6.so \
    -sERROR_ON_UNDEFINED_SYMBOLS=0
```

The trailing `libtcl8.6.so` is load-bearing: it lands on
`libemx11.so`'s NEEDED list, which is the only way em-x11's
`Tcl_SetNotifier` reference resolves at dlopen time. Pyodide
hard-codes `flags=2` in `loadDynlib`, so an explicit `{global: true}`
load order is ignored and the NEEDED auto-cascade is the
mechanism we have to use.

`EMX11_HIDE_INTERNAL_SYMBOLS=OFF` keeps `_tkinter` able to reach
em-x11's stubs.

## Asset staging (not a patch, but ABI-relevant)

After every native rebuild, `scripts/stage-assets.sh` copies the
fresh `.so`s, the `Lib/tkinter` tree, and Tcl/Tk's `library/` Tcl
scripts into `public/` for Vite to serve. Skipping this step
silently exposes stale `.so`s — a common debugging trap.

## Why no source patch was needed

The two Tcl-source issues that motivate wacl-tk's `wacl.patch` are
both side-stepped here:

1. **Runtime autoconf probes** — bypassed by `cross_compiling=yes`
   plus explicit `ac_cv_*` overrides for Xft/fontconfig.
2. **`select(exceptfds)` assertion** — em-x11 supplies the Tcl
   notifier (`Tcl_SetNotifier`), so `tclUnixNotfy.c`'s default
   `select()` path is replaced wholesale. The patched select call
   would only run in a build that uses Tcl's stock notifier.

If a future Tcl/Tk version regresses one of these assumptions, the
fix should land here as a `.patch` file applied during `tclprep`/
`tkprep`, mirroring wacl-tk's structure.

## libwacl side module

`libwacl.so` is built from the **sibling** [`../wacl-tk/opt/wacl.c`](../../wacl-tk/opt/wacl.c)
(single source of truth — no copy). It contributes two Tcl commands
to every interpreter:

- **`::wacl::dom action selector key val`** — query `document` via
  `EM_ASM_INT`, run `querySelectorAll(selector)`, set
  `attr` or `style.{key} = val` on each match. Returns the count
  of elements changed.
- **`::wacl::jscall fcnPtr returnType argType ?args…?`** — invoke a
  function pointer (e.g. obtained via `Module.addFunction`) with the
  declared C signature, passing arguments coerced from Tcl through
  the listed type tags.

### Build
```make
WACL_SRC = $(CURDIR)/../wacl-tk/opt/wacl.c

$(LIBDIR)/libwacl.so: $(WACL_SRC) $(LIBDIR)/libtcl8.6.so
    emcc -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -fPIC -sSIDE_MODULE=1 \
        -I $(INCDIR) \
        $(WACL_SRC) $(LIBDIR)/libtcl8.6.so \
        -sERROR_ON_UNDEFINED_SYMBOLS=0 \
        -o $(LIBDIR)/libwacl.so
```

`libtcl8.6.so` is on the link line so libwacl's references to
`Tcl_CreateNamespace`, `Tcl_CreateObjCommand`, etc. land on
libwacl's NEEDED entry — Pyodide's `loadDynlib` then auto-cascades
the dependency.

### Runtime wiring (worker.ts)

Loaded globally so its `Wacl_Init` symbol is reachable via ctypes:
```ts
await py._api.loadDynlib('/usr/lib/libwacl.so', { global: true, allowUndefined: true });
```

Then a Python prelude monkey-patches `tkinter.Tk.__init__` so every
new root automatically registers `::wacl::*`:
```python
import ctypes, tkinter
_wacl = ctypes.CDLL('/usr/lib/libwacl.so')
_wacl.Wacl_Init.argtypes = [ctypes.c_void_p]
_wacl.Wacl_Init.restype  = ctypes.c_int
_orig = tkinter.Tk.__init__
def _install(self, *a, **kw):
    _orig(self, *a, **kw)
    _wacl.Wacl_Init(self.tk.interpaddr())
tkinter.Tk.__init__ = _install
```

The `tkapp.interpaddr()` call returns the underlying `Tcl_Interp*`,
and `Wacl_Init` registers its commands on that interpreter. Demo
code can then use them straight from `root.tk.call(...)` or, more
typically, via `root.tk.eval(...)`:
```python
root = tkinter.Tk()
root.tk.call('::wacl::dom', 'css', '#status', 'color', 'red')
```

### Optional dependency

Both the build (`Makefile`) and the worker (`worker.ts`) tolerate a
missing libwacl: `make` aborts with a clear message if
`../wacl-tk/opt/wacl.c` isn't present, and the worker's fetch is
wrapped in `.catch(() => null)` so a missing
`pyodide-tk-assets/lib/libwacl.so` skips the dynlib load and leaves
`tkinter.Tk` untouched. Standard tkinter still works in either case;
only `::wacl::dom` / `::wacl::jscall` become unavailable.

### Why a side module instead of patching CPython's tkappinit.c

`Modules/tkappinit.c` is the natural hook for "run something after
`Tcl_Init`". Putting `Wacl_Init` there would make the bridge
automatic with no Python prelude. We chose the side-module route
to preserve the project's no-source-patch invariant — `_tkinter.c`
and `tkappinit.c` remain literally byte-identical to upstream
CPython 3.14.2. The cost is a few lines of Python wiring; the
benefit is that bumping CPython is `tar -x` away with no rebase.
