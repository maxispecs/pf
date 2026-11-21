/**
 * The API for pipe packages (`@pulpfixer/pipe-<name>`): `csvSource` and `csvSink` declare a CSV file as an
 * input or an output (see `@pulpfixer/plugin-io/api` for `definePipes` and the chain helpers).
 */
export { csvAdapter, csvSource, csvSink, readFirstRecord, CsvError, CSV_MODES, type CsvConfig, type CsvMode, type CsvSinkConfig, type CsvSourceConfig } from './adapter.js';
export { parseCsv, toCsv, CsvParser } from '@pulpfixer/kit/csv';
