import type { AgentCommandMeta } from '../help.js';

export const initMeta: AgentCommandMeta = {
  command: 'workspace init',
  description: 'Create new workspace and sync plugins',
  whenToUse: 'When starting a new project or adding allagents to an existing repo for the first time',
  examples: [
    'allagents workspace init',
    'allagents workspace init ./my-project',
    'allagents workspace init --from ../template-workspace/.allagents/workspace.yaml',
  ],
  expectedOutput:
    'Creates .allagents/workspace.yaml and syncs plugins. Shows sync results per plugin. Exit 0 on success, exit 1 on failure.',
  positionals: [
    { name: 'path', type: 'string', required: false, description: 'Target directory for the workspace (defaults to current directory)' },
  ],
  options: [
    { flag: '--from', type: 'string', description: 'Copy workspace.yaml from existing template/workspace' },
  ],
  outputSchema: {
    path: 'string',
    syncResult: {
      copied: 'number',
      generated: 'number',
      failed: 'number',
      skipped: 'number',
      plugins: [{ plugin: 'string', success: 'boolean', copied: 'number', generated: 'number', failed: 'number' }],
    },
  },
};

export const syncMeta: AgentCommandMeta = {
  command: 'workspace sync',
  description: 'Sync plugins to workspace',
  whenToUse: 'After modifying workspace.yaml or pulling shared config changes',
  examples: [
    'allagents workspace sync',
    'allagents workspace sync --dry-run',
    'allagents workspace sync --client claude',
    'allagents workspace sync --offline',
  ],
  expectedOutput:
    'Lists synced files with status per plugin. Exit 0 on success, exit 1 if any files failed.',
  options: [
    { flag: '--offline', type: 'boolean', description: 'Use cached plugins without fetching latest from remote' },
    { flag: '--dry-run', short: '-n', type: 'boolean', description: 'Simulate sync without making changes' },
    { flag: '--client', short: '-c', type: 'string', description: 'Sync only the specified client (e.g., opencode, claude)' },
  ],
  outputSchema: {
    copied: 'number',
    generated: 'number',
    failed: 'number',
    skipped: 'number',
    plugins: [{ plugin: 'string', success: 'boolean', copied: 'number', generated: 'number', failed: 'number' }],
  },
};

export const statusMeta: AgentCommandMeta = {
  command: 'workspace status',
  description: 'Show sync status of plugins',
  whenToUse: 'To check which plugins are configured and whether they are available locally',
  examples: [
    'allagents workspace status',
  ],
  expectedOutput:
    'Lists all configured plugins with availability status and configured clients. Exit 0 on success, exit 1 if workspace is not initialized.',
  outputSchema: {
    plugins: [{ source: 'string', type: 'string', available: 'boolean' }],
    clients: ['string'],
  },
};

export const pluginInstallMeta: AgentCommandMeta = {
  command: 'workspace plugin install',
  description: 'Install plugin to .allagents/workspace.yaml (supports plugin@marketplace, GitHub URL, or local path)',
  whenToUse: 'To add a new plugin to your workspace and immediately sync it',
  examples: [
    'allagents workspace plugin install my-plugin@official',
    'allagents workspace plugin install https://github.com/user/plugin',
    'allagents workspace plugin install ../local-plugin',
  ],
  expectedOutput:
    'Confirms the plugin was added, then runs sync. Shows sync results. Exit 0 on success, exit 1 on failure.',
  positionals: [
    { name: 'plugin', type: 'string', required: true, description: 'Plugin identifier (plugin@marketplace, GitHub URL, or local path)' },
  ],
  outputSchema: {
    plugin: 'string',
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
  command: 'workspace plugin uninstall',
  description: 'Uninstall plugin from .allagents/workspace.yaml',
  whenToUse: 'To remove a plugin from your workspace config and re-sync',
  examples: [
    'allagents workspace plugin uninstall my-plugin@official',
    'allagents workspace plugin uninstall https://github.com/user/plugin',
  ],
  expectedOutput:
    'Confirms the plugin was removed, then runs sync to clean up. Exit 0 on success, exit 1 on failure.',
  positionals: [
    { name: 'plugin', type: 'string', required: true, description: 'Plugin identifier to uninstall' },
  ],
  outputSchema: {
    plugin: 'string',
    syncResult: {
      copied: 'number',
      generated: 'number',
      failed: 'number',
      skipped: 'number',
      plugins: [{ plugin: 'string', success: 'boolean', copied: 'number', generated: 'number', failed: 'number' }],
    },
  },
};
