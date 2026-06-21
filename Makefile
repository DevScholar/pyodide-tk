# pyodide-tk: Tcl/Tk + em-x11 as Pyodide-loadable side modules
# Target: pyemscripten_2026_0 (Python 3.14, Emscripten 5.0.3, wasm-EH ABI)

TCLVERSION ?= 8.6.15
TKVERSION  ?= 8.6.15

EMSCRIPTEN ?= $(HOME)/.local/lib/emsdk/upstream/emscripten

# em-x11 supplies our Xlib (X11/*.h tree + split static archives). The
# emscripten-ports script at tools/ports/em_x11.py is the canonical way to
# discover include paths (--use-port in compile flags) and archive paths
# (--use-port in link flags). For the side-module path we still need the
# raw .a files on disk for --whole-archive relinking, so we build em-x11's
# native/ subset via cmake and copy the archives.
EM_X11_DIR      ?= $(CURDIR)/../em-x11
EM_X11_INCLUDES  = $(EM_X11_DIR)/native/include
EM_X11_PORT      = $(EM_X11_DIR)/tools/ports/em_x11.py

# em-x11 is auto-built by pyodide-tk (see recipe below). Archives land in
# $(BUILD)/em-x11/, built from $(EM_X11_DIR)/native/ with the flags
# Pyodide dlopen requires.  EM_X11_HIDE_INTERNAL_SYMBOLS=OFF is forced
# so --whole-archive can see and export every Xlib symbol.
EM_X11_BUILD_DIR = $(BUILD)/em-x11
EM_X11_STAMP     = $(EM_X11_BUILD_DIR)/.built

# CPython 3.14.2 source — needed for _tkinter.c.
#
# Two flows are supported (see https://pyodide.org/en/stable/development/building-from-sources.html):
#   A. Pre-built xbuildenv:  pyodide xbuildenv install 0.34.3
#      → $(HOME)/.cache/.pyodide-xbuildenv-0.34.3
#   B. Build from source:    git clone pyodide && cd pyodide && make
#      → $(CURDIR)/../pyodide/xbuildenv
#
# Auto-detection tries the source-build path first, then the cached path.
# Override with PYODIDE_XBUILDENV=/custom/path.
PYODIDE_XBUILDENV ?= $(or $(wildcard $(CURDIR)/../pyodide/xbuildenv),$(HOME)/.cache/.pyodide-xbuildenv-0.34.3)
PYINC             ?= $(PYODIDE_XBUILDENV)/xbuildenv/xbuildenv/pyodide-root/cpython/installs/python-3.14.2/include/python3.14
CPYTHON_VERSION   ?= 3.14.2
CPYTHON_TARBALL    = cpython-v$(CPYTHON_VERSION).tar.gz
CPYTHON_URL        = https://www.python.org/ftp/python/$(CPYTHON_VERSION)/Python-$(CPYTHON_VERSION).tgz

IGNORED    = $(CURDIR)/ignored-area
THIRDPARTY = $(IGNORED)/third-party
TARBALLS   = $(IGNORED)/tarballs

BUILD   = $(CURDIR)/build
PREFIX  = $(BUILD)/install
LIBDIR  = $(PREFIX)/lib
INCDIR  = $(PREFIX)/include
TKINTER_OUT = $(BUILD)/_tkinter

TCL_TARBALL = tcl-core$(TCLVERSION)-src.tar.gz
TCL_URL     = http://prdownloads.sourceforge.net/tcl/$(TCL_TARBALL)
TK_TARBALL  = tk$(TKVERSION)-src.tar.gz
TK_URL      = http://prdownloads.sourceforge.net/tcl/$(TK_TARBALL)

# pyemscripten_2026_0 unwinding ABI
WASMEH    = -fwasm-exceptions -sSUPPORT_LONGJMP=wasm
SIDE_CC   = -fPIC

