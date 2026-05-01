# pyodide-tk

⚠️ Early development. Expect breaking changes.

Brings unmodified Python `tkinter` to [Pyodide](https://pyodide.org/) by shipping Tcl 8.6, Tk 8.6, [em-x11](../em-x11), and CPython's `_tkinter` extension as Pyodide-loadable side modules. A standard tkinter program runs in the browser and paints widgets to a canvas — no real X server.

## Status

Working: `tkinter.Tk()`, `Label`, `Button` with `command=` callback, `pack`, `update_idletasks`, mouse / keyboard input. Tested in Pyodide 314.0.0a1 (Python 3.14.2, Emscripten 5.0.3) under Node and in the browser via a Web Worker.

## Architecture

Main thread owns the DOM, transfers an `OffscreenCanvas` to a Web Worker, and forwards mouse / keyboard events. The worker hosts everything else: Pyodide, Tcl/Tk side modules, the em-x11 host, and the Tcl event-loop pump.

```
main.ts ──postMessage──▶ worker.ts
  └── canvas (DOM)        ├── em-x11 Host (paints to OffscreenCanvas)
                          ├── Pyodide (Python 3.14 + _tkinter)
                          └── Tcl_DoOneEvent pump (setTimeout)
```

See [src/worker.ts](src/worker.ts) for the boot sequence and the three non-obvious fixes (defaultModule pre-binding, GIL-safe drain through `tkapp.dooneevent`, settle-then-pump).

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
pnpm build:web    # bundle the worker + main entry via vite
```

`make all` fetches the Tcl 8.6.6 and Tk 8.6.6 source tarballs from the Tcl/SourceForge mirror on first run and rebuilds them under wasm-EH ABI. `make tkinter` extracts CPython 3.14.2 source from xbuildenv (or fetches `cpython-v3.14.2.tar.gz` from python.org if missing) and builds `_tkinter.so`. `stage-assets.sh` packs the Tcl/Tk script libraries and the `tkinter` Python package as `.tar` bundles into `public/pyodide-tk-assets/` for `py.unpackArchive` (~30× faster than per-file fetch).

## Run

```bash
pnpm dev
```

Opens [http://localhost:5174](http://localhost:5174). The hello demo creates a Label and a Button — clicking the button updates its text via a Python callback.

## Test

```bash
pnpm smoke:node   # headless Pyodide load + Tk_Init + widget tree, no canvas
make smoke-tcl    # minimal Tcl_CreateInterp via dlopen, no Python
```

## Layout

```
pyodide-tk/
├── Makefile                 # native build (libtcl, libtk, libemx11, _tkinter)
├── scripts/stage-assets.sh  # pack tcl/tk/tkinter trees into public/pyodide-tk-assets/
├── src/
│   ├── main.ts              # DOM owner: spawns worker, transfers canvas, relays input
│   ├── worker.ts            # Pyodide + Tk + em-x11 host; runs the event-loop pump
│   └── worker-protocol.ts   # message types between the two
└── tests/
    ├── node-load/smoke.mjs  # headless Node smoke test
    └── smoke_tcl.c          # `make smoke-tcl` driver
```

## License

MIT (see [LICENSE.md](LICENSE.md)). Tcl/Tk and CPython sources are fetched at build time and retain their original licenses.
