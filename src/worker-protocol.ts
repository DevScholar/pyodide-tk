/**
 * Wire protocol between pyodide-tk's main thread and worker. All event
 * data is canvas-local and pre-translated -- the worker never has to
 * compute getBoundingClientRect or look up keysyms; main does that
 * before posting.
 */

export interface InitMessage {
  type: 'init';
  surface: OffscreenCanvas;
  width: number;
  height: number;
  /** Python source executed once after _tkinter loads. The worker's
   *  drain helper looks at `tkinter._default_root`, so the demo doesn't
   *  need to expose anything -- a plain `tkinter.Tk()` is enough. */
  demoCode: string;
}

/* --- Mouse relay: main → worker ---
 *
 * Discriminated by `type` so TS guarantees `button` only exists where
 * it's meaningful (down/up). A previous flat shape carried `button: 0`
 * on moves; the worker never used it but downstream consumers had to
 * remember that convention. The union also lets us drop the
 * `m.type === 'mousemove'` else-branch having to spell out an absent
 * button.
 */
export interface MouseDownRelay {
  type: 'mousedown';
  x: number;
  y: number;
  button: number;
  modifiers: number;
}
export interface MouseUpRelay {
  type: 'mouseup';
  x: number;
  y: number;
  button: number;
  modifiers: number;
}
export interface MouseMoveRelay {
  type: 'mousemove';
  x: number;
  y: number;
  modifiers: number;
}
export type MouseRelay = MouseDownRelay | MouseUpRelay | MouseMoveRelay;

export interface KeyRelay {
  type: 'keydown' | 'keyup';
  keysym: number;
  modifiers: number;
  hasFocus: boolean;
  /** UTF-8 string the browser produced for this key (KeyboardEvent.key
   *  when length === 1). Empty for non-printable keys, modifiers, and
   *  multi-codepoint keys. Forwarded to em-x11's pushKey so
   *  Xutf8LookupString returns the typed bytes. */
  text: string;
}

/** main → worker: composed/pasted text from the main-thread textarea
 *  bridge. Worker passes it to emX11.display.inject.textKey, which
 *  fires a synthetic KeyPress/KeyRelease pair carrying the bytes. */
export interface TextKeyRelay {
  type: 'textKey';
  text: string;
}

/* --- IME control: worker → main ---
 *
 * XSetICFocus / Tk_SetCaretPos commands the worker's TextInputOverlay
 * generates; main applies them to the hidden <textarea> so the OS IME
 * anchors near the X widget caret.
 *
 * Each tag carries only its own fields so demo-harness can drop the
 * `typeof msg.window === 'number'` guards that the previous
 * everything-optional shape required.
 *
 * positionHint carries root-relative caret pixels precomputed by the
 * host (window-tree origin + window-local spot). Main converts that
 * into viewport CSS pixels using the canvas's getBoundingClientRect.
 */
export interface ImeFocusMessage {
  type: 'imeFocus';
  window: number;
}
export interface ImeClearFocusMessage {
  type: 'imeClearFocus';
}
export interface ImeSpotMessage {
  type: 'imeSpot';
  window: number;
  /** Window-local X11 caret pixels. Kept for diagnostics; main mostly
   *  acts on positionHint instead. */
  spotX: number;
  spotY: number;
}
export interface ImePositionHintMessage {
  type: 'imePositionHint';
  absX: number;
  absY: number;
}
export type ImeControlMessage =
  | ImeFocusMessage
  | ImeClearFocusMessage
  | ImeSpotMessage
  | ImePositionHintMessage;

export type WorkerInboundMessage = InitMessage | MouseRelay | KeyRelay | TextKeyRelay;

export interface LogMessage { type: 'log'; line: string; }
export interface ReadyMessage { type: 'ready'; }
export interface ErrorMessage { type: 'error'; message: string; }

export type WorkerOutboundMessage =
  | LogMessage
  | ReadyMessage
  | ErrorMessage
  | ImeControlMessage;
