import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dump } from 'js-yaml';
import { syncUserWorkspace } from '../../../src/core/sync.js';
import { WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';

describe('syncUserWorkspace', () => {
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-user-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = testDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(testDir, { recursive: true, force: true });
  });

  /**
   * Helper: create ~/.allagents/workspace.yaml with given config
   */
  async function writeUserConfig(config: WorkspaceConfig): Promise<void> {
    const allagentsDir = join(testDir, '.allagents');
    await mkdir(allagentsDir, { recursive: true });
    await writeFile(
      join(allagentsDir, WORKSPACE_CONFIG_FILE),
      dump(config, { lineWidth: -1 }),
      'utf-8',
    );
  }

  /**
   * Helper: create a local plugin directory with a skill
   */
  async function createLocalPlugin(
    name: string,
    skillName: string,
  ): Promise<string> {
    const pluginDir = join(testDir, 'plugins', name);
    const skillDir = join(pluginDir, 'skills', skillName);
    await mkdir(skillDir, { recursive: true });
    const skillContent = [
      '---',
      `name: ${skillName}`,
      `description: A test skill called ${skillName}`,
      '---',
      '',
      `# ${skillName} skill`,
    ].join('\n');
    await writeFile(join(skillDir, 'SKILL.md'), skillContent);
    return pluginDir;
  }

  it('returns success with empty results when no user workspace config exists', async () => {
    // No ~/.allagents/workspace.yaml exists
    const result = await syncUserWorkspace();

    expect(result.success).toBe(true);
    expect(result.pluginResults).toEqual([]);
    expect(result.totalCopied).toBe(0);
    expect(result.totalFailed).toBe(0);
    expect(result.totalSkipped).toBe(0);
    expect(result.totalGenerated).toBe(0);
  });

  it('returns success with empty results when config has no plugins', async () => {
    await writeUserConfig({
      repositories: [],
      plugins: [],
      clients: ['claude'],
    });

    const result = await syncUserWorkspace();

    expect(result.success).toBe(true);
    expect(result.pluginResults).toEqual([]);
    expect(result.totalCopied).toBe(0);
  });

  it('syncs local plugin skills to user home directories', async () => {
    const pluginDir = await createLocalPlugin('my-plugin', 'my-skill');

    await writeUserConfig({
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
      syncMode: 'copy', // Use copy mode for predictable counts
    });

    const result = await syncUserWorkspace();

    expect(result.success).toBe(true);
    expect(result.totalCopied).toBe(1);
    expect(result.totalFailed).toBe(0);

    // Skill should be copied to ~/.claude/skills/my-skill/
    const skillDest = join(testDir, '.claude', 'skills', 'my-skill', 'SKILL.md');
    expect(existsSync(skillDest)).toBe(true);
    const content = await readFile(skillDest, 'utf-8');
    expect(content).toContain('# my-skill skill');
  });

  it('syncs to multiple clients using USER_CLIENT_MAPPINGS', async () => {
    const pluginDir = await createLocalPlugin('my-plugin', 'my-skill');

    await writeUserConfig({
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude', 'cursor'],
      syncMode: 'copy', // Use copy mode for predictable counts
    });

    const result = await syncUserWorkspace();

    expect(result.success).toBe(true);
    expect(result.totalCopied).toBe(2); // One skill to each client

    // Claude: ~/.claude/skills/my-skill/SKILL.md
    expect(existsSync(join(testDir, '.claude', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);

    // Cursor: ~/.cursor/skills/my-skill/SKILL.md
    expect(existsSync(join(testDir, '.cursor', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);
  });

  it('purges previously synced files on re-sync when plugin is removed', async () => {
    const pluginDir = await createLocalPlugin('my-plugin', 'my-skill');

    // First sync with plugin
    await writeUserConfig({
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
      syncMode: 'copy', // Use copy mode for predictable counts
    });

    const result1 = await syncUserWorkspace();
    expect(result1.success).toBe(true);
    expect(result1.totalCopied).toBe(1);

    // Verify file exists
    const skillDest = join(testDir, '.claude', 'skills', 'my-skill', 'SKILL.md');
    expect(existsSync(skillDest)).toBe(true);

    // Second sync without plugin (removed from config)
    await writeUserConfig({
      repositories: [],
      plugins: [],
      clients: ['claude'],
      syncMode: 'copy', // Use copy mode for predictable counts
    });

    const result2 = await syncUserWorkspace();
    expect(result2.success).toBe(true);
    expect(result2.totalCopied).toBe(0);

    // Previously synced skill should be purged
    expect(existsSync(skillDest)).toBe(false);
  });

  it('saves sync state to ~/.allagents/sync-state.json', async () => {
    const pluginDir = await createLocalPlugin('my-plugin', 'my-skill');

    await writeUserConfig({
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
    });

    await syncUserWorkspace();

    // Sync state should exist
    const statePath = join(testDir, '.allagents', 'sync-state.json');
    expect(existsSync(statePath)).toBe(true);

    const stateContent = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(stateContent.version).toBe(1);
    expect(stateContent.files.claude).toBeDefined();
    expect(stateContent.files.claude.length).toBeGreaterThan(0);
  });

  it('does not write files in dry-run mode', async () => {
    const pluginDir = await createLocalPlugin('my-plugin', 'my-skill');

    await writeUserConfig({
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
      syncMode: 'copy', // Use copy mode for predictable counts
    });

    const result = await syncUserWorkspace({ dryRun: true });

    expect(result.success).toBe(true);
    expect(result.totalCopied).toBe(1); // Reports as copied but doesn't actually write

    // Skill should NOT be on disk
    const skillDest = join(testDir, '.claude', 'skills', 'my-skill', 'SKILL.md');
    expect(existsSync(skillDest)).toBe(false);
  });

  it('returns failure when plugin validation fails', async () => {
    await writeUserConfig({
      repositories: [],
      plugins: ['/nonexistent/path/to/plugin'],
      clients: ['claude'],
    });

    const result = await syncUserWorkspace();

    expect(result.success).toBe(false);
    expect(result.totalFailed).toBeGreaterThan(0);
    expect(result.error).toBeDefined();
  });

  it('copies to each provider-specific path when clients have unique paths', async () => {
    // copilot, codex, opencode now each have unique user-level paths
    const pluginDir = await createLocalPlugin('my-plugin', 'my-skill');

    await writeUserConfig({
      repositories: [],
      plugins: [pluginDir],
      clients: ['copilot', 'codex', 'opencode'],
    });

    const result = await syncUserWorkspace();

    expect(result.success).toBe(true);
    // Should copy 3 times since all have different paths
    expect(result.totalCopied).toBe(3);

    // Skills should exist in each provider-specific path
    expect(existsSync(join(testDir, '.copilot', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(testDir, '.codex', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(testDir, '.opencode', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);

    // Verify sync state tracks the skill for all clients
    const statePath = join(testDir, '.allagents', 'sync-state.json');
    const stateContent = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(stateContent.files.copilot).toContain('.copilot/skills/my-skill/');
    expect(stateContent.files.codex).toContain('.codex/skills/my-skill/');
    expect(stateContent.files.opencode).toContain('.opencode/skills/my-skill/');
  });

  it('syncs to different paths for mixed clients', async () => {
    // claude uses ~/.claude/skills/, copilot uses ~/.copilot/skills/, codex uses ~/.codex/skills/
    const pluginDir = await createLocalPlugin('my-plugin', 'my-skill');

    await writeUserConfig({
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude', 'copilot', 'codex'],
    });

    const result = await syncUserWorkspace();

    expect(result.success).toBe(true);
    // Should copy three times: each client has a unique path
    expect(result.totalCopied).toBe(3);

    // Skill should exist in all locations
    expect(existsSync(join(testDir, '.claude', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(testDir, '.copilot', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(testDir, '.codex', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);

    // Verify sync state tracks correctly
    const statePath = join(testDir, '.allagents', 'sync-state.json');
    const stateContent = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(stateContent.files.claude).toContain('.claude/skills/my-skill/');
    expect(stateContent.files.copilot).toContain('.copilot/skills/my-skill/');
    expect(stateContent.files.codex).toContain('.codex/skills/my-skill/');
  });
});
