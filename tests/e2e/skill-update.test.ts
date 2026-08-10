import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import simpleGit from 'simple-git';
import type { WorkspaceConfig } from '../../src/models/workspace-config.js';

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface SkillUpdateFixture {
  root: string;
  workspace: string;
  home: string;
  upstream: string;
  remote: string;
  cache: string;
  gitConfig: string;
  initialSha: string;
  updatedSha: string;
}

const decoder = new TextDecoder();

function cliEnv(fixture: SkillUpdateFixture): Record<string, string> {
  return {
    ...process.env,
    ALLAGENTS_TEST_HOME: fixture.home,
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    XDG_CONFIG_HOME: join(fixture.home, '.config'),
    GIT_CONFIG_GLOBAL: fixture.gitConfig,
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
  } as Record<string, string>;
}

function runCli(fixture: SkillUpdateFixture, args: string[]): CliResult {
  const cliEntry = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');
  const proc = Bun.spawnSync(['bun', 'run', cliEntry, ...args], {
    cwd: fixture.workspace,
    env: cliEnv(fixture),
    stderr: 'pipe',
    stdout: 'pipe',
  });

  return {
    exitCode: proc.exitCode,
    stdout: decoder.decode(proc.stdout),
    stderr: decoder.decode(proc.stderr),
  };
}

