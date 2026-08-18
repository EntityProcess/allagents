import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(workdir: string, homeDir: string, args: string[]): CliResult {
  const cliEntry = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');
  const proc = Bun.spawnSync(['bun', 'run', cliEntry, '--json', ...args], {
    cwd: workdir,
    env: {
      ...process.env,
      ALLAGENTS_TEST_HOME: homeDir,
      HOME: homeDir,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });

  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

describe('plugin update e2e', () => {
  let rootDir: string;
  let workspaceDir: string;
  let marketplaceDir: string;
  let homeDir: string;

  beforeEach(() => {
    rootDir = join(
      tmpdir(),
      `allagents-e2e-plugin-update-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    workspaceDir = join(rootDir, 'workspace');
    marketplaceDir = join(rootDir, 'marketplace');
    homeDir = join(rootDir, 'home');

    mkdirSync(join(workspaceDir, '.allagents'), { recursive: true });
    mkdirSync(join(marketplaceDir, '.claude-plugin'), { recursive: true });
    mkdirSync(join(marketplaceDir, 'plugins', 'demo', 'skills', 'demo'), { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories: []\nplugins: []\nclients:\n  - claude\nversion: 2\n',
      'utf-8',
    );
    writeFileSync(
      join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'project-marketplace',
        description: 'Project marketplace update fixture',
        plugins: [
          {
            name: 'demo',
            description: 'Demo plugin',
            source: './plugins/demo',
          },
        ],
      }),
      'utf-8',
    );
    writeFileSync(
      join(marketplaceDir, 'plugins', 'demo', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Demo skill\n---\n# Demo\n',
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  test('updates a plugin from a project-scoped marketplace', () => {
    const addResult = runCli(workspaceDir, homeDir, [
      'plugin',
      'marketplace',
      'add',
      marketplaceDir,
      '--scope',
      'project',
    ]);
    expect(addResult.exitCode).toBe(0);

    const installResult = runCli(workspaceDir, homeDir, [
      'plugin',
      'install',
      'demo@project-marketplace',
      '--scope',
      'project',
    ]);
    expect(installResult.exitCode).toBe(0);

    const updateResult = runCli(workspaceDir, homeDir, [
      'plugin',
      'update',
      'demo@project-marketplace',
      '--scope',
      'project',
    ]);

    expect(updateResult.exitCode).toBe(0);
    const payload = JSON.parse(updateResult.stdout);
    expect(payload.success).toBe(true);
    expect(payload.data.results).toEqual([
      {
        plugin: 'demo@project-marketplace',
        success: true,
        action: 'updated',
      },
    ]);
  });

  test('keeps user-scoped marketplace updates isolated from the workspace', () => {
    const addResult = runCli(workspaceDir, homeDir, [
      'plugin',
      'marketplace',
      'add',
      marketplaceDir,
      '--scope',
      'user',
    ]);
    expect(addResult.exitCode).toBe(0);

    const installResult = runCli(workspaceDir, homeDir, [
      'plugin',
      'install',
      'demo@project-marketplace',
      '--scope',
      'user',
    ]);
    expect(installResult.exitCode).toBe(0);

    const updateResult = runCli(workspaceDir, homeDir, [
      'plugin',
      'update',
      'demo@project-marketplace',
      '--scope',
      'user',
    ]);

    expect(updateResult.exitCode).toBe(0);
    const payload = JSON.parse(updateResult.stdout);
    expect(payload.success).toBe(true);
    expect(payload.data.results[0]).toEqual({
      plugin: 'demo@project-marketplace',
      success: true,
      action: 'updated',
    });
  });

  test(
    'updates the same plugin independently when installed in both scopes',
    () => {
      for (const scope of ['user', 'project']) {
        const addResult = runCli(workspaceDir, homeDir, [
          'plugin',
          'marketplace',
          'add',
          marketplaceDir,
          '--scope',
          scope,
        ]);
        expect(addResult.exitCode).toBe(0);

        const installResult = runCli(workspaceDir, homeDir, [
          'plugin',
          'install',
          'demo@project-marketplace',
          '--scope',
          scope,
        ]);
        expect(installResult.exitCode).toBe(0);
      }

      const updateResult = runCli(workspaceDir, homeDir, [
        'plugin',
        'update',
        'demo@project-marketplace',
        '--scope',
        'all',
      ]);

      expect(updateResult.exitCode).toBe(0);
      const payload = JSON.parse(updateResult.stdout);
      expect(payload.success).toBe(true);
      expect(payload.data.results).toHaveLength(2);
      expect(payload.data.results).toEqual([
        {
          plugin: 'demo@project-marketplace',
          success: true,
          action: 'updated',
        },
        {
          plugin: 'demo@project-marketplace',
          success: true,
          action: 'updated',
        },
      ]);
    },
    10_000,
  );
});
