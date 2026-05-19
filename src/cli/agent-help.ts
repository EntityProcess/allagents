import type { AgentCommandMeta } from './help.js';
import { normalizeSkillHelpArgs } from './skill-arg-normalizer.js';

import { initMeta, syncMeta, statusMeta } from './metadata/workspace.js';
import {
  marketplaceListMeta,
  marketplaceAddMeta,
  marketplaceRemoveMeta,
  marketplaceUpdateMeta,
  marketplaceBrowseMeta,
  pluginListMeta,
  pluginValidateMeta,
  pluginInstallMeta,
  pluginUninstallMeta,
} from './metadata/plugin.js';
import { updateMeta } from './metadata/self.js';
import {
  skillsListMeta,
  skillsAddMeta,
  skillsRemoveMeta,
  skillsSearchMeta,
} from './metadata/plugin-skills.js';

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
  marketplaceBrowseMeta,
  pluginListMeta,
  pluginValidateMeta,
  skillsListMeta,
  skillsAddMeta,
  skillsRemoveMeta,
  skillsSearchMeta,
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
  if (meta.jsonFields && meta.jsonFields.length > 0) {
    result.json_fields = [...meta.jsonFields];
  }
  return result;
}

/**
 * Look up a meta by the runtime command path (e.g. "skills list").
 * Used by index.ts to validate `--json=<fields>` against the per-command
 * allowlist before dispatching.
 */
export function findMetaByCommand(commandPath: string): AgentCommandMeta | undefined {
  if (!commandPath) return undefined;
  return allCommands.find((c) => c.command === commandPath);
}

export function printAgentHelp(args: string[], version: string): void {
  // Determine which command is being asked about by looking at remaining args.
  const positional = args.filter(a => !a.startsWith('-'));
  const normalized = normalizeSkillHelpArgs(positional);
  const commandPath = normalized.join(' ');

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
