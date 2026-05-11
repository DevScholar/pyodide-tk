/**
 * pyodide-tk demo harness.
 *
 * Each demo under demos/<name>/ does basically the same thing: stand up
 * a canvas + log, spawn the worker, transfer OffscreenCanvas, relay
 * mouse + keyboard. The only thing that changes between demos is the
 * Python source. So we extract the wiring into runDemo() and let each
 * demo's main.ts shrink to a one-liner.
 *
 * runDemo returns a `DemoHandle` with a `stop()` method. Vite HMR and
 * SPA navigation should call it to terminate the worker and detach the
 * window-level mouse/keyboard listeners; without it, repeated invokes
 * accumulate workers (each pumping Tcl forever) and zombie listeners.
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

export interface DemoHandle {
  /** Terminate the worker and detach all main-thread listeners. Safe to
   *  call more than once. */
  stop(): void;
  /** Underlying worker, exposed for advanced demos that want to post
   *  custom messages. Do not use to add listeners -- they won't be
   *  cleaned up by stop(). */
  worker: Worker;
}

export function runDemo(opts: RunDemoOptions): DemoHandle {
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

  /* AbortController bundles every addEventListener({signal}) call so a
   * single abort() cleans up window-level mouse/key listeners + the
   * canvas listeners + the worker message/error listeners. Without
   * this, HMR-driven re-invokes leak listeners and the old worker
   * keeps pumping Tcl in the background. */
  const ac = new AbortController();
  const { signal } = ac;
  let stopped = false;
  function stop(): void {
    if (stopped) return;
    stopped = true;
    ac.abort();
    worker.terminate();
  }

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
        ime.setFocus(msg.window);
        break;
      case 'imeClearFocus':
        ime.clearFocus();
        break;
      case 'imeSpot':
        /* Window-local caret pixels -- positionHint below carries the
         * root-relative version that the IME actually anchors on, so we
         * don't act on this. Kept in the union for diagnostics; intentionally
         * a no-op. */
        break;
      case 'imePositionHint':
        ime.applyPosition(msg.absX, msg.absY);
        break;
    }
  }, { signal });

  /* worker.onerror catches uncaught throws in the worker script itself
   * (syntax errors, top-level rejections that escape boot's catch,
   * postMessage with a non-cloneable value). Without this, all the
   * user sees is silence; the worker stays alive but does nothing.
   * messageerror covers the rarer case of a structured-clone failure
   * on inbound postMessage. */
  worker.addEventListener('error', (e: ErrorEvent) => {
    note('worker script error:', e.message || e.filename, `(line ${e.lineno})`);
  }, { signal });
  worker.addEventListener('messageerror', () => {
    note('worker messageerror: a postMessage payload failed structured clone');
  }, { signal });

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
    if (stopped) return;
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
  }, { signal });

  // mouseup/mousemove on window so a release outside the canvas during
  // a drag still reaches the C-side implicit grab.
  window.addEventListener('mouseup', (e) => {
    const { x, y } = cssPoint(e);
    send({
      type: 'mouseup', x, y,
      button: e.button + 1,
      modifiers: modifiersFromEvent(e),
    });
  }, { signal });

  window.addEventListener('mousemove', (e) => {
    const { x, y } = cssPoint(e);
    send({
      type: 'mousemove', x, y,
      modifiers: modifiersFromEvent(e),
    });
  }, { signal });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });

  // Keyboard-focusable so KeyboardEvents have a meaningful activeElement.
  canvas.tabIndex = 0;

  window.addEventListener('keydown', (e) => relayKey('keydown', e), { signal });
  window.addEventListener('keyup',   (e) => relayKey('keyup',   e), { signal });

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

  /* Vite HMR: when this module is replaced, tear down the previous run
   * so the new one isn't competing with a leftover worker. import.meta.hot
   * is only present in dev builds. */
  if (import.meta.hot) {
    import.meta.hot.dispose(() => stop());
  }

  note('main: worker spawned, canvas transferred');
  return { stop, worker };
}