OPT      ?= -Oz
# JSPI is required so emscripten_sleep() in poll.c actually suspends the
# wasm fiber. Without it the Promise from the injected emscripten_sleep
# JS function is ignored, creating a tight spin-loop that freezes the page.
# Added to both compile flags (for the poll.c compilation in em-x11) and
# link flags (for side-module .so linking).
JSPI_FLAGS = -sJSPI=1
# -Dselect/poll: Pyodide main-module _select/_poll cannot be overridden
# by side-module exports.  Rename at compile time so Tcl calls resolve
# to __wrap_select/__wrap_poll from libem_x11_event_queue.so instead.
CFLAGS_X  = $(OPT) $(WASMEH) $(JSPI_FLAGS) $(SIDE_CC) -Dselect=__wrap_select -Dpoll=__wrap_poll
LDFLAGS_X = $(WASMEH) $(JSPI_FLAGS)

# Side-module link flags. =1 auto-exports all non-static symbols
# (what _tkinter wants from libtcl/libtk). =2 + EXPORTED_FUNCTIONS
# would be smaller but the export list for Tcl/Tk is huge.
SIDE_LDFLAGS = -sSIDE_MODULE=1 $(WASMEH) $(JSPI_FLAGS)

.PHONY: all tclprep tkprep tkinter clean distclean toolcheck smoke-tcl libtcl-so stage cpython-src

all: $(LIBDIR)/libtcl8.6.so $(LIBDIR)/libtk8.6.so $(EM_X11_SIDE_MODULES_COPY) $(LIBDIR)/libtcldide.so $(TKINTER_OUT)/_tkinter.so stage

# Stage built artefacts into public/ so the vite dev server picks them up.
# Folded into `all` so a fresh clone -> `make` -> `pnpm dev` just works.
stage: $(LIBDIR)/libtcl8.6.so $(LIBDIR)/libtk8.6.so $(EM_X11_SIDE_MODULES_COPY) $(LIBDIR)/libtcldide.so $(TKINTER_OUT)/_tkinter.so
	bash $(CURDIR)/scripts/stage-assets.sh

# smoke-tcl needs an alias because the recipe doesn't reference the .so by path.
libtcl-so: $(LIBDIR)/libtcl8.6.so

toolcheck:
	@echo "== toolcheck =="
	@which emcc
	@emcc --version | head -1
	@test -d "$(EM_X11_INCLUDES)/X11" || \
		(echo "em-x11 headers not found at $(EM_X11_INCLUDES)/X11"; exit 1)
	@test -f "$(EM_X11_PORT)" || \
		(echo "em-x11 port script not found at $(EM_X11_PORT)"; exit 1)
	@echo "em-x11 X11 headers OK: $(EM_X11_INCLUDES)/X11"
	@echo "em-x11 port script OK: $(EM_X11_PORT)"
	@echo "BUILD=$(BUILD)"

# ---- Tcl ---------------------------------------------------------------

$(TARBALLS)/$(TCL_TARBALL):
	mkdir -p $(TARBALLS)
	cd $(TARBALLS) && wget -nc $(TCL_URL)

$(THIRDPARTY)/tcl/unix/configure: $(TARBALLS)/$(TCL_TARBALL)
	rm -rf $(THIRDPARTY)/tcl
	mkdir -p $(THIRDPARTY)/tcl
	tar -C $(THIRDPARTY)/tcl --strip-components=1 -xf $(TARBALLS)/$(TCL_TARBALL)
	cd $(THIRDPARTY)/tcl/unix && autoconf

tclprep: $(THIRDPARTY)/tcl/unix/configure

$(THIRDPARTY)/tcl/unix/Makefile: $(THIRDPARTY)/tcl/unix/configure
	cd $(THIRDPARTY)/tcl/unix && emconfigure ./configure \
		--host=wasm32-unknown-emscripten \
		--prefix=$(PREFIX) \
		--disable-threads --disable-load --disable-shared \
		ac_cv_have_intrinsic_cpuid=no \
		ac_cv_func_strtoul=yes \
		tcl_cv_strtoul_unbroken=ok \
		tcl_cv_strstr_unbroken=ok \
		CFLAGS="$(CFLAGS_X)" LDFLAGS="$(LDFLAGS_X)"
	cd $(THIRDPARTY)/tcl/unix && sed -i 's/-O2//g' Makefile

