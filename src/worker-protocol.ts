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
  /** Python source executed once after _tkinter loads. Must bind a
   *  module-level `root = tkinter.Tk()` -- the worker's drain helper
   *  references it. */
  demoCode: string;
}

export interface MouseRelay {
  type: 'mousedown' | 'mouseup' | 'mousemove';
  x: number;
  y: number;
  button: number;     // X11 button code (1/2/3); 0 for move
  modifiers: number;  // X11 modifier mask
}

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

/** worker → main: XSetICFocus / Tk_SetCaretPos commands the worker's
 *  TextInputOverlay generates. Main applies them to the hidden
 *  <textarea> so the OS IME anchors near the X widget caret.
 *
 *  positionHint carries root-relative caret pixels precomputed by the
 *  host (window-tree origin + window-local spot). Main converts that
 *  into viewport CSS pixels using the canvas's getBoundingClientRect. */
export interface ImeControlMessage {
  type: 'imeFocus' | 'imeClearFocus' | 'imeSpot' | 'imePositionHint';
  /** imeFocus / imeSpot only. */
  window?: number;
  /** imeSpot: window-local X11 caret pixels (we keep them around for
   *  diagnostics; main mostly cares about positionHint). */
  spotX?: number;
  spotY?: number;
  /** imePositionHint: root-relative absolute caret pixels. */
  absX?: number;
  absY?: number;
}

export type WorkerInboundMessage = InitMessage | MouseRelay | KeyRelay | TextKeyRelay;

export interface LogMessage { type: 'log'; line: string; }
export interface ReadyMessage { type: 'ready'; }
export interface ErrorMessage { type: 'error'; message: string; }

export type WorkerOutboundMessage =
  | LogMessage
  | ReadyMessage
  | ErrorMessage
  | ImeControlMessage;
