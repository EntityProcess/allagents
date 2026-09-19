import type { HelpFormatter } from 'cmd-ts';
import type { AgentCommandMeta } from './help.js';
import { formatJsonValue, getJsonFields } from './json-output.js';
import {
  mcpAddMeta,
  mcpGetMeta,
  mcpListMeta,
  mcpReauthMeta,
  mcpRemoveMeta,
  mcpUpdateMeta,
} from './metadata/mcp.js';
import {
  marketplaceAddMeta,
  marketplaceBrowseMeta,
  marketplaceListMeta,
  marketplaceRemoveMeta,
  marketplaceUpdateMeta,
  pluginInstallMeta,
  pluginListMeta,
  pluginUninstallMeta,
  pluginUpdateMeta,
  pluginValidateMeta,
} from './metadata/plugin.js';
import {
  skillsAddMeta,
  skillsListMeta,
  skillsRemoveMeta,
  skillsSearchMeta,
  skillsUpdateMeta,
} from './metadata/plugin-skills.js';
import {
  profileInstallMeta,
  profileListMeta,
  profileRemoveMeta,
  profileStatusMeta,
} from './metadata/profile.js';
import { updateMeta } from './metadata/self.js';
import {
  initMeta,
  pruneMeta,
  setupMeta,
  statusMeta,
  syncMeta,
} from './metadata/workspace.js';
import {
  repoAddMeta,
  repoListMeta,
  repoRemoveMeta,
} from './metadata/workspace-repo.js';

interface RegisteredCommand {
  command: string;
  meta: AgentCommandMeta;
}

/**
 * Public command paths mirror the cmd-ts tree. Aliases reference the same
 * metadata objects as their canonical commands so the two help surfaces cannot
 * drift.
 */
const registeredCommands: RegisteredCommand[] = [
  { command: 'init', meta: initMeta },
  { command: 'update', meta: syncMeta },
  { command: 'status', meta: statusMeta },
  { command: 'workspace init', meta: initMeta },
  { command: 'workspace setup', meta: setupMeta },
  { command: 'workspace sync', meta: syncMeta },
  { command: 'workspace status', meta: statusMeta },
  { command: 'workspace prune', meta: pruneMeta },
  { command: 'workspace repo add', meta: repoAddMeta },
  { command: 'workspace repo remove', meta: repoRemoveMeta },
  { command: 'workspace repo list', meta: repoListMeta },
  { command: 'mcp add', meta: mcpAddMeta },
  { command: 'mcp reauth', meta: mcpReauthMeta },
  { command: 'mcp remove', meta: mcpRemoveMeta },
  { command: 'mcp list', meta: mcpListMeta },
  { command: 'mcp get', meta: mcpGetMeta },
  { command: 'mcp update', meta: mcpUpdateMeta },
  { command: 'plugin install', meta: pluginInstallMeta },
  { command: 'plugin uninstall', meta: pluginUninstallMeta },
  { command: 'plugin update', meta: pluginUpdateMeta },
  { command: 'plugin marketplace list', meta: marketplaceListMeta },
  { command: 'plugin marketplace add', meta: marketplaceAddMeta },
  { command: 'plugin marketplace remove', meta: marketplaceRemoveMeta },
  { command: 'plugin marketplace update', meta: marketplaceUpdateMeta },
  { command: 'plugin marketplace browse', meta: marketplaceBrowseMeta },
  { command: 'plugin list', meta: pluginListMeta },
  { command: 'plugin validate', meta: pluginValidateMeta },
  { command: 'plugin skills list', meta: skillsListMeta },
  { command: 'plugin skills add', meta: skillsAddMeta },
  { command: 'plugin skills remove', meta: skillsRemoveMeta },
  { command: 'plugin skills search', meta: skillsSearchMeta },
  { command: 'plugin skills update', meta: skillsUpdateMeta },
  { command: 'skill list', meta: skillsListMeta },
  { command: 'skill add', meta: skillsAddMeta },
  { command: 'skill remove', meta: skillsRemoveMeta },
  { command: 'skill search', meta: skillsSearchMeta },
  { command: 'skill update', meta: skillsUpdateMeta },
  { command: 'self update', meta: updateMeta },
  { command: 'profile install', meta: profileInstallMeta },
  { command: 'profile list', meta: profileListMeta },
  { command: 'profile status', meta: profileStatusMeta },
  { command: 'profile remove', meta: profileRemoveMeta },
];

function formatStructuredHelp(
  meta: AgentCommandMeta,
  command = meta.command,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    command,
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
  if (meta.interaction) {
    result.interaction = meta.interaction;
  }
  if (meta.jsonFields && meta.jsonFields.length > 0) {
    result.json_fields = [...meta.jsonFields];
  }
  return result;
}

function findRegisteredCommand(
  commandPath: string,
): RegisteredCommand | undefined {
  let longest: RegisteredCommand | undefined;
  for (const command of registeredCommands) {
    const matches =
      commandPath === command.command ||
      commandPath.startsWith(`${command.command} `);
    if (
      matches &&
      (!longest || command.command.length > longest.command.length)
    ) {
      longest = command;
    }
  }
  return longest;
}

/**
 * Look up metadata by a runtime command path (e.g. "skill update foo").
 * Public aliases and trailing positionals/options resolve through the same
 * longest-prefix registry used by structured help.
 */
export function findMetaByCommand(
  commandPath: string,
): AgentCommandMeta | undefined {
  return findRegisteredCommand(commandPath)?.meta;
}

function commandPathFromHelp(path: string[]): string {
  return (path[0] === 'allagents' ? path.slice(1) : path).join(' ');
}

function buildStructuredHelp(
  commandPath: string,
  version: string,
): Record<string, unknown> {
  if (!commandPath) {
    return {
      name: 'allagents',
      version,
      description:
        'CLI tool for managing multi-repo AI agent workspaces with plugin synchronization',
      commands: registeredCommands.map(({ command, meta }) =>
        formatStructuredHelp(meta, command),
      ),
    };
  }

  const match = registeredCommands.find(
    (command) => command.command === commandPath,
  );
  if (match) {
    return formatStructuredHelp(match.meta, match.command);
  }

  const matches = registeredCommands.filter((command) =>
    command.command.startsWith(`${commandPath} `),
  );
  if (matches.length > 0) {
    return {
      name: commandPath,
      commands: matches.map(({ command, meta }) =>
        formatStructuredHelp(meta, command),
      ),
    };
  }

  process.stderr.write(`Unknown command: ${commandPath}\n`);
  process.exit(1);
}

function formatHelp(path: string[], version: string): string {
  if (getJsonFields()) {
    process.stderr.write(
      'Error: --json=<fields> is not supported with --help; use --json.\n',
    );
    process.exit(2);
  }
  return formatJsonValue(
    buildStructuredHelp(commandPathFromHelp(path), version),
  );
}

export function createStructuredHelpFormatter(version: string): HelpFormatter {
  return {
    formatCommand: ({ path }) => formatHelp(path, version),
    formatSubcommands: ({ path }) => formatHelp(path, version),
  };
}
