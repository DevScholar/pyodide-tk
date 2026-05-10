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
import { createDomTextInputBridge } from '@emx11/index.js';
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from './worker-protocol.js';

export interface RunDemoOptions {
  /** Python source executed once after _tkinter loads. Standard desktop
   *  tkinter / turtle code -- typically ending in `root.mainloop()` or
   *  `turtle.done()`. The worker's drain helper looks at
   *  `tkinter._default_root`, so the demo doesn't need to expose anything. */
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

  /* IME bridge: the worker runs em-x11 in a realm without a DOM, so
   * XSetICFocus / Tk_SetCaretPos can't anchor an OS IME by themselves.
   * Main owns a hidden <textarea>; the worker posts setFocus/setSpot/
   * positionHint over and we apply them here. Composed / pasted text
   * goes the other way as a `textKey` message the worker forwards to
   * emX11.display.inject.textKey. */
  const ime = createDomTextInputBridge({
    canvas,
    rootWidth: canvas.width,
    rootHeight: canvas.height,
    onText: (text) => send({ type: 'textKey', text }),
  });

  worker.addEventListener('message', (ev: MessageEvent<WorkerOutboundMessage>) => {
    const msg = ev.data;
    switch (msg.type) {
      case 'log': note(msg.line); break;
      case 'ready': note('worker ready'); break;
      case 'error': note('worker ERROR:', msg.message); break;
      case 'imeFocus':
        if (typeof msg.window === 'number') {
          // eslint-disable-next-line no-console
          console.log('[ime] focus window=', msg.window);
          ime.setFocus(msg.window);
        }
        break;
      case 'imeClearFocus':
        // eslint-disable-next-line no-console
        console.log('[ime] clear focus');
        ime.clearFocus();
        break;
      case 'imeSpot':
        // eslint-disable-next-line no-console
        console.log('[ime] spot window=', msg.window, 'local=', msg.spotX, msg.spotY);
        break;
      case 'imePositionHint':
        if (typeof msg.absX === 'number' && typeof msg.absY === 'number') {
          // eslint-disable-next-line no-console
          console.log('[ime] positionHint abs=', msg.absX, msg.absY);
          ime.applyPosition(msg.absX, msg.absY);
        }
        break;
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
    /* Either the canvas itself or the IME bridge's hidden textarea
     * counts as "focused on the X surface" for keyboard routing. The
     * textarea steals DOM focus only while a Tk entry/text widget is
     * focused (XSetICFocus -> imeFocus), which is exactly when we
     * want to keep delivering keys to the worker. */
    const active = document.activeElement;
    const hasFocus = active === canvas || (active instanceof HTMLTextAreaElement);
    if (hasFocus) e.preventDefault();
    /* IME composition: KeyboardEvent during composition carries
     * key='Process' / isComposing=true. The composed bytes arrive
     * later via the textarea's compositionend handler in the IME
     * bridge -> 'textKey' message, so drop the noisy keydown here. */
    if (e.isComposing || e.key === 'Process') return;
    /* event.key already reflects keyboard layout + Shift state ('a' vs
     * 'A'). Multi-codepoint keys (rare: "FunctionMenuItem", emoji
     * shortcuts) drop their text -- the keysym path stays. Mirrors
     * em-x11's main-thread keyboard handler in host/devices.ts. */
    const text = e.key.length === 1 ? e.key : '';
    send({ type, keysym, modifiers: modifiersFromEvent(e), hasFocus, text });
  }

  note('main: worker spawned, canvas transferred');
}
