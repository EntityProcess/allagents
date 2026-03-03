import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyAgents, copyHooks } from '../../../src/core/transform.js';

describe('copilot agents and hooks sync', () => {
  let testDir: string;
  let pluginDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-copilot-test-'));
    pluginDir = join(testDir, 'plugin');
    workspaceDir = join(testDir, 'workspace');
    await mkdir(pluginDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('copyAgents for copilot', () => {
    it('copies root agents/ to .github/agents/ for copilot client', async () => {
      await mkdir(join(pluginDir, 'agents'), { recursive: true });
      await writeFile(join(pluginDir, 'agents', 'reviewer.agent.md'), '# Reviewer Agent');

      const results = await copyAgents(pluginDir, workspaceDir, 'copilot');

      expect(results).toHaveLength(1);
      expect(results[0].action).toBe('copied');
      expect(existsSync(join(workspaceDir, '.github', 'agents', 'reviewer.agent.md'))).toBe(true);

      const content = await readFile(join(workspaceDir, '.github', 'agents', 'reviewer.agent.md'), 'utf-8');
      expect(content).toBe('# Reviewer Agent');
    });

    it('returns empty when plugin has no agents/ directory', async () => {
      const results = await copyAgents(pluginDir, workspaceDir, 'copilot');
      expect(results).toHaveLength(0);
    });
  });

  describe('copyHooks for copilot', () => {
    it('copies root hooks/ to .github/hooks/ for copilot client', async () => {
      await mkdir(join(pluginDir, 'hooks'), { recursive: true });
      await writeFile(join(pluginDir, 'hooks', 'safety.json'), '{"hooks":[]}');

      const results = await copyHooks(pluginDir, workspaceDir, 'copilot');

      expect(results).toHaveLength(1);
      expect(results[0].action).toBe('copied');
      expect(existsSync(join(workspaceDir, '.github', 'hooks', 'safety.json'))).toBe(true);

      const content = await readFile(join(workspaceDir, '.github', 'hooks', 'safety.json'), 'utf-8');
      expect(content).toBe('{"hooks":[]}');
    });

    it('returns empty when plugin has no hooks/ directory', async () => {
      const results = await copyHooks(pluginDir, workspaceDir, 'copilot');
      expect(results).toHaveLength(0);
    });
  });
});
