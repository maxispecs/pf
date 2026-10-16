import { allCommands, findCommand } from './commands/index.js';
import { GROUPS } from './commands/types.js';
import { buildContext, type Context } from './context.js';
import { localRoot, runLocalMenu } from './local.js';
import { printList, runCustom, runMenu } from './menu.js';
import { printBanner } from './ui/banner.js';
import { err, out } from './ui/palette.js';
import { badge, h2, promptLine, termLine } from './ui/text.js';
import { cachedLatest, refreshInBackground } from './update/check.js';
import { version } from './version.js';

const NO_UPDATE_CHECK = new Set(['update', 'setup', 'uninstall', 'doctor']);

export function helpText(): string {
  const c = out();
  const lines: string[] = [];
  lines.push(`${h2('Usage', c)}  ${termLine('pf [command] [args]', c)}`);
  lines.push(c.dim('        pf with no command opens the menu for the current repo (or a fallback menu outside one)'));
  const cmds = allCommands();
  for (const g of GROUPS) {
    const inGroup = cmds.filter((cmd) => cmd.group === g && !cmd.hidden);
    if (!inGroup.length) continue;
    lines.push('', h2(g, c));
    const width = Math.max(...inGroup.map((x) => x.usage.length));
    for (const cmd of inGroup) lines.push(`  ${termLine(cmd.usage, c)}${' '.repeat(width - cmd.usage.length)}  ${cmd.summary}`);
  }
  lines.push(
    '',
    h2('Options', c),
    `  ${c.cyan('-h, --help')}       Show this help (or a command's usage: ${termLine('pf <command> --help', c)})`,
    `  ${c.cyan('-v, --version')}    Print the version`,
    `  ${c.cyan('-n, --dry-run')}    On commands that run something: print it instead`,
    `  ${c.cyan('--')}               Everything after it goes to the underlying command: ${termLine('pf dev -- --port 4000', c)}`,
    '',
    h2('Environment', c),
    `  ${c.green('NO_COLOR=1')}            Turn colors off (${c.green('FORCE_COLOR=1')} forces them on)`,
    `  ${c.green('PF_HOME=')}${c.blue('<dir>')}         Where pf keeps config and state (default ~/.pf)`,
    `  ${c.green('PF_NO_UPDATE_CHECK=1')}  Skip the daily background update check`,
    '',
    c.dim('Repo commands come from pf.json, package scripts, Makefile/justfile targets and stack defaults.'),
  );
  return lines.join('\n');
}

/** The big logo is for the menu and the pages people read; everything else stays one quiet line. */
const LOGO_COMMANDS = new Set(['menu', 'about', 'help', '-h', '--help']);

export function wantsLogo(first: string | undefined): boolean {
  return first === undefined || LOGO_COMMANDS.has(first);
}

function suggest(name: string, ctx: Context): string[] {
  const names = [...allCommands().map((x) => x.name), ...Object.keys(ctx.config.commands)];
  return names.filter((n) => n.startsWith(name.slice(0, 2)) || n.includes(name) || name.includes(n)).slice(0, 4);
}

export async function main(argv: string[]): Promise<number> {
  const ctx = buildContext();
  const first = argv[0];
  // Set by the ./pf launcher. Read it once and drop it so commands pf starts (a global pf) don't inherit it.
  const local = localRoot();
  delete process.env.PF_LOCAL;

  printBanner(
    {
      version: ctx.version,
      ...(local ? { local: true } : {}),
      ...(ctx.repo ? { repo: ctx.repo.name, stacks: ctx.stacks.map((s) => s.label) } : {}),
      ...(cachedLatest() ? { latest: cachedLatest()! } : {}),
    },
    { logo: wantsLogo(first) },
  );
  if (!first || !NO_UPDATE_CHECK.has(first)) refreshInBackground();

  if (!first) return local ? runLocalMenu(local) : runMenu(ctx);
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
  if (first === 'menu') return local ? runLocalMenu(local) : runMenu(ctx);

  const rest = argv.slice(1);
  const cmd = findCommand(first);
  if (cmd) {
    const beforeDashes = rest.slice(0, rest.indexOf('--') === -1 ? rest.length : rest.indexOf('--'));
    const passthrough = cmd.name === 'ver';
    if (!passthrough && (beforeDashes.includes('-h') || beforeDashes.includes('--help'))) {
      process.stdout.write(`${out().bold(cmd.summary)}\n  ${promptLine(cmd.usage)}\n`);
      return 0;
    }
    return cmd.run(ctx, rest);
  }
  if (ctx.config.commands[first]) return runCustom(ctx, first, rest);

  const c = err();
  const near = suggest(first, ctx);
  process.stderr.write(
    `${badge.error(`unknown command "${first}".${near.length ? ` Did you mean: ${near.map((n) => c.bold(c.green(n))).join(', ')}?` : ''}`, c)}\n` +
      `Run ${termLine('pf list', c)} for what is available here, or ${termLine('pf help', c)}.\n`,
  );
  return 2;
}
