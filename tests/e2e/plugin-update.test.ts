import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CliOptions {
  gitConfig?: string;
  json?: boolean;
  gitWrapperDir?: string;
  tracePath?: string;
}

const decoder = new TextDecoder();
const cliEntry = join(import.meta.dir, '..', '..', 'dist', 'index.js');

beforeAll(() => {
  const build = Bun.spawnSync(['bun', 'run', 'build'], {
    cwd: join(import.meta.dir, '..', '..'),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (build.exitCode !== 0) {
    throw new Error(
      `CLI build failed:\n${decoder.decode(build.stdout)}${decoder.decode(build.stderr)}`,
    );
  }
  if (!existsSync(cliEntry)) {
    throw new Error(`Built CLI not found at ${cliEntry}`);
  }
});

function runCli(
  workdir: string,
  homeDir: string,
  args: string[],
  options: CliOptions = {},
): CliResult {
  const proc = Bun.spawnSync(
    [cliEntry, ...(options.json === false ? [] : ['--json']), ...args],
    {
      cwd: workdir,
      env: {
        ...process.env,
        ALLAGENTS_TEST_HOME: homeDir,
        HOME: homeDir,
        USERPROFILE: homeDir,
        XDG_CONFIG_HOME: join(homeDir, '.config'),
        GIT_TERMINAL_PROMPT: '0',
        NO_COLOR: '1',
        ...(options.gitConfig && { GIT_CONFIG_GLOBAL: options.gitConfig }),
        ...(options.gitWrapperDir && {
          ALLAGENTS_TEST_REAL_GIT: Bun.which('git') ?? 'git',
          PATH: `${options.gitWrapperDir}:${process.env.PATH ?? ''}`,
        }),
        ...(options.tracePath && { GIT_TRACE2_EVENT: options.tracePath }),
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );

  return {
    exitCode: proc.exitCode,
    stdout: decoder.decode(proc.stdout),
    stderr: decoder.decode(proc.stderr),
  };
}

function runGit(path: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', path, ...args], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${path}: ${decoder.decode(result.stderr)}`,
    );
  }
  return decoder.decode(result.stdout).trim();
}

function countGitCommands(
  tracePath: string,
  command: string,
  source?: string,
): number {
  const events = readFileSync(tracePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event?: string; argv?: string[] });
  return events.filter((event) => {
    const invocation = event.argv?.join(' ') ?? '';
    return (
      (event.event === 'start' || event.event === 'child_start') &&
      event.argv?.some((argument) => argument === command) &&
      (!source || invocation.includes(source))
    );
  }).length;
}

function createRemoteMarketplace(rootDir: string): {
  gitConfig: string;
  gitWrapperDir: string;
  source: string;
} {
  const worktree = join(rootDir, 'remote-marketplace-work');
  const remote = join(rootDir, 'remote-marketplace.git');
  const gitConfig = join(rootDir, 'gitconfig');
  mkdirSync(worktree, { recursive: true });
  runGit(worktree, ['init']);
  runGit(worktree, ['checkout', '-b', 'main']);
  runGit(worktree, ['config', '--local', 'user.name', 'AllAgents E2E']);
  runGit(worktree, [
    'config',
    '--local',
    'user.email',
    'allagents@example.test',
  ]);
  mkdirSync(join(worktree, '.claude-plugin'), { recursive: true });
  mkdirSync(join(worktree, 'plugins', 'demo', 'skills', 'demo'), {
    recursive: true,
  });
  writeFileSync(
    join(worktree, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'remote-marketplace',
      plugins: [{ name: 'demo', source: './plugins/demo' }],
    }),
  );
  writeFileSync(
    join(worktree, 'plugins', 'demo', 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: Demo skill\n---\n# Remote demo\n',
  );
  runGit(worktree, ['add', '.']);
  runGit(worktree, ['commit', '-m', 'fixture v1']);
  runGit(rootDir, ['init', '--bare', remote]);
  runGit(worktree, ['remote', 'add', 'origin', remote]);
  runGit(worktree, ['push', '-u', 'origin', 'main']);
  runGit(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  writeFileSync(
    gitConfig,
    `[protocol "file"]\n\tallow = always\n[url "file://${remote}"]\n\tinsteadOf = https://github.com/uat/plugin-marketplace.git\n`,
  );
  const gitWrapperDir = join(rootDir, 'bin');
  mkdirSync(gitWrapperDir, { recursive: true });
  const gitWrapper = join(gitWrapperDir, 'git');
  writeFileSync(
    gitWrapper,
    `#!/bin/sh\ncase " $* " in\n  *" ls-remote "*) exec "$ALLAGENTS_TEST_REAL_GIT" -c "url.file://${remote}.insteadOf=https://github.com/uat/plugin-marketplace.git" "$@" ;;\nesac\nexec "$ALLAGENTS_TEST_REAL_GIT" "$@"\n`,
  );
  chmodSync(gitWrapper, 0o755);
  return {
    gitConfig,
    gitWrapperDir,
    source: 'https://github.com/uat/plugin-marketplace',
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
  }, 15_000);


  test('keeps direct marketplace update JSON free of internal fields', () => {
    const addResult = runCli(workspaceDir, homeDir, [
      'plugin',
      'marketplace',
      'add',
      marketplaceDir,
      '--scope',
      'project',
    ]);
    expect(addResult.exitCode).toBe(0);

    const updateResult = runCli(workspaceDir, homeDir, [
      'plugin',
      'marketplace',
      'update',
      'project-marketplace',
    ]);

    expect(updateResult.exitCode).toBe(0);
    expect(JSON.parse(updateResult.stdout)).toEqual({
      success: true,
      command: 'plugin marketplace update',
      data: {
        results: [
          {
            name: 'project-marketplace',
            success: true,
          },
        ],
        succeeded: 1,
        failed: 0,
      },
    });
  }, 10_000);
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
  }, 15_000);

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
    20_000,
  );

  test(
    'deduplicates embedded marketplace checks across plugin update scopes',
    () => {
      const remote = createRemoteMarketplace(rootDir);
      const addResult = runCli(
        workspaceDir,
        homeDir,
        [
          'plugin',
          'marketplace',
          'add',
          remote.source,
          '--scope',
          'user',
        ],
        { gitConfig: remote.gitConfig },
      );
      expect(addResult.exitCode).toBe(0);
      for (const scope of ['user', 'project']) {
        const installResult = runCli(
          workspaceDir,
          homeDir,
          [
            'plugin',
            'install',
            'demo@remote-marketplace',
            '--scope',
            scope,
          ],
          { gitConfig: remote.gitConfig },
        );
        expect(installResult.exitCode).toBe(0);
      }

      const registryPath = join(
        homeDir,
        '.allagents',
        'marketplaces.json',
      );
      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      const entry = registry.marketplaces['remote-marketplace'];
      entry.lastUpdated = '2000-01-01T00:00:00.000Z';
      writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
      runGit(entry.path, [
        'remote',
        'set-url',
        'origin',
        'https://github.com/uat/plugin-marketplace.git',
      ]);
      const cacheHead = runGit(entry.path, ['rev-parse', 'HEAD']);
      const tracePath = join(rootDir, 'plugin-update-all-noop-trace.jsonl');

      const updateResult = runCli(
        workspaceDir,
        homeDir,
        ['plugin', 'update', 'demo@remote-marketplace', '--scope', 'all'],
        {
          gitWrapperDir: remote.gitWrapperDir,
          tracePath,
        },
      );

      expect(updateResult).toMatchObject({ exitCode: 0 });
      expect(updateResult.stderr).toBe('');
      expect(JSON.parse(updateResult.stdout)).toMatchObject({
        success: true,
        command: 'plugin update',
        data: {
          results: [
            {
              plugin: 'demo@remote-marketplace',
              success: true,
              action: 'updated',
            },
            {
              plugin: 'demo@remote-marketplace',
              success: true,
              action: 'updated',
            },
          ],
          updated: 2,
          skipped: 0,
          failed: 0,
          syncResults: {
            project: { failed: 0 },
            user: { failed: 0 },
          },
        },
      });
      expect(
        countGitCommands(
          tracePath,
          'ls-remote',
          'https://github.com/uat/plugin-marketplace.git',
        ),
      ).toBe(1);
      expect(countGitCommands(tracePath, 'pull')).toBe(2);
      expect(countGitCommands(tracePath, 'fetch')).toBe(4);
      expect(countGitCommands(tracePath, 'clone')).toBe(0);

      const updatedRegistry = JSON.parse(readFileSync(registryPath, 'utf8'));
      const updatedEntry =
        updatedRegistry.marketplaces['remote-marketplace'];
      expect(updatedEntry.lastUpdated).not.toBe(
        '2000-01-01T00:00:00.000Z',
      );
      expect(runGit(updatedEntry.path, ['rev-parse', 'HEAD'])).toBe(
        cacheHead,
      );
    },
    15_000,
  );

  test(
    'deduplicates no-op remote marketplace checks across registry consumers',
    () => {
      const remote = createRemoteMarketplace(rootDir);
      const addResult = runCli(
        workspaceDir,
        homeDir,
        [
          'plugin',
          'marketplace',
          'add',
          remote.source,
          '--scope',
          'user',
        ],
        { gitConfig: remote.gitConfig },
      );
      expect(addResult.exitCode).toBe(0);

      const registryPath = join(homeDir, '.allagents', 'marketplaces.json');
      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      const entry = registry.marketplaces['remote-marketplace'];
      registry.marketplaces['remote-marketplace-alias'] = {
        ...entry,
        lastUpdated: '2000-01-01T00:00:00.000Z',
      };
      entry.lastUpdated = '2000-01-01T00:00:00.000Z';
      writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
      const cachePath = entry.path as string;
      runGit(cachePath, [
        'remote',
        'set-url',
        'origin',
        'https://github.com/uat/plugin-marketplace.git',
      ]);
      const cacheHead = runGit(cachePath, ['rev-parse', 'HEAD']);
      const cacheSkillPath = join(
        cachePath,
        'plugins',
        'demo',
        'skills',
        'demo',
        'SKILL.md',
      );
      const cacheSkill = readFileSync(cacheSkillPath, 'utf8');
      const tracePath = join(rootDir, 'marketplace-noop-trace.jsonl');

      const updateResult = runCli(
        workspaceDir,
        homeDir,
        ['plugin', 'marketplace', 'update'],
        {
          gitWrapperDir: remote.gitWrapperDir,
          tracePath,
        },
      );

      expect(updateResult.exitCode).toBe(0);
      expect(updateResult.stderr).toBe('');
      expect(JSON.parse(updateResult.stdout)).toEqual({
        success: true,
        command: 'plugin marketplace update',
        data: {
          results: [
            { name: 'remote-marketplace', success: true },
            { name: 'remote-marketplace', success: true },
          ],
          succeeded: 2,
          failed: 0,
        },
      });
      expect(
        countGitCommands(
          tracePath,
          'ls-remote',
          'https://github.com/uat/plugin-marketplace.git',
        ),
      ).toBe(1);
      expect(countGitCommands(tracePath, 'pull')).toBe(0);
      expect(countGitCommands(tracePath, 'fetch')).toBe(0);
      expect(countGitCommands(tracePath, 'clone')).toBe(0);

      const updatedRegistry = JSON.parse(readFileSync(registryPath, 'utf8'));
      expect(
        updatedRegistry.marketplaces['remote-marketplace'].lastUpdated,
      ).not.toBe('2000-01-01T00:00:00.000Z');
      expect(
        updatedRegistry.marketplaces['remote-marketplace-alias'].lastUpdated,
      ).not.toBe('2000-01-01T00:00:00.000Z');
      expect(runGit(cachePath, ['rev-parse', 'HEAD'])).toBe(cacheHead);
      expect(runGit(cachePath, ['status', '--porcelain'])).toBe('');
      expect(readFileSync(cacheSkillPath, 'utf8')).toBe(cacheSkill);

      const humanResult = runCli(
        workspaceDir,
        homeDir,
        ['plugin', 'marketplace', 'update'],
        {
          gitWrapperDir: remote.gitWrapperDir,
          json: false,
        },
      );
      expect(humanResult.exitCode).toBe(0);
      expect(humanResult.stderr).toBe('');
      expect(humanResult.stdout).toBe(
        'Updating all marketplaces...\n\n' +
          '✓ remote-marketplace\n' +
          '✓ remote-marketplace\n\n' +
          'Updated: 2, Failed: 0\n',
      );
    },
    20_000,
  );
});
