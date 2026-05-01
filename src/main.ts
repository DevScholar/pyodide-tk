/**
 * pyodide-tk main thread.
 *
 * Owns the DOM: spawns the worker, transfers canvas control via
 * OffscreenCanvas, and relays mouse/keyboard events. The worker does
 * everything else (Pyodide, Tk, em-x11 host, event pump). See
 * src/worker.ts.
 */

import { keyEventToKeysym, modifiersFromEvent } from '@emx11/runtime/keymap.js';
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from './worker-protocol.js';

const log = document.getElementById('log')!;
function note(...parts: unknown[]): void {
  const line = parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ');
  log.textContent += `\n${line}`;
  // eslint-disable-next-line no-console
  console.log('[pyodide-tk]', ...parts);
}

const canvas = document.getElementById('emx11-canvas') as HTMLCanvasElement;

if (!canvas.transferControlToOffscreen) {
  throw new Error('OffscreenCanvas unsupported -- pyodide-tk requires a modern browser');
}

const surface = canvas.transferControlToOffscreen();

const worker = new Worker(new URL('./worker.ts', import.meta.url), {
  type: 'module',
  name: 'pyodide-tk',
});

worker.addEventListener('message', (ev: MessageEvent<WorkerOutboundMessage>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'log': note(msg.line); break;
    case 'ready': note('worker ready'); break;
    case 'error': note('worker ERROR:', msg.message); break;
  }
});

const initMsg: WorkerInboundMessage = {
  type: 'init',
  surface,
  width: canvas.width,
  height: canvas.height,
  demoCode: `
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
`,
};
worker.postMessage(initMsg, [surface]);

// --- input relay ----------------------------------------------------------

function send(msg: WorkerInboundMessage): void {
  worker.postMessage(msg);
}

function cssPoint(e: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: (e.clientX - rect.left) | 0, y: (e.clientY - rect.top) | 0 };
}

canvas.addEventListener('mousedown', (e) => {
  canvas.focus();
  const { x, y } = cssPoint(e);
  send({
    type: 'mousedown', x, y,
    button: e.button + 1,
    modifiers: modifiersFromEvent(e),
  });
});

// mouseup/mousemove on window so a release outside the canvas during
// a drag still reaches the C-side implicit grab (mirrors the in-process
// path's `window.addEventListener` choice).
window.addEventListener('mouseup', (e) => {
  const { x, y } = cssPoint(e);
  send({
    type: 'mouseup', x, y,
    button: e.button + 1,
    modifiers: modifiersFromEvent(e),
  });
});

window.addEventListener('mousemove', (e) => {
  const { x, y } = cssPoint(e);
  send({
    type: 'mousemove', x, y, button: 0,
    modifiers: modifiersFromEvent(e),
  });
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Make canvas keyboard-focusable so KeyboardEvents have a meaningful
// activeElement check.
canvas.tabIndex = 0;

window.addEventListener('keydown', (e) => relayKey('keydown', e));
window.addEventListener('keyup',   (e) => relayKey('keyup',   e));

function relayKey(type: 'keydown' | 'keyup', e: KeyboardEvent): void {
  const keysym = keyEventToKeysym(e);
  if (keysym === 0) return;
  const hasFocus = document.activeElement === canvas;
  if (hasFocus) e.preventDefault();
  send({ type, keysym, modifiers: modifiersFromEvent(e), hasFocus });
}

note('main: worker spawned, canvas transferred');
