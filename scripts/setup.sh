#!/usr/bin/env bash
# setup.sh — one-shot setup for pyodide-tk.
#
# Called automatically by `pnpm install` (postinstall hook), or can be run
# manually after cloning. Downloads Tcl/Tk/CPython sources, builds side-module
# .so files, bundles them into libs.tar + python.tar, gzips large assets,
# and stages everything into public/.
#
# External dependencies — detected but NOT fetched. If missing the script
# prints install instructions and exits; the user installs them and re-runs.
#   - em-x11       sibling dir, cloned (archives auto-built by make)
#   - xbuildenv    see https://pyodide.org/en/stable/development/building-from-sources.html
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

# ---------------------------------------------------------------------------
# Reproducibility-test clone detection (runs on WSL and Git Bash alike)
# ---------------------------------------------------------------------------
if echo "$SCRIPT_DIR" | grep -qi reproducibility; then
    if [ -d .git ]; then
        rm -rf .git
        echo "[reproducibility] removed .git from $SCRIPT_DIR — reproducibility-test clone"
    fi
fi

if [ "$(uname -s)" != "Linux" ]; then
  echo "ERROR: This project requires Linux. Run from WSL, not Git Bash or Windows."
  exit 1
fi

# ---------------------------------------------------------------------------
# Prerequisite check
# ---------------------------------------------------------------------------
missing=()
for cmd in emcc make wget; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
done

if [ ${#missing[@]} -gt 0 ]; then
    echo "ERROR: missing required tools: ${missing[*]}"
    echo "  emcc  — Emscripten SDK (source emsdk_env.sh first)"
    echo "  make  — GNU make"
    echo "  wget  — for downloading source tarballs"
    exit 1
fi

# ---------------------------------------------------------------------------
# Detect em-x11 (user's responsibility — we only check, never fetch)
# ---------------------------------------------------------------------------
EM_X11_DIR="${EM_X11_DIR:-$SCRIPT_DIR/../em-x11}"

if [ ! -d "$EM_X11_DIR/native/include/X11" ]; then
    echo "ERROR: em-x11 headers not found at $EM_X11_DIR/native/include/X11"
    echo ""
    echo "  em-x11 must be cloned as a sibling directory:"
    echo "    cd $SCRIPT_DIR/../.."
    echo "    git clone <em-x11-repo-url> em-x11"
    echo ""
    echo "  (No need to run pnpm install in em-x11 — pyodide-tk's Makefile"
    echo "   builds only the native/ subset directly.)"
    echo ""
    echo "  Then re-run this script."
    exit 1
fi

echo "em-x11 detected at $EM_X11_DIR — OK (archives auto-built by make)"

# ---------------------------------------------------------------------------
# Detect Pyodide xbuildenv (needed for _tkinter's Python.h)
#
# Two flows (see https://pyodide.org/en/stable/development/building-from-sources.html):
#   A. Pre-built:  pyodide xbuildenv install 0.34.3
#      → $HOME/.cache/.pyodide-xbuildenv-0.34.3
#   B. Source:     git clone pyodide && cd pyodide && make
#      → $SCRIPT_DIR/../pyodide/xbuildenv
#
# Auto-detect: source-build path first, then cached. Override with
# PYODIDE_XBUILDENV=/custom/path.
# ---------------------------------------------------------------------------
_detect_xbuildenv() {
    if [ -n "${PYODIDE_XBUILDENV:-}" ]; then
        echo "$PYODIDE_XBUILDENV"
        return
    fi
    for cand in \
        "$SCRIPT_DIR/../pyodide/xbuildenv" \
        "$HOME/.cache/.pyodide-xbuildenv-0.34.3"
    do
        if [ -f "$cand/xbuildenv/xbuildenv/pyodide-root/cpython/installs/python-3.14.2/include/python3.14/Python.h" ]; then
            echo "$cand"
            return
        fi
    done
    echo ""
}

PYODIDE_XBUILDENV="$(_detect_xbuildenv)"

if [ -z "$PYODIDE_XBUILDENV" ]; then
    echo "ERROR: Pyodide xbuildenv not found."
    echo ""
    echo "  The xbuildenv provides Python.h from a wasm-EH CPython build,"
    echo "  which is required to compile _tkinter.so."
    echo ""
    echo "  Follow the Pyodide build-from-source guide:"
    echo "    https://pyodide.org/en/stable/development/building-from-sources.html"
    echo ""
    echo "  Tried:"
    echo "    - \$SCRIPT_DIR/../pyodide/xbuildenv"
    echo "    - \$HOME/.cache/.pyodide-xbuildenv-0.34.3"
    echo ""
    echo "  Or override: PYODIDE_XBUILDENV=/path/to/xbuildenv"
    exit 1
fi

PYINC="$PYODIDE_XBUILDENV/xbuildenv/xbuildenv/pyodide-root/cpython/installs/python-3.14.2/include/python3.14"
echo "xbuildenv detected at $PYODIDE_XBUILDENV — OK"

# ---------------------------------------------------------------------------
# Detect tcldide sibling (optional — libtcldide.so)
# ---------------------------------------------------------------------------
TCLDIDE_SRC="$SCRIPT_DIR/../tcldide/opt/tcldide.c"
if [ -f "$TCLDIDE_SRC" ]; then
    echo "tcldide sibling detected — libtcldide.so will be built."
else
    echo "tcldide sibling not found — skipping libtcldide.so (::tcldide::dom / ::tcldide::jscall unavailable)."
fi

# ---------------------------------------------------------------------------
# Build all native artefacts
# ---------------------------------------------------------------------------
echo ""
echo "==> Building native artefacts (make -j all) ..."
make -j all

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
cat <<'EOF'

pyodide-tk setup complete. Next steps:

  pnpm dev     # start Vite dev server
  pnpm build   # or production build

EOF
