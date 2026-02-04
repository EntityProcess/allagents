import type { AgentCommandMeta } from '../help.js';

export const repoAddMeta: AgentCommandMeta = {
  command: 'workspace repo add',
  description: 'Add a repository to workspace config (auto-detects source from git remote)',
  whenToUse: 'To register a repository in your multi-repo workspace without hand-editing YAML',
  examples: [
    'allagents workspace repo add ../Glow',
    'allagents workspace repo add ../Glow --description "Main Glow application"',
  ],
  expectedOutput:
    'Confirms the repository was added with its path and detected remote info. Exit 1 if path already exists.',
  positionals: [
    { name: 'path', type: 'string', required: true, description: 'Relative path to the repository' },
  ],
  options: [
    { flag: '--description', short: '-d', type: 'string', description: 'Human-readable description of the repository' },
  ],
  outputSchema: {
    path: 'string',
    source: 'string | null',
    repo: 'string | null',
    description: 'string | null',
  },
};

export const repoRemoveMeta: AgentCommandMeta = {
  command: 'workspace repo remove',
  description: 'Remove a repository from workspace config',
  whenToUse: 'To remove a repository from your workspace.yaml',
  examples: [
    'allagents workspace repo remove ../Glow',
  ],
  expectedOutput:
    'Confirms the repository was removed. Exit 1 if not found.',
  positionals: [
    { name: 'path', type: 'string', required: true, description: 'Path of the repository to remove' },
  ],
  outputSchema: {
    path: 'string',
  },
};

export const repoListMeta: AgentCommandMeta = {
  command: 'workspace repo list',
  description: 'List repositories in workspace config',
  whenToUse: 'To see which repositories are configured in the workspace',
  examples: [
    'allagents workspace repo list',
  ],
  expectedOutput:
    'Lists each repository with path, source, repo, and description.',
  outputSchema: {
    repositories: [{ path: 'string', source: 'string | null', repo: 'string | null', description: 'string | null' }],
    total: 'number',
  },
};
