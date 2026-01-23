import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncWorkspace, purgeWorkspace, getPurgePaths } from '../../../src/core/sync.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';

describe('sync', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('purgeWorkspace', () => {
    it('should purge commands, skills, hooks directories and agent file for claude client', async () => {
      // Setup: Create directories and files
      await mkdir(join(testDir, '.claude', 'commands'), { recursive: true });
      await mkdir(join(testDir, '.claude', 'skills'), { recursive: true });
      await mkdir(join(testDir, '.claude', 'hooks'), { recursive: true });
      await writeFile(join(testDir, '.claude', 'commands', 'test.md'), 'test');
      await writeFile(join(testDir, '.claude', 'skills', 'test.md'), 'test');
      await writeFile(join(testDir, '.claude', 'hooks', 'test.json'), '{}');
      await writeFile(join(testDir, 'CLAUDE.md'), '# Agent');

      // Verify files exist before purge
      expect(existsSync(join(testDir, '.claude', 'commands', 'test.md'))).toBe(true);
      expect(existsSync(join(testDir, 'CLAUDE.md'))).toBe(true);

      // Purge
      const result = await purgeWorkspace(testDir, ['claude']);

      // Verify directories are gone
      expect(existsSync(join(testDir, '.claude', 'commands'))).toBe(false);
      expect(existsSync(join(testDir, '.claude', 'skills'))).toBe(false);
      expect(existsSync(join(testDir, '.claude', 'hooks'))).toBe(false);
      expect(existsSync(join(testDir, 'CLAUDE.md'))).toBe(false);

      // Verify result structure
      expect(result).toHaveLength(1);
      expect(result[0].client).toBe('claude');
      expect(result[0].paths).toContain('.claude/commands/');
      expect(result[0].paths).toContain('.claude/skills/');
      expect(result[0].paths).toContain('.claude/hooks/');
      expect(result[0].paths).toContain('CLAUDE.md');
    });

    it('should not error when directories do not exist', async () => {
      // Purge on empty directory should not throw
      const result = await purgeWorkspace(testDir, ['claude']);

      // Should still return the client but with directories that would be purged if they existed
      expect(result).toHaveLength(1);
      expect(result[0].client).toBe('claude');
    });

    it('should purge multiple clients', async () => {
      // Setup: Create directories for multiple clients
      await mkdir(join(testDir, '.claude', 'commands'), { recursive: true });
      await mkdir(join(testDir, '.github', 'prompts'), { recursive: true });
      await writeFile(join(testDir, 'CLAUDE.md'), '# Claude');
      await writeFile(join(testDir, 'AGENTS.md'), '# Agents');

      // Purge both
      const result = await purgeWorkspace(testDir, ['claude', 'copilot']);

      // Verify both are purged
      expect(existsSync(join(testDir, '.claude', 'commands'))).toBe(false);
      expect(existsSync(join(testDir, '.github', 'prompts'))).toBe(false);
      expect(existsSync(join(testDir, 'CLAUDE.md'))).toBe(false);
      expect(existsSync(join(testDir, 'AGENTS.md'))).toBe(false);

      expect(result).toHaveLength(2);
    });
  });

  describe('getPurgePaths', () => {
    it('should return paths that exist', async () => {
      // Setup: Create some directories
      await mkdir(join(testDir, '.claude', 'commands'), { recursive: true });
      await writeFile(join(testDir, 'CLAUDE.md'), '# Agent');

      const result = getPurgePaths(testDir, ['claude']);

      expect(result).toHaveLength(1);
      expect(result[0].client).toBe('claude');
      expect(result[0].paths).toContain('.claude/commands/');
      expect(result[0].paths).toContain('CLAUDE.md');
      // Skills and hooks don't exist, so shouldn't be included
      expect(result[0].paths).not.toContain('.claude/skills/');
      expect(result[0].paths).not.toContain('.claude/hooks/');
    });

    it('should return empty array when nothing exists', () => {
      const result = getPurgePaths(testDir, ['claude']);
      expect(result).toHaveLength(0);
    });
  });

  describe('syncWorkspace - validation phase', () => {
    it('should fail if .allagents/workspace.yaml does not exist', async () => {
      const result = await syncWorkspace(testDir);

      expect(result.success).toBe(false);
      expect(result.error).toContain(`${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found`);
    });

    it('should fail if plugin does not exist and leave workspace unchanged', async () => {
      // Setup: Create .allagents/workspace.yaml with non-existent plugin
      await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
      await writeFile(
        join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
        `
repositories: []
plugins:
  - ./nonexistent-plugin
clients:
  - claude
`,
      );

      // Create some existing files that should NOT be purged
      await mkdir(join(testDir, '.claude', 'commands'), { recursive: true });
      await writeFile(join(testDir, '.claude', 'commands', 'existing.md'), 'existing');

      const result = await syncWorkspace(testDir);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Plugin validation failed');
      expect(result.error).toContain('workspace unchanged');

      // Verify existing files were NOT purged
      expect(existsSync(join(testDir, '.claude', 'commands', 'existing.md'))).toBe(true);
    });
  });

  describe('syncWorkspace - declarative sync', () => {
    it('should purge and rebuild when plugin is removed from workspace.yaml', async () => {
      // Setup: Create a local plugin
      const pluginDir = join(testDir, 'my-plugin');
      await mkdir(join(pluginDir, 'commands'), { recursive: true });
      await writeFile(join(pluginDir, 'commands', 'my-command.md'), '# My Command');

      // Setup: Create .allagents/workspace.yaml with the plugin
      await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
      await writeFile(
        join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
        `
repositories: []
plugins:
  - ./my-plugin
clients:
  - claude
`,
      );

      // First sync - should copy the command
      const result1 = await syncWorkspace(testDir);
      expect(result1.success).toBe(true);
      expect(existsSync(join(testDir, '.claude', 'commands', 'my-command.md'))).toBe(true);

      // Now remove plugin from workspace.yaml
      await writeFile(
        join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
        `
repositories: []
plugins: []
clients:
  - claude
`,
      );

      // Second sync - should purge the command since plugin is removed
      const result2 = await syncWorkspace(testDir);
      expect(result2.success).toBe(true);
      expect(existsSync(join(testDir, '.claude', 'commands', 'my-command.md'))).toBe(false);
    });

    it('should rebuild fresh on every sync', async () => {
      // Setup: Create local plugins
      const plugin1Dir = join(testDir, 'plugin1');
      const plugin2Dir = join(testDir, 'plugin2');
      await mkdir(join(plugin1Dir, 'commands'), { recursive: true });
      await mkdir(join(plugin2Dir, 'commands'), { recursive: true });
      await writeFile(join(plugin1Dir, 'commands', 'cmd1.md'), '# Command 1');
      await writeFile(join(plugin2Dir, 'commands', 'cmd2.md'), '# Command 2');

      // Setup: workspace with both plugins
      await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
      await writeFile(
        join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
        `
repositories: []
plugins:
  - ./plugin1
  - ./plugin2
clients:
  - claude
`,
      );

      // First sync
      const result1 = await syncWorkspace(testDir);
      expect(result1.success).toBe(true);
      expect(existsSync(join(testDir, '.claude', 'commands', 'cmd1.md'))).toBe(true);
      expect(existsSync(join(testDir, '.claude', 'commands', 'cmd2.md'))).toBe(true);

      // Update workspace to only have plugin1
      await writeFile(
        join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
        `
repositories: []
plugins:
  - ./plugin1
clients:
  - claude
`,
      );

      // Second sync - cmd2.md should be gone
      const result2 = await syncWorkspace(testDir);
      expect(result2.success).toBe(true);
      expect(existsSync(join(testDir, '.claude', 'commands', 'cmd1.md'))).toBe(true);
      expect(existsSync(join(testDir, '.claude', 'commands', 'cmd2.md'))).toBe(false);
    });
  });

  describe('syncWorkspace - dry-run', () => {
    it('should show purge plan without executing in dry-run mode', async () => {
      // Setup: Create a local plugin and sync it
      const pluginDir = join(testDir, 'my-plugin');
      await mkdir(join(pluginDir, 'commands'), { recursive: true });
      await writeFile(join(pluginDir, 'commands', 'my-command.md'), '# My Command');

      await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
      await writeFile(
        join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
        `
repositories: []
plugins:
  - ./my-plugin
clients:
  - claude
`,
      );

      // First sync to create files
      await syncWorkspace(testDir);
      expect(existsSync(join(testDir, '.claude', 'commands', 'my-command.md'))).toBe(true);

      // Dry-run sync
      const result = await syncWorkspace(testDir, { dryRun: true });
      expect(result.success).toBe(true);

      // Should have purge paths in result
      expect(result.purgedPaths).toBeDefined();
      expect(result.purgedPaths!.length).toBeGreaterThan(0);
      expect(result.purgedPaths![0].client).toBe('claude');
      expect(result.purgedPaths![0].paths).toContain('.claude/commands/');

      // Files should still exist (dry-run doesn't purge)
      expect(existsSync(join(testDir, '.claude', 'commands', 'my-command.md'))).toBe(true);
    });
  });
});
