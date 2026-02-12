import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyGitHubContent } from '../../../src/core/transform.js';

describe('copyGitHubContent', () => {
  let testDir: string;
  let pluginDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-github-test-'));
    pluginDir = join(testDir, 'plugin');
    workspaceDir = join(testDir, 'workspace');
    await mkdir(pluginDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('copies .github folder for copilot client', async () => {
    // Setup: Create .github folder with prompts in plugin
    await mkdir(join(pluginDir, '.github', 'prompts'), { recursive: true });
    await writeFile(join(pluginDir, '.github', 'prompts', 'test.md'), '# Test Prompt');
    await writeFile(join(pluginDir, '.github', 'copilot-instructions.md'), '# Copilot Instructions');

    const results = await copyGitHubContent(pluginDir, workspaceDir, 'copilot');

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('copied');
    expect(existsSync(join(workspaceDir, '.github', 'prompts', 'test.md'))).toBe(true);
    expect(existsSync(join(workspaceDir, '.github', 'copilot-instructions.md'))).toBe(true);

    const content = await readFile(join(workspaceDir, '.github', 'prompts', 'test.md'), 'utf-8');
    expect(content).toBe('# Test Prompt');
  });

  it('skips clients without githubPath', async () => {
    await mkdir(join(pluginDir, '.github', 'prompts'), { recursive: true });
    await writeFile(join(pluginDir, '.github', 'prompts', 'test.md'), '# Test');

    // Claude doesn't have githubPath, so should skip
    const results = await copyGitHubContent(pluginDir, workspaceDir, 'claude');

    expect(results).toHaveLength(0);
    expect(existsSync(join(workspaceDir, '.github'))).toBe(false);
  });

  it('returns empty when plugin has no .github folder', async () => {
    const results = await copyGitHubContent(pluginDir, workspaceDir, 'copilot');

    expect(results).toHaveLength(0);
  });

  it('supports dry run mode', async () => {
    await mkdir(join(pluginDir, '.github', 'prompts'), { recursive: true });
    await writeFile(join(pluginDir, '.github', 'prompts', 'test.md'), '# Test');

    const results = await copyGitHubContent(pluginDir, workspaceDir, 'copilot', { dryRun: true });

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('copied');
    // Should not actually copy in dry run
    expect(existsSync(join(workspaceDir, '.github'))).toBe(false);
  });
});
