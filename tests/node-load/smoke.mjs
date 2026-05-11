// Headless ABI smoke: load all side modules into Pyodide and import _tkinter.
import { loadPyodide } from "pyodide";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

// Locate the staged-assets dir relative to this file rather than a
// fixed /mnt/c/... path. Smoke now runs on any developer machine and
// in CI without edits.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(__dirname, "../../public/pyodide-tk-assets");
const LIBDIR = `${ASSETS}/lib`;

if (!fs.existsSync(LIBDIR)) {
  console.error(`smoke: missing ${LIBDIR}`);
  console.error("Run 'pnpm run stage-assets' from pyodide-tk/ first.");
  process.exit(1);
}

(async () => {
  const py = await loadPyodide({
    env: {
      TCL_LIBRARY: "/usr/lib/tcl8.6",
      TK_LIBRARY:  "/usr/lib/tk8.6",
      DISPLAY:     ":0",
      HOME: "/home/pyodide",
    },
  });
  console.log("pyodide loaded; py.version =", py.version);

  // Stage .so under Pyodide's default LD search path so NEEDED resolution works.
  const LDDIR = "/usr/lib";
  py.FS.mkdirTree(LDDIR);
  py.FS.mkdirTree("/lib/python3.14/site-packages");
  const stage = (hostPath, memPath) => {
    py.FS.writeFile(memPath, fs.readFileSync(hostPath));
  };
  stage(`${LIBDIR}/libtcl8.6.so`, `${LDDIR}/libtcl8.6.so`);
  stage(`${LIBDIR}/libemx11.so`,  `${LDDIR}/libemx11.so`);
  stage(`${LIBDIR}/libtk8.6.so`,  `${LDDIR}/libtk8.6.so`);
  stage(`${LIBDIR}/_tkinter.so`,  "/lib/python3.14/site-packages/_tkinter.so");
  // libwacl is optional (sibling wacl-tk might not be built). Staging it
  // when present keeps smoke aligned with worker.ts's real boot path so
  // ABI drifts in ::wacl::dom / ::wacl::jscall surface here too.
  const libwaclPath = `${LIBDIR}/libwacl.so`;
  const hasWacl = fs.existsSync(libwaclPath);
  if (hasWacl) stage(libwaclPath, `${LDDIR}/libwacl.so`);

  // Script libraries: same tar+unpackArchive path the worker uses (~30x
  // faster than per-file FS.writeFile and exercises the prod load path).
  const unpackTar = (tarPath, extractDir) => {
    py.FS.mkdirTree(extractDir);
    // Pyodide's unpackArchive wants an ArrayBuffer / Uint8Array, not a
    // Node Buffer ("Unknown typed array type 'Buffer'"). Take a slice
    // of the underlying ArrayBuffer.
    const buf = fs.readFileSync(tarPath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    py.unpackArchive(ab, "tar", { extractDir });
  };
  unpackTar(`${ASSETS}/tcl-library.tar`, "/usr/lib/tcl8.6");
  unpackTar(`${ASSETS}/tk-library.tar`,  "/usr/lib/tk8.6");
  unpackTar(`${ASSETS}/tkinter.tar`,     "/lib/python3.14/site-packages/tkinter");

  // libemx11 is the bridge entry point -- nothing else NEEDs it, so load
  // manually. Loading it pulls libtcl via NEEDED. _tkinter then pulls
  // libtk via NEEDED, and libtk's Xlib refs resolve against libemx11.
  const order = [
    [`${LDDIR}/libemx11.so`,                       { global: true, allowUndefined: true }],
    ["/lib/python3.14/site-packages/_tkinter.so",  { global: false, allowUndefined: true }],
  ];
  if (hasWacl) {
    order.push([`${LDDIR}/libwacl.so`, { global: true, allowUndefined: true }]);
  }
  for (const [p, opts] of order) {
    process.stdout.write(`loadDynlib ${path.basename(p)} ... `);
    try {
      await py._api.loadDynlib(p, opts);
      console.log("ok");
    } catch (e) {
      console.log("FAIL");
      console.error(e);
      process.exit(1);
    }
  }

  console.log("\n--- import _tkinter ---");
  py.runPython(`
import _tkinter
print("TCL_VERSION:", _tkinter.TCL_VERSION)
print("TK_VERSION :", _tkinter.TK_VERSION)
`);

  console.log("\n--- Tcl interp only (no Tk yet) ---");
  py.runPython(`
import _tkinter
app = _tkinter.create(None, "py", "Tk", 0, 1, 0, 0, None)
print("Tcl interp created:", app)
print("eval expr {2+3} =", app.eval("expr {2+3}"))
`);

  console.log("\n--- import tkinter (Python wrapper) ---");
  py.runPython(`
import tkinter
root = tkinter.Tk()
root.title("smoke test")
print("title set ->", root.title())
`);

  console.log("\n--- create + pack widgets ---");
  py.runPython(`
import tkinter
root = tkinter.Tk()
lbl = tkinter.Label(root, text="hello pyodide tk")
lbl.pack()
btn = tkinter.Button(root, text="click me")
btn.pack()
print("widget tree:", root.winfo_children())
root.update_idletasks()
print("update_idletasks OK")
`);

  console.log("\nSMOKE DONE");
})();
