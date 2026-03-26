import type { AgentCommandMeta } from '../help.js';

export const initMeta: AgentCommandMeta = {
  command: 'workspace init',
  description: 'Create new workspace and sync plugins',
  whenToUse: 'When starting a new project or adding allagents to an existing repo for the first time',
  examples: [
    'allagents workspace init',
    'allagents workspace init ./my-project',
    'allagents workspace init --from ../template-workspace/.allagents/workspace.yaml',
    'allagents workspace init --client claude,copilot,cursor',
  ],
  expectedOutput:
    'Creates .allagents/workspace.yaml and syncs plugins. Shows sync results per plugin. Exit 0 on success, exit 1 on failure.',
  positionals: [
    { name: 'path', type: 'string', required: false, description: 'Target directory for the workspace (defaults to current directory)' },
  ],
  options: [
    { flag: '--from', type: 'string', description: 'Copy workspace.yaml from existing template/workspace' },
    { flag: '--client', type: 'string', description: 'Comma-separated list of clients (e.g., claude,copilot,cursor)' },
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
  command: 'sync',
  description: 'Sync plugins to workspace',
  whenToUse: 'After modifying workspace.yaml or pulling shared config changes',
  examples: [
    'allagents sync',
    'allagents sync --dry-run',
    'allagents sync --offline',
    'allagents sync --verbose',
  ],
  expectedOutput:
    'Lists synced files with status per plugin. Exit 0 on success, exit 1 if any files failed.',
  options: [
    { flag: '--offline', type: 'boolean', description: 'Use cached plugins without fetching latest from remote' },
    { flag: '--dry-run', short: '-n', type: 'boolean', description: 'Simulate sync without making changes' },
    { flag: '--verbose', short: '-v', type: 'boolean', description: 'Show informational sync messages' },
  ],
  outputSchema: {
    copied: 'number',
    generated: 'number',
    failed: 'number',
    skipped: 'number',
    plugins: [{ plugin: 'string', success: 'boolean', copied: 'number', generated: 'number', failed: 'number' }],
  },
};

export const pruneMeta: AgentCommandMeta = {
  command: 'workspace prune',
  description: 'Remove orphaned plugin references',
  whenToUse: 'After removing a marketplace to clean up stale plugin references in workspace configs',
  examples: [
    'allagents workspace prune',
  ],
  expectedOutput:
    'Lists removed orphaned plugins from both project and user scopes. Exit 0 on success, exit 1 on error.',
  outputSchema: {
    project: { removed: ['string'], kept: ['string'] },
    user: { removed: ['string'], kept: ['string'] },
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
