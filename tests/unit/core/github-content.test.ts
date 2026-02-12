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

  it('adjusts relative links to skills in markdown files', async () => {
    // Setup: Create .github/instructions/cargowise.instructions.md with skill references
    await mkdir(join(pluginDir, '.github', 'instructions'), { recursive: true });
    const originalContent = `# Cargowise Instructions

See #file:../../skills/cw-coding/SKILL.md for coding guidelines.

Also check [API Guide](../../skills/cw-api/README.md).
`;
    await writeFile(join(pluginDir, '.github', 'instructions', 'cargowise.instructions.md'), originalContent);

    const results = await copyGitHubContent(pluginDir, workspaceDir, 'copilot');

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('copied');

    const copiedContent = await readFile(
      join(workspaceDir, '.github', 'instructions', 'cargowise.instructions.md'),
      'utf-8',
    );

    // Links should be adjusted to workspace skills path (.agents/skills/)
    expect(copiedContent).toContain('#file:../../.agents/skills/cw-coding/SKILL.md');
    expect(copiedContent).toContain('[API Guide](../../.agents/skills/cw-api/README.md)');
  });

  it('adjusts links using skill name map for renamed skills', async () => {
    await mkdir(join(pluginDir, '.github', 'instructions'), { recursive: true });
    const originalContent = `See #file:../../skills/my-skill/SKILL.md`;
    await writeFile(join(pluginDir, '.github', 'instructions', 'file.md'), originalContent);

    const skillNameMap = new Map([['my-skill', 'plugin-name:my-skill']]);
    const results = await copyGitHubContent(pluginDir, workspaceDir, 'copilot', { skillNameMap });

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('copied');

    const copiedContent = await readFile(join(workspaceDir, '.github', 'instructions', 'file.md'), 'utf-8');
    expect(copiedContent).toContain('#file:../../.agents/skills/plugin-name:my-skill/SKILL.md');
  });

  it('preserves non-skill links and external URLs', async () => {
    await mkdir(join(pluginDir, '.github', 'instructions'), { recursive: true });
    const originalContent = `# Instructions

See [GitHub](https://github.com) for more info.
Local link: [Setup](#setup)
Relative to .github: [Other](../prompts/other.md)
`;
    await writeFile(join(pluginDir, '.github', 'instructions', 'file.md'), originalContent);

    await copyGitHubContent(pluginDir, workspaceDir, 'copilot');

    const copiedContent = await readFile(join(workspaceDir, '.github', 'instructions', 'file.md'), 'utf-8');

    // External URLs unchanged
    expect(copiedContent).toContain('[GitHub](https://github.com)');
    // Anchor links unchanged
    expect(copiedContent).toContain('[Setup](#setup)');
    // Links within .github unchanged
    expect(copiedContent).toContain('[Other](../prompts/other.md)');
  });
});
