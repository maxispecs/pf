import readline from 'node:readline';

export type KeyHandler = (str: string | undefined, key: readline.Key) => void;

/**
 * Start reading single keypresses from the terminal (raw mode). Returns a stop function that
 * puts the terminal back. The stop function also runs on process exit, so a crash or
 * `process.exit` never leaves the cursor hidden or the terminal in raw mode.
 * Callers check for a TTY on stdin first.
 */
export function listenKeys(onKey: KeyHandler, hideCursorOn?: NodeJS.WriteStream): () => void {
  const stdin = process.stdin;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stdin.removeListener('keypress', onKey);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    if (hideCursorOn) hideCursorOn.write('\x1b[?25h');
    process.removeListener('exit', stop);
  };
  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  if (hideCursorOn) hideCursorOn.write('\x1b[?25l');
  stdin.on('keypress', onKey);
  process.on('exit', stop);
  return stop;
}
