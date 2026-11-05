import readline from 'node:readline';

export type KeyHandler = (str: string | undefined, key: readline.Key) => void;

/**
 * Start reading single keypresses from the terminal (raw mode). Returns a stop function that
 * puts the terminal back. The stop function also runs on process exit, so a crash or
 * `process.exit` never leaves the cursor hidden or the terminal in raw mode.
 * Callers check for a TTY on stdin first.
 *
 * A lone esc byte is delivered at once. Node's keypress decoder waits about half a second after
 * esc in case it starts an arrow-key sequence, which makes a single esc feel stuck, so a chunk
 * that is exactly `\x1b` is reported here and the decoder's late duplicate is dropped.
 */
export function listenKeys(onKey: KeyHandler, hideCursorOn?: NodeJS.WriteStream): () => void {
  const stdin = process.stdin;
  let stopped = false;
  const onKeypress: KeyHandler = (str, key) => {
    if (key?.name === 'escape' && key.sequence === '\x1b' && !key.ctrl && !key.meta) return;
    onKey(str, key);
  };
  const onData = (chunk: Buffer | string) => {
    if (String(chunk) === '\x1b') onKey('\x1b', { name: 'escape', sequence: '\x1b', ctrl: false, meta: false, shift: false });
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stdin.removeListener('keypress', onKeypress);
    stdin.removeListener('data', onData);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    if (hideCursorOn) hideCursorOn.write('\x1b[?25h');
    process.removeListener('exit', stop);
  };
  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  if (hideCursorOn) hideCursorOn.write('\x1b[?25l');
  stdin.on('keypress', onKeypress);
  stdin.on('data', onData);
  process.on('exit', stop);
  return stop;
}
