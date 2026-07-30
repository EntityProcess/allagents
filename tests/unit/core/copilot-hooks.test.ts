import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';
import { syncWorkspace } from '../../../src/core/sync.js';

describe('syncWorkspace Copilot hooks', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-copilot-hooks-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeWorkspace(plugins: string[]): Promise<void> {
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
${plugins.length > 0 ? `plugins:\n${plugins.map((plugin) => `  - ./${plugin}`).join('\n')}` : 'plugins: []'}
clients:
  - copilot
syncMode: copy
`,
    );
  }

  async function writePlugin(
    name: string,
    event: string,
    options: { nestedDeclaration?: boolean } = {},
  ): Promise<string> {
    const pluginDir = join(testDir, name);
    await mkdir(join(pluginDir, 'hooks'), { recursive: true });
    await writeFile(join(pluginDir, 'hooks', `${name}.sh`), '#!/bin/sh\n');
    const declarationPath = options.nestedDeclaration
      ? join(pluginDir, 'hooks', 'hooks.json')
      : join(pluginDir, 'hooks.json');
    await writeFile(
      declarationPath,
      JSON.stringify({
        version: 1,
        hooks: {
          [event]: [
            {
              type: 'command',
              bash: `bash "\${COPILOT_PLUGIN_ROOT}/hooks/${name}.sh"`,
            },
          ],
        },
      }),
    );
    return pluginDir;
  }

  it('materializes root plugin hook declarations as executable repository hooks', async () => {
    const pluginDir = join(testDir, 'org');
    await mkdir(join(pluginDir, 'hooks'), { recursive: true });
    await writeFile(join(pluginDir, 'hooks', 'session-start.sh'), '#!/bin/sh\n');
    await writeFile(
      join(pluginDir, 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          SessionStart: [
            {
              type: 'command',
              bash: 'bash "${COPILOT_PLUGIN_ROOT}/hooks/session-start.sh"',
            },
          ],
        },
      }),
    );
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ./org
clients:
  - copilot
syncMode: copy
`,
    );

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    const hooks = JSON.parse(
      await readFile(join(testDir, '.github', 'hooks', 'allagents.json'), 'utf-8'),
    ) as {
      hooks: Record<string, Array<{ env?: Record<string, string> }>>;
    };
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    expect(hooks.hooks.SessionStart?.[0]?.env?.COPILOT_PLUGIN_ROOT).toBe(pluginDir);
  });

  it('syncs a direct manifest-less plugin that has no hook declaration', async () => {
    await mkdir(join(testDir, 'direct-plugin', 'skills', 'direct-skill'), {
      recursive: true,
    });
    await writeFile(
      join(testDir, 'direct-plugin', 'skills', 'direct-skill', 'SKILL.md'),
      '---\nname: direct-skill\ndescription: Direct plugin skill\n---\n# Direct skill\n',
    );
    await writeWorkspace(['direct-plugin']);

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    expect(
      existsSync(join(testDir, '.github', 'skills', 'direct-skill', 'SKILL.md')),
    ).toBe(true);
    expect(existsSync(join(testDir, '.github', 'hooks', 'allagents.json'))).toBe(
      false,
    );
    expect(
      (result.warnings ?? []).some((warning) => warning.startsWith('Copilot hooks:')),
    ).toBe(false);
  });

  it('merges multiple plugins and reconciles only the AllAgents-owned hook file', async () => {
    const pluginA = await writePlugin('plugin-a', 'SessionStart');
    const pluginB = await writePlugin('plugin-b', 'PostToolUse');
    await writeWorkspace(['plugin-a', 'plugin-b']);
    await mkdir(join(testDir, '.github', 'hooks'), { recursive: true });
    await writeFile(
      join(testDir, '.github', 'hooks', 'user.json'),
      '{"version":1,"hooks":{}}',
    );

    const first = await syncWorkspace(testDir);

    expect(first.success).toBe(true);
    let hooks = JSON.parse(
      await readFile(join(testDir, '.github', 'hooks', 'allagents.json'), 'utf-8'),
    ) as {
      hooks: Record<string, Array<{ env: Record<string, string> }>>;
    };
    expect(hooks.hooks.SessionStart?.[0]?.env.COPILOT_PLUGIN_ROOT).toBe(pluginA);
    expect(hooks.hooks.PostToolUse?.[0]?.env.COPILOT_PLUGIN_ROOT).toBe(pluginB);
    expect(existsSync(join(testDir, '.github', 'hooks', 'user.json'))).toBe(true);

    await writeWorkspace(['plugin-b']);
    const second = await syncWorkspace(testDir);

    expect(second.success).toBe(true);
    hooks = JSON.parse(
      await readFile(join(testDir, '.github', 'hooks', 'allagents.json'), 'utf-8'),
    ) as typeof hooks;
    expect(hooks.hooks.SessionStart).toBeUndefined();
    expect(hooks.hooks.PostToolUse).toHaveLength(1);
    expect(existsSync(join(testDir, '.github', 'hooks', 'user.json'))).toBe(true);

    await writeWorkspace([]);
    const third = await syncWorkspace(testDir);

    expect(third.success).toBe(true);
    expect(existsSync(join(testDir, '.github', 'hooks', 'allagents.json'))).toBe(
      false,
    );
    expect(existsSync(join(testDir, '.github', 'hooks', 'user.json'))).toBe(true);
  });

  it('skips an entire hook declaration when any event is not an array', async () => {
    const invalidPlugin = await writePlugin('invalid-plugin', 'SessionStart');
    const validPlugin = await writePlugin('valid-plugin', 'PostToolUse');
    await mkdir(join(invalidPlugin, 'skills', 'invalid-plugin-skill'), {
      recursive: true,
    });
    await writeFile(
      join(invalidPlugin, 'skills', 'invalid-plugin-skill', 'SKILL.md'),
      '---\nname: invalid-plugin-skill\ndescription: Still syncs\n---\n# Skill\n',
    );
    await writeFile(
      join(invalidPlugin, 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          SessionStart: [
            {
              type: 'command',
              bash: 'bash "${COPILOT_PLUGIN_ROOT}/hooks/invalid-plugin.sh"',
            },
          ],
          UserPromptSubmit: { type: 'command', bash: 'echo invalid' },
        },
      }),
    );
    await writeWorkspace(['invalid-plugin', 'valid-plugin']);

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    expect(result.warnings).toContain(
      `Copilot hooks: event 'UserPromptSubmit' in ${join(invalidPlugin, 'hooks.json')} must be an array`,
    );
    const hooks = JSON.parse(
      await readFile(join(testDir, '.github', 'hooks', 'allagents.json'), 'utf-8'),
    ) as {
      hooks: Record<string, Array<{ env: Record<string, string> }>>;
    };
    expect(hooks.hooks.SessionStart).toBeUndefined();
    expect(hooks.hooks.PostToolUse).toHaveLength(1);
    expect(hooks.hooks.PostToolUse?.[0]?.env.COPILOT_PLUGIN_ROOT).toBe(validPlugin);
    expect(
      existsSync(
        join(testDir, '.github', 'skills', 'invalid-plugin-skill', 'SKILL.md'),
      ),
    ).toBe(true);
  });

  it('does not overwrite an existing unowned allagents hook file', async () => {
    await writePlugin('plugin-a', 'SessionStart');
    await writeWorkspace(['plugin-a']);
    await mkdir(join(testDir, '.github', 'hooks'), { recursive: true });
    const original = '{"version":1,"hooks":{"SessionStart":[]}}';
    await writeFile(join(testDir, '.github', 'hooks', 'allagents.json'), original);

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    expect(result.warnings).toContain(
      'Copilot hooks: not updating .github/hooks/allagents.json because the existing file is not owned by AllAgents',
    );
    expect(
      await readFile(join(testDir, '.github', 'hooks', 'allagents.json'), 'utf-8'),
    ).toBe(original);
  });

  it('materializes hooks/hooks.json once instead of copying an unresolved duplicate', async () => {
    await writePlugin('plugin-a', 'SessionStart', { nestedDeclaration: true });
    await writeWorkspace(['plugin-a']);

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    expect(existsSync(join(testDir, '.github', 'hooks', 'allagents.json'))).toBe(
      true,
    );
    expect(existsSync(join(testDir, '.github', 'hooks', 'hooks.json'))).toBe(
      false,
    );
  });

  it('does not activate a root declaration when its hook payload is excluded', async () => {
    await writePlugin('plugin-a', 'SessionStart');
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - source: ./plugin-a
    exclude:
      - hooks/plugin-a.sh
clients:
  - copilot
syncMode: copy
`,
    );

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    expect(existsSync(join(testDir, '.github', 'hooks', 'allagents.json'))).toBe(
      false,
    );
    expect(existsSync(join(testDir, '.github', 'hooks', 'plugin-a.sh'))).toBe(
      false,
    );
  });

  it('does not activate an excluded nested declaration', async () => {
    await writePlugin('plugin-a', 'SessionStart', { nestedDeclaration: true });
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - source: ./plugin-a
    exclude:
      - hooks/hooks.json
clients:
  - copilot
syncMode: copy
`,
    );

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    expect(existsSync(join(testDir, '.github', 'hooks', 'allagents.json'))).toBe(
      false,
    );
  });
});
