/**
 * The API for pipe packages (`@pulpfixer/pipe-<name>`) and IO adapter add-ons (`@pulpfixer/io-<name>`):
 * declare inputs and outputs with the builders of an adapter (`dbSource`, `csvSink`, `memorySource`, ...),
 * couple them with `definePipes` and the chain helpers (`from`, `.map`, `.filter`, `.to`, ...).
 */
export { definePipes, pipeSpec, pipeUsage, type PipeDef, type PipePackage, type PipeRun, type Transformed } from './define.js';
export { Flow, from, fromRows, concat, collect, count, DEFAULT_BATCH_SIZE, type FlowSource, type ToResult } from './flow.js';
export { runPipe, type Handles, type PipeSpec, type RunOptions, type RunReport } from './run.js';
export { memoryAdapter, memorySource, memorySink, type MemoryConfig } from './adapters/memory.js';
export { stdoutAdapter, stdoutSink, STDOUT_FORMATS, type StdoutConfig, type StdoutFormat } from './adapters/stdout.js';
export { IoError } from './errors.js';
export { parseParams, type ParamDef, type Params } from '@pulpfixer/kit/params';
export { ioRef, IO_API } from '@pulpfixer/kit/io';
export type { IoAdapter, IoContext, IoRef, IoSink, IoSource, Row, RowBatches } from '@pulpfixer/kit/io';
