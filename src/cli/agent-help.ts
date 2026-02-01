import type { AgentCommandMeta } from './help.js';

import { initMeta, syncMeta, statusMeta } from './metadata/workspace.js';
import {
  marketplaceListMeta,
  marketplaceAddMeta,
  marketplaceRemoveMeta,
  marketplaceUpdateMeta,
  pluginListMeta,
  pluginValidateMeta,
  pluginInstallMeta,
  pluginUninstallMeta,
} from './metadata/plugin.js';
import { updateMeta } from './metadata/self.js';

const allCommands: AgentCommandMeta[] = [
  initMeta,
  syncMeta,
  statusMeta,
  pluginInstallMeta,
  pluginUninstallMeta,
  marketplaceListMeta,
  marketplaceAddMeta,
  marketplaceRemoveMeta,
  marketplaceUpdateMeta,
  pluginListMeta,
  pluginValidateMeta,
  updateMeta,
];

/**
 * Strip --agent-help from args so cmd-ts doesn't see it.
 */
export function extractAgentHelpFlag(args: string[]): { args: string[]; agentHelp: boolean } {
  const idx = args.indexOf('--agent-help');
  if (idx === -1) return { args, agentHelp: false };
  return { args: [...args.slice(0, idx), ...args.slice(idx + 1)], agentHelp: true };
}

function formatForAgent(meta: AgentCommandMeta) {
  const result: Record<string, unknown> = {
    command: meta.command,
    description: meta.description,
    when_to_use: meta.whenToUse,
  };
  if (meta.positionals && meta.positionals.length > 0) {
    result.positionals = meta.positionals;
  }
  if (meta.options && meta.options.length > 0) {
    result.options = meta.options;
  }
  result.examples = meta.examples;
  if (meta.outputSchema) {
    result.output_schema = meta.outputSchema;
  }
  return result;
}

export function printAgentHelp(args: string[], version: string): void {
  // Determine which command is being asked about by looking at remaining args
  const commandPath = args.filter(a => !a.startsWith('-')).join(' ');

  if (!commandPath) {
    // Full tree
    const tree = {
      name: 'allagents',
      version,
      description: 'CLI tool for managing multi-repo AI agent workspaces with plugin synchronization',
      commands: allCommands.map(formatForAgent),
    };
    console.log(JSON.stringify(tree, null, 2));
  } else {
    // Find exact matching command
    const match = allCommands.find(c => c.command === commandPath);
    if (match) {
      console.log(JSON.stringify(formatForAgent(match), null, 2));
    } else {
      // Try prefix match for subcommand groups
      const matches = allCommands.filter(c => c.command.startsWith(`${commandPath} `));
      if (matches.length > 0) {
        const group = {
          name: commandPath,
          commands: matches.map(formatForAgent),
        };
        console.log(JSON.stringify(group, null, 2));
      } else {
        console.error(`Unknown command: ${commandPath}`);
        process.exit(1);
      }
    }
  }
  process.exit(0);
}
