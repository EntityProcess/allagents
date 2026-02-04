import { describe, expect, test } from 'bun:test';
import {
  generateVscodeWorkspace,
  getWorkspaceOutputPath,
  substituteRepoPlaceholders,
} from '../../../src/core/vscode-workspace.js';

describe('generateVscodeWorkspace', () => {
  test('generates workspace with repository folders resolved to absolute paths', () => {
    const result = generateVscodeWorkspace({
      workspacePath: '/home/user/projects/myapp',
      repositories: [
        { path: '../backend' },
        { path: '../frontend' },
      ],
      plugins: [],
      template: undefined,
    });

    expect(result.folders).toEqual([
      { path: '/home/user/projects/backend' },
      { path: '/home/user/projects/frontend' },
    ]);
  });

  test('applies default settings when no template', () => {
    const result = generateVscodeWorkspace({
      workspacePath: '/home/user/projects/myapp',
      repositories: [],
      plugins: [],
      template: undefined,
    });

    expect(result.settings).toEqual({
      'chat.agent.maxRequests': 999,
    });
  });

  test('includes plugin folders with display names', () => {
    const result = generateVscodeWorkspace({
      workspacePath: '/home/user/projects/myapp',
      repositories: [],
      plugins: [
        {
          resolvedPath: '/home/user/.allagents/marketplaces/official/plugins/code-review',
          displayName: 'code-review',
        },
      ],
      template: undefined,
    });

    expect(result.folders).toEqual([
      {
        path: '/home/user/.allagents/marketplaces/official/plugins/code-review',
        name: 'code-review',
      },
    ]);
  });

  test('merges template folders after repo folders, deduplicating by path', () => {
    const result = generateVscodeWorkspace({
      workspacePath: '/home/user/projects/myapp',
      repositories: [
        { path: '../backend' },
        { path: '../shared' },
      ],
      plugins: [],
      template: {
        folders: [
          { path: '/home/user/projects/shared', name: 'SharedLib' },
          { path: '/home/user/projects/extra' },
        ],
      },
    });

    // ../shared resolves to /home/user/projects/shared — template duplicate removed
    expect(result.folders).toEqual([
      { path: '/home/user/projects/backend' },
      { path: '/home/user/projects/shared' },
      { path: '/home/user/projects/extra' },
    ]);
  });

  test('uses template settings verbatim, no defaults injected', () => {
    const result = generateVscodeWorkspace({
      workspacePath: '/home/user/projects/myapp',
      repositories: [],
      plugins: [],
      template: {
        settings: {
          'chat.agent.maxRequests': 50,
          'cSpell.words': ['foo'],
        },
      },
    });

    expect(result.settings).toEqual({
      'chat.agent.maxRequests': 50,
      'cSpell.words': ['foo'],
    });
  });

  test('passes through template launch/extensions verbatim', () => {
    const template = {
      settings: { 'chat.agent.maxRequests': 999 },
      launch: {
        configurations: [
          { type: 'node', name: 'dev', runtimeExecutable: 'npm' },
        ],
      },
      extensions: {
        recommendations: ['dbaeumer.vscode-eslint'],
      },
    };

    const result = generateVscodeWorkspace({
      workspacePath: '/home/user/projects/myapp',
      repositories: [],
      plugins: [],
      template,
    });

    expect(result.launch).toEqual(template.launch);
    expect(result.extensions).toEqual(template.extensions);
  });

  test('adds prompt/instruction location settings from plugins', () => {
    const result = generateVscodeWorkspace({
      workspacePath: '/home/user/projects/myapp',
      repositories: [],
      plugins: [
        {
          resolvedPath: '/home/user/.allagents/cache/code-review',
          displayName: 'code-review',
          hasPrompts: true,
          hasInstructions: true,
        },
      ],
      template: {
        settings: { 'chat.agent.maxRequests': 999 },
      },
    });

    expect(result.settings['chat.promptFilesLocations']).toEqual({
      '/home/user/.allagents/cache/code-review/prompts/**/*.prompt.md': true,
    });
    expect(result.settings['chat.instructionsFilesLocations']).toEqual({
      '/home/user/.allagents/cache/code-review/instructions/**/*.instructions.md': true,
    });
  });
});

describe('substituteRepoPlaceholders', () => {
  const repoMap = new Map<string, string>([
    ['../Glow', '/home/user/projects/Glow'],
    ['../Glow.Shared', '/home/user/projects/Glow.Shared'],
  ]);

  test('substitutes {repo:..} in string values', () => {
    const input = { cwd: '{repo:../Glow}/DotNet/Client' };
    const result = substituteRepoPlaceholders(input, repoMap);
    expect(result.cwd).toBe('/home/user/projects/Glow/DotNet/Client');
  });

  test('substitutes in nested objects', () => {
    const input = {
      launch: {
        configurations: [
          { cwd: '{repo:../Glow}/src', name: 'dev' },
        ],
      },
    };
    const result = substituteRepoPlaceholders(input, repoMap);
    expect(result.launch.configurations[0].cwd).toBe('/home/user/projects/Glow/src');
    expect(result.launch.configurations[0].name).toBe('dev');
  });

  test('substitutes in folder path entries', () => {
    const input = {
      folders: [
        { path: '{repo:../Glow.Shared}', name: 'Shared' },
      ],
    };
    const result = substituteRepoPlaceholders(input, repoMap);
    expect(result.folders[0].path).toBe('/home/user/projects/Glow.Shared');
  });

  test('leaves strings without placeholders unchanged', () => {
    const input = { name: 'no placeholders here' };
    const result = substituteRepoPlaceholders(input, repoMap);
    expect(result.name).toBe('no placeholders here');
  });

  test('leaves non-string values unchanged', () => {
    const input = { count: 999, enabled: true, items: [1, 2, 3] };
    const result = substituteRepoPlaceholders(input, repoMap);
    expect(result).toEqual(input);
  });
});

describe('getWorkspaceOutputPath', () => {
  test('uses --output flag when provided', () => {
    const result = getWorkspaceOutputPath('/home/user/myapp', undefined, 'custom');
    expect(result).toBe('/home/user/myapp/custom.code-workspace');
  });

  test('uses vscode.output from config', () => {
    const result = getWorkspaceOutputPath('/home/user/myapp', { output: 'glow' });
    expect(result).toBe('/home/user/myapp/glow.code-workspace');
  });

  test('--output flag takes priority over vscode.output', () => {
    const result = getWorkspaceOutputPath('/home/user/myapp', { output: 'glow' }, 'override');
    expect(result).toBe('/home/user/myapp/override.code-workspace');
  });

  test('defaults to dirname when no override', () => {
    const result = getWorkspaceOutputPath('/home/user/myapp', undefined);
    expect(result).toBe('/home/user/myapp/myapp.code-workspace');
  });

  test('does not double-add .code-workspace extension', () => {
    const result = getWorkspaceOutputPath('/home/user/myapp', { output: 'test.code-workspace' });
    expect(result).toBe('/home/user/myapp/test.code-workspace');
  });
});
