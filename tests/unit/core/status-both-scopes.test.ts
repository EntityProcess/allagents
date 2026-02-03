import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dump } from 'js-yaml';
import { getWorkspaceStatus } from '../../../src/core/status.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';

describe('workspace status - both scopes', () => {
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-status-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = testDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
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

  async function writeUserConfig(config: WorkspaceConfig): Promise<void> {
    const allagentsDir = join(testDir, '.allagents');
    await mkdir(allagentsDir, { recursive: true });
    await writeFile(
      join(allagentsDir, WORKSPACE_CONFIG_FILE),
      dump(config, { lineWidth: -1 }),
      'utf-8',
    );
  }

  async function createLocalPlugin(name: string): Promise<string> {
    const pluginDir = join(testDir, 'plugins', name);
    await mkdir(pluginDir, { recursive: true });
    return pluginDir;
  }

  it('should include userPlugins in status result', async () => {
    const projectPlugin = await createLocalPlugin('project-plugin');
    const userPlugin = await createLocalPlugin('user-plugin');

    await writeProjectConfig({
      repositories: [],
      plugins: [projectPlugin],
      clients: ['claude'],
    });

    await writeUserConfig({
      repositories: [],
      plugins: [userPlugin],
      clients: ['claude'],
    });

    const result = await getWorkspaceStatus(testDir);
    expect(result.success).toBe(true);
    expect(result.plugins.length).toBe(1);
    expect(result.userPlugins).toBeDefined();
    expect(result.userPlugins!.length).toBe(1);
  });

  it('should fall back to user plugins when no project workspace exists', async () => {
    // Use a separate HOME so user config doesn't overlap with project dir
    const homeDir = await mkdtemp(join(tmpdir(), 'allagents-status-home-'));
    process.env.HOME = homeDir;

    const userPlugin = await createLocalPlugin('user-plugin');
    const allagentsDir = join(homeDir, '.allagents');
    await mkdir(allagentsDir, { recursive: true });
    await writeFile(
      join(allagentsDir, WORKSPACE_CONFIG_FILE),
      dump({ repositories: [], plugins: [userPlugin], clients: ['claude'] } satisfies WorkspaceConfig, { lineWidth: -1 }),
      'utf-8',
    );

    // No project config — should succeed with user plugins only
    const result = await getWorkspaceStatus(testDir);
    expect(result.success).toBe(true);
    expect(result.plugins).toEqual([]);
    expect(result.clients).toEqual([]);
    expect(result.userPlugins!.length).toBe(1);

    await rm(homeDir, { recursive: true, force: true });
  });

  it('should show empty userPlugins when no user config exists', async () => {
    // Use a separate HOME dir so there's no user config
    const separateHome = await mkdtemp(join(tmpdir(), 'allagents-status-home-'));
    process.env.HOME = separateHome;

    const projectPlugin = await createLocalPlugin('project-plugin');

    await writeProjectConfig({
      repositories: [],
      plugins: [projectPlugin],
      clients: ['claude'],
    });

    const result = await getWorkspaceStatus(testDir);
    expect(result.success).toBe(true);
    expect(result.userPlugins).toEqual([]);

    await rm(separateHome, { recursive: true, force: true });
  });
});
