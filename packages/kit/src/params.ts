/**
 * The flags a named query or pipe takes: a definition per parameter, read out of an argument list,
 * defaulted and checked. Shared by `defineQueries` (plugin-db) and `definePipes` (plugin-io).
 */
import { takeOption } from './util.js';

/** The values of a command's parameters, already checked and converted. Typed loosely so `({ month }) => ...` reads simply. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Params = Record<string, any>;

export interface ParamDef {
  help?: string;
  /** `string` (default), `number` or `boolean` (a flag). */
  type?: 'string' | 'number' | 'boolean';
  required?: boolean;
  default?: string | number | boolean;
  /** Allowed values (strings). */
  choices?: string[];
}

export type ParsedParams = { values: Params } | { error: string };

/** `sslMode` -> `--ssl-mode`. */
export const flagName = (key: string): string => '--' + key.replace(/([A-Z])/g, '-$1').toLowerCase();

/** Remove a boolean flag: `--ssl` or `--ssl=true|false` is a value, `--no-ssl` is false. Undefined when absent. */
export function takeBool(args: string[], flag: string): boolean | undefined {
  let found: boolean | undefined;
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i]!;
    if (a === flag || a === `--no-${flag.slice(2)}` || a.startsWith(`${flag}=`)) {
      found ??= a === flag ? true : a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) !== 'false' : false;
      args.splice(i, 1);
    }
  }
  return found;
}

/** Read the `--param value` flags out of `args` (consumed), apply defaults and check them. */
export function parseParams(defs: Record<string, ParamDef> | undefined, args: string[]): ParsedParams {
  const values: Params = {};
  for (const [key, def] of Object.entries(defs ?? {})) {
    const flag = flagName(key);
    let value: string | number | boolean | undefined;
    if (def.type === 'boolean') {
      value = takeBool(args, flag);
    } else {
      const raw = takeOption(args, flag);
      if (raw === undefined && args.includes(flag)) return { error: `${flag} needs a value` };
      if (raw !== undefined) {
        if (def.type === 'number') {
          const n = Number(raw);
          if (raw.trim() === '' || !Number.isFinite(n)) return { error: `${flag} must be a number (got "${raw}")` };
          value = n;
        } else {
          value = raw;
        }
      }
    }
    value ??= def.default;
    if (value === undefined) {
      if (def.required) return { error: `${flag} is required${def.help ? ` (${def.help})` : ''}` };
      continue;
    }
    if (def.choices && !def.choices.includes(String(value))) return { error: `${flag} must be one of ${def.choices.join(', ')} (got "${String(value)}")` };
    values[key] = value;
  }
  return { values };
}
