/**
 * The IO adapter contract. `@pulpfixer/plugin-io` runs pipes: a pipe reads rows from one or more sources
 * and writes them to one or more sinks. An adapter (the database, CSV files, ... or an
 * `@pulpfixer/io-<name>` registry plugin) knows how to open one kind of source and / or sink. This file
 * holds the types every side shares and the registry that joins them.
 *
 * Every registry plugin is installed with its own copy of this package, so a module-level variable would
 * not be shared. The registry therefore lives on `globalThis` under a symbol that every copy agrees on.
 */
import type { Context } from './context.js';

/** Revision of this contract. An adapter written for a newer one is refused by `validateIoAdapter`. */
export const IO_API = 1;

/** One record: column name to value. */
export type Row = Record<string, unknown>;

/** Rows in groups, so a big table or file never has to be in memory at once. */
export type RowBatches = AsyncIterable<Row[]>;

/** What an adapter is told about the run it takes part in. */
export interface IoContext {
  ctx: Context;
  /** Under `--dry-run` a sink must not change anything: it reports what it would do through `log`. */
  dryRun: boolean;
  /** One line of progress or "would do" text (goes to stderr). */
  log(line: string): void;
  /** How many rows a source puts in a batch, and a sink is happy to write at once. */
  batchSize: number;
}

export interface IoSource {
  /** The rows, once. A source that cannot be read twice may throw on the second call. */
  batches(): RowBatches;
  close(): Promise<void>;
}

export interface IoSink {
  /** Write one batch. Batches arrive in order. */
  write(batch: Row[]): Promise<void>;
  /** The pipe is over. `ok` false means it failed: roll back, delete the temporary file, discard. */
  close(ok: boolean): Promise<void>;
}

/** What a pipe declares for an input or an output: which adapter, and the values it is configured with. */
export interface IoRef<C = unknown> {
  adapter: string;
  config: C;
}

/** `config` is whatever the adapter documents; the adapter checks it. */
export interface IoAdapter<C = unknown> {
  /** Short name used in pipes and `pf io adapters`, e.g. `csv`. */
  id: string;
  label: string;
  /** One safe line for confirmations and lists, e.g. `csv file /tmp/out.csv`. Never include secrets. */
  describe(config: C): string;
  /** Present when the adapter can be read from. */
  source?(config: C, io: IoContext): Promise<IoSource>;
  /** Present when the adapter can be written to. */
  sink?(config: C, io: IoContext): Promise<IoSink>;
  /**
   * Writing to it changes nothing outside this process (the terminal, memory): a pipe that writes only
   * to harmless adapters runs without asking first.
   */
  harmless?: boolean;
}

/** An adapter whose config type is erased, for the registry. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyIoAdapter = IoAdapter<any>;

/** A reference with its config typed for one adapter. */
export const ioRef = <C>(adapter: string, config: C): IoRef<C> => ({ adapter, config });

const KEY = Symbol.for('pulpfixer.io.v1');
interface Entry {
  adapter: AnyIoAdapter;
  origin: string;
}
type Registry = Map<string, Entry>;

function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (g[KEY] ??= new Map());
}

/**
 * Make adapters known to every copy of the kit. An adapter with the same id replaces the earlier one.
 * `origin` says where they come from, for `pf io adapters` (`built in`, `plugin io-foo`).
 */
export function registerIoAdapters(adapters: readonly AnyIoAdapter[], origin = 'unknown'): void {
  for (const adapter of adapters) registry().set(adapter.id, { adapter, origin });
}

export function ioAdapters(): AnyIoAdapter[] {
  return [...registry().values()].map((e) => e.adapter).sort((a, b) => a.id.localeCompare(b.id));
}

export function ioAdapter(id: string): AnyIoAdapter | undefined {
  return registry().get(id)?.adapter;
}

/** Where an adapter was registered from, or undefined when it is not registered. */
export function ioAdapterOrigin(id: string): string | undefined {
  return registry().get(id)?.origin;
}

/** Forget every adapter (tests). */
export function clearIoAdapters(): void {
  registry().clear();
}

/** Check what a plugin exports as an adapter. Returns why it is unusable, or null. */
export function validateIoAdapter(value: unknown): string | null {
  const a = value as Partial<AnyIoAdapter> | null;
  if (!a || typeof a !== 'object') return 'an IO adapter must be an object';
  if (typeof a.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(a.id)) return 'an IO adapter needs a lowercase id';
  const at = `IO adapter "${a.id}"`;
  if (typeof a.label !== 'string' || !a.label) return `${at} needs a label`;
  if (typeof a.describe !== 'function') return `${at} needs describe()`;
  if (a.source !== undefined && typeof a.source !== 'function') return `${at} has a source that is not a function`;
  if (a.sink !== undefined && typeof a.sink !== 'function') return `${at} has a sink that is not a function`;
  if (!a.source && !a.sink) return `${at} needs source() or sink()`;
  return null;
}
