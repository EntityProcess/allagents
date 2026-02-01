import type { CommandMeta } from '../help.js';

export const initMeta: CommandMeta = {
  description: 'Create new workspace and sync plugins',
  whenToUse: 'When starting a new project or adding allagents to an existing repo for the first time',
  examples: [
    'allagents workspace init',
    'allagents workspace init ./my-project',
    'allagents workspace init --from ../template-workspace/.allagents/workspace.yaml',
  ],
  expectedOutput:
    'Creates .allagents/workspace.yaml and syncs plugins. Shows sync results per plugin. Exit 0 on success, exit 1 on failure.',
};

export const syncMeta: CommandMeta = {
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
};

export const statusMeta: CommandMeta = {
  description: 'Show sync status of plugins',
  whenToUse: 'To check which plugins are configured and whether they are available locally',
  examples: [
    'allagents workspace status',
  ],
  expectedOutput:
    'Lists all configured plugins with availability status and configured clients. Exit 0 on success, exit 1 if workspace is not initialized.',
};

export const pluginInstallMeta: CommandMeta = {
  description: 'Install plugin to .allagents/workspace.yaml (supports plugin@marketplace, GitHub URL, or local path)',
  whenToUse: 'To add a new plugin to your workspace and immediately sync it',
  examples: [
    'allagents workspace plugin install my-plugin@official',
    'allagents workspace plugin install https://github.com/user/plugin',
    'allagents workspace plugin install ../local-plugin',
  ],
  expectedOutput:
    'Confirms the plugin was added, then runs sync. Shows sync results. Exit 0 on success, exit 1 on failure.',
};

export const pluginUninstallMeta: CommandMeta = {
  description: 'Uninstall plugin from .allagents/workspace.yaml',
  whenToUse: 'To remove a plugin from your workspace config and re-sync',
  examples: [
    'allagents workspace plugin uninstall my-plugin@official',
    'allagents workspace plugin uninstall https://github.com/user/plugin',
  ],
  expectedOutput:
    'Confirms the plugin was removed, then runs sync to clean up. Exit 0 on success, exit 1 on failure.',
};
