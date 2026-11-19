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
