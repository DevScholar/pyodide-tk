#!/usr/bin/env bash
# Stage all runtime assets into public/ for the vite dev server.
# Idempotent — safe to re-run after rebuilding native artefacts.

set -euo pipefail
cd "$(dirname "$0")/.."

LIB=build/install/lib
TKD=build/_tkinter
PUB=public/pyodide-tk-assets
PYNM=node_modules/pyodide

mkdir -p public/pyodide "$PUB/lib"

# Pyodide runtime: copy from node_modules/pyodide. The package is pinned
# in package.json (see "pyodide" devDependency); the copy keeps the dev
# server self-contained instead of pointing vite at node_modules. The
# guard is just a belt-and-braces no-op if someone's already populated
# public/pyodide/ via another route (xbuildenv extract, manual stage).
if [[ -d $PYNM ]]; then
    cp -u "$PYNM"/pyodide.{asm.mjs,asm.wasm,mjs,js,d.ts} \
          "$PYNM"/python_stdlib.zip \
          "$PYNM"/pyodide-lock.json \
          public/pyodide/
fi

# Side modules.
cp -u "$LIB"/libtcl8.6.so "$LIB"/libtk8.6.so "$LIB"/libemx11.so "$PUB/lib/"
cp -u "$TKD"/_tkinter.so "$PUB/lib/"

# Tcl + Tk script libraries: pack each tree as a single tarball. The
# worker fetches one HTTP response and hands it to py.unpackArchive,
# which extracts into MEMFS in C — orders of magnitude faster than
# 1000+ per-file fetch + writeFile round-trips (~9s → <1s).
pack_tree() {
    local src=$1 tar=$2
    rm -f "$tar"
    # -C + . so paths inside the tar are relative (no leading "build/...").
    tar -cf "$tar" -C "$src" .
    echo "  $(stat -c%s "$tar") bytes in $tar"
}

pack_tree build/tcl/library                                "$PUB/tcl-library.tar"
pack_tree build/tk/library                                 "$PUB/tk-library.tar"
pack_tree build/cpython-src/cpython-3.14.2/Lib/tkinter     "$PUB/tkinter.tar"

# Drop any old per-file trees so the dev server doesn't keep serving
# them (and so the build dir doesn't grow stale copies).
rm -rf "$PUB/tcl-library" "$PUB/tk-library" "$PUB/tkinter"

echo "stage-assets done."
