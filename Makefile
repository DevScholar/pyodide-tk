# pyodide-tk: Tcl/Tk + em-x11 as Pyodide-loadable side modules
# Target: pyemscripten_2026_0 (Python 3.14, Emscripten 5.0.3, wasm-EH ABI)

TCLVERSION ?= 8.6.15
TKVERSION  ?= 8.6.15

EMSCRIPTEN ?= $(HOME)/.local/lib/emsdk/upstream/emscripten

# em-x11 supplies our Xlib (X11/*.h tree + split static archives). The
# emscripten-ports script at tools/ports/emx11.py is the canonical way to
# discover include paths (--use-port in compile flags) and archive paths
# (--use-port in link flags). For the side-module path we still need the
# raw .a files on disk for --whole-archive relinking, so we build em-x11's
# native/ subset via cmake and copy the archives.
EMX11_DIR      ?= $(CURDIR)/../em-x11
EMX11_INCLUDES  = $(EMX11_DIR)/native/include
EMX11_PORT      = $(EMX11_DIR)/tools/ports/emx11.py

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
TKINTER_OUT = $(BUILD)/_tkinter

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

.PHONY: all tclprep tkprep tkinter clean distclean toolcheck smoke-tcl libtcl-so stage cpython-src

all: $(LIBDIR)/libtcl8.6.so $(LIBDIR)/libtk8.6.so $(LIBDIR)/libemx11.so $(LIBDIR)/libtcldide.so $(TKINTER_OUT)/_tkinter.so stage

# Stage built artefacts into public/ so the vite dev server picks them up.
# Folded into `all` so a fresh clone -> `make` -> `pnpm dev` just works.
stage: $(LIBDIR)/libtcl8.6.so $(LIBDIR)/libtk8.6.so $(LIBDIR)/libemx11.so $(LIBDIR)/libtcldide.so $(TKINTER_OUT)/_tkinter.so
	bash $(CURDIR)/scripts/stage-assets.sh

# smoke-tcl needs an alias because the recipe doesn't reference the .so by path.
libtcl-so: $(LIBDIR)/libtcl8.6.so

toolcheck:
	@echo "== toolcheck =="
	@which emcc
	@emcc --version | head -1
	@test -d "$(EMX11_INCLUDES)/X11" || \
		(echo "em-x11 headers not found at $(EMX11_INCLUDES)/X11"; exit 1)
	@test -f "$(EMX11_PORT)" || \
		(echo "em-x11 port script not found at $(EMX11_PORT)"; exit 1)
	@echo "em-x11 X11 headers OK: $(EMX11_INCLUDES)/X11"
	@echo "em-x11 port script OK: $(EMX11_PORT)"
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
		ac_cv_have_intrinsic_cpuid=no \
		ac_cv_func_strtoul=yes \
		tcl_cv_strtoul_unbroken=ok \
		tcl_cv_strstr_unbroken=ok \
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
$(LIBDIR)/libtcl8.6.so: $(LIBDIR)/libtcl8.6.a
	emcc $(SIDE_LDFLAGS) -o $(LIBDIR)/libtcl8.6.so \
		-Wl,--whole-archive $(LIBDIR)/libtcl8.6.a -Wl,--no-whole-archive

# ---- Tk ----------------------------------------------------------------
# Stock Tk 8.6 against em-x11's Xlib. Same trick as tcldide: --with-x
# uses real X11/*.h, but no Xlib.so to link against -- libtk.a will
# carry unresolved Xlib symbols, resolved at libtk-so link time by
# libemx11 (or as undefined symbols satisfied by the host JS bridge).
# Disable optional deps tcldide also disables for the first cut.

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
	chmod +x $(CURDIR)/scripts/xft-config
	cd $(BUILD)/tk/unix && \
		PATH="$(CURDIR)/scripts:$$PATH" \
		EMX11_INCLUDES="$(EMX11_INCLUDES)" \
		EMX11_LIBDIR="$(LIBDIR)" \
		ac_cv_lib_Xft_XftFontOpen=yes \
		ac_cv_lib_fontconfig_FcFontSort=no \
		ac_cv_lib_X11_XkbKeycodeToKeysym=yes \
		cross_compiling=yes \
		emconfigure ./configure \
		--host=wasm32-unknown-emscripten \
		--prefix=$(PREFIX) \
		--with-tcl=$(LIBDIR) \
		--x-includes=$(EMX11_INCLUDES) \
		--x-libraries=$(LIBDIR) \
		--disable-threads --disable-load --disable-shared \
		--disable-xss \
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
# em-x11 ships as split archives (libX11.a / libXext.a / libXrender.a /
# libfontconfig.a / libXft.a). The user must build it separately:
#   cd ../em-x11 && pnpm install && pnpm build:native
#
# For our side-module path we need everything in one .so (Pyodide dlopens
# exactly one file), so we --whole-archive all five into a single libemx11.so.
# GLX is excluded -- _tkinter doesn't use OpenGL.

EMX11_ARCHIVES = \
	$(EMX11_DIR)/build/artifacts/libX11.a \
	$(EMX11_DIR)/build/artifacts/libXext.a \
	$(EMX11_DIR)/build/artifacts/libXrender.a \
	$(EMX11_DIR)/build/artifacts/libfontconfig.a \
	$(EMX11_DIR)/build/artifacts/libXft.a

$(LIBDIR)/libemx11.so: $(LIBDIR)/libtcl8.6.so
	@for a in $(EMX11_ARCHIVES); do \
		test -f "$$a" || { \
			echo "ERROR: em-x11 archive not found: $$a"; \
			echo "Run: cd ../em-x11 && pnpm install && pnpm build:native"; \
			exit 1; \
		}; \
	done
	mkdir -p $(LIBDIR)
	cp $(EMX11_ARCHIVES) $(LIBDIR)/
	# Link libtcl8.6.so so it lands on libemx11's NEEDED entry. Pyodide's
	# loadDynlib hard-codes flags=2; the only way our notifier's
	# Tcl_SetNotifier ref resolves at dlopen time is via NEEDED auto-cascade.
	emcc $(SIDE_LDFLAGS) -o $(LIBDIR)/libemx11.so \
		-Wl,--whole-archive \
		$(LIBDIR)/libX11.a \
		$(LIBDIR)/libXext.a \
		$(LIBDIR)/libXrender.a \
		$(LIBDIR)/libfontconfig.a \
		$(LIBDIR)/libXft.a \
		-Wl,--no-whole-archive \
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
		-I $(INCDIR) -I $(INCDIR)/tk \
		--use-port=$(EMX11_PORT) \
		$(CPYTHON_SRC)/_tkinter.c $(CPYTHON_SRC)/tkappinit.c \
		$(LIBDIR)/libtk8.6.so $(LIBDIR)/libtcl8.6.so $(LIBDIR)/libemx11.so \
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
