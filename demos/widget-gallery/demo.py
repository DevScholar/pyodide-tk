import tkinter as tk
from tkinter import ttk
import sys

root = tk.Tk()
root.title("Tk Widget Gallery")
root.geometry("740x560")

# --- Main notebook ---
nb = ttk.Notebook(root)
nb.pack(fill="both", expand=1, padx=8, pady=(8, 0))

# ====================================================================
# Tab 1 — Buttons
# ====================================================================
f = ttk.Frame(nb)
nb.add(f, text="Buttons")

# Button
tk.Label(f, text="Button", font=("Helvetica", 10, "bold")).pack(padx=14, pady=(10, 2), anchor="w")

brow = tk.Frame(f)
tk.Button(brow, text="Normal", command=lambda: print("Normal button clicked")).pack(side="left", padx=3)
tk.Button(brow, text="Disabled", state="disabled").pack(side="left", padx=3)
tk.Button(brow, text="Close", command=root.destroy).pack(side="left", padx=3)
brow.pack(padx=14, anchor="w")

# Checkbutton
tk.Label(f, text="Checkbutton", font=("Helvetica", 10, "bold")).pack(padx=14, pady=(14, 2), anchor="w")

chk_a = tk.IntVar(value=1)
chk_b = tk.IntVar(value=0)
tk.Checkbutton(f, text="Checked by default", variable=chk_a).pack(padx=14, anchor="w", pady=1)
tk.Checkbutton(f, text="Unchecked", variable=chk_b).pack(padx=14, anchor="w", pady=1)
tk.Checkbutton(f, text="Disabled", state="disabled").pack(padx=14, anchor="w", pady=1)

# Radiobutton
tk.Label(f, text="Radiobutton", font=("Helvetica", 10, "bold")).pack(padx=14, pady=(14, 2), anchor="w")

rset = tk.Frame(f)
lang = tk.StringVar(value="tcl")
tk.Radiobutton(rset, text="Tcl", variable=lang, value="tcl").pack(side="left", padx=6)
tk.Radiobutton(rset, text="Python", variable=lang, value="python").pack(side="left", padx=6)
tk.Radiobutton(rset, text="Rust", variable=lang, value="rust").pack(side="left", padx=6)
rset.pack(padx=14, anchor="w")

tk.Label(f, textvariable=lang, relief="sunken", width=10, anchor="center").pack(padx=14, pady=4, anchor="w")

# Menubutton
tk.Label(f, text="Menubutton", font=("Helvetica", 10, "bold")).pack(padx=14, pady=(14, 2), anchor="w")

mb = tk.Menubutton(f, text="File ▾", relief="raised")
menu = tk.Menu(mb, tearoff=0)
menu.add_command(label="New", command=lambda: print("File > New"))
menu.add_command(label="Open", command=lambda: print("File > Open"))
menu.add_separator()
autosave = tk.IntVar(value=0)
menu.add_checkbutton(label="Auto-save", variable=autosave)
menu.add_separator()
menu.add_command(label="Quit", command=root.destroy)
mb.configure(menu=menu)
mb.pack(padx=14, pady=4, anchor="w")

# ====================================================================
# Tab 2 — Text & Entry
# ====================================================================
f = ttk.Frame(nb)
nb.add(f, text="Text & Entry")

# Label
tk.Label(f, text="Label", font=("Helvetica", 10, "bold")).pack(padx=14, pady=(10, 2), anchor="w")
tk.Label(f, text="A read-only label with groove border",
         relief="groove", bd=1, padx=10, pady=4).pack(padx=14, anchor="w")

# Entry
tk.Label(f, text="Entry", font=("Helvetica", 10, "bold")).pack(padx=14, pady=(14, 2), anchor="w")

er1 = tk.Frame(f)
tk.Label(er1, text="Name:", width=9, anchor="e").pack(side="left", padx=3)
e1 = tk.Entry(er1, width=26)
e1.insert(0, "Type your name...")
e1.pack(side="left", padx=3)
er1.pack(padx=14, anchor="w")

er2 = tk.Frame(f)
tk.Label(er2, text="Password:", width=9, anchor="e").pack(side="left", padx=3)
e2 = tk.Entry(er2, width=26, show="*")
e2.insert(0, "secret")
e2.pack(side="left", padx=3)
er2.pack(padx=14, anchor="w", pady=3)

# Spinbox
tk.Label(f, text="Spinbox", font=("Helvetica", 10, "bold")).pack(padx=14, pady=(14, 2), anchor="w")

