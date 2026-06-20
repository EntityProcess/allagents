import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncCodexProjectHooks } from '../../../src/core/codex-hooks.js';
import { syncWorkspace } from '../../../src/core/sync.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';
import type { SyncState } from '../../../src/models/sync-state.js';
import type { ValidatedPlugin } from '../../../src/core/sync.js';

function validatedCodexPlugin(path: string, plugin: string): ValidatedPlugin {
  return {
    plugin,
    resolved: path,
    success: true,
    clients: ['codex'],
    nativeClients: [],
  };
}

async function writeSkill(pluginDir: string, name: string): Promise<void> {
  await mkdir(join(pluginDir, 'skills', name), { recursive: true });
  await writeFile(
    join(pluginDir, 'skills', name, 'SKILL.md'),
    `---
name: ${name}
description: ${name} description
---
`,
    'utf-8',
  );
}

async function readHooks(workspaceDir: string): Promise<Record<string, unknown[]>> {
  const content = await readFile(join(workspaceDir, '.codex', 'hooks.json'), 'utf-8');
  return (JSON.parse(content) as { hooks: Record<string, unknown[]> }).hooks;
}

function commandFrom(group: unknown): string | undefined {
  const hooks = (group as { hooks?: Array<{ command?: string }> }).hooks;
  return hooks?.[0]?.command;
}

describe('syncCodexProjectHooks', () => {
  let testDir: string;
  let workspaceDir: string;
  let pluginA: string;
  let pluginB: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-codex-hooks-'));
    workspaceDir = join(testDir, 'workspace');
    pluginA = join(testDir, 'plugin-a');
    pluginB = join(testDir, 'plugin-b');
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(join(pluginA, '.codex-plugin', 'hooks'), { recursive: true });
    await mkdir(join(pluginB, 'hooks'), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('merges multiple plugin hooks into existing project hooks without duplicating on update', async () => {
    await mkdir(join(workspaceDir, '.codex'), { recursive: true });
    await writeFile(
      join(workspaceDir, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo user' }] }],
        },
      }),
      'utf-8',
    );

    await writeFile(
      join(pluginA, '.codex-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'plugin-a',
        hooks: './.codex-plugin/hooks/hooks.json',
      }),
      'utf-8',
    );
    await writeFile(
      join(pluginA, '.codex-plugin', 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '"${PLUGIN_ROOT}/hooks/run-hook.cmd" session-start',
                },
              ],
            },
          ],
        },
      }),
      'utf-8',
    );
    await writeFile(
      join(pluginB, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo b' }] }],
        },
      }),
      'utf-8',
    );

    const plugins = [
      validatedCodexPlugin(pluginA, './plugin-a'),
      validatedCodexPlugin(pluginB, './plugin-b'),
    ];
    const first = syncCodexProjectHooks(plugins, workspaceDir, undefined);
    expect(first.warnings).toEqual([]);

    let hooks = await readHooks(workspaceDir);
    expect(hooks.SessionStart).toHaveLength(2);
    expect(commandFrom(hooks.SessionStart![0])).toBe('echo user');
    expect(commandFrom(hooks.SessionStart![1])).toContain(`${pluginA}/hooks/run-hook.cmd`);
    expect(hooks.UserPromptSubmit).toHaveLength(1);

    const withoutState = syncCodexProjectHooks(plugins, workspaceDir, undefined);
    expect(withoutState.warnings).toEqual([]);

    hooks = await readHooks(workspaceDir);
    expect(hooks.SessionStart).toHaveLength(2);
    expect(commandFrom(hooks.SessionStart![0])).toBe('echo user');
    expect(commandFrom(hooks.SessionStart![1])).toContain(`${pluginA}/hooks/run-hook.cmd`);
    expect(hooks.UserPromptSubmit).toHaveLength(1);

    const second = syncCodexProjectHooks(plugins, workspaceDir, first.managedHooks);
    expect(second.warnings).toEqual([]);

    hooks = await readHooks(workspaceDir);
    expect(hooks.SessionStart).toHaveLength(2);
    expect(commandFrom(hooks.SessionStart![0])).toBe('echo user');
    expect(commandFrom(hooks.SessionStart![1])).toContain(`${pluginA}/hooks/run-hook.cmd`);
    expect(hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('removes only the previously managed hooks when plugins stop providing hooks', async () => {
    await mkdir(join(workspaceDir, '.codex'), { recursive: true });
    await writeFile(
      join(workspaceDir, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'echo user' }] },
            { hooks: [{ type: 'command', command: 'echo managed' }] },
          ],
        },
      }),
      'utf-8',
    );
    const previousManaged: NonNullable<SyncState['codexHooks']> = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo managed' }] }],
      },
    };

    syncCodexProjectHooks([], workspaceDir, previousManaged);

    const hooks = await readHooks(workspaceDir);
    expect(hooks.SessionStart).toHaveLength(1);
    expect(commandFrom(hooks.SessionStart![0])).toBe('echo user');
  });

  it('deletes hooks.json when the only hooks were previously managed', async () => {
    await mkdir(join(workspaceDir, '.codex'), { recursive: true });
    await writeFile(
      join(workspaceDir, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo managed' }] }],
        },
      }),
      'utf-8',
    );
    const previousManaged: NonNullable<SyncState['codexHooks']> = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo managed' }] }],
      },
    };

    syncCodexProjectHooks([], workspaceDir, previousManaged);

    expect(existsSync(join(workspaceDir, '.codex', 'hooks.json'))).toBe(false);
  });

  it('does not overwrite an existing project hooks file with invalid hook arrays', async () => {
    await mkdir(join(workspaceDir, '.codex'), { recursive: true });
    const hooksPath = join(workspaceDir, '.codex', 'hooks.json');
    const originalContent = JSON.stringify({
      hooks: {
        SessionStart: { hooks: [{ type: 'command', command: 'echo invalid' }] },
      },
    });
    await writeFile(hooksPath, originalContent, 'utf-8');
    await writeFile(
      join(pluginB, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo b' }] }],
        },
      }),
      'utf-8',
    );

    const result = syncCodexProjectHooks(
      [validatedCodexPlugin(pluginB, './plugin-b')],
      workspaceDir,
      undefined,
    );

    expect(result.copyResults).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes('not updating'))).toBe(true);
    expect(await readFile(hooksPath, 'utf-8')).toBe(originalContent);
  });
});

