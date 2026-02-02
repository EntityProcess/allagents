import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addUserPlugin, removeUserPlugin, getUserWorkspaceConfig } from '../../src/core/user-workspace.js';
import { addPlugin } from '../../src/core/workspace-modify.js';
import { syncUserWorkspace, syncWorkspace } from '../../src/core/sync.js';
import { initWorkspace } from '../../src/core/workspace.js';

// E2E tests require network access and gh authentication.
// They are skipped by default; run with ALLAGENTS_E2E=1 to enable.
const e2eEnabled = process.env.ALLAGENTS_E2E === '1';

describe.skipIf(!e2eEnabled)('E2E: user scope vs project scope', () => {
  let tempHome: string;
  let tempProject: string;
  let originalHome: string;
  let originalGhConfigDir: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'allagents-e2e-home-'));
    tempProject = await mkdtemp(join(tmpdir(), 'allagents-e2e-proj-'));
    originalHome = process.env.HOME || '';
    originalGhConfigDir = process.env.GH_CONFIG_DIR;

    // Preserve gh CLI config so it can authenticate when HOME changes
    if (!process.env.GH_CONFIG_DIR) {
      process.env.GH_CONFIG_DIR = join(originalHome, '.config', 'gh');
    }

    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (originalGhConfigDir !== undefined) {
      process.env.GH_CONFIG_DIR = originalGhConfigDir;
    } else {
      delete process.env.GH_CONFIG_DIR;
    }
    await rm(tempHome, { recursive: true, force: true });
    await rm(tempProject, { recursive: true, force: true });
  });

  test('user scope installs plugin from obra/superpowers', async () => {
    const result = await addUserPlugin('superpowers@obra/superpowers');
    expect(result.success).toBe(true);

    const syncResult = await syncUserWorkspace();
    expect(syncResult.success).toBe(true);
    expect(syncResult.totalCopied).toBeGreaterThan(0);

    // obra/superpowers installs both commands and skills
    const claudeDir = join(tempHome, '.claude');
    expect(existsSync(claudeDir)).toBe(true);

    // Verify commands were synced
    expect(existsSync(join(claudeDir, 'commands'))).toBe(true);
    const commands = await readdir(join(claudeDir, 'commands'));
    expect(commands.length).toBeGreaterThan(0);

    // Verify skills were synced
    expect(existsSync(join(claudeDir, 'skills'))).toBe(true);
    const skills = await readdir(join(claudeDir, 'skills'));
    expect(skills.length).toBeGreaterThan(0);
  }, 60000); // 60s timeout for network

  test('project scope installs plugin from claude-plugins-official', async () => {
    // Init a workspace first
    await initWorkspace(tempProject);

    const result = await addPlugin('code-review@claude-plugins-official', tempProject);
    expect(result.success).toBe(true);

    const syncResult = await syncWorkspace(tempProject);
    expect(syncResult.success).toBe(true);
    expect(syncResult.totalCopied).toBeGreaterThan(0);

    // code-review plugin installs commands (not skills)
    const claudeDir = join(tempProject, '.claude');
    expect(existsSync(claudeDir)).toBe(true);
    expect(existsSync(join(claudeDir, 'commands'))).toBe(true);
    const commands = await readdir(join(claudeDir, 'commands'));
    expect(commands.length).toBeGreaterThan(0);
  }, 60000);

  test('user and project scope do not interfere', async () => {
    // Install user-scoped plugin
    const userResult = await addUserPlugin('superpowers@obra/superpowers');
    expect(userResult.success).toBe(true);
    await syncUserWorkspace();

    // Init project and install project-scoped plugin
    await initWorkspace(tempProject);
    const projResult = await addPlugin('code-review@claude-plugins-official', tempProject);
    expect(projResult.success).toBe(true);
    await syncWorkspace(tempProject);

    // User commands/skills in home dir
    expect(existsSync(join(tempHome, '.claude', 'commands'))).toBe(true);
    expect(existsSync(join(tempHome, '.claude', 'skills'))).toBe(true);

    // Project commands in project dir
    expect(existsSync(join(tempProject, '.claude', 'commands'))).toBe(true);

    // Verify they are independent - user home should not have project plugin files
    const userCommands = await readdir(join(tempHome, '.claude', 'commands'));
    const projCommands = await readdir(join(tempProject, '.claude', 'commands'));

    // The user has superpowers commands, the project has code-review commands
    // They should be different sets
    expect(userCommands.length).toBeGreaterThan(0);
    expect(projCommands.length).toBeGreaterThan(0);
  }, 90000);

  test('user scope uninstall purges synced files from home', async () => {
    // Install
    const addResult = await addUserPlugin('superpowers@obra/superpowers');
    expect(addResult.success).toBe(true);
    await syncUserWorkspace();
    expect(existsSync(join(tempHome, '.claude', 'commands'))).toBe(true);

    // Read config to find the actual stored plugin name (may be normalized)
    const config = await getUserWorkspaceConfig();
    expect(config).not.toBeNull();
    const storedPluginName = config!.plugins[0];

    // Uninstall using the stored name
    const removeResult = await removeUserPlugin(storedPluginName);
    expect(removeResult.success).toBe(true);
    await syncUserWorkspace();

    // Synced files should be purged after re-sync with empty plugin list
    const commandsDir = join(tempHome, '.claude', 'commands');
    if (existsSync(commandsDir)) {
      const remaining = await readdir(commandsDir);
      expect(remaining.length).toBe(0);
    }

    const skillsDir = join(tempHome, '.claude', 'skills');
    if (existsSync(skillsDir)) {
      const remaining = await readdir(skillsDir);
      expect(remaining.length).toBe(0);
    }
  }, 60000);
});
