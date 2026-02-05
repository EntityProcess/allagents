import { describe, expect, test } from 'bun:test';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildPathPlaceholderMap,
  generateVscodeWorkspace,
  getWorkspaceOutputPath,
  substitutePathPlaceholders,
} from '../../../src/core/vscode-workspace.js';

// Use tmpdir for cross-platform test paths
const testBase = join(tmpdir(), 'allagents-test');

describe('generateVscodeWorkspace', () => {
  test('generates workspace with repository folders resolved to absolute paths', () => {
    const workspacePath = join(testBase, 'myapp');
    const result = generateVscodeWorkspace({
      workspacePath,
      repositories: [
        { path: '../backend' },
        { path: '../frontend' },
      ],
      template: undefined,
    });

    expect(result.folders).toEqual([
      { path: '.' },
      { path: resolve(workspacePath, '../backend') },
      { path: resolve(workspacePath, '../frontend') },
    ]);
  });

  test('applies default settings when no template', () => {
    const result = generateVscodeWorkspace({
      workspacePath: join(testBase, 'myapp'),
      repositories: [],
      template: undefined,
    });

    expect(result.settings).toEqual({
      'chat.agent.maxRequests': 999,
    });
  });

  test('merges template folders after repo folders, deduplicating by path', () => {
    const workspacePath = join(testBase, 'myapp');
    const sharedPath = resolve(workspacePath, '../shared');
    const extraPath = join(testBase, 'extra');

    const result = generateVscodeWorkspace({
      workspacePath,
      repositories: [
        { path: '../backend' },
        { path: '../shared' },
      ],
      template: {
        folders: [
          { path: sharedPath, name: 'SharedLib' }, // duplicate of ../shared
          { path: extraPath, name: 'ExtraLib' },
        ],
      },
    });

    // ../shared resolves to sharedPath — template duplicate removed
    // extra is not a duplicate, so it's kept with its name
    expect(result.folders).toEqual([
      { path: '.' },
      { path: resolve(workspacePath, '../backend') },
      { path: sharedPath },
      { path: extraPath, name: 'ExtraLib' },
    ]);
  });

  test('uses template settings verbatim, no defaults injected', () => {
    const result = generateVscodeWorkspace({
      workspacePath: join(testBase, 'myapp'),
      repositories: [],
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
      workspacePath: join(testBase, 'myapp'),
      repositories: [],
      template,
    });

    expect(result.launch).toEqual(template.launch);
    expect(result.extensions).toEqual(template.extensions);
  });
});

describe('substitutePathPlaceholders', () => {
  // Use resolved paths for the map values
  const glowPath = resolve(testBase, 'Glow');
  const glowSharedPath = resolve(testBase, 'Glow.Shared');
  const pathMap = new Map<string, string>([
    ['../Glow', glowPath],
    ['../Glow.Shared', glowSharedPath],
  ]);

  test('substitutes {path:..} in string values', () => {
    const input = { cwd: '{path:../Glow}/DotNet/Client' };
    const result = substitutePathPlaceholders(input, pathMap);
    expect(result.cwd).toBe(`${glowPath}/DotNet/Client`);
  });

  test('substitutes in nested objects', () => {
    const input = {
      launch: {
        configurations: [
          { cwd: '{path:../Glow}/src', name: 'dev' },
        ],
      },
    };
    const result = substitutePathPlaceholders(input, pathMap);
    expect(result.launch.configurations[0].cwd).toBe(`${glowPath}/src`);
    expect(result.launch.configurations[0].name).toBe('dev');
  });

  test('substitutes in folder path entries', () => {
    const input = {
      folders: [
        { path: '{path:../Glow.Shared}', name: 'Shared' },
      ],
    };
    const result = substitutePathPlaceholders(input, pathMap);
    expect(result.folders[0].path).toBe(glowSharedPath);
  });

  test('leaves strings without placeholders unchanged', () => {
    const input = { name: 'no placeholders here' };
    const result = substitutePathPlaceholders(input, pathMap);
    expect(result.name).toBe('no placeholders here');
  });

  test('leaves non-string values unchanged', () => {
    const input = { count: 999, enabled: true, items: [1, 2, 3] };
    const result = substitutePathPlaceholders(input, pathMap);
    expect(result).toEqual(input);
  });
});

describe('buildPathPlaceholderMap', () => {
  test('registers repositories by relative path', () => {
    const workspacePath = join(testBase, 'workspace');
    const map = buildPathPlaceholderMap(
      [{ path: '../Glow' }, { path: '../Glow.Shared' }],
      workspacePath,
    );

    expect(map.get('../Glow')).toBe(resolve(workspacePath, '../Glow'));
    expect(map.get('../Glow.Shared')).toBe(resolve(workspacePath, '../Glow.Shared'));
  });

  test('resolves paths to absolute paths', () => {
    const workspacePath = join(testBase, 'workspace');
    const map = buildPathPlaceholderMap(
      [{ path: '../Glow', repo: 'WiseTechGlobal/Glow' }],
      workspacePath,
    );

    // Path should be absolute (not relative)
    const resolved = map.get('../Glow');
    expect(resolved).toBeDefined();
    expect(resolved).not.toContain('..');
  });
});

describe('getWorkspaceOutputPath', () => {
  test('uses vscode.output from config', () => {
    const workspacePath = join(testBase, 'myapp');
    const result = getWorkspaceOutputPath(workspacePath, { output: 'glow' });
    expect(result).toBe(join(workspacePath, 'glow.code-workspace'));
  });

  test('defaults to dirname when no config', () => {
    const workspacePath = join(testBase, 'myapp');
    const result = getWorkspaceOutputPath(workspacePath, undefined);
    expect(result).toBe(join(workspacePath, 'myapp.code-workspace'));
  });

  test('does not double-add .code-workspace extension', () => {
    const workspacePath = join(testBase, 'myapp');
    const result = getWorkspaceOutputPath(workspacePath, { output: 'test.code-workspace' });
    expect(result).toBe(join(workspacePath, 'test.code-workspace'));
  });
});
