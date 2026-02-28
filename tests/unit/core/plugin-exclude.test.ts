import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyCommands, copyAgents, copyPluginToWorkspace } from '../../../src/core/transform.js';

describe('plugin exclude patterns', () => {
  let testDir: string;
  let pluginDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-exclude-test-'));
    pluginDir = join(testDir, 'plugin');
    workspaceDir = join(testDir, 'workspace');
    await mkdir(pluginDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('copyCommands', () => {
    it('excludes commands matching exclude patterns', async () => {
      await mkdir(join(pluginDir, 'commands'), { recursive: true });
      await writeFile(join(pluginDir, 'commands', 'public-cmd.md'), '# Public');
      await writeFile(join(pluginDir, 'commands', 'internal-cmd.md'), '# Internal');

      const results = await copyCommands(pluginDir, workspaceDir, 'claude', {
        exclude: ['commands/internal-cmd.md'],
      });

      expect(results).toHaveLength(1);
      expect(existsSync(join(workspaceDir, '.claude', 'commands', 'public-cmd.md'))).toBe(true);
      expect(existsSync(join(workspaceDir, '.claude', 'commands', 'internal-cmd.md'))).toBe(false);
    });
  });

  describe('copyAgents', () => {
    it('excludes agents matching exclude patterns', async () => {
      await mkdir(join(pluginDir, 'agents'), { recursive: true });
      await writeFile(join(pluginDir, 'agents', 'reviewer.md'), '# Reviewer');
      await writeFile(join(pluginDir, 'agents', 'debug-only.md'), '# Debug');

      const results = await copyAgents(pluginDir, workspaceDir, 'claude', {
        exclude: ['agents/debug-only.md'],
      });

      expect(results).toHaveLength(1);
      expect(existsSync(join(workspaceDir, '.claude', 'agents', 'reviewer.md'))).toBe(true);
      expect(existsSync(join(workspaceDir, '.claude', 'agents', 'debug-only.md'))).toBe(false);
    });
  });

  describe('copyPluginToWorkspace', () => {
    it('applies exclude across all content types', async () => {
      // Setup commands (claude supports commandsPath)
      await mkdir(join(pluginDir, 'commands'), { recursive: true });
      await writeFile(join(pluginDir, 'commands', 'keep.md'), '# Keep');
      await writeFile(join(pluginDir, 'commands', 'drop.md'), '# Drop');

      // Setup agents (claude supports agentsPath)
      await mkdir(join(pluginDir, 'agents'), { recursive: true });
      await writeFile(join(pluginDir, 'agents', 'keep.md'), '# Keep');
      await writeFile(join(pluginDir, 'agents', 'drop.md'), '# Drop');

      // Use 'claude' client which supports commands and agents
      await copyPluginToWorkspace(pluginDir, workspaceDir, 'claude', {
        exclude: ['commands/drop.md', 'agents/drop.md'],
      });

      // Commands: kept file exists, excluded does not
      expect(existsSync(join(workspaceDir, '.claude', 'commands', 'keep.md'))).toBe(true);
      expect(existsSync(join(workspaceDir, '.claude', 'commands', 'drop.md'))).toBe(false);

      // Agents: kept file exists, excluded does not
      expect(existsSync(join(workspaceDir, '.claude', 'agents', 'keep.md'))).toBe(true);
      expect(existsSync(join(workspaceDir, '.claude', 'agents', 'drop.md'))).toBe(false);
    });
  });
});
