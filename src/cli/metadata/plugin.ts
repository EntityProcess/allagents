import type { AgentCommandMeta } from '../help.js';

export const marketplaceListMeta: AgentCommandMeta = {
  command: 'plugin marketplace list',
  description: 'List registered marketplaces',
  whenToUse: 'To see which plugin marketplaces are currently registered on your system',
  examples: [
    'allagents plugin marketplace list',
  ],
  expectedOutput:
    'Shows each marketplace with source, path, and last updated date. If none registered, shows well-known marketplace suggestions.',
  outputSchema: {
    marketplaces: [{ name: 'string', source: { type: 'string', location: 'string' }, path: 'string', lastUpdated: 'string | null' }],
  },
};

export const marketplaceAddMeta: AgentCommandMeta = {
  command: 'plugin marketplace add',
  description: 'Add a marketplace from GitHub URL, owner/repo, local path, or well-known name',
  whenToUse: 'To register a new marketplace so its plugins become available for installation',
  examples: [
    'allagents plugin marketplace add official',
    'allagents plugin marketplace add https://github.com/user/marketplace',
    'allagents plugin marketplace add user/marketplace --name custom',
    'allagents plugin marketplace add ../local-marketplace',
    'allagents plugin marketplace add owner/repo --branch feat/v2 --name custom',
  ],
  expectedOutput:
    'Confirms the marketplace was added with its name and local path. Exit 1 if the source is invalid or unreachable.',
  positionals: [
    { name: 'source', type: 'string', required: true, description: 'GitHub URL, owner/repo, local path, or well-known marketplace name' },
  ],
  options: [
    { flag: '--name', short: '-n', type: 'string', description: 'Custom name for the marketplace' },
    { flag: '--branch', short: '-b', type: 'string', description: 'Branch to checkout after cloning (requires --name)' },
  ],
  outputSchema: {
    marketplace: { name: 'string', path: 'string' },
  },
};

export const marketplaceRemoveMeta: AgentCommandMeta = {
  command: 'plugin marketplace remove',
  description: 'Remove a marketplace from registry (does not delete files)',
  whenToUse: 'To unregister a marketplace you no longer need, without deleting its cached files',
  examples: [
    'allagents plugin marketplace remove official',
    'allagents plugin marketplace remove custom',
  ],
  expectedOutput:
    'Confirms removal from registry and notes that files were not deleted. Exit 1 if marketplace not found.',
  positionals: [
    { name: 'name', type: 'string', required: true, description: 'Name of the marketplace to remove' },
  ],
  outputSchema: {
    name: 'string',
    path: 'string',
  },
};

export const marketplaceUpdateMeta: AgentCommandMeta = {
  command: 'plugin marketplace update',
  description: 'Update marketplace(s) from remote',
  whenToUse: 'To pull the latest plugin definitions from remote marketplace repositories',
  examples: [
    'allagents plugin marketplace update',
    'allagents plugin marketplace update official',
  ],
  expectedOutput:
    'Shows update status per marketplace. Exit 0 if all succeed, exit 1 if any fail.',
  positionals: [
    { name: 'name', type: 'string', required: false, description: 'Specific marketplace to update (updates all if omitted)' },
  ],
  outputSchema: {
    results: [{ name: 'string', success: 'boolean', error: 'string | undefined' }],
    succeeded: 'number',
    failed: 'number',
  },
};

export const pluginListMeta: AgentCommandMeta = {
  command: 'plugin list',
  description: 'List available plugins from registered marketplaces',
  whenToUse: 'To browse available plugins before installing one into your workspace',
  examples: [
    'allagents plugin list',
    'allagents plugin list official',
  ],
  expectedOutput:
    'Lists plugins grouped by marketplace with install-ready names (plugin@marketplace). Shows total count.',
  positionals: [
    { name: 'marketplace', type: 'string', required: false, description: 'Filter plugins by marketplace name' },
  ],
  outputSchema: {
    plugins: [{ name: 'string', marketplace: 'string' }],
    total: 'number',
  },
};

