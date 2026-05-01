"""
turtle-hello: classic turtle graphics — draw a square with the standard
library `turtle` module. Standard turtle code, animation included.

Animation works because the worker runs this via py.runPythonAsync():
turtle's `forward()` ends up calling Tcl `after delay` which em-x11's
browser notifier translates into emscripten_sleep(1). Pyodide 314.x
uses JSPI for stack switching, so that sleep yields the JS event loop,
the browser paints a frame, and Python resumes -- real animation, no
patches to turtle or to Python.

turtle implicitly creates its own Tk root via Screen(); we expose it as
`root` because the worker's drain helper does `root.tk.dooneevent(...)`.
"""

import turtle

screen = turtle.Screen()
screen.title("hello pyodide-tk · turtle")
root = screen._root  # noqa: SLF001 -- intentional: needed by drain helper

t = turtle.Turtle()
t.shape("turtle")
t.pensize(3)
t.color("steelblue")
t.speed(3)

for _ in range(4):
    t.forward(150)
    t.left(90)

t.penup()
t.goto(0, -120)
t.color("crimson")
t.write("hello, pyodide-tk!", align="center", font=("Arial", 16, "bold"))
t.hideturtle()
