import type { AgentCommandMeta } from '../help.js';

export const skillsListMeta: AgentCommandMeta = {
  command: 'skill list',
  description: 'List all skills from installed plugins',
  whenToUse: 'To see available skills and their enabled/disabled status',
  examples: [
    'allagents skill list',
    'allagents skill list --scope user',
    'allagents --json=name,plugin skill list',
  ],
  expectedOutput: 'Lists skills grouped by plugin with enabled/disabled status',
  options: [
    { flag: '--scope', short: '-s', type: 'string', description: 'Scope: "project" (default) or "user"' },
  ],
  outputSchema: {
    skills: [{ name: 'string', plugin: 'string', disabled: 'boolean' }],
  },
  jsonFields: ['name', 'plugin', 'disabled'] as const,
};

export const skillsRemoveMeta: AgentCommandMeta = {
  command: 'skill remove',
  description: 'Disable a skill (exclude from sync)',
  whenToUse: 'To prevent a specific skill from being synced to your workspace',
  examples: [
    'allagents skill remove brainstorming',
    'allagents skill remove brainstorming --plugin superpowers',
    'allagents skill remove brainstorming --scope user',
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

export const skillsSearchMeta: AgentCommandMeta = {
  command: 'skill search',
  description: 'Search GitHub for skills by querying SKILL.md files via the Code Search API',
  whenToUse:
    'To discover available skills from public GitHub repositories without leaving the CLI. Bridges "I want a skill that does X" → install.',
  examples: [
    'allagents skill search terraform',
    'allagents skill search terraform --owner hashicorp',
    'allagents skill search docs --page 2 --limit 10',
    'allagents --json skill search docs --limit 5',
  ],
  expectedOutput: 'Ranked list of matching skills with repo, path, and description',
  positionals: [
    { name: 'query', type: 'string', required: true, description: 'Search query (≥2 characters).' },
  ],
  options: [
    { flag: '--owner', type: 'string', description: 'Scope to a single GitHub owner (org or user).' },
    { flag: '--page', type: 'string', description: 'Result page (1-indexed, default 1).' },
    { flag: '--limit', type: 'string', description: 'Results per page (1–100, default 30).' },
  ],
  outputSchema: {
    query: 'string',
    items: [{ name: 'string', repo: 'string', path: 'string', description: 'string', sha: 'string' }],
    total: 'number',
    truncated: 'boolean',
  },
};

export const skillsAddMeta: AgentCommandMeta = {
  command: 'skill add',
  description: 'Add a skill from a plugin, or re-enable a previously disabled skill',
  whenToUse:
    'To add a skill from a GitHub repo or marketplace plugin, or to re-enable a skill that was previously disabled',
  examples: [
    'allagents skill add reddit --from ReScienceLab/opc-skills',
    'allagents skill add https://github.com/owner/repo/tree/main/skills/my-skill',
    'allagents skill add brainstorming',
    'allagents skill add brainstorming --plugin superpowers',
    'allagents skill add --list --from rstackjs/agent-skills',
    'allagents skill add --all --from rstackjs/agent-skills',
  ],
  expectedOutput: 'Confirms skill was enabled and runs sync',
  positionals: [
    {
      name: 'skill',
      type: 'string',
      required: false,
      description: 'Skill name to add, or a GitHub URL pointing to a skill. Omit with --list or --all.',
    },
  ],
  options: [
    { flag: '--scope', short: '-s', type: 'string', description: 'Scope: "project" (default) or "user"' },
    {
      flag: '--plugin',
      short: '-p',
      type: 'string',
      description: 'Plugin name (required if skill exists in multiple plugins)',
    },
    {
      flag: '--from',
      short: '-f',
      type: 'string',
      description:
        'Plugin source (GitHub URL, owner/repo, or plugin@marketplace) to install if the skill is not already available',
    },
    {
      flag: '--list',
      short: '-l',
      type: 'boolean',
      description: 'List skills at the --from source without installing',
    },
    {
      flag: '--all',
      type: 'boolean',
      description: 'Install every skill from the --from source',
    },
  ],
  outputSchema: {
    skill: 'string',
    plugin: 'string',
    syncResult: { copied: 'number', failed: 'number' },
  },
};
