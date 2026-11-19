/**
 * The API for query packages (`@pulpfixer/query-<name>`): write SQL with `sql`, run it through a `Db`,
 * and wrap a set of queries in `defineQueries`.
 */
export { sql, insert, update, deleteFrom, where, conditions, compile, SqlFragment, SqlError, type Row, type SqlLike, type InsertOptions } from './sql.js';
export { connect, connectWith, withDb, makeDb, type Db, type DbOptions, type WritePolicy } from './client.js';
export { defineQueries, parseParams, queryUsage, type ParamDef, type Params, type QueryContext, type QueryDef, type QueryPackage } from './define.js';
export { DbError } from './errors.js';
export type { CompiledQuery, ConnectionParams, DbDriver, DbSession, Dialect, QueryResult } from '@pulpfixer/kit/db';
