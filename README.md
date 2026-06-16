# PyodideTk

⚠️ This project is in early development and is not yet stable. Expect breaking changes and missing features.

Run Tkinter with Python in the browser.

![tk-hello demo screenshot](./screenshots/tk-hello.png)

Built on top of [Pyodide](https://pyodide.org/); Tk's X11 calls are handled by the sibling project [em-x11](https://github.com/DevScholar/em-x11). Optional Tcl→DOM bridge commands (`::tcldide::dom`, `::tcldide::jscall`) are built from the sibling [tcldide](https://github.com/DevScholar/tcldide) project's `opt/tcldide.c`.

# Prerequisites

- Linux
- Emscripten 5.0.3 (pinned by Pyodide 314; `emcc` must be on `PATH`)
- Node.js ≥ 20, pnpm ≥ 9
- Python ≥ 3.11 with Pyodide development environment — follow [Building from sources](https://pyodide.org/en/stable/development/building-from-sources.html) to install `pyodide-build` and xbuildenv
- [em-x11](https://github.com/DevScholar/em-x11) cloned as a sibling directory (the Makefile auto-builds the native/ subset — no manual build needed)
- [tcldide](https://github.com/DevScholar/tcldide) cloned as a sibling directory (**optional** — only needed for the `::tcldide::*` Tcl→DOM commands)

# Quick start

```bash
pnpm install   # downloads sources, builds .so side modules, stages assets
pnpm dev       # starts Vite dev server
```

`pnpm install` detects missing external dependencies (em-x11, xbuildenv) and prints install instructions if any are absent. Install them and re-run `pnpm install`.

# Build

```bash
pnpm build
```

# Run

```bash
pnpm dev
```

# Known Issues

These are known issues that remain unresolved despite repeated attempts.

- In EmX11, running both TWM and Tcldide simultaneously causes the web page to freeze.

- When attempting to open any dialog box in Common Dialogs, the web page freezes.

# License

MIT (see [LICENSE.md](LICENSE.md)).
