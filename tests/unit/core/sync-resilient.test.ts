import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dump } from 'js-yaml';
import { syncWorkspace, syncUserWorkspace } from '../../../src/core/sync.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';

describe('sync resilience - project scope', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-resilient-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeProjectConfig(config: WorkspaceConfig): Promise<void> {
    const configDir = join(testDir, CONFIG_DIR);
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, WORKSPACE_CONFIG_FILE),
      dump(config, { lineWidth: -1 }),
      'utf-8',
    );
  }

  async function createLocalPlugin(name: string, skillName: string): Promise<string> {
    const pluginDir = join(testDir, 'plugins', name);
    const skillDir = join(pluginDir, 'skills', skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), [
      '---',
      `name: ${skillName}`,
      `description: Test skill ${skillName}`,
      '---',
      '',
      `# ${skillName}`,
    ].join('\n'));
    return pluginDir;
  }

  it('should sync valid plugins and skip invalid ones with warnings', async () => {
    const goodPlugin = await createLocalPlugin('good-plugin', 'good-skill');

    await writeProjectConfig({
      repositories: [],
      plugins: [
        goodPlugin,
        'nonexistent@fake-marketplace',
      ],
      clients: ['claude'],
    });

    const result = await syncWorkspace(testDir);

    // Should succeed overall (partial success)
    expect(result.success).toBe(true);
    expect(result.totalCopied).toBeGreaterThan(0);

    // Should have warnings for the failed plugin
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
    expect(result.warnings![0]).toContain('nonexistent@fake-marketplace');

    // The good plugin should have been synced
    expect(result.pluginResults.length).toBe(1);
    expect(result.pluginResults[0].success).toBe(true);
  });

  it('should fail when ALL plugins are invalid', async () => {
    await writeProjectConfig({
      repositories: [],
      plugins: [
        'bad1@fake-marketplace',
        'bad2@fake-marketplace',
      ],
      clients: ['claude'],
    });

    const result = await syncWorkspace(testDir);

    // When everything fails, sync should fail
    expect(result.success).toBe(false);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBe(2);
  });
});

describe('sync resilience - user scope', () => {
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-user-resilient-'));
    originalHome = process.env.HOME;
    process.env.HOME = testDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeUserConfig(config: WorkspaceConfig): Promise<void> {
    const allagentsDir = join(testDir, '.allagents');
    await mkdir(allagentsDir, { recursive: true });
    await writeFile(
      join(allagentsDir, WORKSPACE_CONFIG_FILE),
      dump(config, { lineWidth: -1 }),
      'utf-8',
    );
  }

  async function createLocalPlugin(name: string, skillName: string): Promise<string> {
    const pluginDir = join(testDir, 'plugins', name);
    const skillDir = join(pluginDir, 'skills', skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), [
      '---',
      `name: ${skillName}`,
      `description: Test skill ${skillName}`,
      '---',
      '',
      `# ${skillName}`,
    ].join('\n'));
    return pluginDir;
  }

  it('should sync valid user plugins and skip invalid ones with warnings', async () => {
    const goodPlugin = await createLocalPlugin('good-plugin', 'good-skill');

    await writeUserConfig({
      repositories: [],
      plugins: [
        goodPlugin,
        'nonexistent@fake-marketplace',
      ],
      clients: ['claude'],
    });

    const result = await syncUserWorkspace();

    expect(result.success).toBe(true);
    expect(result.totalCopied).toBeGreaterThan(0);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
  });
});
