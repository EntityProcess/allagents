import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dump } from 'js-yaml';

describe('plugin uninstall smart scope resolution', () => {
  let tempHome: string;
  let tempProject: string;
  let originalHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'allagents-uninstall-home-'));
    tempProject = await mkdtemp(join(tmpdir(), 'allagents-uninstall-proj-'));
    originalHome = process.env.HOME || '';
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
    await rm(tempProject, { recursive: true, force: true });
  });

  async function setupProjectWorkspace(plugins: string[]) {
    const configDir = join(tempProject, '.allagents');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, 'workspace.yaml'),
      dump({ repositories: [], plugins, clients: ['claude'] }, { lineWidth: -1 }),
    );
  }

  async function setupUserWorkspace(plugins: string[]) {
    const configDir = join(tempHome, '.allagents');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, 'workspace.yaml'),
      dump({ repositories: [], plugins, clients: ['claude'] }, { lineWidth: -1 }),
    );
  }

  test('hasPlugin returns true for exact match in project scope', async () => {
    await setupProjectWorkspace(['my-plugin@marketplace']);
    const { hasPlugin } = await import('../../src/core/workspace-modify.js');
    expect(await hasPlugin('my-plugin@marketplace', tempProject)).toBe(true);
  });

  test('hasPlugin returns true for partial match in project scope', async () => {
    await setupProjectWorkspace(['my-plugin@marketplace']);
    const { hasPlugin } = await import('../../src/core/workspace-modify.js');
    expect(await hasPlugin('my-plugin', tempProject)).toBe(true);
  });

  test('hasPlugin returns false when plugin not in project scope', async () => {
    await setupProjectWorkspace(['other-plugin@marketplace']);
    const { hasPlugin } = await import('../../src/core/workspace-modify.js');
    expect(await hasPlugin('my-plugin', tempProject)).toBe(false);
  });

  test('hasPlugin returns false when no project workspace exists', async () => {
    const { hasPlugin } = await import('../../src/core/workspace-modify.js');
    expect(await hasPlugin('my-plugin', tempProject)).toBe(false);
  });

  test('hasUserPlugin returns true for exact match in user scope', async () => {
    await setupUserWorkspace(['my-plugin@marketplace']);
    const { hasUserPlugin } = await import('../../src/core/user-workspace.js');
    expect(await hasUserPlugin('my-plugin@marketplace')).toBe(true);
  });

  test('hasUserPlugin returns true for partial match in user scope', async () => {
    await setupUserWorkspace(['my-plugin@marketplace']);
    const { hasUserPlugin } = await import('../../src/core/user-workspace.js');
    expect(await hasUserPlugin('my-plugin')).toBe(true);
  });

  test('hasUserPlugin returns false when plugin not in user scope', async () => {
    await setupUserWorkspace(['other-plugin@marketplace']);
    const { hasUserPlugin } = await import('../../src/core/user-workspace.js');
    expect(await hasUserPlugin('my-plugin')).toBe(false);
  });

  test('hasUserPlugin returns false when no user workspace exists', async () => {
    const { hasUserPlugin } = await import('../../src/core/user-workspace.js');
    expect(await hasUserPlugin('my-plugin')).toBe(false);
  });

  test('removePlugin succeeds when plugin is in project scope', async () => {
    await setupProjectWorkspace(['my-plugin@marketplace']);
    const { removePlugin } = await import('../../src/core/workspace-modify.js');
    const result = await removePlugin('my-plugin@marketplace', tempProject);
    expect(result.success).toBe(true);
  });

  test('removeUserPlugin succeeds when plugin is in user scope', async () => {
    await setupUserWorkspace(['my-plugin@marketplace']);
    const { removeUserPlugin } = await import('../../src/core/user-workspace.js');
    const result = await removeUserPlugin('my-plugin@marketplace');
    expect(result.success).toBe(true);
  });

  test('removePlugin fails when plugin only in user scope', async () => {
    await setupProjectWorkspace([]);
    await setupUserWorkspace(['my-plugin@marketplace']);
    const { removePlugin } = await import('../../src/core/workspace-modify.js');
    const result = await removePlugin('my-plugin@marketplace', tempProject);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});
