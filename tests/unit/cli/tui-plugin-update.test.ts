import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dump } from 'js-yaml';
import { getPluginCachePath } from '../../../src/utils/plugin-path.js';

const noteMock = mock((_message: string, _title?: string) => {});
const spinner = {
  start: mock((_message?: string) => {}),
  message: mock((_message?: string) => {}),
  stop: mock((_message?: string) => {}),
};

mock.module('@clack/prompts', () => ({
  autocomplete: mock(async () => ''),
  confirm: mock(async () => false),
  isCancel: () => false,
  multiselect: mock(async () => []),
  note: noteMock,
  select: mock(async () => ''),
  spinner: () => spinner,
  text: mock(async () => ''),
}));

// The prompt module must be mocked before loading the TUI action.
const { runUpdateAllPlugins } = await import(
  '../../../src/cli/tui/actions/plugins.js'
);

const SOURCE =
  'https://github.com/mattpocock/skills/tree/main/skills/engineering/setup-matt-pocock-skills';
const GENERIC_SOURCE = 'https://github.com/example/plugins';
const originalEnvironment = {
  ALLAGENTS_TEST_HOME: process.env.ALLAGENTS_TEST_HOME,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  HOME: process.env.HOME,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

function runGit(path: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', path, ...args], {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${path}: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString().trim();
}
async function createRemote(
  root: string,
  name: string,
  files: Record<string, string>,
): Promise<{ remote: string; upstream: string }> {
  const remote = join(root, `${name}.git`);
  const upstream = join(root, `${name}-upstream`);
  await mkdir(remote, { recursive: true });
  runGit(remote, ['init', '--bare', '--initial-branch=main']);
  runGit(root, ['clone', remote, upstream]);
  runGit(upstream, ['config', '--local', 'user.name', 'TUI Update Test']);
  runGit(upstream, [
    'config',
    '--local',
    'user.email',
    'tui-update@example.test',
  ]);
  for (const [path, content] of Object.entries(files)) {
    const target = join(upstream, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  runGit(upstream, ['add', '.']);
  runGit(upstream, ['commit', '-m', 'fixture v1']);
  runGit(upstream, ['push', 'origin', 'main']);
  return { remote, upstream };
}
async function advanceRemote(
  upstream: string,
  path: string,
  content: string,
  version: string,
): Promise<string> {
  await writeFile(join(upstream, path), content);
  runGit(upstream, ['add', '.']);
  runGit(upstream, ['commit', '-m', `fixture ${version}`]);
  runGit(upstream, ['push', 'origin', 'main']);
  return runGit(upstream, ['rev-parse', 'HEAD']);
}

function restoreEnvironment(): void {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

afterEach(() => {
  restoreEnvironment();
  noteMock.mockClear();
  spinner.start.mockClear();
  spinner.message.mockClear();
  spinner.stop.mockClear();
});

describe('interactive plugin updates', () => {
  test(
    'updates a GitHub tree-path standalone skill with its semantic name',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'allagents-tui-skill-update-'));
      const home = join(root, 'home');
      const workspace = join(root, 'workspace');
      const gitConfig = join(root, 'gitconfig');
      const skillPath =
        'skills/engineering/setup-matt-pocock-skills/SKILL.md';
      const genericSkillPath = 'skills/generic/SKILL.md';

      try {
        await mkdir(home, { recursive: true });
        await mkdir(workspace, { recursive: true });
        const skillRepository = await createRemote(root, 'skills', {
          [skillPath]:
            '---\nname: setup-matt-pocock-skills\ndescription: test skill\n---\n# standalone v1\n',
        });
        const genericRepository = await createRemote(root, 'plugins', {
          [genericSkillPath]:
            '---\nname: generic\ndescription: generic skill\n---\n# generic v1\n',
        });

        await writeFile(
          gitConfig,
          `[url "file://${skillRepository.remote}"]\n\tinsteadOf = https://github.com/mattpocock/skills.git\n[url "file://${genericRepository.remote}"]\n\tinsteadOf = https://github.com/example/plugins.git\n`,
        );
        process.env.ALLAGENTS_TEST_HOME = home;
        process.env.HOME = home;
        process.env.XDG_CACHE_HOME = join(home, '.cache');
        process.env.XDG_CONFIG_HOME = join(home, '.config');
        process.env.XDG_DATA_HOME = join(home, '.local/share');
        process.env.GIT_CONFIG_GLOBAL = gitConfig;

        const cache = getPluginCachePath('mattpocock', 'skills', 'main');
        const genericCache = getPluginCachePath('example', 'plugins');
        await mkdir(dirname(cache), { recursive: true });
        runGit(root, [
          'clone',
          '--branch',
          'main',
          'https://github.com/mattpocock/skills.git',
          cache,
        ]);
        runGit(root, [
          'clone',
          'https://github.com/example/plugins.git',
          genericCache,
        ]);

        const skillShaV2 = await advanceRemote(
          skillRepository.upstream,
          skillPath,
          '---\nname: setup-matt-pocock-skills\ndescription: test skill\n---\n# standalone v2\n',
          'v2',
        );
        const genericShaV2 = await advanceRemote(
          genericRepository.upstream,
          genericSkillPath,
          '---\nname: generic\ndescription: generic skill\n---\n# generic v2\n',
          'v2',
        );

        await mkdir(join(workspace, '.allagents'), { recursive: true });
        await writeFile(
          join(workspace, '.allagents/workspace.yaml'),
          dump({
            version: 2,
            repositories: [],
            clients: ['claude'],
            plugins: [SOURCE, GENERIC_SOURCE],
          }),
        );

        const context = {
          hasWorkspace: true,
          workspacePath: workspace,
          projectPluginCount: 2,
          userPluginCount: 0,
          needsSync: false,
          hasUserConfig: false,
          marketplaceCount: 0,
        };
        await runUpdateAllPlugins(context);

        expect(noteMock).toHaveBeenCalledTimes(1);
        expect(noteMock).toHaveBeenCalledWith(
          `✓ ${GENERIC_SOURCE} (updated)\n✓ setup-matt-pocock-skills (updated)\n\nUpdated: 2  Skipped: 0  Failed: 0`,
          'Update Results',
        );
        expect(noteMock.mock.calls[0]?.[0]).not.toContain(SOURCE);
        expect(runGit(cache, ['rev-parse', 'HEAD'])).toBe(skillShaV2);
        expect(runGit(genericCache, ['rev-parse', 'HEAD'])).toBe(genericShaV2);
        expect(await readFile(join(cache, skillPath), 'utf-8')).toContain(
          '# standalone v2',
        );
        expect(
          await readFile(join(genericCache, genericSkillPath), 'utf-8'),
        ).toContain('# generic v2');
        expect(
          await readFile(
            join(
              workspace,
              '.claude/skills/setup-matt-pocock-skills/SKILL.md',
            ),
            'utf-8',
          ),
        ).toContain('# standalone v2');
        expect(
          await readFile(
            join(workspace, '.claude/skills/generic/SKILL.md'),
            'utf-8',
          ),
        ).toContain('# generic v2');

        noteMock.mockClear();
        const skillShaV3 = await advanceRemote(
          skillRepository.upstream,
          skillPath,
          '---\nname: setup-matt-pocock-skills\ndescription: test skill\n---\n# standalone v3\n',
          'v3',
        );
        const genericShaV3 = await advanceRemote(
          genericRepository.upstream,
          genericSkillPath,
          '---\nname: generic\ndescription: generic skill\n---\n# generic v3\n',
          'v3',
        );

        await runUpdateAllPlugins(context);

        expect(noteMock).toHaveBeenCalledWith(
          `✓ ${GENERIC_SOURCE} (updated)\n✓ setup-matt-pocock-skills (updated)\n\nUpdated: 2  Skipped: 0  Failed: 0`,
          'Update Results',
        );
        expect(runGit(cache, ['rev-parse', 'HEAD'])).toBe(skillShaV3);
        expect(runGit(genericCache, ['rev-parse', 'HEAD'])).toBe(genericShaV3);
        expect(await readFile(join(cache, skillPath), 'utf-8')).toContain(
          '# standalone v3',
        );
        expect(
          await readFile(join(genericCache, genericSkillPath), 'utf-8'),
        ).toContain('# generic v3');
        expect(
          await readFile(
            join(
              workspace,
              '.claude/skills/setup-matt-pocock-skills/SKILL.md',
            ),
            'utf-8',
          ),
        ).toContain('# standalone v3');
        expect(
          await readFile(
            join(workspace, '.claude/skills/generic/SKILL.md'),
            'utf-8',
          ),
        ).toContain('# generic v3');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
