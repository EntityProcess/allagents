import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { generateVscodeWorkspace, getWorkspaceOutputPath } from '../../src/core/vscode-workspace.js';
import { parseWorkspaceConfig } from '../../src/utils/workspace-parser.js';
import { syncWorkspace } from '../../src/core/sync.js';

describe('vscode workspace setup e2e', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `allagents-e2e-vscode-${Date.now()}`);
    mkdirSync(join(testDir, '.allagents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('full generation with template and placeholder substitution', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../Glow
    description: Main project
  - path: ../Glow.Shared
    description: Shared library
plugins: []
clients:
  - copilot
  - claude
vscode:
  output: glow
`,
    );

    writeFileSync(
      join(testDir, '.allagents', 'vscode-template.json'),
      JSON.stringify({
        folders: [
          { path: '{repo:../Glow.Shared}', name: 'Glow.Shared' },
          { path: '/some/other/path', name: 'Extra' },
        ],
        settings: {
          'cSpell.words': ['clusterer', 'polylines'],
          '[vue]': {
            'editor.defaultFormatter': 'esbenp.prettier-vscode',
            'editor.formatOnSave': true,
          },
          'chat.agent.maxRequests': 999,
        },
        launch: {
          configurations: [
            {
              type: 'node',
              request: 'launch',
              name: 'watch-dsk',
              cwd: '{repo:../Glow}/DotNet/HTML/Client/Client',
              runtimeExecutable: 'npm',
              runtimeArgs: ['run', 'watch-dsk'],
            },
          ],
        },
        extensions: {
          recommendations: ['dbaeumer.vscode-eslint', 'esbenp.prettier-vscode'],
        },
      }, null, 2),
    );

    const config = await parseWorkspaceConfig(join(testDir, '.allagents', 'workspace.yaml'));
    const template = JSON.parse(
      readFileSync(join(testDir, '.allagents', 'vscode-template.json'), 'utf-8'),
    );

    const content = generateVscodeWorkspace({
      workspacePath: testDir,
      repositories: config.repositories,
      template,
    });

    // Verify folders: 2 repos + 1 extra (Glow.Shared deduplicated)
    const folders = content.folders as Array<{ path: string; name?: string }>;
    expect(folders).toHaveLength(4); // ".", ../Glow, ../Glow.Shared (from repo), /some/other/path
    expect(folders[0].path).toBe('.');
    expect(folders[1].path).toContain('/Glow');
    expect(folders[2].path).toContain('/Glow.Shared');
    expect(folders[3].path).toBe('/some/other/path');

    // All repo paths should be absolute
    expect(folders[1].path.startsWith('/')).toBe(true);
    expect(folders[2].path.startsWith('/')).toBe(true);

    // Verify settings from template
    const settings = content.settings as Record<string, unknown>;
    expect(settings['cSpell.words']).toEqual(['clusterer', 'polylines']);
    expect(settings['chat.agent.maxRequests']).toBe(999);

    // Verify launch config placeholder was substituted
    const launch = content.launch as { configurations: Array<{ cwd: string }> };
    expect(launch.configurations[0].cwd).toContain('/Glow/DotNet/HTML/Client/Client');
    expect(launch.configurations[0].cwd.startsWith('/')).toBe(true);
    expect(launch.configurations[0].cwd).not.toContain('{repo:');

    // Verify extensions pass through
    const extensions = content.extensions as { recommendations: string[] };
    expect(extensions.recommendations).toHaveLength(2);

    // Verify output path
    const outputPath = getWorkspaceOutputPath(testDir, config.vscode);
    expect(outputPath).toContain('glow.code-workspace');

    // Write and re-read to verify valid JSON
    writeFileSync(outputPath, JSON.stringify(content, null, '\t') + '\n');
    const written = JSON.parse(readFileSync(outputPath, 'utf-8'));
    expect(written.folders).toHaveLength(4);
  });

  test('generation without template uses defaults', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins: []
clients:
  - claude
`,
    );

    const config = await parseWorkspaceConfig(join(testDir, '.allagents', 'workspace.yaml'));
    const content = generateVscodeWorkspace({
      workspacePath: testDir,
      repositories: config.repositories,
      template: undefined,
    });

    const folders = content.folders as Array<{ path: string }>;
    expect(folders).toHaveLength(2);
    expect(folders[0].path).toBe('.');
    expect(folders[1].path).toContain('/myrepo');
    expect(content.settings).toEqual({ 'chat.agent.maxRequests': 999 });
    expect(content.launch).toBeUndefined();
    expect(content.extensions).toBeUndefined();
  });

  test('sync generates .code-workspace when vscode client is configured', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins: []
clients:
  - vscode
`,
    );

    await syncWorkspace(testDir);

    const expectedPath = join(testDir, `${basename(testDir)}.code-workspace`);
    expect(existsSync(expectedPath)).toBe(true);

    const content = JSON.parse(readFileSync(expectedPath, 'utf-8'));
    expect(content.folders).toHaveLength(2);
    expect(content.folders[0].path).toBe('.');
    expect(content.settings).toEqual({ 'chat.agent.maxRequests': 999 });
  });

  test('sync does not generate .code-workspace when vscode client is absent', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins: []
clients:
  - claude
`,
    );

    await syncWorkspace(testDir);

    const expectedPath = join(testDir, `${basename(testDir)}.code-workspace`);
    expect(existsSync(expectedPath)).toBe(false);
  });
});
