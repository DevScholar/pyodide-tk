# pyodide-tk: Tcl/Tk + em-x11 as Pyodide-loadable side modules
# Target: pyemscripten_2026_0 (Python 3.14, Emscripten 5.0.3, wasm-EH ABI)

TCLVERSION ?= 8.6.6
TKVERSION  ?= 8.6.6

EMSCRIPTEN ?= $(HOME)/.local/lib/emsdk/upstream/emscripten

# em-x11 supplies our Xlib (X11/*.h tree + later libemx11.so).
EMX11_DIR      ?= $(CURDIR)/../em-x11
EMX11_INCLUDES  = $(EMX11_DIR)/native/include

# CPython 3.14.2 source — needed for _tkinter.c. Either reuse the copy
# pyodide-build's xbuildenv unpacks (`pyodide xbuildenv install 0.34.3`),
# or fall back to fetching the source tarball from python.org.
PYODIDE_XBUILDENV ?= $(HOME)/.cache/.pyodide-xbuildenv-0.34.3
PYINC             ?= $(PYODIDE_XBUILDENV)/xbuildenv/xbuildenv/pyodide-root/cpython/installs/python-3.14.2/include/python3.14
CPYTHON_VERSION   ?= 3.14.2
CPYTHON_TARBALL    = cpython-v$(CPYTHON_VERSION).tar.gz
CPYTHON_URL        = https://www.python.org/ftp/python/$(CPYTHON_VERSION)/Python-$(CPYTHON_VERSION).tgz

BUILD   = $(CURDIR)/build
PREFIX  = $(BUILD)/install
LIBDIR  = $(PREFIX)/lib
INCDIR  = $(PREFIX)/include

TCL_TARBALL = tcl-core$(TCLVERSION)-src.tar.gz
TCL_URL     = http://prdownloads.sourceforge.net/tcl/$(TCL_TARBALL)
TK_TARBALL  = tk$(TKVERSION)-src.tar.gz
TK_URL      = http://prdownloads.sourceforge.net/tcl/$(TK_TARBALL)

# pyemscripten_2026_0 unwinding ABI
WASMEH    = -fwasm-exceptions -sSUPPORT_LONGJMP=wasm
SIDE_CC   = -fPIC

OPT      ?= -Oz
CFLAGS_X  = $(OPT) $(WASMEH) $(SIDE_CC)
LDFLAGS_X = $(WASMEH)

# Side-module link flags. =1 auto-exports all non-static symbols
# (what _tkinter wants from libtcl/libtk). =2 + EXPORTED_FUNCTIONS
# would be smaller but the export list for Tcl/Tk is huge.
SIDE_LDFLAGS = -sSIDE_MODULE=1 $(WASMEH)

.PHONY: all tclprep tkprep tkinter clean distclean toolcheck smoke-tcl libtcl-so

all: $(LIBDIR)/libtcl8.6.so $(LIBDIR)/libtk8.6.so $(LIBDIR)/libemx11.so

# smoke-tcl needs an alias because the recipe doesn't reference the .so by path.
libtcl-so: $(LIBDIR)/libtcl8.6.so

toolcheck:
	@echo "== toolcheck =="
	@which emcc
	@emcc --version | head -1
	@test -d "$(EMX11_INCLUDES)/X11" || \
		(echo "em-x11 headers not found at $(EMX11_INCLUDES)/X11"; exit 1)
	@echo "em-x11 X11 headers OK: $(EMX11_INCLUDES)/X11"
	@echo "BUILD=$(BUILD)"

# ---- Tcl ---------------------------------------------------------------

$(BUILD)/$(TCL_TARBALL):
	mkdir -p $(BUILD)
	cd $(BUILD) && wget -nc $(TCL_URL)

$(BUILD)/tcl/unix/configure: $(BUILD)/$(TCL_TARBALL)
	rm -rf $(BUILD)/tcl
	mkdir -p $(BUILD)/tcl
	tar -C $(BUILD)/tcl --strip-components=1 -xf $(BUILD)/$(TCL_TARBALL)
	cd $(BUILD)/tcl/unix && autoconf

tclprep: $(BUILD)/tcl/unix/configure

$(BUILD)/tcl/unix/Makefile: $(BUILD)/tcl/unix/configure
	cd $(BUILD)/tcl/unix && emconfigure ./configure \
		--host=wasm32-unknown-emscripten \
		--prefix=$(PREFIX) \
		--disable-threads --disable-load --disable-shared \
		CFLAGS="$(CFLAGS_X)" LDFLAGS="$(LDFLAGS_X)"
	cd $(BUILD)/tcl/unix && sed -i 's/-O2//g' Makefile