describe('syncWorkspace Codex hooks', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-codex-hooks-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('syncs project-scoped Codex skills and multiple hooks while preserving existing hooks', async () => {
    const pluginA = join(testDir, 'plugin-a');
    const pluginB = join(testDir, 'plugin-b');
    await writeSkill(pluginA, 'a');
    await writeSkill(pluginB, 'b');
    await mkdir(join(pluginA, '.codex-plugin', 'hooks'), { recursive: true });
    await mkdir(join(pluginB, 'hooks'), { recursive: true });
    await writeFile(
      join(pluginA, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'plugin-a', hooks: './.codex-plugin/hooks/hooks.json' }),
      'utf-8',
    );
    await writeFile(
      join(pluginA, '.codex-plugin', 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo a' }] }],
        },
      }),
      'utf-8',
    );
    await writeFile(
      join(pluginB, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo b' }] }],
        },
      }),
      'utf-8',
    );
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await mkdir(join(testDir, '.codex'), { recursive: true });
    await writeFile(
      join(testDir, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo user' }] }],
        },
      }),
      'utf-8',
    );
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ./plugin-a
  - ./plugin-b
clients:
  - codex
syncMode: copy
`,
      'utf-8',
    );

    const first = await syncWorkspace(testDir);
    expect(first.success).toBe(true);
    expect(first.totalGenerated).toBe(1);
    expect(existsSync(join(testDir, '.codex', 'skills', 'a'))).toBe(true);
    expect(existsSync(join(testDir, '.codex', 'skills', 'b'))).toBe(true);

    let hooks = await readHooks(testDir);
    expect(hooks.SessionStart).toHaveLength(2);
    expect(hooks.UserPromptSubmit).toHaveLength(1);

    const stateContent = await readFile(join(testDir, CONFIG_DIR, 'sync-state.json'), 'utf-8');
    const state = JSON.parse(stateContent) as SyncState;
    expect(state.codexHooks?.hooks.SessionStart).toHaveLength(1);
    expect(state.codexHooks?.hooks.UserPromptSubmit).toHaveLength(1);

    const second = await syncWorkspace(testDir);
    expect(second.success).toBe(true);
    expect(second.totalGenerated).toBe(1);

    hooks = await readHooks(testDir);
    expect(hooks.SessionStart).toHaveLength(2);
    expect(hooks.UserPromptSubmit).toHaveLength(1);
  });
});