async function writeSkill(
  root: string,
  name: string,
  body: string,
): Promise<void> {
  const directory = join(root, 'skills', name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} fixture\n---\n${body}\n`,
  );
}

async function createFixture(): Promise<SkillUpdateFixture> {
  const root = await mkdtemp(join(tmpdir(), 'allagents-e2e-skill-update-'));
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const upstream = join(root, 'upstream-work');
  const remote = join(root, 'upstream.git');
  const cache = join(
    home,
    '.allagents',
    'plugins',
    'marketplaces',
    'uat-skill-update-e2e',
  );
  const gitConfig = join(root, 'gitconfig');

  await mkdir(join(workspace, '.allagents'), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(upstream, { recursive: true });

  const upstreamGit = simpleGit(upstream);
  await upstreamGit.init();
  await upstreamGit.checkoutLocalBranch('main');
  await upstreamGit.addConfig('user.name', 'AllAgents UAT');
  await upstreamGit.addConfig('user.email', 'allagents@example.test');
  await writeSkill(upstream, 'keep', '# keep v1');
  await writeSkill(upstream, 'gone', '# gone v1');
  await upstreamGit.add('.');
  await upstreamGit.commit('fixture v1');
  const initialSha = (await upstreamGit.revparse(['HEAD'])).trim();

  await simpleGit().raw(['init', '--bare', remote]);
  await upstreamGit.addRemote('origin', remote);
  await upstreamGit.push(['-u', 'origin', 'main']);
  await simpleGit(remote).raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);

  await writeFile(
    gitConfig,
    `[protocol "file"]\n\tallow = always\n[url "file://${remote}"]\n\tinsteadOf = https://github.com/uat/skill-update-e2e.git\n`,
  );

  await mkdir(join(cache, '..'), { recursive: true });
  const clone = Bun.spawnSync(
    ['git', 'clone', 'https://github.com/uat/skill-update-e2e.git', cache],
    {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_TERMINAL_PROMPT: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  if (clone.exitCode !== 0) {
    throw new Error(`fixture clone failed: ${decoder.decode(clone.stderr)}`);
  }

  const config: WorkspaceConfig = {
    repositories: [],
    plugins: [
      {
        source: 'uat/skill-update-e2e',
        skills: ['keep', 'gone'],
      },
    ],
    clients: ['claude'],
    version: 2,
  };
  await writeFile(
    join(workspace, '.allagents', 'workspace.yaml'),
    dump(config),
  );

  await writeSkill(upstream, 'keep', '# keep v2');
  await rm(join(upstream, 'skills', 'gone'), { recursive: true });
  await upstreamGit.add(['-A']);
  await upstreamGit.commit('fixture v2');
  await upstreamGit.push('origin', 'main');
  const updatedSha = (await upstreamGit.revparse(['HEAD'])).trim();

  return {
    root,
    workspace,
    home,
    upstream,
    remote,
    cache,
    gitConfig,
    initialSha,
    updatedSha,
  };
}

async function cacheSha(fixture: SkillUpdateFixture): Promise<string> {
  return (await simpleGit(fixture.cache).revparse(['HEAD'])).trim();
}

async function addUnreachableSiblingSource(
  fixture: SkillUpdateFixture,
): Promise<{ cache: string; sha: string }> {
  const cache = join(
    fixture.home,
    '.allagents',
    'plugins',
    'marketplaces',
    'uat-unreachable-skill-update',
  );
  await writeFile(
    fixture.gitConfig,
    `[protocol "file"]\n\tallow = always\n[url "file://${fixture.remote}"]\n\tinsteadOf = https://github.com/uat/skill-update-e2e.git\n\tinsteadOf = https://github.com/uat/unreachable-skill-update.git\n`,
  );
  const clone = Bun.spawnSync(
    [
      'git',
      'clone',
      'https://github.com/uat/unreachable-skill-update.git',
      cache,
    ],
    {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: fixture.gitConfig,
        GIT_TERMINAL_PROMPT: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  if (clone.exitCode !== 0) {
    throw new Error(
      `sibling fixture clone failed: ${decoder.decode(clone.stderr)}`,
    );
  }
  const sha = (await simpleGit(cache).revparse(['HEAD'])).trim();

  await writeFile(
    fixture.gitConfig,
    `[protocol "file"]\n\tallow = always\n[url "file://${fixture.remote}"]\n\tinsteadOf = https://github.com/uat/skill-update-e2e.git\n[url "file://${join(fixture.root, 'missing.git')}"]\n\tinsteadOf = https://github.com/uat/unreachable-skill-update.git\n`,
  );
  const config: WorkspaceConfig = {
    repositories: [],
    plugins: [
      { source: 'uat/skill-update-e2e', skills: ['keep'] },
      { source: 'uat/unreachable-skill-update', skills: ['keep'] },
    ],
    clients: ['claude'],
    version: 2,
  };
  await writeFile(
    join(fixture.workspace, '.allagents', 'workspace.yaml'),
    dump(config),
  );
  return { cache, sha };
}

describe('skill update CLI e2e', () => {
  let fixtures: SkillUpdateFixture[] = [];

  beforeEach(() => {
    fixtures = [];
  });

  afterEach(async () => {
    await Promise.all(
      fixtures.map((fixture) =>
        rm(fixture.root, { recursive: true, force: true }),
      ),
    );
  });

  test('non-interactive mode retains deleted skills and preserves the shared cache', async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    const result = runCli(fixture, [
      '--json',
      'skill',
      'update',
      '--scope',
      'project',
      '--yes',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const payload = JSON.parse(result.stdout);
    expect(payload.success).toBe(true);
    expect(payload.data.summary).toMatchObject({
      updated: 0,
      removed: 0,
      retained: 1,
      skipped: 1,
      failed: 0,
    });
    expect(payload.data.results).toHaveLength(1);
    expect(payload.data.results[0]).toMatchObject({
      status: 'retained',
      skillCounts: { updated: 0, removed: 0, retained: 1 },
    });
    expect(await cacheSha(fixture)).toBe(fixture.initialSha);
    expect(existsSync(join(fixture.cache, 'skills', 'gone', 'SKILL.md'))).toBe(
      true,
    );
    expect(
      await readFile(join(fixture.cache, 'skills', 'keep', 'SKILL.md'), 'utf8'),
    ).toContain('# keep v1');
  });

  test('a confirmed deletion removes the selector and advances surviving skills', async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const cliEntry = join(
      import.meta.dir,
      '..',
      '..',
      'src',
      'cli',
      'index.ts',
    );
    const command = `bun run ${cliEntry} skill update --scope project`;
    const proc = Bun.spawn(['script', '-qefc', command, '/dev/null'], {
      cwd: fixture.workspace,
      env: cliEnv(fixture),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    proc.stdin.write('y\n');
    proc.stdin.end();
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('appear to have been deleted upstream');
    expect(stdout).toContain('Removed deleted skills and updated');
    expect(await cacheSha(fixture)).toBe(fixture.updatedSha);
    expect(existsSync(join(fixture.cache, 'skills', 'gone'))).toBe(false);
    expect(
      await readFile(join(fixture.cache, 'skills', 'keep', 'SKILL.md'), 'utf8'),
    ).toContain('# keep v2');

    const rawConfig = await readFile(
      join(fixture.workspace, '.allagents', 'workspace.yaml'),
      'utf8',
    );
    const config = load(rawConfig) as WorkspaceConfig;
    const plugin = config.plugins[0];
    expect(typeof plugin === 'string' ? undefined : plugin?.skills).toEqual([
      'keep',
    ]);
  });

  test('one unreachable source fails without blocking an independent healthy update', async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const unreachable = await addUnreachableSiblingSource(fixture);

    const result = runCli(fixture, [
      '--json',
      'skill',
      'update',
      '--scope',
      'project',
      '--yes',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    const payload = JSON.parse(result.stdout);
    expect(payload.success).toBe(false);
    expect(payload.data.summary).toMatchObject({
      updated: 1,
      failed: 1,
      removed: 0,
      retained: 0,
    });
    expect(
      payload.data.results
        .map((entry: { status: string }) => entry.status)
        .sort(),
    ).toEqual(['failed', 'updated']);
    expect(await cacheSha(fixture)).toBe(fixture.updatedSha);
    expect((await simpleGit(unreachable.cache).revparse(['HEAD'])).trim()).toBe(
      unreachable.sha,
    );
  });
});
