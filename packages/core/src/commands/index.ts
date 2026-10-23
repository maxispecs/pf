import { aboutCommand } from './about.js';
import { agentCommand } from './agent.js';
import { mcpCommand } from './mcp.js';
import { deployCommand } from './deploy.js';
import { docCommand } from './doc.js';
import { doctorCommand } from './doctor.js';
import { hostCommand } from './host.js';
import { initCommand } from './init.js';
import { setupCommand } from './setup.js';
import { SHORTCUTS, shortcutCommand } from './shortcuts.js';
import { skillCommand } from './skill.js';
import { TASK_COMMANDS } from './tasks.js';
import type { Command } from '@pulpfixer/kit/types';
import { uninstallCommand } from './uninstall.js';
import { updateCommand } from './update.js';
import { verCommand } from './ver.js';
import { pluginCommands } from '../plugins/index.js';

/** Built-in commands except the ones that live in cli.ts (help, list, menu, version). */
export function allCommands(): Command[] {
  return [
    agentCommand,
    mcpCommand,
    ...TASK_COMMANDS,
    docCommand,
    deployCommand,
    verCommand,
    skillCommand,
    initCommand,
    doctorCommand,
    setupCommand,
    hostCommand,
    ...pluginCommands(),
    ...SHORTCUTS.map((sc) => shortcutCommand(sc, findCommand)),
    updateCommand,
    uninstallCommand,
    aboutCommand,
    { name: 'list', summary: 'List available commands (static)', group: 'Help', usage: 'pf list', run: async () => 0 },
    { name: 'help', summary: 'Show help', group: 'Help', usage: 'pf help', run: async () => 0 },
  ];
}

export function findCommand(name: string): Command | undefined {
  return allCommands().find((c) => c.name === name);
}
