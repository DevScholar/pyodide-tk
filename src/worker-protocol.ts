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
}

export type WorkerInboundMessage = InitMessage | MouseRelay | KeyRelay;

export interface LogMessage { type: 'log'; line: string; }
export interface ReadyMessage { type: 'ready'; }
export interface ErrorMessage { type: 'error'; message: string; }

export type WorkerOutboundMessage = LogMessage | ReadyMessage | ErrorMessage;