$(THIRDPARTY)/tcl/unix/libtcl8.6.a: $(THIRDPARTY)/tcl/unix/Makefile
	cd $(THIRDPARTY)/tcl/unix && emmake make -j libtcl8.6.a libtclstub8.6.a

# Install the static archive + headers into PREFIX so Tk's configure
# can find them via --with-tcl=$(LIBDIR).
$(LIBDIR)/libtcl8.6.a: $(THIRDPARTY)/tcl/unix/libtcl8.6.a
	mkdir -p $(LIBDIR) $(INCDIR)
	cp $(THIRDPARTY)/tcl/unix/libtcl8.6.a $(THIRDPARTY)/tcl/unix/libtclstub8.6.a $(LIBDIR)/
	cp $(THIRDPARTY)/tcl/unix/tclConfig.sh $(LIBDIR)/
	cp $(THIRDPARTY)/tcl/generic/tcl.h $(THIRDPARTY)/tcl/generic/tclDecls.h \
	   $(THIRDPARTY)/tcl/generic/tclPlatDecls.h $(THIRDPARTY)/tcl/generic/tclTomMath.h \
	   $(THIRDPARTY)/tcl/generic/tclTomMathDecls.h $(INCDIR)/

# Relink the static archive into a Pyodide-style side module.
# --whole-archive forces all object files in to keep public symbols.
# libem_x11_event_queue.so on the link line creates a NEEDED entry so
# __wrap_select/__wrap_poll resolve from it (Pyodide loadDynlib ignores
# {global:true}, so only NEEDED-chain visibility works).
$(LIBDIR)/libtcl8.6.so: $(LIBDIR)/libtcl8.6.a $(LIBDIR)/libem_x11_event_queue.so
	emcc $(SIDE_LDFLAGS) -o $@ \
		-Wl,--whole-archive $(LIBDIR)/libtcl8.6.a -Wl,--no-whole-archive \
		$(LIBDIR)/libem_x11_event_queue.so

# ---- Tk ----------------------------------------------------------------
# Stock Tk 8.6 against em-x11's Xlib. Same trick as tcldide: --with-x
# uses real X11/*.h, but no Xlib.so to link against -- libtk.a will
# carry unresolved Xlib symbols, resolved at libtk-so link time by
# libem_x11 (or as undefined symbols satisfied by the host JS bridge).
# Disable optional deps tcldide also disables for the first cut.

$(TARBALLS)/$(TK_TARBALL):
	mkdir -p $(TARBALLS)
	cd $(TARBALLS) && wget -nc $(TK_URL)

$(THIRDPARTY)/tk/unix/configure: $(TARBALLS)/$(TK_TARBALL)
	rm -rf $(THIRDPARTY)/tk
	mkdir -p $(THIRDPARTY)/tk
	tar -C $(THIRDPARTY)/tk --strip-components=1 -xf $(TARBALLS)/$(TK_TARBALL)
	cd $(THIRDPARTY)/tk/unix && autoconf

tkprep: $(THIRDPARTY)/tk/unix/configure

$(THIRDPARTY)/tk/unix/Makefile: $(THIRDPARTY)/tk/unix/configure $(LIBDIR)/libtcl8.6.a
	chmod +x $(CURDIR)/scripts/xft-config 2>/dev/null || true
	cd $(THIRDPARTY)/tk/unix && \
		PATH="$(CURDIR)/scripts:$$PATH" \
		EM_X11_INCLUDES="$(EM_X11_INCLUDES)" \
		EM_X11_LIBDIR="$(LIBDIR)" \
		XFT_CFLAGS="-I$(EM_X11_INCLUDES)" \
		XFT_LIBS="-L$(LIBDIR) -lem_x11" \
		ac_cv_lib_Xft_XftFontOpen=yes \
		ac_cv_lib_fontconfig_FcFontSort=no \
		ac_cv_lib_X11_XkbKeycodeToKeysym=yes \
		cross_compiling=yes \
		emconfigure ./configure \
		--host=wasm32-unknown-emscripten \
		--prefix=$(PREFIX) \
		--with-tcl=$(LIBDIR) \
		--x-includes=$(EM_X11_INCLUDES) \
		--x-libraries=$(LIBDIR) \
		--disable-threads --disable-load --disable-shared \
		--disable-xss \
		CFLAGS="$(CFLAGS_X)" LDFLAGS="$(LDFLAGS_X)"
	# Force our flags + header order over what configure's probe inserts.
	cd $(THIRDPARTY)/tk/unix && sed -i 's/-O2//g' Makefile
	cd $(THIRDPARTY)/tk/unix && sed -i 's|^X11_INCLUDES[[:space:]]*=.*|X11_INCLUDES = -I$(EM_X11_INCLUDES)|' Makefile

