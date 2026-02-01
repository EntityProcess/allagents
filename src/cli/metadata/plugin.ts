import type { CommandMeta } from '../help.js';

export const marketplaceListMeta: CommandMeta = {
  description: 'List registered marketplaces',
  whenToUse: 'To see which plugin marketplaces are currently registered on your system',
  examples: [
    'allagents plugin marketplace list',
  ],
  expectedOutput:
    'Shows each marketplace with source, path, and last updated date. If none registered, shows well-known marketplace suggestions.',
};

export const marketplaceAddMeta: CommandMeta = {
  description: 'Add a marketplace from GitHub URL, owner/repo, local path, or well-known name',
  whenToUse: 'To register a new marketplace so its plugins become available for installation',
  examples: [
    'allagents plugin marketplace add official',
    'allagents plugin marketplace add https://github.com/user/marketplace',
    'allagents plugin marketplace add user/marketplace --name custom',
    'allagents plugin marketplace add ../local-marketplace',
  ],
  expectedOutput:
    'Confirms the marketplace was added with its name and local path. Exit 1 if the source is invalid or unreachable.',
};

export const marketplaceRemoveMeta: CommandMeta = {
  description: 'Remove a marketplace from registry (does not delete files)',
  whenToUse: 'To unregister a marketplace you no longer need, without deleting its cached files',
  examples: [
    'allagents plugin marketplace remove official',
    'allagents plugin marketplace remove custom',
  ],
  expectedOutput:
    'Confirms removal from registry and notes that files were not deleted. Exit 1 if marketplace not found.',
};

export const marketplaceUpdateMeta: CommandMeta = {
  description: 'Update marketplace(s) from remote',
  whenToUse: 'To pull the latest plugin definitions from remote marketplace repositories',
  examples: [
    'allagents plugin marketplace update',
    'allagents plugin marketplace update official',
  ],
  expectedOutput:
    'Shows update status per marketplace. Exit 0 if all succeed, exit 1 if any fail.',
};

export const pluginListMeta: CommandMeta = {
  description: 'List available plugins from registered marketplaces',
  whenToUse: 'To browse available plugins before installing one into your workspace',
  examples: [
    'allagents plugin list',
    'allagents plugin list official',
  ],
  expectedOutput:
    'Lists plugins grouped by marketplace with install-ready names (plugin@marketplace). Shows total count.',
};

export const pluginValidateMeta: CommandMeta = {
  description: 'Validate plugin structure at the given path',
  whenToUse: 'When developing a plugin, to check that its structure conforms to the expected format',
  examples: [
    'allagents plugin validate ./my-plugin',
    'allagents plugin validate ../shared-plugins/eslint-config',
  ],
  expectedOutput:
    'Reports validation results. Exit 0 if valid, exit 1 if structure errors are found.',
};
