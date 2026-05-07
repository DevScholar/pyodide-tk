# PyodideTk

⚠️ This project is in early development and is not yet stable. Expect breaking changes and missing features.

Run Tkinter with Python in the browser.

![tk-hello demo screenshot](./screenshots/tk-hello.png)

Built on top of [Pyodide](https://pyodide.org/); Tk's X11 calls are handled by the sibling project [em-x11](https://github.com/DevScholar/em-x11).

# Prerequisites

- Linux
- Emscripten 5.0.3 (pinned by Pyodide 314; `emcc` must be on `PATH`)
- Node.js ≥ 20, pnpm ≥ 9
- Python ≥ 3.11 with `pyodide-build`
- [em-x11](https://github.com/DevScholar/em-x11) cloned as a sibling directory

```bash
pip install pyodide-build
pyodide xbuildenv install 0.34.3
cd ../em-x11 && pnpm install && pnpm build:native && cd ../pyodide-tk
pnpm install
```

# Build

```bash
pnpm build
```

# Run

```bash
pnpm dev
```

# License

MIT (see [LICENSE.md](LICENSE.md)).
