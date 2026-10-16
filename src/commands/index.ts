import { aboutCommand } from './about.js';
import { deployCommand } from './deploy.js';
import { docCommand } from './doc.js';
import { doctorCommand } from './doctor.js';
import { initCommand } from './init.js';
import { setupCommand } from './setup.js';
import { skillCommand } from './skill.js';
import { TASK_COMMANDS } from './tasks.js';
import type { Command } from './types.js';
import { uninstallCommand } from './uninstall.js';
import { updateCommand } from './update.js';
import { verCommand } from './ver.js';

/** Built-in commands except the ones that live in cli.ts (help, list, menu, version). */
export function allCommands(): Command[] {
  return [
    ...TASK_COMMANDS,
    docCommand,
    deployCommand,
    verCommand,
    skillCommand,
    initCommand,
    doctorCommand,
    setupCommand,
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
