import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
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

interface RemoteSourceFixture {
  slug: string;
  source: string;
  worktree: string;
  remote: string;
  cache: string;
  initialSha: string;
  updatedSha: string;
}

const decoder = new TextDecoder();
const cliEntry = join(import.meta.dir, '..', '..', 'dist', 'index.js');

function buildCli(): void {
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
}

beforeAll(buildCli, 60_000);

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
  const proc = Bun.spawnSync([cliEntry, ...args], {
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

async function runInteractiveCli(
  fixture: SkillUpdateFixture,
  args: string[],
  input: string,
): Promise<CliResult> {
  const shellQuote = (value: string): string =>
    `'${value.replaceAll("'", `'\\''`)}'`;
  const command = `stty cols 160 rows 40; exec ${[cliEntry, ...args].map(shellQuote).join(' ')}`;
  const proc = Bun.spawn(['script', '-qefc', command, '/dev/null'], {
    cwd: fixture.workspace,
    env: cliEnv(fixture),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdoutReader = proc.stdout.getReader();
  const streamDecoder = new TextDecoder();
  let stdout = '';
  let inputSent = false;
  const readStdout = (async () => {
    while (true) {
      const { done, value } = await stdoutReader.read();
      if (done) break;
      stdout += streamDecoder.decode(value, { stream: true });
      if (!inputSent && stdout.includes('deleted upstream')) {
        inputSent = true;
        await new Promise((resolve) => setTimeout(resolve, 75));
        proc.stdin.write(input);
        proc.stdin.end();
      }
    }
    stdout += streamDecoder.decode();
  })();
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    readStdout,
  ]).then(([code, error]) => [code, error] as const);
  const result = {
    exitCode,
    stdout,
    stderr,
  };
  return result;
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

async function appendGitRedirect(
  fixture: SkillUpdateFixture,
  remote: string,
  slug: string,
): Promise<void> {
  const existing = await readFile(fixture.gitConfig, 'utf8');
  await writeFile(
    fixture.gitConfig,
    `${existing}[url "file://${remote}"]\n\tinsteadOf = https://github.com/uat/${slug}.git\n`,
  );
}

async function createRemoteSource(
  fixture: SkillUpdateFixture,
  slug: string,
  initialSkills: Array<{ name: string; body: string }>,
  updatedSkills: Array<{ name: string; body: string }>,
): Promise<RemoteSourceFixture> {
  const worktree = join(fixture.root, `${slug}-work`);
  const remote = join(fixture.root, `${slug}.git`);
  const cache = join(
    fixture.home,
    '.allagents',
    'plugins',
    'marketplaces',
    `uat-${slug}`,
  );
  await mkdir(worktree, { recursive: true });
  const git = simpleGit(worktree);
  await git.init();
  await git.checkoutLocalBranch('main');
  await git.addConfig('user.name', 'AllAgents UAT');
  await git.addConfig('user.email', 'allagents@example.test');
  for (const skill of initialSkills) {
    await writeSkill(worktree, skill.name, skill.body);
  }
  await git.add('.');
  await git.commit('fixture v1');
  const initialSha = (await git.revparse(['HEAD'])).trim();
  await simpleGit().raw(['init', '--bare', remote]);
  await git.addRemote('origin', remote);
  await git.push(['-u', 'origin', 'main']);
  await simpleGit(remote).raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await appendGitRedirect(fixture, remote, slug);

  const clone = Bun.spawnSync(
    ['git', 'clone', `https://github.com/uat/${slug}.git`, cache],
    {
      env: cliEnv(fixture),
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  if (clone.exitCode !== 0) {
    throw new Error(`fixture clone failed: ${decoder.decode(clone.stderr)}`);
  }
  await simpleGit(cache).remote([
    'set-url',
    'origin',
    `https://github.com/uat/${slug}.git`,
  ]);

  await rm(join(worktree, 'skills'), { recursive: true, force: true });
  for (const skill of updatedSkills) {
    await writeSkill(worktree, skill.name, skill.body);
  }
  await git.add(['-A']);
  await git.commit('fixture v2');
  await git.push('origin', 'main');
  const updatedSha = (await git.revparse(['HEAD'])).trim();

  return {
    slug,
    source: `uat/${slug}`,
    worktree,
    remote,
    cache,
    initialSha,
    updatedSha,
  };
}

async function writeEmbeddedMarketplaceVersion(
  root: string,
  keepBody: string,
  includeGone: boolean,
): Promise<void> {
  await rm(join(root, 'plugins'), { recursive: true, force: true });
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(root, '.claude-plugin', 'marketplace.json'),
    `${JSON.stringify(
      {
        name: 'uat-market',
        description: 'Embedded marketplace E2E fixture',
        plugins: [
          {
            name: 'demo',
            description: 'Embedded demo plugin',
            source: './plugins/demo',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const pluginRoot = join(root, 'plugins', 'demo');
  await writeSkill(pluginRoot, 'keep', keepBody);
  if (includeGone) await writeSkill(pluginRoot, 'gone', '# gone v1');
}

async function createEmbeddedMarketplaceSource(
  fixture: SkillUpdateFixture,
): Promise<RemoteSourceFixture> {
  const slug = 'skill-market-e2e';
  const worktree = join(fixture.root, `${slug}-work`);
  const remote = join(fixture.root, `${slug}.git`);
  const cache = join(
    fixture.home,
    '.allagents',
    'plugins',
    'marketplaces',
    'uat-market',
  );
  await mkdir(worktree, { recursive: true });
  const git = simpleGit(worktree);
  await git.init();
  await git.checkoutLocalBranch('main');
  await git.addConfig('user.name', 'AllAgents UAT');
  await git.addConfig('user.email', 'allagents@example.test');
  await writeEmbeddedMarketplaceVersion(worktree, '# keep v1', true);
  await git.add('.');
  await git.commit('marketplace v1');
  const initialSha = (await git.revparse(['HEAD'])).trim();
  await simpleGit().raw(['init', '--bare', remote]);
  await git.addRemote('origin', remote);
  await git.push(['-u', 'origin', 'main']);
  await simpleGit(remote).raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await appendGitRedirect(fixture, remote, slug);

  const clone = Bun.spawnSync(
    ['git', 'clone', `https://github.com/uat/${slug}.git`, cache],
    {
      env: cliEnv(fixture),
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  if (clone.exitCode !== 0) {
    throw new Error(
      `marketplace fixture clone failed: ${decoder.decode(clone.stderr)}`,
    );
  }
  await simpleGit(cache).remote([
    'set-url',
    'origin',
    `https://github.com/uat/${slug}.git`,
  ]);

  await writeEmbeddedMarketplaceVersion(worktree, '# keep v2', false);
  await git.add(['-A']);
  await git.commit('marketplace v2');
  await git.push('origin', 'main');
  const updatedSha = (await git.revparse(['HEAD'])).trim();

  await writeFile(
    join(fixture.workspace, '.allagents', 'marketplaces.json'),
    `${JSON.stringify(
      {
        version: 1,
        marketplaces: {
          'uat-market': {
            name: 'uat-market',
            source: { type: 'github', location: `uat/${slug}` },
            path: cache,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeProjectConfig(fixture, [
    { source: 'demo@uat-market', skills: ['keep', 'gone'] },
  ]);

  return {
    slug,
    source: 'demo@uat-market',
    worktree,
    remote,
    cache,
    initialSha,
    updatedSha,
  };
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
  await simpleGit(cache).remote([
    'set-url',
    'origin',
    'https://github.com/uat/skill-update-e2e.git',
  ]);

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

async function checkoutSha(path: string): Promise<string> {
  return (await simpleGit(path).revparse(['HEAD'])).trim();
}

async function writeProjectConfig(
  fixture: SkillUpdateFixture,
  plugins: WorkspaceConfig['plugins'],
): Promise<void> {
  const config: WorkspaceConfig = {
    repositories: [],
    plugins,
    clients: ['claude'],
    version: 2,
  };
  await writeFile(
    join(fixture.workspace, '.allagents', 'workspace.yaml'),
    dump(config),
  );
}

async function writeUserConfig(
  fixture: SkillUpdateFixture,
  plugins: WorkspaceConfig['plugins'],
): Promise<void> {
  const config: WorkspaceConfig = {
    repositories: [],
    plugins,
    clients: ['claude'],
    version: 2,
  };
  await mkdir(join(fixture.home, '.allagents'), { recursive: true });
  await writeFile(
    join(fixture.home, '.allagents', 'workspace.yaml'),
    dump(config),
  );
}

async function readWorkspaceConfig(path: string): Promise<WorkspaceConfig> {
  return load(await readFile(path, 'utf8')) as WorkspaceConfig;
}

function expectPluginSkills(
  config: WorkspaceConfig,
  index: number,
  skills: string[],
): void {
  const plugin = config.plugins[index];
  expect(typeof plugin === 'string' ? undefined : plugin?.skills).toEqual(
    skills,
  );
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
  await simpleGit(cache).remote([
    'set-url',
    'origin',
    'https://github.com/uat/unreachable-skill-update.git',
  ]);
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
    const result = await runInteractiveCli(
      fixture,
      ['skill', 'update', '--scope', 'project'],
      'y\n',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('appear to have been deleted upstream');
    expect(result.stdout).toContain('Removed deleted skills and updated');
    expect(await cacheSha(fixture)).toBe(fixture.updatedSha);
    expect(existsSync(join(fixture.cache, 'skills', 'gone'))).toBe(false);
    expect(
      await readFile(join(fixture.cache, 'skills', 'keep', 'SKILL.md'), 'utf8'),
    ).toContain('# keep v2');

    const rawConfig = await readFile(
      join(fixture.workspace, '.allagents', 'workspace.yaml'),
      'utf8',
    );
    expectPluginSkills(load(rawConfig) as WorkspaceConfig, 0, ['keep']);
  });

  test('interactive No retains one source while an independent healthy source updates', async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const healthy = await createRemoteSource(
      fixture,
      'healthy-skill-update-e2e',
      [{ name: 'healthy', body: '# healthy v1' }],
      [{ name: 'healthy', body: '# healthy v2' }],
    );
    await writeProjectConfig(fixture, [
      { source: 'uat/skill-update-e2e', skills: ['keep', 'gone'] },
      { source: healthy.source, skills: ['healthy'] },
    ]);

    const seed = runCli(fixture, ['update', '--offline']);
    expect(seed.exitCode).toBe(0);
    const configPath = join(
      fixture.workspace,
      '.allagents',
      'workspace.yaml',
    );
    const goneArtifact = join(
      fixture.workspace,
      '.claude',
      'skills',
      'gone',
      'SKILL.md',
    );
    const configBefore = await readFile(configPath, 'utf8');
    const goneBefore = await readFile(goneArtifact, 'utf8');

    const result = await runInteractiveCli(
      fixture,
      ['skill', 'update', '--scope', 'project'],
      'n\n',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      'No keeps them and skips every update from this source',
    );
    expect(result.stdout).toContain('Kept local copies and skipped updates');
    expect(result.stdout).toContain(`Updated ${healthy.source}`);
    expect(await readFile(configPath, 'utf8')).toBe(configBefore);
    expect(await cacheSha(fixture)).toBe(fixture.initialSha);
    expect(await readFile(goneArtifact, 'utf8')).toBe(goneBefore);
    expect(await checkoutSha(healthy.cache)).toBe(healthy.updatedSha);
    expect(
      await readFile(
        join(fixture.workspace, '.claude', 'skills', 'healthy', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('# healthy v2');
  }, 15_000);

  test('interactive cancellation leaves config, cache, and synced artifacts unchanged', async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const seed = runCli(fixture, ['update', '--offline']);
    expect(seed.exitCode).toBe(0);
    const configPath = join(
      fixture.workspace,
      '.allagents',
      'workspace.yaml',
    );
    const keepArtifact = join(
      fixture.workspace,
      '.claude',
      'skills',
      'keep',
      'SKILL.md',
    );
    const goneArtifact = join(
      fixture.workspace,
      '.claude',
      'skills',
      'gone',
      'SKILL.md',
    );
    const configBefore = await readFile(configPath, 'utf8');
    const keepBefore = await readFile(keepArtifact, 'utf8');
    const goneBefore = await readFile(goneArtifact, 'utf8');

    const result = await runInteractiveCli(
      fixture,
      ['skill', 'update', '--scope', 'project'],
      '\u0003',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Update cancelled before changes');
    expect(await readFile(configPath, 'utf8')).toBe(configBefore);
    expect(await cacheSha(fixture)).toBe(fixture.initialSha);
    expect(await readFile(keepArtifact, 'utf8')).toBe(keepBefore);
    expect(await readFile(goneArtifact, 'utf8')).toBe(goneBefore);
  });

  test('shared project and user cache blocks project-only update and reconciles once with scope all', async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    await writeUserConfig(fixture, [
      { source: 'uat/skill-update-e2e', skills: ['keep', 'gone'] },
    ]);

    const projectOnly = runCli(fixture, [
      '--json',
      'skill',
      'update',
      '--scope',
      'project',
      '--yes',
    ]);
    expect(projectOnly.exitCode).toBe(0);
    const projectPayload = JSON.parse(projectOnly.stdout);
    expect(projectPayload.data.results).toHaveLength(1);
    expect(projectPayload.data.results[0]).toMatchObject({
      status: 'retained',
      skillCounts: { removed: 0, retained: 2 },
    });
    expect(await cacheSha(fixture)).toBe(fixture.initialSha);

    const scopeAll = await runInteractiveCli(
      fixture,
      ['skill', 'update', '--scope', 'all'],
      'y\n',
    );
    expect(scopeAll.exitCode).toBe(0);
    expect(scopeAll.stderr).toBe('');
    expect(scopeAll.stdout).toContain('gone (project)');
    expect(scopeAll.stdout).toContain('gone (user)');
    expect(scopeAll.stdout).toContain('Removed deleted skills and updated');
    expect(await cacheSha(fixture)).toBe(fixture.updatedSha);

    const projectConfig = await readWorkspaceConfig(
      join(fixture.workspace, '.allagents', 'workspace.yaml'),
    );
    const userConfig = await readWorkspaceConfig(
      join(fixture.home, '.allagents', 'workspace.yaml'),
    );
    expectPluginSkills(projectConfig, 0, ['keep']);
    expectPluginSkills(userConfig, 0, ['keep']);
  });

  test('confirmed embedded marketplace deletion advances the marketplace cache', async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const marketplace = await createEmbeddedMarketplaceSource(fixture);

    const result = await runInteractiveCli(
      fixture,
      ['skill', 'update', '--scope', 'project'],
      'y\n',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      'skills from demo@uat-market appear to have been deleted upstream',
    );
    expect(result.stdout).toContain('Removed deleted skills and updated');
    expect(await checkoutSha(marketplace.cache)).toBe(marketplace.updatedSha);
    expect(
      existsSync(
        join(
          marketplace.cache,
          'plugins',
          'demo',
          'skills',
          'gone',
          'SKILL.md',
        ),
      ),
    ).toBe(false);
    expect(
      await readFile(
        join(
          marketplace.cache,
          'plugins',
          'demo',
          'skills',
          'keep',
          'SKILL.md',
        ),
        'utf8',
      ),
    ).toContain('# keep v2');
    const config = await readWorkspaceConfig(
      join(fixture.workspace, '.allagents', 'workspace.yaml'),
    );
    expectPluginSkills(config, 0, ['keep']);
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
