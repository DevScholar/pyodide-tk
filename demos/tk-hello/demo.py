"""
tk-hello: minimal Tk widgets — Label + Button with a -command callback.

Demonstrates the basic plumbing: tkinter.Tk(), pack geometry, and that
button -command callbacks correctly re-enter Python through em-x11's
Tcl notifier + GIL-safe dooneevent path.
"""

import tkinter

root = tkinter.Tk()
root.title("hello pyodide-tk")

tkinter.Label(root, text="hello, pyodide-tk!").pack()

b = tkinter.Button(root, text="click me")
def clicked(*_):
    print("button clicked!")
    b.config(text="clicked!")
b.config(command=clicked)
b.pack()

root.update_idletasks()
