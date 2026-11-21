import { readLastChat, type Chat } from '@pulpfixer/kit/chats';
import type { Context } from '@pulpfixer/kit/context';
import { capture, runCmd } from '@pulpfixer/kit/exec';
import { err } from '@pulpfixer/kit/ui/palette';
import { pick } from '@pulpfixer/kit/ui/picker';
import { ask } from '@pulpfixer/kit/ui/prompt';
import { badgeLabel, h2, termLine, ul } from '@pulpfixer/kit/ui/text';
import { interactive, takeFlag, takeOption } from '@pulpfixer/kit/util';
import { agentText } from '../agent/oneshot.js';
import { resolveAgent, type AgentChoice } from '../agent/agents.js';
import {
  buildCommitPrompt,
  changedPaths,
  commitArgs,
  fitSubject,
  mechanicalMessage,
  parseAgentMessage,
  splitStatus,
  type CommitMessage,
  type SplitStatus,
} from '../repocommit.js';

/**
 * `pf repo commit` (shortcut `pf g`): commit everything uncommitted (staged, unstaged and untracked) with a
 * message written from the most recent Cursor chat of this repo. The coding agent writes it from the chat and
 * the git status; without an agent (or with `--no-agent`) it is made from the chat's first request and last
 * answer. It always shows the files and the message and asks first (`--yes` without a terminal). Never pushes.
 */

export const REPO_COMMIT_USAGE =
  'pf repo commit [-m <message>] [--chat <id>] [--agent <name>] [--no-agent] [--dry-run] [--yes]';

export interface CommitDeps {
  /** Ask an agent for text; replaced in tests. */
  agentText?: typeof agentText;
  /** The last chat of a folder; replaced in tests. */
  readChat?: (folder: string, id?: string) => Chat | null;
  /** Which agent to use; replaced in tests so they do not depend on the CLIs installed here. */
  choose?: (ctx: Context, flag: string | undefined) => AgentChoice;
}

const fail = (msg: string, code = 1): number => {
  process.stderr.write(`${badgeLabel('error', err())} ${msg}\n`);
  return code;
};

const git = (root: string, ...args: string[]) => capture(['git', ...args], { cwd: root });

/** A `-m` value as a message: the first paragraph is the subject, the rest the body. */
export function messageFromFlag(text: string): CommitMessage | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const [first = '', ...rest] = trimmed.split('\n');
  return { subject: first.trim(), body: rest.join('\n').trim() };
}

const LABEL: Record<string, string> = { '??': 'new', ' M': 'modified', 'M ': 'modified', MM: 'modified', ' D': 'deleted', 'D ': 'deleted', 'A ': 'added', AM: 'added', 'R ': 'renamed' };

function describeFiles(s: SplitStatus): string[] {
  const all = [...s.staged, ...s.unstaged.filter((u) => !s.staged.some((e) => e.path === u.path)), ...s.untracked];
  const lines = all.slice(0, 30).map((e) => `${LABEL[e.code] ?? e.code.trim()}: ${e.path}`);
  if (all.length > 30) lines.push(`and ${all.length - 30} more`);
  return lines;
}

function showPlan(files: string[], m: CommitMessage): void {
  const c = err();
  process.stderr.write(`${h2('Files', c)}\n${ul(files, c)}\n\n${h2('Message', c)}\n${c.bold(m.subject)}\n${m.body ? `\n${m.body}\n` : ''}\n`);
}

const chooseAgent = (ctx: Context, flag: string | undefined): AgentChoice => resolveAgent({ flag, env: process.env.PF_AGENT, configured: ctx.user.agent });

/** The message from the last chat: written by the agent, else made from the chat. Null when there is no chat. */
async function messageFromChat(
  ctx: Context,
  root: string,
  chat: Chat,
  opts: { noAgent: boolean; agentFlag: string | undefined; status: string },
  deps: CommitDeps,
): Promise<CommitMessage | null> {
  const c = err();
  if (!opts.noAgent) {
    const choice = (deps.choose ?? chooseAgent)(ctx, opts.agentFlag);
    if (choice.agent && !choice.missing && !choice.unknown) {
      const stat = git(root, 'diff', '--stat', 'HEAD');
      const prompt = buildCommitPrompt({ chat, status: opts.status, stat: stat.ok ? stat.stdout : '' });
      process.stderr.write(`${c.dim(`asking ${choice.agent.label} to write the message from chat ${chat.id.slice(0, 8)}...`)}\n`);
      const reply = await (deps.agentText ?? agentText)(choice.agent, prompt, root);
      const parsed = reply ? parseAgentMessage(reply) : null;
      if (parsed) return parsed;
      process.stderr.write(`${badgeLabel('warning', c)} ${choice.agent.label} gave no usable message, using the chat's first request instead\n`);
    } else if (opts.agentFlag || choice.requested) {
      process.stderr.write(`${badgeLabel('warning', c)} agent "${choice.requested ?? opts.agentFlag}" is not available, using the chat's first request instead\n`);
    }
  }
  return mechanicalMessage(chat);
}

