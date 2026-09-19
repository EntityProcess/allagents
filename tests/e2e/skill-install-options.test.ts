import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';

const cliEntry = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');
let root: string;
let home: string;
let workspace: string;
let plugin: string;

async function runSkillAdd(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  const child = Bun.spawn(
    ['bun', 'run', cliEntry, '--json', 'skill', 'add', ...args],
    {
      cwd: workspace,
      env: {
        ...process.env,
        ALLAGENTS_TEST_HOME: home,
        HOME: home,
        USERPROFILE: home,
        NO_COLOR: '1',
        CI: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { exitCode, stdout };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'allagents-skill-install-options-'));
  home = join(root, 'home');
  workspace = join(root, 'workspace');
  plugin = 'https://github.com/acme/skill-target';
  const pluginCache = join(
    home,
    '.allagents',
    'plugins',
    'marketplaces',
    'acme-skill-target',
  );
  await mkdir(join(pluginCache, 'skills', 'demo'), { recursive: true });
  await mkdir(join(workspace, '.allagents'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(
    join(pluginCache, 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: Demo\n---\n# Demo\n',
  );
  await writeFile(
    join(workspace, '.allagents', 'workspace.yaml'),
    dump({
      repositories: [],
      plugins: [],
      clients: ['claude', 'codex', 'cursor'],
    }),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('skill add target options', () => {
  test('persists file mode, the complete allowlist, and selected clients for a new source', async () => {
    const result = await runSkillAdd([
      'demo',
      '--from',
      plugin,
      '--scope',
      'project',
      '--client',
      'codex,cursor',
      '--yes',
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      command: 'skill add',
      data: { skill: 'demo' },
    });
    const config = load(
      await readFile(join(workspace, '.allagents', 'workspace.yaml'), 'utf8'),
    ) as {
      clients: string[];
      plugins: Array<{
        source: string;
        install: string;
        skills: string[];
        clients: string[];
      }>;
    };
    expect(config.clients).toEqual(['claude', 'codex', 'cursor']);
    expect(config.plugins).toEqual([
      {
        source: plugin,
        install: 'file',
        skills: ['demo'],
        clients: ['codex', 'cursor'],
      },
    ]);
  });
});
