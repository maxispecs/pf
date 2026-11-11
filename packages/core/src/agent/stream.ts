import { spawn } from 'node:child_process';
import { badge } from '@pulpfixer/kit/ui/text';
import { err, type Palette } from '@pulpfixer/kit/ui/palette';
import { SERVER_NAME } from './mcp.js';

/**
 * Print mode (`claude -p`, `cursor-agent -p`) prints nothing until the task is done. With
 * `--output-format stream-json` both CLIs write one JSON event per line instead, and pf turns each
 * one into a short line (what the agent says, which tool it runs, what failed), so a one-shot task
 * shows its progress and still exits on its own. Claude and Cursor use different event shapes;
 * anything unknown is skipped, and a line that is not JSON is printed as is.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

const MAX_DETAIL = 90;

function short(s: string, max = MAX_DETAIL): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** `mcp__pulpfixer__pf_skill` -> `pf_skill`; Cursor's `readToolCall` -> `read`. */
export function toolLabel(name: string): string {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (mcp) return mcp[1] === SERVER_NAME ? mcp[2]! : `${mcp[1]}: ${mcp[2]}`;
  return name.replace(/ToolCall$/, '');
}

/** The one argument that says what a tool call is about: a path, a command, a pattern, a skill name. */
export function toolDetail(input: unknown): string {
  if (!isObj(input)) return '';
  for (const key of ['file_path', 'path', 'command', 'pattern', 'glob_pattern', 'query', 'url', 'name', 'description', 'prompt']) {
    const v = str(input[key]);
    if (v) return short(v);
  }
  return '';
}

export interface StreamState {
  /** Claude tool_use id -> label, to name a failed result. */
  tools: Map<string, string>;
  startedAt: number;
  /** Paths under it are shown relative. */
  cwd?: string;
}

export function newStreamState(cwd?: string): StreamState {
  return { tools: new Map(), startedAt: Date.now(), ...(cwd ? { cwd } : {}) };
}

function toolLine(label: string, detail: string, state: StreamState, c: Palette): string {
  const shown = state.cwd && detail.startsWith(`${state.cwd}/`) ? detail.slice(state.cwd.length + 1) : detail;
  return `  ${c.cyan('▸')} ${c.bold(label)}${shown ? ` ${c.dim(shown)}` : ''}`;
}
const failLine = (label: string, text: string, c: Palette) => `  ${c.red('✗')} ${label}${text ? `: ${c.dim(short(text))}` : ''}`;
const sayLines = (text: string, c: Palette) => text.trim().split('\n').map((l) => `  ${c.dim('│')} ${l}`);

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (isObj(p) && typeof p.text === 'string' ? p.text : '')).join(' ');
  return '';
}

function finish(e: Obj, state: StreamState, c: Palette): string[] {
  const secs = Math.round((typeof e.duration_ms === 'number' ? e.duration_ms : Date.now() - state.startedAt) / 1000);
  const parts = [`${secs}s`];
  if (typeof e.num_turns === 'number') parts.push(`${e.num_turns} turns`);
  if (typeof e.total_cost_usd === 'number') parts.push(`$${e.total_cost_usd.toFixed(2)}`);
  if (e.is_error === true || (typeof e.subtype === 'string' && e.subtype !== 'success')) {
    return [badge.error(`agent stopped (${str(e.subtype) ?? 'error'}) after ${parts.join(', ')}`, c)];
  }
  return [`${c.green('✔')} ${c.dim(`agent finished in ${parts.join(', ')}`)}`];
}

/** Lines to print for one event line. Pure, so each CLI's shapes are tested without starting it. */
export function renderEvent(line: string, state: StreamState, c: Palette): string[] {
  const raw = line.trim();
  if (!raw) return [];
  let e: unknown;
  try {
    e = JSON.parse(raw);
  } catch {
    return [raw];
  }
  if (!isObj(e)) return [];

  if (e.type === 'system' && e.subtype === 'init') {
    const model = str(e.model);
    const servers = Array.isArray(e.mcp_servers) ? e.mcp_servers.filter(isObj) : [];
    const ours = servers.find((s) => s.name === SERVER_NAME);
    const out = [c.dim(`agent started${model ? ` (${model})` : ''}`)];
    if (ours && ours.status !== 'connected') out.push(badge.warning(`the ${SERVER_NAME} tools are ${String(ours.status ?? 'not connected')}`, c));
    return out;
  }

  // Claude: an assistant message carries text and tool_use blocks; tool results come back as a user message.
  if ((e.type === 'assistant' || e.type === 'user') && isObj(e.message) && Array.isArray(e.message.content)) {
    const out: string[] = [];
    for (const block of e.message.content.filter(isObj)) {
      if (e.type === 'assistant' && block.type === 'text' && str(block.text)) out.push(...sayLines(block.text as string, c));
      else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const label = toolLabel(block.name);
        if (typeof block.id === 'string') state.tools.set(block.id, label);
        out.push(toolLine(label, toolDetail(block.input), state, c));
      } else if (block.type === 'tool_result' && block.is_error === true) {
        const label = (typeof block.tool_use_id === 'string' && state.tools.get(block.tool_use_id)) || 'tool';
        out.push(failLine(label, resultText(block.content), c));
      }
    }
    return out;
  }

  // Cursor: one event when a tool call starts and one when it completes, `{ <kind>ToolCall: { args, result } }`.
  if (e.type === 'tool_call' && isObj(e.tool_call)) {
    const [kind, body] = Object.entries(e.tool_call)[0] ?? [];
    if (!kind || !isObj(body)) return [];
    let label = toolLabel(kind);
    let args: unknown = body.args;
    if (kind === 'function' && typeof body.name === 'string') {
      label = toolLabel(body.name);
      try {
        args = typeof body.arguments === 'string' ? JSON.parse(body.arguments) : body.arguments;
      } catch {
        args = undefined;
      }
    }
    if (e.subtype === 'started') return [toolLine(label, toolDetail(args), state, c)];
    if (e.subtype === 'completed' && isObj(body.result) && !('success' in body.result)) {
      const [, failure] = Object.entries(body.result)[0] ?? [];
      return [failLine(label, isObj(failure) ? (str(failure.message) ?? str(failure.error) ?? '') : resultText(failure), c)];
    }
    return [];
  }

  if (e.type === 'result') return finish(e, state, c);
  return [];
}

/**
 * Run an agent CLI that writes stream-json on stdout and print its progress to stderr. stdin and
 * stderr stay the terminal's. Resolves with the exit code, like `runCmd`.
 */
export function runStreaming(argv: string[], cwd: string): Promise<number> {
  const c = err();
  const state = newStreamState(cwd);
  const print = (line: string) => {
    for (const l of renderEvent(line, state, c)) process.stderr.write(`${l}\n`);
  };
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ['inherit', 'pipe', 'inherit'] });
    let buffered = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      lines.forEach(print);
    });
    // Let the child own Ctrl-C; pf exits with the child's status.
    const ignore = () => undefined;
    process.on('SIGINT', ignore);
    child.on('error', (e: NodeJS.ErrnoException) => {
      process.removeListener('SIGINT', ignore);
      process.stderr.write(`${badge.error(e.code === 'ENOENT' ? `${argv[0]} not found on PATH` : e.message, c)}\n`);
      resolve(127);
    });
    child.on('close', (code, signal) => {
      process.removeListener('SIGINT', ignore);
      print(buffered);
      resolve(code ?? (signal ? 130 : 1));
    });
  });
}