$(THIRDPARTY)/tk/unix/libtk8.6.a: $(THIRDPARTY)/tk/unix/Makefile
	cd $(THIRDPARTY)/tk/unix && emmake make -j libtk8.6.a libtkstub8.6.a

# Side-module relink for Tk. Tk references many Xlib symbols from
# em-x11; we pass them as undefined for now (the .so link step will
# resolve them at the next layer). --no-whole-archive on libtcl avoids
# duplicating its objects (libtcl-so already exports them).
$(LIBDIR)/libtk8.6.so: $(THIRDPARTY)/tk/unix/libtk8.6.a $(LIBDIR)/libem_x11_event_queue.so
	mkdir -p $(LIBDIR) $(INCDIR)/tk
	cp $(THIRDPARTY)/tk/unix/libtk8.6.a $(THIRDPARTY)/tk/unix/libtkstub8.6.a $(LIBDIR)/
	cp $(THIRDPARTY)/tk/generic/*.h $(INCDIR)/tk/
	emcc $(SIDE_LDFLAGS) -o $(LIBDIR)/libtk8.6.so \
		-Wl,--whole-archive $(LIBDIR)/libtk8.6.a -Wl,--no-whole-archive \
		$(LIBDIR)/libem_x11_event_queue.so \
		-sERROR_ON_UNDEFINED_SYMBOLS=0

clean:
	rm -rf $(BUILD)

distclean: clean

# ---- Smoke test --------------------------------------------------------
# Minimal C main calling Tcl_CreateInterp + Tcl_Eval, linked against
# libtcl8.6.so as a runtime side module. Validates wasm-EH dlopen
# end-to-end before we touch CPython.

SMOKE_DIR = $(BUILD)/smoke

smoke-tcl: libtcl-so
	mkdir -p $(SMOKE_DIR)
	# Stage the .so next to the main module so emscripten's loader finds it.
	cp $(LIBDIR)/libtcl8.6.so $(SMOKE_DIR)/
	emcc $(WASMEH) -sMAIN_MODULE=2 \
		-I $(INCDIR) \
		-sEXIT_RUNTIME=1 \
		$(CURDIR)/tests/smoke_tcl.c \
		$(SMOKE_DIR)/libtcl8.6.so \
		-o $(SMOKE_DIR)/smoke_tcl.js
	@echo "---- node $(SMOKE_DIR)/smoke_tcl.js ----"
	cd $(SMOKE_DIR) && node smoke_tcl.js

# ---- em-x11 build (auto) -------------------------------------------------
# Builds em-x11 static archives from the sibling repo's native/ source into
# $(BUILD)/em-x11/.  EM_X11_HIDE_INTERNAL_SYMBOLS=OFF is forced so that
# --whole-archive can see and export every Xlib symbol during the side-module
# relink step below.
#
# This replaces the old workflow of requiring the user to pre-build em-x11
# separately.  make now drives the cmake configure + build itself, ensuring
# the correct flags every time.
#
# The cmake build only compiles the native/ archive set (libX11, libXext,
# libXrender, libfontconfig, libXft).  Third-party libs and demos are
# skipped — pyodide-tk doesn't need them.

# Track every source file under em-x11/native/ so a .c or .h change
# invalidates the stamp and re-runs cmake --build (which itself only
# rebuilds changed .o files).  Without this, .so relinking silently
# picks up stale .a archives.
EM_X11_SRCFILES := $(shell find $(EM_X11_DIR)/native -type f \( -name '*.c' -o -name '*.h' -o -name 'CMakeLists.txt' \))

$(EM_X11_STAMP): $(EM_X11_SRCFILES)
	@echo "==> Configuring em-x11 (native subset) into $(EM_X11_BUILD_DIR)"
	rm -rf $(EM_X11_BUILD_DIR)
	mkdir -p $(EM_X11_BUILD_DIR)
	cd $(EM_X11_BUILD_DIR) && emcmake cmake -S $(EM_X11_DIR)/native -B . \
		-DCMAKE_BUILD_TYPE=Release \
		-DEM_X11_HIDE_INTERNAL_SYMBOLS=OFF \
		-DCMAKE_C_FLAGS="$(JSPI_FLAGS)" \
		-DCMAKE_CXX_FLAGS="$(JSPI_FLAGS)"
	@echo "==> Building em-x11 archives"
	$(MAKE) -C $(EM_X11_BUILD_DIR) -j
	touch $@

$(EM_X11_BUILD_DIR)/libem_x11_event_queue.a: $(EM_X11_STAMP)
$(EM_X11_BUILD_DIR)/libX11.a: $(EM_X11_STAMP)
$(EM_X11_BUILD_DIR)/libXext.a: $(EM_X11_STAMP)
$(EM_X11_BUILD_DIR)/libXrender.a: $(EM_X11_STAMP)
$(EM_X11_BUILD_DIR)/libfontconfig.a: $(EM_X11_STAMP)
$(EM_X11_BUILD_DIR)/libXft.a: $(EM_X11_STAMP)

# ---- em-x11 split side modules ------------------------------------------
# Relink each static archive into a proper SIDE_MODULE.  Dependencies mirror
# real X's NEEDED graph:
#   libX11.so       -> libtcl8.6.so
#   libXext.so      -> libX11.so, libtcl8.6.so
#   libXrender.so   -> libX11.so, libtcl8.6.so
#   libfontconfig.so -> libX11.so, libtcl8.6.so
#   libXft.so       -> libXrender.so, libfontconfig.so, libX11.so, libtcl8.6.so
#
# Each .so carries proper NEEDED entries; Pyodide's recursive dlopen
# cascades through the graph at load time.
#
# GLX is excluded — _tkinter doesn't use OpenGL.

EM_X11_ARCHIVES = \
	$(EM_X11_BUILD_DIR)/libem_x11_event_queue.a \
	$(EM_X11_BUILD_DIR)/libX11.a \
	$(EM_X11_BUILD_DIR)/libXext.a \
	$(EM_X11_BUILD_DIR)/libXrender.a \
	$(EM_X11_BUILD_DIR)/libfontconfig.a \
	$(EM_X11_BUILD_DIR)/libXft.a

EM_X11_RELINK = -Wl,--whole-archive $< -Wl,--no-whole-archive
EM_X11_SO_FLAGS = $(WASMEH) $(JSPI_FLAGS) -sSIDE_MODULE=1 $(OPT)

$(LIBDIR)/libem_x11_event_queue.so: $(EM_X11_BUILD_DIR)/libem_x11_event_queue.a
	emcc $(EM_X11_SO_FLAGS) -o $@ \
		$(EM_X11_RELINK) \
		-sERROR_ON_UNDEFINED_SYMBOLS=0

$(LIBDIR)/libX11.so: $(EM_X11_BUILD_DIR)/libX11.a $(LIBDIR)/libem_x11_event_queue.so
	emcc $(EM_X11_SO_FLAGS) -o $@ \
		$(EM_X11_RELINK) $(LIBDIR)/libem_x11_event_queue.so \
		-sERROR_ON_UNDEFINED_SYMBOLS=0

$(LIBDIR)/libXext.so: $(EM_X11_BUILD_DIR)/libXext.a $(LIBDIR)/libX11.so $(LIBDIR)/libtcl8.6.so
	emcc $(EM_X11_SO_FLAGS) -o $@ \
		$(EM_X11_RELINK) $(LIBDIR)/libX11.so $(LIBDIR)/libtcl8.6.so \
		-sERROR_ON_UNDEFINED_SYMBOLS=0

$(LIBDIR)/libXrender.so: $(EM_X11_BUILD_DIR)/libXrender.a $(LIBDIR)/libX11.so $(LIBDIR)/libtcl8.6.so
	emcc $(EM_X11_SO_FLAGS) -o $@ \
		$(EM_X11_RELINK) $(LIBDIR)/libX11.so $(LIBDIR)/libtcl8.6.so \
		-sERROR_ON_UNDEFINED_SYMBOLS=0

$(LIBDIR)/libfontconfig.so: $(EM_X11_BUILD_DIR)/libfontconfig.a $(LIBDIR)/libX11.so $(LIBDIR)/libtcl8.6.so
	emcc $(EM_X11_SO_FLAGS) -o $@ \
		$(EM_X11_RELINK) $(LIBDIR)/libX11.so $(LIBDIR)/libtcl8.6.so \
		-sERROR_ON_UNDEFINED_SYMBOLS=0

$(LIBDIR)/libXft.so: $(EM_X11_BUILD_DIR)/libXft.a $(LIBDIR)/libX11.so $(LIBDIR)/libXrender.so $(LIBDIR)/libfontconfig.so $(LIBDIR)/libtcl8.6.so
	emcc $(EM_X11_SO_FLAGS) -o $@ \
		$(EM_X11_RELINK) $(LIBDIR)/libX11.so $(LIBDIR)/libXrender.so $(LIBDIR)/libfontconfig.so $(LIBDIR)/libtcl8.6.so \
		-sERROR_ON_UNDEFINED_SYMBOLS=0

EM_X11_SIDE_MODULES_COPY = $(LIBDIR)/.em-x11-side-modules.stamp

$(LIBDIR)/.em-x11-side-modules.stamp: $(LIBDIR)/libem_x11_event_queue.so $(LIBDIR)/libX11.so $(LIBDIR)/libXext.so $(LIBDIR)/libXrender.so $(LIBDIR)/libfontconfig.so $(LIBDIR)/libXft.so
	touch $@

# ---- CPython source + _tkinter.so --------------------------------------
# We need _tkinter.c and tkappinit.c from CPython's Modules/, plus the
# Include/ tree to compile against. Source comes from python.org's tarball
# (mirrors the Tcl/Tk fetch pattern); the matching Python.h headers come
# from pyodide-build's xbuildenv (`pyodide xbuildenv install 0.34.3`),
# which guarantees they're built with the same Emscripten ABI Pyodide
# itself uses at runtime.

CPYTHON_SRC = $(THIRDPARTY)/cpython

$(TARBALLS)/$(CPYTHON_TARBALL):
	mkdir -p $(TARBALLS)
	cd $(TARBALLS) && wget -nc -O $(CPYTHON_TARBALL) $(CPYTHON_URL)

$(CPYTHON_SRC)/_tkinter.c: $(TARBALLS)/$(CPYTHON_TARBALL)
	# Extract just what we need: Modules/_tkinter.c + Modules/tkappinit.c
	# + the Include/ tree (ABI must match xbuildenv's Python.h, but we
	# also need a few private headers under Include/internal/).
	mkdir -p $(CPYTHON_SRC)
	cd $(CPYTHON_SRC) && tar -xf $(TARBALLS)/$(CPYTHON_TARBALL) \
		Python-$(CPYTHON_VERSION)/Modules/_tkinter.c \
		Python-$(CPYTHON_VERSION)/Modules/tkinter.h \
		Python-$(CPYTHON_VERSION)/Modules/tkappinit.c \
		Python-$(CPYTHON_VERSION)/Modules/clinic/_tkinter.c.h \
		Python-$(CPYTHON_VERSION)/Include \
		Python-$(CPYTHON_VERSION)/Lib/tkinter \
		Python-$(CPYTHON_VERSION)/Lib/turtle.py
	cp $(CPYTHON_SRC)/Python-$(CPYTHON_VERSION)/Modules/_tkinter.c $(CPYTHON_SRC)/_tkinter.c
	cp $(CPYTHON_SRC)/Python-$(CPYTHON_VERSION)/Modules/tkinter.h $(CPYTHON_SRC)/tkinter.h
	cp $(CPYTHON_SRC)/Python-$(CPYTHON_VERSION)/Modules/tkappinit.c $(CPYTHON_SRC)/tkappinit.c
	mkdir -p $(CPYTHON_SRC)/clinic
	cp $(CPYTHON_SRC)/Python-$(CPYTHON_VERSION)/Modules/clinic/_tkinter.c.h $(CPYTHON_SRC)/clinic/_tkinter.c.h
	cp -r $(CPYTHON_SRC)/Python-$(CPYTHON_VERSION)/Include $(CPYTHON_SRC)/Include
	# stage-assets.sh expects this layout:
	mkdir -p $(CPYTHON_SRC)/cpython-$(CPYTHON_VERSION)
	cp -r $(CPYTHON_SRC)/Python-$(CPYTHON_VERSION)/Lib $(CPYTHON_SRC)/cpython-$(CPYTHON_VERSION)/Lib

cpython-src: $(CPYTHON_SRC)/_tkinter.c

# Toolchain check for _tkinter: the xbuildenv must be installed because we
# need Python.h from the wasm-EH-built CPython. Bail with a clear message
# if the user hasn't run `pyodide xbuildenv install 0.34.3`.
$(PYINC)/Python.h:
	@echo "ERROR: Pyodide xbuildenv not found at $(PYINC)" >&2
	@echo "       Run: pip install pyodide-build && pyodide xbuildenv install 0.34.3" >&2
	@echo "       Or override PYINC=/path/to/python3.14/include on the make line." >&2
	@exit 1

tkinter: $(TKINTER_OUT)/_tkinter.so

$(TKINTER_OUT)/_tkinter.so: $(CPYTHON_SRC)/_tkinter.c $(LIBDIR)/libtk8.6.so $(LIBDIR)/libtcl8.6.so $(EM_X11_SIDE_MODULES_COPY) $(PYINC)/Python.h
	mkdir -p $(TKINTER_OUT)
	emcc $(WASMEH) $(SIDE_CC) -sSIDE_MODULE=1 \
		-DWITH_APPINIT=1 -DPy_BUILD_CORE_BUILTIN=1 \
		-I $(PYINC) -I $(CPYTHON_SRC)/Include/internal -I $(CPYTHON_SRC) \
		-I $(INCDIR) -I $(INCDIR)/tk \
		-I $(EM_X11_INCLUDES) \
		$(CPYTHON_SRC)/_tkinter.c $(CPYTHON_SRC)/tkappinit.c \
		$(LIBDIR)/libtk8.6.so $(LIBDIR)/libtcl8.6.so \
		$(LIBDIR)/libX11.so $(LIBDIR)/libXft.so $(LIBDIR)/libXrender.so $(LIBDIR)/libfontconfig.so \
		-sERROR_ON_UNDEFINED_SYMBOLS=0 \
		-o $(TKINTER_OUT)/_tkinter.so

# ---- libtcldide.so --------------------------------------------------------
# tcldide's ::tcldide::dom and ::tcldide::jscall Tcl commands, repackaged as a
# Pyodide side module so Python tkinter code can drive the DOM straight
# from Tcl (no `from js import …` round-trip). Source is the sibling
# tcldide/opt/tcldide.c -- single source of truth, no copy. The runtime
# wires it up by ctypes-calling Tcldide_Init(interp) on each tkinter.Tk()
# (see worker.ts prelude).
#
# libtcl8.6.so is on the link line so Tcl_CreateNamespace etc. land on
# libtcldide.so's NEEDED entry; loadDynlib's flags=2 then auto-cascades.

TCLDIDE_SRC = $(CURDIR)/../tcldide/opt/tcldide.c

$(LIBDIR)/libtcldide.so: $(TCLDIDE_SRC) $(LIBDIR)/libtcl8.6.so
	@test -f $(TCLDIDE_SRC) || \
		(echo "tcldide source missing at $(TCLDIDE_SRC) -- clone tcldide as a sibling dir"; exit 1)
	mkdir -p $(LIBDIR)
	emcc $(WASMEH) $(SIDE_CC) -sSIDE_MODULE=1 \
		-I $(INCDIR) \
		$(TCLDIDE_SRC) $(LIBDIR)/libtcl8.6.so \
		-sERROR_ON_UNDEFINED_SYMBOLS=0 \
		-o $(LIBDIR)/libtcldide.so

