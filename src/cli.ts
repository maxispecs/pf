import { allCommands, findCommand } from './commands/index.js';
import { GROUPS } from './commands/types.js';
import { buildContext, type Context } from './context.js';
import { printList, runCustom, runMenu } from './menu.js';
import { printBanner } from './ui/banner.js';
import { err, out } from './ui/palette.js';
import { cachedLatest, refreshInBackground } from './update/check.js';
import { version } from './version.js';

const NO_UPDATE_CHECK = new Set(['update', 'setup', 'uninstall', 'doctor']);

export function helpText(): string {
  const c = out();
  const lines: string[] = [];
  lines.push(`${c.bold('Usage')}  pf [command] [args]`);
  lines.push(c.dim('        pf with no command opens the menu for the current repo (or a fallback menu outside one)'));
  const cmds = allCommands();
  for (const g of GROUPS) {
    const inGroup = cmds.filter((cmd) => cmd.group === g && !cmd.hidden);
    if (!inGroup.length) continue;
    lines.push('', c.bold(g));
    const width = Math.max(...inGroup.map((x) => x.usage.length));
    for (const cmd of inGroup) lines.push(`  ${c.boldBrand(cmd.usage.padEnd(width))}  ${cmd.summary}`);
  }
  lines.push(
    '',
    c.bold('Options'),
    '  -h, --help       Show this help (or a command\'s usage: pf <command> --help)',
    '  -v, --version    Print the version',
    '  -n, --dry-run    On commands that run something: print it instead',
    '  --               Everything after it goes to the underlying command: pf dev -- --port 4000',
    '',
    c.bold('Environment'),
    '  NO_COLOR=1            Turn colors off (FORCE_COLOR=1 forces them on)',
    '  PF_HOME=<dir>         Where pf keeps config and state (default ~/.pf)',
    '  PF_NO_UPDATE_CHECK=1  Skip the daily background update check',
    '',
    c.dim('Repo commands come from pf.json, package scripts, Makefile/justfile targets and stack defaults.'),
  );
  return lines.join('\n');
}

function suggest(name: string, ctx: Context): string[] {
  const names = [...allCommands().map((x) => x.name), ...Object.keys(ctx.config.commands)];
  return names.filter((n) => n.startsWith(name.slice(0, 2)) || n.includes(name) || name.includes(n)).slice(0, 4);
}

export async function main(argv: string[]): Promise<number> {
  const ctx = buildContext();
  const first = argv[0];

  printBanner({
    version: ctx.version,
    ...(ctx.repo ? { repo: ctx.repo.name, stacks: ctx.stacks.map((s) => s.label) } : {}),
    ...(cachedLatest() ? { latest: cachedLatest()! } : {}),
  });
  if (!first || !NO_UPDATE_CHECK.has(first)) refreshInBackground();

  if (!first) return runMenu(ctx);
  if (first === '-v' || first === '--version' || first === 'version') {
    process.stdout.write(version() + '\n');
    return 0;
  }
  if (first === '-h' || first === '--help' || first === 'help') {
    process.stdout.write(helpText() + '\n');
    return 0;
  }
  if (first === 'list' || first === 'ask') {
    printList(ctx);
    return 0;
  }
  if (first === 'menu') return runMenu(ctx);

  const rest = argv.slice(1);
  const cmd = findCommand(first);
  if (cmd) {
    const beforeDashes = rest.slice(0, rest.indexOf('--') === -1 ? rest.length : rest.indexOf('--'));
    const passthrough = cmd.name === 'ver';
    if (!passthrough && (beforeDashes.includes('-h') || beforeDashes.includes('--help'))) {
      process.stdout.write(`${out().bold(cmd.summary)}\n  ${cmd.usage}\n`);
      return 0;
    }
    return cmd.run(ctx, rest);
  }
  if (ctx.config.commands[first]) return runCustom(ctx, first, rest);

  const c = err();
  const near = suggest(first, ctx);
  process.stderr.write(
    `${c.red('error:')} unknown command "${first}".${near.length ? ` Did you mean: ${near.map((n) => c.bold(n)).join(', ')}?` : ''}\n` +
      `Run ${c.bold('pf list')} for what is available here, or ${c.bold('pf help')}.\n`,
  );
  return 2;
}