export const pluginValidateMeta: AgentCommandMeta = {
  command: 'plugin validate',
  description: 'Validate plugin structure at the given path',
  whenToUse: 'When developing a plugin, to check that its structure conforms to the expected format',
  examples: [
    'allagents plugin validate ./my-plugin',
    'allagents plugin validate ../shared-plugins/eslint-config',
  ],
  expectedOutput:
    'Reports validation results. Exit 0 if valid, exit 1 if structure errors are found.',
  positionals: [
    { name: 'path', type: 'string', required: true, description: 'Path to the plugin directory to validate' },
  ],
  outputSchema: {
    path: 'string',
    valid: 'boolean',
    message: 'string',
  },
};

export const pluginInstallMeta: AgentCommandMeta = {
  command: 'plugin install',
  description: 'Install plugin to workspace (supports plugin@marketplace, GitHub URL, or local path). Use --scope user for user-level install.',
  whenToUse: 'To add a new plugin to your workspace (or user-level config with --scope user) and immediately sync it',
  examples: [
    'allagents plugin install my-plugin@official',
    'allagents plugin install https://github.com/user/plugin',
    'allagents plugin install ../local-plugin',
    'allagents plugin install my-plugin@official --scope user',
  ],
  expectedOutput:
    'Confirms the plugin was added, then runs sync. Shows sync results. Exit 0 on success, exit 1 on failure.',
  positionals: [
    { name: 'plugin', type: 'string', required: true, description: 'Plugin identifier (plugin@marketplace, GitHub URL, or local path)' },
  ],
  options: [
    { flag: '--scope', short: '-s', type: 'string', description: 'Installation scope: "project" (default) or "user"' },
  ],
  outputSchema: {
    plugin: 'string',
    scope: 'string',
    autoRegistered: 'string | null',
    syncResult: {
      copied: 'number',
      generated: 'number',
      failed: 'number',
      skipped: 'number',
      plugins: [{ plugin: 'string', success: 'boolean', copied: 'number', generated: 'number', failed: 'number' }],
    },
  },
};

export const pluginUninstallMeta: AgentCommandMeta = {
  command: 'plugin uninstall',
  description: 'Uninstall plugin from workspace config. Use --scope user for user-level uninstall.',
  whenToUse: 'To remove a plugin from your workspace (or user-level config with --scope user) and re-sync',
  examples: [
    'allagents plugin uninstall my-plugin@official',
    'allagents plugin uninstall https://github.com/user/plugin',
    'allagents plugin uninstall my-plugin@official --scope user',
  ],
  expectedOutput:
    'Confirms the plugin was removed, then runs sync to clean up. Exit 0 on success, exit 1 on failure.',
  positionals: [
    { name: 'plugin', type: 'string', required: true, description: 'Plugin identifier to uninstall' },
  ],
  options: [
    { flag: '--scope', short: '-s', type: 'string', description: 'Installation scope: "project" (default) or "user"' },
  ],
  outputSchema: {
    plugin: 'string',
    scope: 'string',
    syncResult: {
      copied: 'number',
      generated: 'number',
      failed: 'number',
      skipped: 'number',
      plugins: [{ plugin: 'string', success: 'boolean', copied: 'number', generated: 'number', failed: 'number' }],
    },
  },
};

export const pluginUpdateMeta: AgentCommandMeta = {
  command: 'plugin update',
  description: 'Update installed plugins to latest version and sync plugin files (skips AGENTS.md)',
  whenToUse: 'To pull the latest changes for installed plugins and deploy plugin files only, without regenerating AGENTS.md',
  examples: [
    'allagents plugin update',
    'allagents plugin update my-plugin@official',
    'allagents plugin update --scope user',
  ],
  expectedOutput:
    'Shows update status per plugin, then syncs plugin files. Exit 0 if all succeed, exit 1 if any fail.',
  positionals: [
    { name: 'plugin', type: 'string', required: false, description: 'Specific plugin to update (updates all if omitted)' },
  ],
  options: [
    { flag: '--scope', short: '-s', type: 'string', description: 'Installation scope: "project" (default), "user", or "all"' },
  ],
  outputSchema: {
    results: [{ plugin: 'string', success: 'boolean', action: 'string', error: 'string | undefined' }],
    updated: 'number',
    skipped: 'number',
    failed: 'number',
    syncResult: {
      copied: 'number',
      generated: 'number',
      failed: 'number',
      skipped: 'number',
    },
  },
};
