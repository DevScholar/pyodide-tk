#!/usr/bin/env bash
# Stage all runtime assets into public/ for the vite dev server.
# Idempotent — safe to re-run after rebuilding native artefacts.
#
# Bundling (HTTP/1.1 connection-limit mitigation):
#   libs.tar   — all .so + tcl8.6/ + tk8.6/  (extract dir: /usr/lib)
#   python.tar — _tkinter.so + turtle.py + tkinter/ (extract dir: site-packages)
#
# 14+ individual fetches → 2 tar fetches. gzip halves the wire size.

set -euo pipefail
cd "$(dirname "$0")/.."

LIB=build/install/lib
TKD=build/_tkinter
PUB=public/pyodide-tk-assets
PYNM=node_modules/pyodide
CPYLIB=ignored-area/third-party/cpython/cpython-3.14.2/Lib

# --- Pre-flight: every input must exist ---
missing=()
for f in \
    "$LIB/libtcl8.6.so" "$LIB/libtk8.6.so" \
    "$LIB/libem_x11_event_queue.so" \
    "$LIB/libX11.so" "$LIB/libXext.so" "$LIB/libXrender.so" "$LIB/libfontconfig.so" "$LIB/libXft.so" \
    "$LIB/libtcldide_notifier.so" \
    "$TKD/_tkinter.so" \
    "$CPYLIB/turtle.py" \
    "ignored-area/third-party/tcl/library" "ignored-area/third-party/tk/library" "$CPYLIB/tkinter"
do
    [[ -e "$f" ]] || missing+=("$f")
done
if (( ${#missing[@]} > 0 )); then
    {
        echo "stage-assets: missing required build artefacts:"
        for f in "${missing[@]}"; do echo "  - $f"; done
        echo "Run 'make all && make tkinter' first."
    } >&2
    exit 1
fi

mkdir -p public/pyodide "$PUB/lib"

# --- Pyodide runtime ---
if [[ -d $PYNM ]]; then
    for f in "$PYNM"/pyodide.asm.mjs "$PYNM"/pyodide.asm.wasm \
             "$PYNM"/pyodide.mjs "$PYNM"/pyodide.js "$PYNM"/pyodide.d.ts \
             "$PYNM"/python_stdlib.zip "$PYNM"/pyodide-lock.json
    do
        [[ -f "$f" ]] && cp -u "$f" public/pyodide/
    done
fi

# --- Side modules: copy individually (kept for direct URL access / fallback) ---
cp -u "$LIB"/libtcl8.6.so "$LIB"/libtk8.6.so \
    "$LIB"/libem_x11_event_queue.so \
    "$LIB"/libX11.so "$LIB"/libXext.so "$LIB"/libXrender.so "$LIB"/libfontconfig.so "$LIB"/libXft.so \
    "$LIB"/libtcldide_notifier.so \
    "$PUB/lib/"
if [[ -f "$LIB/libtcldide.so" ]]; then
    cp -u "$LIB/libtcldide.so" "$PUB/lib/"
fi
cp -u "$TKD"/_tkinter.so "$PUB/lib/"
cp -u "$CPYLIB/turtle.py" "$PUB/turtle.py"

# --- Tar bundling ---
pack_tree() {
    local src=$1 tar=$2
    rm -f "$tar"
    tar -cf "$tar" \
        --sort=name --mtime=@0 \
        --owner=0 --group=0 --numeric-owner \
        -C "$src" .
    echo "  $(wc -c < "$tar") bytes in $tar"
}

# libs.tar: .so files + tcl8.6/ + tk8.6/  → worker unpacks to /usr/lib/
TMP_LIBS=$(mktemp -d)
cleanup() { rm -rf "$TMP_LIBS" "$TMP_PY"; }
TMP_PY=$(mktemp -d)
trap cleanup EXIT
for so in "$LIB"/*.so; do cp "$so" "$TMP_LIBS/"; done
cp -r ignored-area/third-party/tcl/library "$TMP_LIBS/tcl8.6"
cp -r ignored-area/third-party/tk/library  "$TMP_LIBS/tk8.6"
pack_tree "$TMP_LIBS" "$PUB/libs.tar"

# python.tar: _tkinter.so + turtle.py + tkinter/ → worker unpacks to site-packages/
cp "$TKD/_tkinter.so" "$TMP_PY/"
cp "$CPYLIB/turtle.py"   "$TMP_PY/"
cp -r "$CPYLIB/tkinter"  "$TMP_PY/tkinter"
pack_tree "$TMP_PY" "$PUB/python.tar"

# Legacy content tars — kept so old worker.ts paths still work during transition.
pack_tree ignored-area/third-party/tcl/library "$PUB/tcl-library.tar"
pack_tree ignored-area/third-party/tk/library  "$PUB/tk-library.tar"
pack_tree "$CPYLIB/tkinter" "$PUB/tkinter.tar"

# --- gzip pre-compression (vite middleware serves .gz when Accept-Encoding matches) ---
for f in "$PUB"/*.tar public/pyodide/pyodide.asm.wasm public/pyodide/python_stdlib.zip; do
    [[ -f "$f" ]] || continue
    gzip -kf "$f"
    echo "  gzipped: $(wc -c < "$f") → $(wc -c < "$f.gz") bytes ($f)"
done

# --- Cleanup stale ---
rm -rf "$PUB/tcl-library" "$PUB/tk-library" "$PUB/tkinter"
rm -f "$PUB/lib/libwacl.so"

echo "stage-assets done."
