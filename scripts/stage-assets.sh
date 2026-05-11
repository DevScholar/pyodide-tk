#!/usr/bin/env bash
# Stage all runtime assets into public/ for the vite dev server.
# Idempotent — safe to re-run after rebuilding native artefacts.

set -euo pipefail
cd "$(dirname "$0")/.."

LIB=build/install/lib
TKD=build/_tkinter
PUB=public/pyodide-tk-assets
PYNM=node_modules/pyodide
CPYLIB=build/cpython-src/cpython-3.14.2/Lib

# --- Pre-flight: every input the script depends on must exist before we
# start copying. On a clean checkout the previous behaviour was to abort
# mid-stage with `cp: cannot stat …` which gave no hint about what step
# was missing. List everything we need and report all gaps at once.
missing=()
for f in \
    "$LIB/libtcl8.6.so" "$LIB/libtk8.6.so" "$LIB/libemx11.so" \
    "$TKD/_tkinter.so" \
    "$CPYLIB/turtle.py" \
    "build/tcl/library" "build/tk/library" "$CPYLIB/tkinter"
do
    [[ -e "$f" ]] || missing+=("$f")
done
if (( ${#missing[@]} > 0 )); then
    {
        echo "stage-assets: missing required build artefacts:"
        for f in "${missing[@]}"; do echo "  - $f"; done
        echo "Run 'make all && make tkinter' first (or fetch the cpython source via the Makefile)."
    } >&2
    exit 1
fi

mkdir -p public/pyodide "$PUB/lib"

# Pyodide runtime: copy from node_modules/pyodide. The package is pinned
# in package.json (see "pyodide" devDependency); the copy keeps the dev
# server self-contained instead of pointing vite at node_modules. The
# guard is just a belt-and-braces no-op if someone's already populated
# public/pyodide/ via another route (xbuildenv extract, manual stage).
if [[ -d $PYNM ]]; then
    # Glob rather than brace-expand: future Pyodide releases may add or
    # drop files (e.g. pyodide.d.ts is currently optional) without our
    # `set -e` aborting on a missing fixed name.
    for f in "$PYNM"/pyodide.asm.mjs "$PYNM"/pyodide.asm.wasm \
             "$PYNM"/pyodide.mjs "$PYNM"/pyodide.js "$PYNM"/pyodide.d.ts \
             "$PYNM"/python_stdlib.zip "$PYNM"/pyodide-lock.json
    do
        [[ -f "$f" ]] && cp -u "$f" public/pyodide/
    done
fi

# Side modules. libwacl is optional -- sibling wacl-tk might not be
# built. Distinguish "file absent" (skip with a friendly note) from
# "cp failed for any other reason" (real error, propagate via set -e).
cp -u "$LIB"/libtcl8.6.so "$LIB"/libtk8.6.so "$LIB"/libemx11.so "$PUB/lib/"
if [[ -f "$LIB/libwacl.so" ]]; then
    cp -u "$LIB/libwacl.so" "$PUB/lib/"
else
    echo "  (libwacl.so missing -- ::wacl::dom / ::wacl::jscall unavailable)"
fi
cp -u "$TKD"/_tkinter.so "$PUB/lib/"

# Tcl + Tk script libraries: pack each tree as a single tarball. The
# worker fetches one HTTP response and hands it to py.unpackArchive,
# which extracts into MEMFS in C — orders of magnitude faster than
# 1000+ per-file fetch + writeFile round-trips (~9s → <1s).
#
# Reproducibility flags:
#   --sort=name         stable file order regardless of readdir() order
#   --mtime=@0          zero mtime on every entry
#   --owner=0 --group=0 strip local uid/gid
#   --numeric-owner     don't embed /etc/passwd lookups
# Without these the tarball hash drifts on every rebuild, which churns
# the dev-server's HTTP ETag and any downstream content-addressed cache.
pack_tree() {
    local src=$1 tar=$2
    rm -f "$tar"
    tar -cf "$tar" \
        --sort=name --mtime=@0 \
        --owner=0 --group=0 --numeric-owner \
        -C "$src" .
    # wc -c rather than `stat -c%s` for portability (the BSD `stat` on
    # macOS uses `-f%z`; wc is the same everywhere).
    echo "  $(wc -c < "$tar") bytes in $tar"
}

pack_tree build/tcl/library "$PUB/tcl-library.tar"
pack_tree build/tk/library  "$PUB/tk-library.tar"
pack_tree "$CPYLIB/tkinter" "$PUB/tkinter.tar"

# turtle.py is a single-file stdlib module that imports tkinter. Pyodide
# strips it from python_stdlib.zip (along with tkinter) since stock
# Pyodide has no _tkinter.so. Stage it as a plain file -- the worker
# writes it to site-packages alongside _tkinter.so.
cp -u "$CPYLIB/turtle.py" "$PUB/turtle.py"

# Drop any old per-file trees so the dev server doesn't keep serving
# them (and so the build dir doesn't grow stale copies).
rm -rf "$PUB/tcl-library" "$PUB/tk-library" "$PUB/tkinter"

echo "stage-assets done."
