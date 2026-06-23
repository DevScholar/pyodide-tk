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
#   - xbuildenv    auto-downloaded from GitHub releases (no pip/pyodide-build needed)
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
for cmd in emcc make wget curl; do
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
# Detect / auto-download Pyodide xbuildenv (needed for _tkinter's Python.h)
#
# The xbuildenv is a ~19 MB pre-built CPython wasm-headers tarball published
# alongside each Pyodide release on GitHub. We download and cache it directly
# — no pip/pyodide-build required.
# ---------------------------------------------------------------------------
XBUILDENV_VERSION="${XBUILDENV_VERSION:-314.0.0a1}"
XBUILDENV_URL="https://github.com/pyodide/pyodide/releases/download/${XBUILDENV_VERSION}/xbuildenv-${XBUILDENV_VERSION}.tar.bz2"
XBUILDENV_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/pyodide-tk-xbuildenv"
XBUILDENV_DIR="$XBUILDENV_CACHE/$XBUILDENV_VERSION"
# The tarball unpacks with a double xbuildenv/xbuildenv/ prefix, and the
# CPython headers land at xbuildenv/xbuildenv/pyodide-root/cpython/installs/.
PYINC="$XBUILDENV_DIR/xbuildenv/xbuildenv/pyodide-root/cpython/installs/python-3.14.2/include/python3.14"

# Also check the legacy pyodide-build cache path for backward compatibility.
LEGACY_XBUILDENV="$HOME/.cache/.pyodide-xbuildenv-0.34.3/xbuildenv/xbuildenv/pyodide-root/cpython/installs/python-3.14.2/include/python3.14"

if [ -f "$PYINC/Python.h" ]; then
    echo "xbuildenv detected at $XBUILDENV_DIR — OK"
elif [ -f "$LEGACY_XBUILDENV/Python.h" ]; then
    echo "xbuildenv detected at legacy path $HOME/.cache/.pyodide-xbuildenv-0.34.3 — OK"
    XBUILDENV_DIR="$HOME/.cache/.pyodide-xbuildenv-0.34.3"
    PYINC="$LEGACY_XBUILDENV"
else
    echo "xbuildenv not found — downloading ${XBUILDENV_VERSION} from GitHub..."
    mkdir -p "$XBUILDENV_DIR"
    curl -L --progress-bar "$XBUILDENV_URL" | tar -xjf - -C "$XBUILDENV_DIR" --strip-components=1
    if [ ! -f "$PYINC/Python.h" ]; then
        echo "ERROR: xbuildenv download failed — Python.h not found after extraction"
        echo "       Tried: $XBUILDENV_URL"
        exit 1
    fi
    echo "xbuildenv installed to $XBUILDENV_DIR — OK"
fi

# Export for the Makefile so it picks up the detected path.
# The Makefile derives PYINC from PYODIDE_XBUILDENV as:
#   $(PYODIDE_XBUILDENV)/xbuildenv/xbuildenv/pyodide-root/.../include/python3.14
export PYODIDE_XBUILDENV="$XBUILDENV_DIR"
export PYINC

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