sr = tk.Frame(f)
tk.Label(sr, text="Value:", width=9, anchor="e").pack(side="left", padx=3)
spval = tk.StringVar(value="42")
tk.Spinbox(sr, from_=0, to=100, increment=5, width=6, textvariable=spval).pack(side="left", padx=3)
sr.pack(padx=14, anchor="w")

# Text widget
tk.Label(f, text="Text", font=("Helvetica", 10, "bold")).pack(padx=14, pady=(14, 2), anchor="w")

txt = tk.Text(f, width=48, height=8, wrap="word", padx=6, pady=4)
txt.insert("1.0", """Multi-line text widget.

You can select, copy, and type here.
- Bullet one
- Bullet two
- Bullet three

Tab stops every 4 characters.""")
txt.pack(padx=14, pady=2)

# ====================================================================
# Tab 3 — Selection
# ====================================================================
f = ttk.Frame(nb)
nb.add(f, text="Selection")

# --- Left panel: scrollable widget list ---
left = tk.Frame(f, width=340)
left.pack(side="left", fill="both", expand=1)

c = tk.Canvas(left, yscrollcommand=lambda *a: sb.set(*a), width=320, highlightthickness=0)
sb = tk.Scrollbar(left, command=c.yview)
sb.pack(side="right", fill="y")
c.pack(side="left", fill="both", expand=1)

inner = tk.Frame(c)
c.create_window(0, 0, window=inner, anchor="nw", tags="inner")
inner.bind("<Configure>", lambda e: c.configure(scrollregion=c.bbox("inner")))

# Listbox
tk.Label(inner, text="Listbox", font=("Helvetica", 10, "bold")).pack(padx=10, pady=(8, 2), anchor="w")

lr = tk.Frame(inner)
lb = tk.Listbox(lr, width=18, height=6, exportselection=False)
for item in ["Apple", "Banana", "Cherry", "Date", "Elderberry", "Fig", "Grape", "Kiwi"]:
    lb.insert("end", item)
lb.selection_set(0)
sb2 = tk.Scrollbar(lr, command=lb.yview)
lb.configure(yscrollcommand=sb2.set)
lb.pack(side="left", fill="y")
sb2.pack(side="left", fill="y")
lr.pack(padx=10, anchor="w")

# Combobox
tk.Label(inner, text="Combobox (ttk)", font=("Helvetica", 10, "bold")).pack(padx=10, pady=(12, 2), anchor="w")

cb = ttk.Combobox(inner, values=["One", "Two", "Three", "Four", "Five", "Six"], state="readonly", width=16)
cb.current(0)
cb.pack(padx=10, anchor="w")

# Scale
tk.Label(inner, text="Scale", font=("Helvetica", 10, "bold")).pack(padx=10, pady=(12, 2), anchor="w")

scr = tk.Frame(inner)
scl = tk.IntVar(value=50)
tk.Scale(scr, from_=0, to=100, orient="horizontal", length=240, variable=scl, showvalue=1).pack(side="left")
scr.pack(padx=10, anchor="w")

# Progressbar
tk.Label(inner, text="Progressbar (ttk)", font=("Helvetica", 10, "bold")).pack(padx=10, pady=(12, 2), anchor="w")

pval = tk.IntVar(value=70)
pb = ttk.Progressbar(inner, length=260, mode="determinate", variable=pval)
pb.pack(padx=10, anchor="w", pady=2)

pctl = tk.Frame(inner)
tk.Button(pctl, text=" -10 ", command=lambda: pval.set(pval.get() - 10) if pval.get() >= 10 else None).pack(side="left", padx=2)
tk.Button(pctl, text=" +10 ", command=lambda: pval.set(pval.get() + 10) if pval.get() <= 90 else None).pack(side="left", padx=2)
tk.Button(pctl, text="  0  ", command=lambda: pval.set(0)).pack(side="left", padx=2)
tk.Button(pctl, text=" 100 ", command=lambda: pval.set(100)).pack(side="left", padx=2)
pctl.pack(padx=10, anchor="w", pady=4)

# --- Right panel: Treeview ---
right = tk.Frame(f)
right.pack(side="left", fill="both", expand=1, padx=(4, 0))

tk.Label(right, text="Treeview (ttk)", font=("Helvetica", 10, "bold")).pack(pady=(8, 2), anchor="w")

tv = ttk.Treeview(right, columns=("size", "kind"), show="tree headings", height=16)
tv.heading("#0", text="Name")
tv.heading("size", text="Size")
tv.heading("kind", text="Kind")
tv.column("#0", width=150)
tv.column("size", width=60, anchor="e")
tv.column("kind", width=70, anchor="center")

