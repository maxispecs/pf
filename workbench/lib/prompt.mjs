// Tiny prompts for tools that are started from a menu. Plain node, no dependencies.
// Only ask when there is a terminal (`canAsk()`); a script or pipe gets flags and usage instead.
import readline from 'node:readline/promises';

export const canAsk = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/**
 * Ask one line. `validate(value)` returns an error text (asked again) or nothing. An empty answer takes
 * `default`. Returns null when the input ends (Ctrl-D) or the question is cancelled with Ctrl-C.
 */
export async function ask(question, { default: def, validate } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let cancelled = false;
  rl.on('SIGINT', () => {
    cancelled = true;
    rl.close();
  });
  try {
    for (;;) {
      let answer;
      try {
        answer = (await rl.question(`${question}${def ? ` (${def})` : ''}: `)).trim();
      } catch {
        return null; // closed
      }
      if (cancelled) return null;
      const value = answer || def || '';
      const problem = validate ? validate(value) : undefined;
      if (!problem) return value;
      console.log(`  ${problem}`);
    }
  } finally {
    rl.close();
  }
}

/** Pick one of `options` (`[{ value, label }]` or strings) by number. Returns the value or null. */
export async function choose(question, options) {
  const list = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  console.log(question);
  list.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}`));
  const answer = await ask('number', {
    default: '1',
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= list.length ? undefined : `enter a number from 1 to ${list.length}`),
  });
  return answer === null ? null : list[Number(answer) - 1].value;
}
