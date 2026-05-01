/**
 * pyodide-tk demo harness.
 *
 * Each demo under demos/<name>/ does basically the same thing: stand up
 * a canvas + log, spawn the worker, transfer OffscreenCanvas, relay
 * mouse + keyboard. The only thing that changes between demos is the
 * Python source. So we extract the wiring into runDemo() and let each
 * demo's main.ts shrink to a one-liner.
 */

import { keyEventToKeysym, modifiersFromEvent } from '@emx11/runtime/keymap.js';
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from './worker-protocol.js';

export interface RunDemoOptions {
  /** Python source executed once after _tkinter loads. Must bind a
   *  module-level `root` referring to a Tk root (`tkinter.Tk()` or e.g.
   *  `turtle.Screen()._root`) — the worker's drain helper references
   *  `root.tk.dooneevent`. */
  pythonCode: string;
  /** id of the <canvas> element the worker should paint into. */
  canvasId?: string;
  /** id of the <div> that receives status / error log lines. */
  logId?: string;
}

export function runDemo(opts: RunDemoOptions): void {
  const canvasId = opts.canvasId ?? 'emx11-canvas';
  const logId = opts.logId ?? 'log';

  const log = document.getElementById(logId);
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
  if (!log) throw new Error(`runDemo: missing #${logId}`);
  if (!canvas) throw new Error(`runDemo: missing #${canvasId}`);
  if (!canvas.transferControlToOffscreen) {
    throw new Error('OffscreenCanvas unsupported -- pyodide-tk requires a modern browser');
  }

  function note(...parts: unknown[]): void {
    const line = parts
      .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
      .join(' ');
    log!.textContent += `\n${line}`;
    // eslint-disable-next-line no-console
    console.log('[pyodide-tk]', ...parts);
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
    demoCode: opts.pythonCode,
  };
  worker.postMessage(initMsg, [surface]);

  // --- input relay --------------------------------------------------------

  function send(msg: WorkerInboundMessage): void {
    worker.postMessage(msg);
  }

  function cssPoint(e: MouseEvent): { x: number; y: number } {
    const rect = canvas!.getBoundingClientRect();
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
  // a drag still reaches the C-side implicit grab.
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

  // Keyboard-focusable so KeyboardEvents have a meaningful activeElement.
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
}
