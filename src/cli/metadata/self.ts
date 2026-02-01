import type { CommandMeta } from '../help.js';

export const updateMeta: CommandMeta = {
  description: 'Update allagents to the latest version',
  whenToUse: 'To upgrade allagents to the latest published version using your package manager',
  examples: [
    'allagents self update',
    'allagents self update --npm',
    'allagents self update --bun',
  ],
  expectedOutput:
    'Shows current version, runs the update, then shows the new version. Exit 1 if the update fails.',
};