$(BUILD)/tcl/unix/libtcl8.6.a: $(BUILD)/tcl/unix/Makefile
	cd $(BUILD)/tcl/unix && emmake make -j libtcl8.6.a libtclstub8.6.a

# Install the static archive + headers into PREFIX so Tk's configure
# can find them via --with-tcl=$(LIBDIR).
$(LIBDIR)/libtcl8.6.a: $(BUILD)/tcl/unix/libtcl8.6.a
	mkdir -p $(LIBDIR) $(INCDIR)
	cp $(BUILD)/tcl/unix/libtcl8.6.a $(BUILD)/tcl/unix/libtclstub8.6.a $(LIBDIR)/
	cp $(BUILD)/tcl/unix/tclConfig.sh $(LIBDIR)/
	cp $(BUILD)/tcl/generic/tcl.h $(BUILD)/tcl/generic/tclDecls.h \
	   $(BUILD)/tcl/generic/tclPlatDecls.h $(BUILD)/tcl/generic/tclTomMath.h \
	   $(BUILD)/tcl/generic/tclTomMathDecls.h $(INCDIR)/

# Relink the static archive into a Pyodide-style side module.
# --whole-archive forces all object files in to keep public symbols.
# strtod.o is dropped first: Tcl's configure flags emscripten's libc as
# "buggy strtod" (false positive) and pulls a compat shim that collides
# with the canonical fixstrtod.o under --whole-archive.
$(LIBDIR)/libtcl8.6.so: $(LIBDIR)/libtcl8.6.a
	emar d $(LIBDIR)/libtcl8.6.a strtod.o
	emcc $(SIDE_LDFLAGS) -o $(LIBDIR)/libtcl8.6.so \
		-Wl,--whole-archive $(LIBDIR)/libtcl8.6.a -Wl,--no-whole-archive

# ---- Tk ----------------------------------------------------------------
# Stock Tk 8.6 against em-x11's Xlib. Same trick as wacl-tk: --with-x
# uses real X11/*.h, but no Xlib.so to link against -- libtk.a will
# carry unresolved Xlib symbols, resolved at libtk-so link time by
# libemx11 (or as undefined symbols satisfied by the host JS bridge).
# Disable optional deps wacl-tk also disables for the first cut.

$(BUILD)/$(TK_TARBALL):
	mkdir -p $(BUILD)
	cd $(BUILD) && wget -nc $(TK_URL)

$(BUILD)/tk/unix/configure: $(BUILD)/$(TK_TARBALL)
	rm -rf $(BUILD)/tk
	mkdir -p $(BUILD)/tk
	tar -C $(BUILD)/tk --strip-components=1 -xf $(BUILD)/$(TK_TARBALL)
	cd $(BUILD)/tk/unix && autoconf

tkprep: $(BUILD)/tk/unix/configure

$(BUILD)/tk/unix/Makefile: $(BUILD)/tk/unix/configure $(LIBDIR)/libtcl8.6.a
	cd $(BUILD)/tk/unix && emconfigure ./configure \
		--host=wasm32-unknown-emscripten \
		--prefix=$(PREFIX) \
		--with-tcl=$(LIBDIR) \
		--x-includes=$(EMX11_INCLUDES) \
		--x-libraries=$(LIBDIR) \
		--disable-threads --disable-load --disable-shared \
		--disable-xft --disable-xss \
		CFLAGS="$(CFLAGS_X)" LDFLAGS="$(LDFLAGS_X)"
	# Force our flags + header order over what configure's probe inserts.
	cd $(BUILD)/tk/unix && sed -i 's/-O2//g' Makefile
	cd $(BUILD)/tk/unix && sed -i 's|^X11_INCLUDES[[:space:]]*=.*|X11_INCLUDES = -I$(EMX11_INCLUDES)|' Makefile

$(BUILD)/tk/unix/libtk8.6.a: $(BUILD)/tk/unix/Makefile
	cd $(BUILD)/tk/unix && emmake make -j libtk8.6.a libtkstub8.6.a

