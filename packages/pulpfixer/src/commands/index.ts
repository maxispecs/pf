import { aboutCommand } from './about.js';
import { actionsCommand } from './actions.js';
import { agentCommand } from './agent.js';
import { artCommand } from './art.js';
import { mcpCommand } from './mcp.js';
import { cycleCommands } from './cycle.js';
import { deployCommand } from './deploy.js';
import { docCommand } from './doc.js';
import { doctorCommand } from './doctor.js';
import { gitCommand } from './git.js';
import { hostCommand } from './host.js';
import { initCommand } from './init.js';
import { installCommand } from './install.js';
import { setupCommand } from './setup.js';
import { shortcutsCommand } from './shortcutlist.js';
import { SHORTCUTS, shortcutCommands } from './shortcuts.js';
import { skillCommand } from './skill.js';
import { TASK_COMMANDS } from './tasks.js';
import { toolsCommand } from './tools.js';
import { troubleshootCommand } from './troubleshoot.js';
import type { Command } from '@pulpfixer/kit/types';
import { uninstallCommand } from './uninstall.js';
import { updateCommand } from './update.js';
import { verCommand } from './ver.js';
import { versionsCommand } from './versions.js';
import { pluginCommand } from './plugin.js';
import { profileCommand } from './profile.js';
import { publishCommand } from './publish.js';
import { repoCommand } from './repo.js';
import { templateCommand } from './template.js';
import { pluginCommands } from '../plugins/index.js';

/** Built-in commands except the ones that live in cli.ts (help, list, menu, version). */
export function allCommands(): Command[] {
  const all: Command[] = [
    agentCommand,
    troubleshootCommand,
    artCommand,
    mcpCommand,
    ...TASK_COMMANDS,
    installCommand,
    gitCommand,
    docCommand,
    deployCommand,
    publishCommand,
    verCommand,
    versionsCommand,
    toolsCommand,
    actionsCommand,
    skillCommand,
    initCommand,
    repoCommand,
    templateCommand,
    profileCommand,
    doctorCommand,
    setupCommand,
    hostCommand,
    pluginCommand,
    ...cycleCommands,
    shortcutsCommand,
    ...SHORTCUTS.flatMap((sc) => shortcutCommands(sc, findCommand)),
    updateCommand,
    uninstallCommand,
    aboutCommand,
    { name: 'list', summary: 'List available commands (static)', group: 'Help', usage: 'pf list', run: async () => 0 },
    { name: 'help', summary: 'Show help', group: 'Help', usage: 'pf help', run: async () => 0 },
    // Last, so a plugin can add commands but never shadow a built-in one (first definition wins).
    ...pluginCommands(),
  ];
  const seen = new Set<string>();
  return all.filter((c) => !seen.has(c.name) && !!seen.add(c.name));
}

export function findCommand(name: string): Command | undefined {
  return allCommands().find((c) => c.name === name);
}
