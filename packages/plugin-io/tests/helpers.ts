import os from 'node:os';
import { buildContext } from '@pulpfixer/kit/context';
import { clearIoAdapters, registerIoAdapters, type AnyIoAdapter, type IoSink, type IoSource, type Row } from '@pulpfixer/kit/io';
import { memoryAdapter } from '../src/adapters/memory.js';
import { stdoutAdapter } from '../src/adapters/stdout.js';

export const ctx = () => buildContext(os.tmpdir());

/** Only the built-in adapters of plugin-io, plus any given. */
export function freshAdapters(...extra: AnyIoAdapter[]): void {
  clearIoAdapters();
  registerIoAdapters([memoryAdapter, stdoutAdapter, ...extra], 'built in');
}

export const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `n${i + 1}` }));

/** A source over these batches that records whether it was closed. */
export function fakeSource(batches: Row[][]): IoSource & { closed: boolean } {
  const s = {
    closed: false,
    batches: () =>
      (async function* () {
        for (const b of batches) yield b;
      })(),
    close: async () => void (s.closed = true),
  };
  return s;
}

/** A sink that records writes and how it was closed. */
export function fakeSink(): IoSink & { written: Row[][]; closedWith: boolean | null } {
  const s = {
    written: [] as Row[][],
    closedWith: null as boolean | null,
    write: async (b: Row[]) => void s.written.push(b),
    close: async (ok: boolean) => void (s.closedWith = ok),
  };
  return s;
}

export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `fn` with stdout and stderr captured and no terminal, whatever runs the tests. */
export async function capture(fn: () => Promise<number>): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  const tty = [process.stdin.isTTY, process.stdout.isTTY, process.stderr.isTTY];
  const set = (s: NodeJS.ReadStream | NodeJS.WriteStream, v: boolean | undefined) => Object.defineProperty(s, 'isTTY', { value: v, configurable: true, writable: true });
  set(process.stdin, false);
  set(process.stdout, false);
  set(process.stderr, false);
  // The test runner reports through stdout with binary chunks; only text written during `fn` is kept.
  process.stdout.write = ((s: string | Uint8Array) => (typeof s === 'string' ? out.push(s) : so(s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => (typeof s === 'string' ? err.push(s) : se(s), true)) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
    set(process.stdin, tty[0]);
    set(process.stdout, tty[1]);
    set(process.stderr, tty[2]);
  }
}
