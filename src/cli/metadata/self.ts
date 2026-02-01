import type { AgentCommandMeta } from '../help.js';

export const updateMeta: AgentCommandMeta = {
  command: 'self update',
  description: 'Update allagents to the latest version',
  whenToUse: 'To upgrade allagents to the latest published version using your package manager',
  examples: [
    'allagents self update',
    'allagents self update --npm',
    'allagents self update --bun',
  ],
  expectedOutput:
    'Shows current version, runs the update, then shows the new version. Exit 1 if the update fails.',
  options: [
    { flag: '--npm', type: 'boolean', description: 'Force update using npm' },
    { flag: '--bun', type: 'boolean', description: 'Force update using bun' },
  ],
  outputSchema: {
    previousVersion: 'string',
    newVersion: 'string',
    packageManager: 'string',
  },
};