export async function runRepoCommit(ctx: Context, args: string[], deps: CommitDeps = {}): Promise<number> {
  const c = err();
  const rest = [...args];
  const dryRun = takeFlag(rest, '--dry-run', '-n');
  const yes = takeFlag(rest, '--yes', '-y');
  const noAgent = takeFlag(rest, '--no-agent');
  const message = takeOption(rest, '--message') ?? takeOption(rest, '-m');
  const chatId = takeOption(rest, '--chat');
  const agentFlag = takeOption(rest, '--agent');
  if (rest.length) return fail(`unexpected argument "${rest[0]}". Usage: ${REPO_COMMIT_USAGE}`, 2);
  if (!ctx.repo) return fail('pf repo commit needs a repo. Run it inside a project directory.');
  const root = ctx.repo.root;
  if (!git(root, 'rev-parse', '--is-inside-work-tree').ok) return fail('pf repo commit needs a git repository. Run it inside one.');

  const porcelain = git(root, 'status', '--porcelain=v1', '-z', '-uall');
  if (!porcelain.ok) return fail(`git status failed: ${porcelain.stderr.trim() || 'unknown error'}`);
  const status = splitStatus(porcelain.stdout);
  const paths = changedPaths(status);
  if (!paths.length) {
    process.stderr.write(`${c.dim('nothing to commit, the working tree is clean')}\n`);
    return 0;
  }

  let msg: CommitMessage | null = null;
  if (message !== undefined) {
    msg = messageFromFlag(message);
    if (!msg) return fail('the message (-m) is empty', 2);
  } else {
    const chat = (deps.readChat ?? ((f, id) => readLastChat(f, id ? { id } : {})))(root, chatId);
    if (!chat && chatId) return fail(`no Cursor chat "${chatId}" found for this repo`);
    if (chat) {
      const short = git(root, 'status', '--short', '-uall').stdout;
      msg = await messageFromChat(ctx, root, chat, { noAgent, agentFlag, status: short }, deps);
    } else {
      process.stderr.write(`${c.dim('no Cursor chat found for this repo')}\n`);
    }
    if (!msg) {
      const typed = interactive() ? await ask('Commit message', { placeholder: 'what changed', validate: (v) => (v.trim() ? null : 'a message is needed') }) : null;
      msg = typed ? messageFromFlag(typed) : null;
      if (!msg) return fail(`no message to use. Pass one with ${termLine('pf repo commit -m "..."', c)}.`, 2);
    }
  }

  showPlan(describeFiles(status), msg);

  if (dryRun) {
    process.stderr.write(`${c.dim('would run')} ${termLine('git add -A', c)}\n${c.dim('would run')} ${termLine(`git ${commitArgs(msg).map((a) => (/^[\w./:=-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')}`, c)}\n`);
    return 0;
  }

  if (!yes) {
    if (!interactive()) return fail(`pf repo commit changes the repo and needs a terminal to confirm. Pass ${termLine('--yes', c)} to commit.`, 2);
    for (;;) {
      const choice = await pick<'commit' | 'edit' | 'cancel'>(`Commit ${paths.length} file${paths.length === 1 ? '' : 's'}?`, [
        { value: 'commit', label: 'commit', hint: 'git add -A, then git commit' },
        { value: 'edit', label: 'edit the subject' },
        { value: 'cancel', label: 'cancel' },
      ]);
      if (!choice || choice === 'cancel') {
        process.stderr.write(`${c.dim('cancelled, nothing was committed')}\n`);
        return 130;
      }
      if (choice === 'commit') break;
      const subject = await ask('Subject', { initial: msg.subject, validate: (v) => (v.trim() ? null : 'a subject is needed') });
      if (subject) msg = { ...msg, subject: fitSubject(subject, 200) };
    }
  }

  const add = await runCmd({ argv: ['git', 'add', '-A'], cwd: root }, { base: root });
  if (add !== 0) return add;
  const code = await runCmd({ argv: ['git', ...commitArgs(msg)], cwd: root }, { base: root });
  if (code !== 0) return code;
  process.stderr.write(`${badgeLabel('success', c)} committed ${paths.length} file${paths.length === 1 ? '' : 's'}. ${c.dim('Push with')} ${termLine('pf gp', c)}\n`);
  return 0;
}