proj = tv.insert("", "end", text="project/", values=("--", "folder"), open=True)
src = tv.insert(proj, "end", text="src/", values=("--", "folder"))
tv.insert(src, "end", text="main.tcl", values=("3.2K", "file"))
tv.insert(src, "end", text="utils.tcl", values=("1.8K", "file"))
img = tv.insert(proj, "end", text="img/", values=("--", "folder"))
tv.insert(img, "end", text="logo.png", values=("24K", "image"))
tv.insert(img, "end", text="icon.gif", values=("8K", "image"))
tv.insert(proj, "end", text="README.md", values=("1.5K", "doc"))
tv.insert(proj, "end", text="Makefile", values=("0.6K", "build"))

sb3 = tk.Scrollbar(right, command=tv.yview)
tv.configure(yscrollcommand=sb3.set)
tv.pack(side="left", fill="both", expand=1)
sb3.pack(side="right", fill="y")

# ====================================================================
# Tab 4 — Containers
# ====================================================================
f = ttk.Frame(nb)
nb.add(f, text="Containers")

# Labelframe
tk.Label(f, text="Labelframe", font=("Helvetica", 10, "bold")).pack(padx=14, pady=(10, 2), anchor="w")

lf = tk.LabelFrame(f, text="Preferences", padx=10, pady=6)
feat_x = tk.IntVar(value=1)
feat_y = tk.IntVar(value=0)
tk.Checkbutton(lf, text="Enable feature X", variable=feat_x).pack(anchor="w", pady=1)
tk.Checkbutton(lf, text="Enable feature Y", variable=feat_y).pack(anchor="w", pady=1)
lf.pack(padx=14, pady=4, fill="x")

# Panedwindow (ttk)
tk.Label(f, text="Panedwindow (ttk)", font=("Helvetica", 10, "bold")).pack(padx=14, pady=(14, 2), anchor="w")

pw = ttk.Panedwindow(f, orient="vertical")
pw.configure(height=150)

topf = tk.Frame(pw, bg="#d0e4f7", height=60)
botf = tk.Frame(pw, bg="#f7d4c8", height=60)
tk.Label(topf, text="Top pane — drag the sash below to resize", bg="#d0e4f7", pady=10).pack(expand=1)
tk.Label(botf, text="Bottom pane — also resizable", bg="#f7d4c8", pady=10).pack(expand=1)
pw.add(topf, weight=1)
pw.add(botf, weight=1)
pw.pack(padx=14, pady=4, fill="x")

# ====================================================================
# Tab 5 — Canvas
# ====================================================================
f = ttk.Frame(nb)
nb.add(f, text="Canvas")

tk.Label(f, text="Canvas drawing primitives", font=("Helvetica", 10, "bold")).pack(padx=14, pady=(10, 4), anchor="w")

canvas = tk.Canvas(f, width=420, height=260, bg="white", relief="sunken", bd=1)

# Rectangle with text
canvas.create_rectangle(20, 20, 140, 80, fill="#4a90d9", outline="#1a3a5c", width=2)
canvas.create_text(80, 50, text="Rectangle", fill="white", font=("Helvetica", 10, "bold"))

# Oval
canvas.create_oval(180, 20, 300, 80, fill="#e85d75", outline="#8b1a2b", width=2)
canvas.create_text(240, 50, text="Oval", fill="white", font=("Helvetica", 10, "bold"))

# Lines (axis-like)
canvas.create_line(20, 120, 320, 120, fill="#333", width=4)
canvas.create_line(20, 118, 20, 180, fill="#333", width=4)
canvas.create_text(40, 140, text="Lines", fill="#555", font=("Helvetica", 10), anchor="w")

# Polygon (pentagon-ish)
canvas.create_polygon(230, 200, 290, 150, 350, 180, 330, 230, 250, 230,
                      fill="#50c878", outline="#1a5c30", width=2)
canvas.create_text(290, 195, text="Polygon", fill="white", font=("Helvetica", 9, "bold"))

# Arc
canvas.create_arc(30, 160, 130, 240, start=30, extent=270, style="arc",
                  outline="#9370db", width=3)
canvas.create_text(80, 210, text="Arc", fill="#9370db", font=("Helvetica", 10))

# Canvas text
canvas.create_text(380, 40, text="Canvas\nText", fill="#e67e22",
                   font=("Helvetica", 12, "bold"), justify="center")

canvas.pack(padx=14, pady=4)

# ====================================================================
# Status bar
# ====================================================================
status = tk.Frame(root, relief="sunken", bd=1, height=24)
tk.Label(status, text=f" Tk {tk.TkVersion:.1f}  |  {sys.platform}",
         anchor="w", pady=2).pack(fill="x")
status.pack(fill="x", padx=8, pady=6)

print("Widget Gallery ready.")
root.mainloop()