# Side-module relink for Tk. Tk references many Xlib symbols from
# em-x11; we pass them as undefined for now (libemx11 .so step will
# resolve them at the next layer). --no-whole-archive on libtcl avoids
# duplicating its objects (libtcl-so already exports them).
$(LIBDIR)/libtk8.6.so: $(BUILD)/tk/unix/libtk8.6.a
	mkdir -p $(LIBDIR) $(INCDIR)/tk
	cp $(BUILD)/tk/unix/libtk8.6.a $(BUILD)/tk/unix/libtkstub8.6.a $(LIBDIR)/
	cp $(BUILD)/tk/generic/*.h $(INCDIR)/tk/
	emcc $(SIDE_LDFLAGS) -o $(LIBDIR)/libtk8.6.so \
		-Wl,--whole-archive $(LIBDIR)/libtk8.6.a -Wl,--no-whole-archive \
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

# ---- em-x11 (libemx11.so) ----------------------------------------------
# Build em-x11's existing static archive (emx11_static target) under our
# wasm-EH flags, then relink as a SIDE_MODULE the same way we do libtcl /
# libtk. CMake's Emscripten toolchain silently downgrades SHARED targets
# to static archives, so going via the static path + manual relink is
# the only reliable route.

EMX11_BUILD = $(BUILD)/em-x11

$(EMX11_BUILD)/CMakeCache.txt:
	mkdir -p $(EMX11_BUILD)
	cd $(EMX11_BUILD) && emcmake cmake $(EMX11_DIR)/native \
		-DCMAKE_BUILD_TYPE=MinSizeRel \
		-DEMX11_HIDE_INTERNAL_SYMBOLS=OFF \
		-DCMAKE_C_FLAGS="$(WASMEH) -fPIC"

$(EMX11_BUILD)/libemx11.a: $(EMX11_BUILD)/CMakeCache.txt
	cd $(EMX11_BUILD) && emmake make -j emx11_static

$(LIBDIR)/libemx11.so: $(EMX11_BUILD)/libemx11.a $(LIBDIR)/libtcl8.6.so
	mkdir -p $(LIBDIR)
	cp $(EMX11_BUILD)/libemx11.a $(LIBDIR)/
	# Link libtcl8.6.so so it lands on libemx11's NEEDED entry. Pyodide's
	# loadDynlib hard-codes flags=2; the only way our notifier's
	# Tcl_SetNotifier ref resolves at dlopen time is via NEEDED auto-cascade.
	emcc $(SIDE_LDFLAGS) -o $(LIBDIR)/libemx11.so \
		-Wl,--whole-archive $(LIBDIR)/libemx11.a -Wl,--no-whole-archive \
		$(LIBDIR)/libtcl8.6.so \
		-sERROR_ON_UNDEFINED_SYMBOLS=0

# ---- CPython source + _tkinter.so --------------------------------------
# We need _tkinter.c and tkappinit.c from CPython's Modules/, plus the
# Include/ tree to compile against. Source comes from python.org's tarball
# (mirrors the Tcl/Tk fetch pattern); the matching Python.h headers come
# from pyodide-build's xbuildenv (`pyodide xbuildenv install 0.34.3`),
# which guarantees they're built with the same Emscripten ABI Pyodide
# itself uses at runtime.

CPYTHON_SRC = $(BUILD)/cpython-src
TKINTER_OUT = $(BUILD)/_tkinter

$(CPYTHON_SRC)/$(CPYTHON_TARBALL):
	mkdir -p $(CPYTHON_SRC)
	cd $(CPYTHON_SRC) && wget -nc -O $(CPYTHON_TARBALL) $(CPYTHON_URL)

$(CPYTHON_SRC)/_tkinter.c: $(CPYTHON_SRC)/$(CPYTHON_TARBALL)
	# Extract just what we need: Modules/_tkinter.c + Modules/tkappinit.c
	# + the Include/ tree (ABI must match xbuildenv's Python.h, but we
	# also need a few private headers under Include/internal/).
	cd $(CPYTHON_SRC) && tar -xf $(CPYTHON_TARBALL) \
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

$(TKINTER_OUT)/_tkinter.so: $(CPYTHON_SRC)/_tkinter.c $(LIBDIR)/libtk8.6.so $(LIBDIR)/libtcl8.6.so $(LIBDIR)/libemx11.so $(PYINC)/Python.h
	mkdir -p $(TKINTER_OUT)
	emcc $(WASMEH) $(SIDE_CC) -sSIDE_MODULE=1 \
		-DWITH_APPINIT=1 -DPy_BUILD_CORE_BUILTIN=1 \
		-I $(PYINC) -I $(CPYTHON_SRC)/Include/internal -I $(CPYTHON_SRC) \
		-I $(INCDIR) -I $(INCDIR)/tk -I $(EMX11_INCLUDES) \
		$(CPYTHON_SRC)/_tkinter.c $(CPYTHON_SRC)/tkappinit.c \
		$(LIBDIR)/libtk8.6.so $(LIBDIR)/libtcl8.6.so $(LIBDIR)/libemx11.so \
		-sERROR_ON_UNDEFINED_SYMBOLS=0 \
		-o $(TKINTER_OUT)/_tkinter.so
