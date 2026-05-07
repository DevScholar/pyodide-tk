# PyodideTk

⚠️ Early development. Expect breaking changes.

Run Tkinter with Python in the browser.

![tk-hello demo screenshot](./screenshots/tk-hello.png)

## Status

Working in Pyodide 314.0.0a1 (Python 3.14.2, Emscripten 5.0.3) under Node and in the browser via a Web Worker:

- `tkinter.Tk()`, `Label`, `Button`, `Entry`, `Canvas`, `pack`, `mainloop()`, mouse / keyboard input, `command=` callbacks
- `turtle` module: `Screen`, `Turtle`, animation pacing, `turtle.done()`
- Demo Python is the same code you'd run on a desktop — no `_root` exposure, no `update_idletasks()` substitute for `mainloop()`, no monkey-patching from user code

## Architecture

Main thread owns the DOM, transfers an `OffscreenCanvas` to a Web Worker, and forwards mouse / keyboard events as plain data. The worker hosts everything else: Pyodide, Tcl/Tk side modules, the em-x11 host, and the Tcl event-loop driver.

```
main.ts ──postMessage──▶ worker.ts
  └── canvas (DOM)        ├── em-x11 Host (paints to OffscreenCanvas)
                          ├── Pyodide (Python 3.14 + _tkinter)
                          └── Patched Misc.mainloop (drain + JSPI yield)
```

The non-obvious fixes that make this work, all in [src/worker.ts](src/worker.ts):

1. **defaultModule pre-binding.** `host.connection.setDefaultModule(libemx11Exports)` runs before `_tkinter.so` loads so the very first `XOpenDisplay` from `tkinter.Tk()` picks up the surface — no `_tkinter.create` bootstrap, no second redundant Tk root.
2. **GIL-safe drain.** Tcl callbacks (button `-command`, default `<Configure>` bindings) re-enter Python. Calling `Tcl_DoOneEvent` directly via `ccall` fatals on the first such callback. We drain through `tkinter._default_root.tk.dooneevent(2)` so `Tkapp_DoOneEvent`'s `ENTER_TCL`/`LEAVE_TCL` set `tcl_tstate` correctly.
3. **Settle then pump.** Tk's realize/map/expose chain produces a burst of `after 0` callbacks. Boot drains-then-`setTimeout(0)` until quiescent, then starts a steady `setTimeout(_, 8)` pump for any background events.
4. **JSPI sync sleep for `Misc.after`.** No-callback `Misc.after(ms)` lowers to Tcl's blocking `after delay`. Pyodide 314 uses JSPI instead of Asyncify, so `emscripten_sleep` is a no-op stub — turtle's per-step delay would burn ~7 s of CPU painting nothing. The patch routes the sync branch through `pyodide.ffi.run_sync(asyncio.sleep(...))` which suspends the wasm stack via JSPI; the JS event loop runs (browser composites a frame) then resumes.
5. **JSPI async `mainloop`.** `Tkapp_MainLoop` busy-loops `Tcl_DoOneEvent(0)` with no JS yield, wedging the worker. We replace `tkinter.Misc.mainloop` and `tkinter.mainloop` (the module-level function `turtle.done()` ultimately calls) with a Python loop that drains via `dooneevent(2)` and yields a frame between batches.
6. **`turtle.py` staged separately.** Pyodide strips `tkinter` *and* `turtle` from `python_stdlib.zip` (it has no Tk available). We ship the CPython 3.14.2 `Lib/turtle.py` source verbatim into `/lib/python3.14/site-packages/turtle.py`.

## Demos

Each demo under [demos/](demos/) is a single self-contained HTML file: an inline `<script type="text/python">` block plus a one-liner that hands it to the shared harness. View-source on either page shows exactly the unmodified desktop Python that runs in the browser.

- [demos/tk-hello/](demos/tk-hello/) — `Label` + `Button` with `command=` callback, ends in `root.mainloop()`
- [demos/turtle-hello/](demos/turtle-hello/) — `turtle.Screen()` + `Turtle()` drawing a square and writing text, ends in `turtle.done()`

`pnpm dev` prints both URLs at startup.

## Prerequisites

**Linux or WSL only.** Mixing Windows-side toolchains (npm, python, emcc) with WSL builds is not supported and will fail.

- Node.js ≥ 20, pnpm ≥ 9
- Python ≥ 3.11 (host) for `pyodide-build`
- [Emscripten 5.0.3](https://emscripten.org/), the version pinned by Pyodide 314 (`pyemscripten_2026_0`)
- `pyodide-build` ≥ 0.34.3 with the 314.0.0a1 cross-build environment installed:

```bash
pip install pyodide-build
pyodide xbuildenv install 0.34.3
```

This downloads CPython 3.14.2, the matching emsdk 5.0.3, and headers into `~/.cache/.pyodide-xbuildenv-0.34.3/`. Set `EMSDK` on `PATH` so `emcc` is the xbuildenv version (not your distro's).

## Build

```bash
pnpm install
make all          # build libtcl8.6.so / libtk8.6.so / libemx11.so as side modules
make tkinter      # cross-compile CPython's _tkinter.c against the side modules
bash scripts/stage-assets.sh
pnpm build:web    # bundle the worker + demos via vite
```

`make all` fetches Tcl 8.6.6 and Tk 8.6.6 source tarballs on first run and rebuilds them under wasm-EH ABI. `make tkinter` extracts CPython 3.14.2 source from xbuildenv (or fetches `cpython-v3.14.2.tar.gz` from python.org if missing) and builds `_tkinter.so`. `stage-assets.sh` copies the freshly built `.so` files (`libtcl8.6.so`, `libtk8.6.so`, `libemx11.so`, `_tkinter.so`) into `public/pyodide-tk-assets/lib/`, packs the Tcl/Tk script libraries and the `tkinter` Python package as `.tar` bundles (~30× faster than per-file fetch via `py.unpackArchive`), and copies `Lib/turtle.py` alongside.

> **Re-run `stage-assets.sh` after every `make all` / `make tkinter` rebuild.** Vite serves from `public/pyodide-tk-assets/`, not `build/install/`, and Make has no rule copying between them. Skipping it leaves the dev server pinning the previous build — a fresh native fix will look like it didn't take effect.

## Run

```bash
pnpm dev
```

## Test

```bash
pnpm smoke:node   # headless Pyodide load + Tk_Init + widget tree, no canvas
make smoke-tcl    # minimal Tcl_CreateInterp via dlopen, no Python
```

## Layout

```
pyodide-tk/
├── Makefile                 # native build (libtcl, libtk, libemx11, _tkinter)
├── scripts/stage-assets.sh  # pack tcl/tk/tkinter trees + turtle.py into public/pyodide-tk-assets/
├── vite.config.ts           # auto-discovers demos/*/index.html as Rollup inputs
├── index.html               # landing page that lists demos
├── src/
│   ├── main.ts              # landing-page renderer (lists demos)
│   ├── demo-harness.ts      # shared: spawns worker, transfers canvas, relays input
│   ├── worker.ts            # Pyodide + Tk + em-x11 host; runs the event-loop driver
│   └── worker-protocol.ts   # message types between main and worker
├── demos/
│   ├── tk-hello/index.html      # inline tkinter Label+Button demo
│   └── turtle-hello/index.html  # inline turtle drawing demo
└── tests/
    ├── node-load/smoke.mjs  # headless Node smoke test
    └── smoke_tcl.c          # `make smoke-tcl` driver
```

## License

MIT (see [LICENSE.md](LICENSE.md)). Tcl/Tk and CPython sources are fetched at build time and retain their original licenses.
