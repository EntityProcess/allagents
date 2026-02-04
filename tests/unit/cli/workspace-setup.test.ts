import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { generateVscodeWorkspace, getWorkspaceOutputPath } from '../../../src/core/vscode-workspace.js';
import { parseWorkspaceConfig } from '../../../src/utils/workspace-parser.js';

describe('workspace setup integration', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `allagents-test-vscode-${Date.now()}`);
    mkdirSync(join(testDir, '.allagents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('generates workspace from yaml without template', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../backend
  - path: ../frontend
plugins: []
clients:
  - claude
`,
    );

    const config = await parseWorkspaceConfig(join(testDir, '.allagents', 'workspace.yaml'));
    const result = generateVscodeWorkspace({
      workspacePath: testDir,
      repositories: config.repositories,

      template: undefined,
    });

    for (const folder of result.folders as Array<{ path: string }>) {
      expect(folder.path.startsWith('/')).toBe(true);
    }

    expect(result.settings).toEqual({ 'chat.agent.maxRequests': 999 });
  });

  test('generates workspace from yaml with template', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins: []
clients:
  - copilot
`,
    );

    const template = {
      settings: {
        'cSpell.words': ['myword'],
        'chat.agent.maxRequests': 50,
      },
      launch: {
        configurations: [
          { type: 'node', name: 'dev', cwd: '{repo:../myrepo}/src' },
        ],
      },
    };
    writeFileSync(
      join(testDir, '.allagents', 'vscode-template.json'),
      JSON.stringify(template, null, 2),
    );

    const config = await parseWorkspaceConfig(join(testDir, '.allagents', 'workspace.yaml'));
    const templateContent = JSON.parse(
      readFileSync(join(testDir, '.allagents', 'vscode-template.json'), 'utf-8'),
    );

    const result = generateVscodeWorkspace({
      workspacePath: testDir,
      repositories: config.repositories,

      template: templateContent,
    });

    // Settings from template
    const settings = result.settings as Record<string, unknown>;
    expect(settings['cSpell.words']).toEqual(['myword']);
    expect(settings['chat.agent.maxRequests']).toBe(50);

    // Launch config with substituted path
    const launch = result.launch as { configurations: Array<{ cwd: string }> };
    expect(launch.configurations[0].cwd).toContain('/myrepo/src');
    expect(launch.configurations[0].cwd.startsWith('/')).toBe(true);
  });

  test('uses vscode.output for filename', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories: []
plugins: []
clients:
  - claude
vscode:
  output: my-project
`,
    );

    const config = await parseWorkspaceConfig(join(testDir, '.allagents', 'workspace.yaml'));
    const outputPath = getWorkspaceOutputPath(testDir, config.vscode);
    expect(outputPath).toBe(join(testDir, 'my-project.code-workspace'));
  });
});
