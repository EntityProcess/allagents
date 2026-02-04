import type { AgentCommandMeta } from '../help.js';

export const setupMeta: AgentCommandMeta = {
  command: 'workspace setup',
  description: 'Generate a VSCode .code-workspace file from workspace.yaml. Repository and plugin paths are resolved to absolute paths. Optionally merges with .allagents/vscode-template.json for settings, launch configs, and extensions.',
  whenToUse: 'When setting up a multi-repo workspace for VSCode with Copilot prompt file locations.',
  examples: [
    'allagents workspace setup',
    'allagents workspace setup --output my-workspace',
  ],
  expectedOutput: 'Path to the generated .code-workspace file.',
  options: [
    {
      flag: '--output',
      short: '-o',
      type: 'string',
      description: 'Output filename (default: vscode.output from workspace.yaml, or <dirname>.code-workspace)',
    },
  ],
};
