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

import { keyEventToKeysym, keyEventToKeycode, modifiersFromEvent } from '@emx11/runtime/keymap.js';
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
      case 'clipboardWrite': {
        /* Tk copied bytes via XSetSelectionOwner(CLIPBOARD); libemx11's
         * write bridge forwarded them here because the worker can't
         * reliably call navigator.clipboard.writeText. The DOM main
         * thread holds the permission. */
        const text = new TextDecoder('utf-8').decode(msg.bytes);
        navigator.clipboard?.writeText(text).catch((err) => {
          note('clipboard write failed:', String(err));
        });
        break;
      }
      case 'cursorChange':
        canvas.style.cursor = msg.css;
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
    /* Scale CSS coords back into the canvas's internal coordinate
     * space. The shared style.css renders #emx11-canvas at a fixed
     * 1024x768 CSS box regardless of the canvas's `width`/`height`
     * attributes, so a demo with a 640x360 backing buffer gets its
     * clicks landing at the wrong widget without this transform.
     * Guard against zero-size rects (collapsed layout during HMR). */
    const sx = rect.width > 0 ? canvas!.width / rect.width : 1;
    const sy = rect.height > 0 ? canvas!.height / rect.height : 1;
    return {
      x: ((e.clientX - rect.left) * sx) | 0,
      y: ((e.clientY - rect.top) * sy) | 0,
    };
  }

  canvas.addEventListener('mousedown', (e) => {
    /* If the IME bridge's hidden textarea currently holds DOM focus,
     * the OS IME has anchored its per-element state (Chinese mode,
     * candidate window) to it. Browser default mousedown would focus
     * the canvas (tabIndex=0), blurring the textarea -- and on Windows
     * a subsequent .focus() restores DOM focus but resets the IME to
     * default English. preventDefault keeps the textarea focused so
     * the second click on the same Tk Entry/Text widget preserves IME
     * state. Otherwise focus the canvas as before so plain key routing
     * works for non-text demos. */
    if (document.activeElement instanceof HTMLTextAreaElement) {
      e.preventDefault();
    } else {
      canvas.focus();
    }
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

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { x, y } = cssPoint(e);
    send({
      type: 'wheel', x, y,
      deltaY: (e as WheelEvent).deltaY,
      modifiers: modifiersFromEvent(e),
    });
  }, { signal, passive: false });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });

  // Keyboard-focusable so KeyboardEvents have a meaningful activeElement.
  canvas.tabIndex = 0;

  window.addEventListener('keydown', (e) => relayKey('keydown', e), { signal });
  window.addEventListener('keyup',   (e) => relayKey('keyup',   e), { signal });

  /* Clipboard read staging: ahead of every paste-equivalent gesture
   * (Ctrl+V / Cmd+V / Shift+Insert keydown, or a document `paste`),
   * fetch the OS clipboard bytes on the main thread (where the
   * navigator.clipboard permission lives) and post them to the worker
   * BEFORE the keydown forwards. libemx11's
   * emx11_js_clipboard_read_begin / _fetch in the worker realm then
   * find data when Tk's XConvertSelection synchronously asks for it.
   *
   * Document `paste` carries the bytes inline via ClipboardEvent
   * (no permission prompt), so we forward those whenever they fire.
   * Ctrl+V via keydown needs an async readText(); we forward the
   * key only after the stage message has been queued so the order
   * is preserved by the worker's message handler. */
  document.addEventListener('paste', (ev) => {
    const text = (ev as ClipboardEvent).clipboardData?.getData('text/plain');
    if (typeof text === 'string') {
      worker.postMessage({
        type: 'clipboardStage',
        bytes: new TextEncoder().encode(text),
      });
    }
  }, { signal });

  function relayKey(type: 'keydown' | 'keyup', e: KeyboardEvent): void {
    const keysym = keyEventToKeysym(e);
    const keycode = keyEventToKeycode(e);
    if (keysym === 0 && keycode === 0) return;
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
    /* Ctrl+V / Cmd+V / Shift+Insert: stage the clipboard bytes into
     * the worker BEFORE relaying the keydown. async readText() means
     * we have to defer the key forward; Tk processes the paste on its
     * next pump tick by which point the stage message is in the
     * worker queue ahead of the keydown. The dispatch fires
     * unconditionally on resolve OR reject so a denied permission
     * doesn't swallow the keystroke. Mirrors the main-thread DOM
     * path in em-x11/src/host/devices.ts. */
    if (type === 'keydown' && hasFocus && isPasteCombo(e) &&
        navigator.clipboard?.readText) {
      void navigator.clipboard.readText()
        .then((clip) => {
          worker.postMessage({
            type: 'clipboardStage',
            bytes: new TextEncoder().encode(clip),
          });
        })
        .catch(() => { /* permission denied -- no stage, key still goes */ })
        .finally(() => {
          send({ type, keysym, keycode, modifiers: modifiersFromEvent(e), hasFocus, text });
        });
      return;
    }
    send({ type, keysym, keycode, modifiers: modifiersFromEvent(e), hasFocus, text });
  }

  /** Ctrl+V / Cmd+V / Shift+Insert detector. KeyboardEvent.code is
   *  layout-independent for the V key; we accept either ctrl OR meta
   *  to cover Linux/Windows/macOS conventions. Mirrors the helper of
   *  the same name in em-x11/src/host/devices.ts. */
  function isPasteCombo(e: KeyboardEvent): boolean {
    if (e.code === 'KeyV' && (e.ctrlKey || e.metaKey)) return true;
    if (e.code === 'Insert' && e.shiftKey) return true;
    return false;
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
