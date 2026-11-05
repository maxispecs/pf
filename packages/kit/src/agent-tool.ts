import type { Context } from './context.js';

export interface ToolResult {
  ok: boolean;
  text: string;
}

/** The user's answer to an elicitation (MCP `elicitation/create`). */
export interface ElicitResult {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

/** What the MCP server offers a tool beyond its arguments. */
export interface ToolSession {
  /** Identifies this agent session (one MCP server process). */
  id: string;
  /**
   * Ask the user in the agent CLI's own dialog (MCP form elicitation). Missing when the client
   * cannot show one. `requestedSchema` is a flat object schema of primitive fields.
   */
  elicit?(message: string, requestedSchema: Record<string, unknown>): Promise<ElicitResult>;
  /**
   * Without `elicit`: true when the agent CLI's own tool prompt may stand in for the user's
   * approval (it was not told to run the tool unasked), false when an approval must be refused.
   */
  trustClientPrompt: boolean;
  /** Append one event to this session's audit log. Never throws. */
  audit(event: Record<string, unknown>): void;
}

/** A tool pf serves to agent CLIs over MCP. */
export interface Tool {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  inputSchema: Record<string, unknown>;
  /** Changes nothing, so agent CLIs may run it without asking. */
  readOnly: boolean;
  /** Asks the user itself (elicitation) before it changes anything, so an agent CLI that shows elicitations needs no prompt of its own. */
  asksUser?: boolean;
  run(ctx: Context, input: Record<string, unknown>, session?: ToolSession): Promise<ToolResult>;
}

/** Object schema for tool arguments; extra keys are refused. */
export function objectSchema(properties: Record<string, unknown> = {}, required: string[] = []): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}
