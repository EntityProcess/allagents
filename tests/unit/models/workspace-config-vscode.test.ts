import { describe, expect, test } from 'bun:test';
import { WorkspaceConfigSchema } from '../../../src/models/workspace-config.js';

describe('WorkspaceConfig vscode section', () => {
  test('parses config without vscode section', () => {
    const config = WorkspaceConfigSchema.parse({
      repositories: [],
      plugins: [],
      clients: ['claude'],
    });
    expect(config.vscode).toBeUndefined();
  });

  test('parses config with vscode.output', () => {
    const config = WorkspaceConfigSchema.parse({
      repositories: [],
      plugins: [],
      clients: ['claude'],
      vscode: {
        output: 'my-workspace.code-workspace',
      },
    });
    expect(config.vscode).toBeDefined();
    expect(config.vscode!.output).toBe('my-workspace.code-workspace');
  });

  test('parses vscode section with only output', () => {
    const config = WorkspaceConfigSchema.parse({
      repositories: [],
      plugins: [],
      clients: ['claude'],
      vscode: { output: 'test' },
    });
    expect(config.vscode!.output).toBe('test');
  });
});
