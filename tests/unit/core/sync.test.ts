import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncWorkspace, purgeWorkspace, getPurgePaths } from '../../../src/core/sync.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE, WORKSPACE_RULES } from '../../../src/constants.js';

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
      await mkdir(join(testDir, '.github', 'skills'), { recursive: true });
      await writeFile(join(testDir, 'CLAUDE.md'), '# Claude');
      await writeFile(join(testDir, 'AGENTS.md'), '# Agents');

      // Purge both
      const result = await purgeWorkspace(testDir, ['claude', 'copilot']);

      // Verify both are purged
      expect(existsSync(join(testDir, '.claude', 'commands'))).toBe(false);
      expect(existsSync(join(testDir, '.github', 'skills'))).toBe(false);
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

      // Should have purge paths in result (now shows individual files from state)
      expect(result.purgedPaths).toBeDefined();
      expect(result.purgedPaths!.length).toBeGreaterThan(0);
      expect(result.purgedPaths![0].client).toBe('claude');
      // Non-destructive sync tracks individual files, not directories
      expect(result.purgedPaths![0].paths).toContain('.claude/commands/my-command.md');

      // Files should still exist (dry-run doesn't purge)
      expect(existsSync(join(testDir, '.claude', 'commands', 'my-command.md'))).toBe(true);
    });
  });

  describe('syncWorkspace - workspace files with WORKSPACE-RULES injection', () => {
    it('should append WORKSPACE-RULES to both CLAUDE.md and AGENTS.md when both are copied', async () => {
      // Setup: Create a workspace source with both agent files
      const sourceDir = join(testDir, 'workspace-source');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, 'CLAUDE.md'), '# Claude Agent\n');
      await writeFile(join(sourceDir, 'AGENTS.md'), '# Agents\n');

      // Setup: Create .allagents/workspace.yaml
      await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
      await writeFile(
        join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
        `
workspace:
  source: ./workspace-source
  files:
    - CLAUDE.md
    - AGENTS.md
repositories: []
plugins: []
clients:
  - claude
`,
      );

      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      // Both files should have WORKSPACE-RULES appended
      const claudeContent = await readFile(join(testDir, 'CLAUDE.md'), 'utf-8');
      expect(claudeContent).toContain('<!-- WORKSPACE-RULES:START -->');
      expect(claudeContent).toContain('<!-- WORKSPACE-RULES:END -->');

      const agentsContent = await readFile(join(testDir, 'AGENTS.md'), 'utf-8');
      expect(agentsContent).toContain('<!-- WORKSPACE-RULES:START -->');
      expect(agentsContent).toContain('<!-- WORKSPACE-RULES:END -->');
    });

    it('should append WORKSPACE-RULES to CLAUDE.md when only CLAUDE.md is copied', async () => {
      // Setup: Create a workspace source with only CLAUDE.md
      const sourceDir = join(testDir, 'workspace-source');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, 'CLAUDE.md'), '# Claude Agent\n');

      // Setup: Create .allagents/workspace.yaml
      await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
      await writeFile(
        join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
        `
workspace:
  source: ./workspace-source
  files:
    - CLAUDE.md
repositories: []
plugins: []
clients:
  - claude
`,
      );

      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      // CLAUDE.md should have WORKSPACE-RULES appended
      const claudeContent = await readFile(join(testDir, 'CLAUDE.md'), 'utf-8');
      expect(claudeContent).toContain('# Claude Agent');
      expect(claudeContent).toContain('<!-- WORKSPACE-RULES:START -->');
      expect(claudeContent).toContain('<!-- WORKSPACE-RULES:END -->');
    });

    it('should append WORKSPACE-RULES to AGENTS.md when only AGENTS.md is copied', async () => {
      // Setup: Create a workspace source with only AGENTS.md
      const sourceDir = join(testDir, 'workspace-source');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, 'AGENTS.md'), '# Agents\n');

      // Setup: Create .allagents/workspace.yaml
      await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
      await writeFile(
        join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
        `
workspace:
  source: ./workspace-source
  files:
    - AGENTS.md
repositories: []
plugins: []
clients:
  - claude
`,
      );

      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      // AGENTS.md should have WORKSPACE-RULES appended
      const agentsContent = await readFile(join(testDir, 'AGENTS.md'), 'utf-8');
      expect(agentsContent).toContain('# Agents');
      expect(agentsContent).toContain('<!-- WORKSPACE-RULES:START -->');
      expect(agentsContent).toContain('<!-- WORKSPACE-RULES:END -->');
    });

    it('should not append WORKSPACE-RULES when no agent files are copied', async () => {
      // Setup: Create a workspace source with a non-agent file
      const sourceDir = join(testDir, 'workspace-source');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, 'README.md'), '# README\n');

      // Setup: Create .allagents/workspace.yaml
      await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
      await writeFile(
        join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
        `
workspace:
  source: ./workspace-source
  files:
    - README.md
repositories: []
plugins: []
clients:
  - claude
`,
      );

      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      // README.md should NOT have WORKSPACE-RULES
      const readmeContent = await readFile(join(testDir, 'README.md'), 'utf-8');
      expect(readmeContent).toBe('# README\n');
      expect(readmeContent).not.toContain('WORKSPACE-RULES');
    });
  });

  describe('syncWorkspace - non-destructive sync', () => {
    it('should preserve user files on first sync (no previous state)', async () => {
      // Setup: User has existing files before first sync
      await mkdir(join(testDir, '.claude', 'commands'), { recursive: true });
      await writeFile(join(testDir, '.claude', 'commands', 'user-command.md'), '# User Command');

      // Setup: Create a plugin with a different command
      const pluginDir = join(testDir, 'my-plugin');
      await mkdir(join(pluginDir, 'commands'), { recursive: true });
      await writeFile(join(pluginDir, 'commands', 'plugin-command.md'), '# Plugin Command');

      // Setup: Create workspace config
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

      // First sync - should overlay without purging user files
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      // User file should be preserved
      expect(existsSync(join(testDir, '.claude', 'commands', 'user-command.md'))).toBe(true);
      const userContent = await readFile(
        join(testDir, '.claude', 'commands', 'user-command.md'),
        'utf-8',
      );
      expect(userContent).toBe('# User Command');

      // Plugin file should be copied
      expect(existsSync(join(testDir, '.claude', 'commands', 'plugin-command.md'))).toBe(true);
    });

    it('should only remove previously synced files on subsequent sync', async () => {
      // Setup: Create two plugins
      const plugin1Dir = join(testDir, 'plugin1');
      const plugin2Dir = join(testDir, 'plugin2');
      await mkdir(join(plugin1Dir, 'commands'), { recursive: true });
      await mkdir(join(plugin2Dir, 'commands'), { recursive: true });
      await writeFile(join(plugin1Dir, 'commands', 'cmd1.md'), '# Command 1');
      await writeFile(join(plugin2Dir, 'commands', 'cmd2.md'), '# Command 2');

      // Setup: User has their own command
      await mkdir(join(testDir, '.claude', 'commands'), { recursive: true });
      await writeFile(join(testDir, '.claude', 'commands', 'user.md'), '# User');

      // Setup: Create workspace config with both plugins
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
      expect(existsSync(join(testDir, '.claude', 'commands', 'user.md'))).toBe(true);

      // Now remove plugin2 from config
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

      // Second sync - should remove cmd2.md but keep user.md
      const result2 = await syncWorkspace(testDir);
      expect(result2.success).toBe(true);
      expect(existsSync(join(testDir, '.claude', 'commands', 'cmd1.md'))).toBe(true);
      expect(existsSync(join(testDir, '.claude', 'commands', 'cmd2.md'))).toBe(false);
      expect(existsSync(join(testDir, '.claude', 'commands', 'user.md'))).toBe(true);
    });

    it('should preserve user files added after initial sync', async () => {
      // Setup: Create a plugin
      const pluginDir = join(testDir, 'my-plugin');
      await mkdir(join(pluginDir, 'commands'), { recursive: true });
      await writeFile(join(pluginDir, 'commands', 'plugin.md'), '# Plugin');

      // Setup: Create workspace config
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

      // First sync
      const result1 = await syncWorkspace(testDir);
      expect(result1.success).toBe(true);

      // User adds a file AFTER initial sync
      await writeFile(join(testDir, '.claude', 'commands', 'user-added.md'), '# User Added');

      // Second sync - user file should be preserved
      const result2 = await syncWorkspace(testDir);
      expect(result2.success).toBe(true);
      expect(existsSync(join(testDir, '.claude', 'commands', 'user-added.md'))).toBe(true);
      expect(existsSync(join(testDir, '.claude', 'commands', 'plugin.md'))).toBe(true);
    });

    it('should create state file after sync', async () => {
      // Setup: Create a plugin
      const pluginDir = join(testDir, 'my-plugin');
      await mkdir(join(pluginDir, 'commands'), { recursive: true });
      await writeFile(join(pluginDir, 'commands', 'cmd.md'), '# Command');

      // Setup: Create workspace config
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

      // Sync
      await syncWorkspace(testDir);

      // State file should exist
      const statePath = join(testDir, CONFIG_DIR, 'sync-state.json');
      expect(existsSync(statePath)).toBe(true);

      // State should contain synced files
      const stateContent = await readFile(statePath, 'utf-8');
      const state = JSON.parse(stateContent);
      expect(state.version).toBe(1);
      expect(state.files.claude).toContain('.claude/commands/cmd.md');
    });
  });

  describe('syncWorkspace - skill directory tracking', () => {
    it('should track skill directories with trailing slash in state', async () => {
      // Setup: Create a plugin with a skill
      const pluginDir = join(testDir, 'my-plugin');
      const skillDir = join(pluginDir, 'skills', 'my-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: my-skill
description: A test skill
---

# My Skill`,
      );

      // Setup: Create workspace config
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

      // Sync
      await syncWorkspace(testDir);

      // Skill directory should exist
      expect(existsSync(join(testDir, '.claude', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);

      // State should track skill directory with trailing /
      const statePath = join(testDir, CONFIG_DIR, 'sync-state.json');
      const stateContent = await readFile(statePath, 'utf-8');
      const state = JSON.parse(stateContent);
      expect(state.files.claude).toContain('.claude/skills/my-skill/');
    });

    it('should purge skill directory when plugin is removed', async () => {
      // Setup: Create a plugin with a skill
      const pluginDir = join(testDir, 'my-plugin');
      const skillDir = join(pluginDir, 'skills', 'my-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: my-skill
description: A test skill
---

# My Skill`,
      );

      // Setup: Create workspace config
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

      // First sync
      await syncWorkspace(testDir);
      expect(existsSync(join(testDir, '.claude', 'skills', 'my-skill'))).toBe(true);

      // Remove plugin from config
      await writeFile(
        join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
        `
repositories: []
plugins: []
clients:
  - claude
`,
      );

      // Second sync - skill directory should be purged
      await syncWorkspace(testDir);
      expect(existsSync(join(testDir, '.claude', 'skills', 'my-skill'))).toBe(false);
    });
  });

  describe('syncWorkspace - WORKSPACE-RULES idempotency', () => {
    it('should have exactly one WORKSPACE-RULES section after multiple syncs', async () => {
      // Setup: Create workspace source with CLAUDE.md
      const sourceDir = join(testDir, 'workspace-source');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, 'CLAUDE.md'), '# My Project\n');

      // Setup: Create workspace config
      await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
      await writeFile(
        join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
        `
workspace:
  source: ./workspace-source
  files:
    - CLAUDE.md
repositories: []
plugins: []
clients:
  - claude
`,
      );

      // First sync
      await syncWorkspace(testDir);

      // Second sync
      await syncWorkspace(testDir);

      // Third sync
      await syncWorkspace(testDir);

      // Check CLAUDE.md has exactly ONE WORKSPACE-RULES section
      const content = await readFile(join(testDir, 'CLAUDE.md'), 'utf-8');
      const startCount = (content.match(/<!-- WORKSPACE-RULES:START -->/g) || []).length;
      const endCount = (content.match(/<!-- WORKSPACE-RULES:END -->/g) || []).length;

      expect(startCount).toBe(1);
      expect(endCount).toBe(1);
    });
  });
});
