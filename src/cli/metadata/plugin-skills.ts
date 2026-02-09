import type { AgentCommandMeta } from '../help.js';

export const skillsListMeta: AgentCommandMeta = {
  command: 'plugin skills list',
  description: 'List all skills from installed plugins',
  whenToUse: 'To see available skills and their enabled/disabled status',
  examples: [
    'allagents plugin skills list',
    'allagents plugin skills list --scope user',
  ],
  expectedOutput: 'Lists skills grouped by plugin with enabled/disabled status',
  options: [
    { flag: '--scope', short: '-s', type: 'string', description: 'Scope: "project" (default) or "user"' },
  ],
  outputSchema: {
    skills: [{ name: 'string', plugin: 'string', disabled: 'boolean' }],
  },
};

export const skillsRemoveMeta: AgentCommandMeta = {
  command: 'plugin skills remove',
  description: 'Disable a skill (exclude from sync)',
  whenToUse: 'To prevent a specific skill from being synced to your workspace',
  examples: [
    'allagents plugin skills remove brainstorming',
    'allagents plugin skills remove brainstorming --plugin superpowers',
    'allagents plugin skills remove brainstorming --scope user',
  ],
  expectedOutput: 'Confirms skill was disabled and runs sync',
  positionals: [
    { name: 'skill', type: 'string', required: true, description: 'Skill name to disable' },
  ],
  options: [
    { flag: '--scope', short: '-s', type: 'string', description: 'Scope: "project" (default) or "user"' },
    { flag: '--plugin', short: '-p', type: 'string', description: 'Plugin name (required if skill exists in multiple plugins)' },
  ],
  outputSchema: {
    skill: 'string',
    plugin: 'string',
    syncResult: { copied: 'number', failed: 'number' },
  },
};

export const skillsAddMeta: AgentCommandMeta = {
  command: 'plugin skills add',
  description: 'Re-enable a previously disabled skill',
  whenToUse: 'To re-enable a skill that was previously disabled',
  examples: [
    'allagents plugin skills add brainstorming',
    'allagents plugin skills add brainstorming --plugin superpowers',
  ],
  expectedOutput: 'Confirms skill was enabled and runs sync',
  positionals: [
    { name: 'skill', type: 'string', required: true, description: 'Skill name to enable' },
  ],
  options: [
    { flag: '--scope', short: '-s', type: 'string', description: 'Scope: "project" (default) or "user"' },
    { flag: '--plugin', short: '-p', type: 'string', description: 'Plugin name (required if skill exists in multiple plugins)' },
  ],
  outputSchema: {
    skill: 'string',
    plugin: 'string',
    syncResult: { copied: 'number', failed: 'number' },
  },
};
