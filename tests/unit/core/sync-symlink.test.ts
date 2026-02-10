import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, lstat, readlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { syncWorkspace } from '../../../src/core/sync.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';

describe('syncWorkspace with symlink mode', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-symlink-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function createPlugin(name: string, skillName: string): Promise<string> {
    const pluginDir = join(testDir, name);
    const skillDir = join(pluginDir, 'skills', skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: ${skillName}
description: Test skill
---

# ${skillName} skill`,
    );
    return pluginDir;
  }

  it('creates symlink from non-universal client to canonical location', async () => {
    const pluginDir = await createPlugin('my-plugin', 'my-skill');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - claude
`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    // Canonical should exist as a real directory
    const canonicalPath = join(testDir, '.agents', 'skills', 'my-skill');
    expect(existsSync(canonicalPath)).toBe(true);
    const canonicalStats = await lstat(canonicalPath);
    expect(canonicalStats.isSymbolicLink()).toBe(false);
    expect(canonicalStats.isDirectory()).toBe(true);

    // Claude path should be a symlink
    const claudePath = join(testDir, '.claude', 'skills', 'my-skill');
    expect(existsSync(claudePath)).toBe(true);
    const claudeStats = await lstat(claudePath);
    expect(claudeStats.isSymbolicLink()).toBe(true);

    // Symlink should point to canonical
    const target = await readlink(claudePath);
    // On Windows, junction may return absolute or relative path
    // On Unix, it's a relative path. Just check it contains the canonical path.
    const normalizedTarget = target.split(sep).join('/');
    expect(normalizedTarget).toContain('.agents/skills/my-skill');
  });

  it('does not create symlink for universal clients', async () => {
    const pluginDir = await createPlugin('my-plugin', 'my-skill');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - copilot
`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    // Canonical should exist as a real directory
    const canonicalPath = join(testDir, '.agents', 'skills', 'my-skill');
    expect(existsSync(canonicalPath)).toBe(true);
    const canonicalStats = await lstat(canonicalPath);
    expect(canonicalStats.isSymbolicLink()).toBe(false);
    expect(canonicalStats.isDirectory()).toBe(true);
  });

  it('creates symlinks for multiple non-universal clients', async () => {
    const pluginDir = await createPlugin('my-plugin', 'my-skill');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - claude
  - cursor
`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    // Both should be symlinks pointing to canonical
    for (const client of ['claude', 'cursor']) {
      const clientPath = join(testDir, `.${client}`, 'skills', 'my-skill');
      expect(existsSync(clientPath)).toBe(true);
      const stats = await lstat(clientPath);
      expect(stats.isSymbolicLink()).toBe(true);
    }
  });

  it('purges symlink when plugin is removed', async () => {
    const pluginDir = await createPlugin('my-plugin', 'my-skill');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - claude
`,
    );

    // First sync
    await syncWorkspace(testDir);
    expect(existsSync(join(testDir, '.claude', 'skills', 'my-skill'))).toBe(true);

    // Remove plugin
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins: []
clients:
  - claude
`,
    );

    // Second sync
    await syncWorkspace(testDir);

    // Symlink should be purged
    expect(existsSync(join(testDir, '.claude', 'skills', 'my-skill'))).toBe(false);
  });

  it('uses copy mode when syncMode is set to copy', async () => {
    const pluginDir = await createPlugin('my-plugin', 'my-skill');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - claude
syncMode: copy
`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    // With copy mode, .claude/skills/my-skill should be a real directory, not a symlink
    const claudePath = join(testDir, '.claude', 'skills', 'my-skill');
    expect(existsSync(claudePath)).toBe(true);
    const stats = await lstat(claudePath);
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.isDirectory()).toBe(true);

    // Canonical should NOT exist (copy mode doesn't use canonical)
    const canonicalPath = join(testDir, '.agents', 'skills', 'my-skill');
    expect(existsSync(canonicalPath)).toBe(false);
  });

  it('mixed universal and non-universal clients share canonical', async () => {
    const pluginDir = await createPlugin('my-plugin', 'my-skill');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - claude
  - copilot
`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    // Copilot uses canonical directly
    const canonicalPath = join(testDir, '.agents', 'skills', 'my-skill');
    expect(existsSync(canonicalPath)).toBe(true);
    const canonicalStats = await lstat(canonicalPath);
    expect(canonicalStats.isDirectory()).toBe(true);
    expect(canonicalStats.isSymbolicLink()).toBe(false);

    // Claude uses symlink
    const claudePath = join(testDir, '.claude', 'skills', 'my-skill');
    expect(existsSync(claudePath)).toBe(true);
    const claudeStats = await lstat(claudePath);
    expect(claudeStats.isSymbolicLink()).toBe(true);

    // Both should have the same content (via symlink for claude)
    expect(existsSync(join(canonicalPath, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(claudePath, 'SKILL.md'))).toBe(true);
  });
});
