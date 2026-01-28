/**
 * Integration tests for duplicate skill handling with GitHub sources.
 *
 * These tests verify the org_plugin_skill naming format when plugins come from
 * GitHub sources. We mock the execa module to simulate successful GitHub fetches
 * pointing to local test directories.
 *
 * Test scenarios:
 * 1. Skill + plugin conflict with GitHub sources - {org}_{plugin}_{skill} format
 * 2. Mixed GitHub + local sources with conflicts
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../src/constants.js';
import { getShortId } from '../../src/utils/hash.js';

// Test directory references
let testDir: string;
let cacheBaseDir: string;

// Track which GitHub paths map to which local test paths
const githubToLocalMap = new Map<string, string>();

// Override HOME to use test directory for cache
const originalHome = process.env.HOME;

// Mock execa to intercept gh commands
const execaMock = mock(async (cmd: string, args: string[]) => {
  if (cmd === 'gh') {
    if (args[0] === '--version') {
      return { stdout: 'gh version 2.40.0', stderr: '' };
    }
    if (args[0] === 'repo' && args[1] === 'clone') {
      // args[2] is the repo (owner/repo)
      // args[3] is the destination path
      const repo = args[2];
      const destPath = args[3];

      // Find the local source for this repo
      const localSource = githubToLocalMap.get(repo);
      if (localSource) {
        // Copy the local plugin to the cache path
        await copyDir(localSource, destPath);
        return { stdout: '', stderr: '' };
      }
      throw new Error(`Unknown repo: ${repo}`);
    }
  }
  throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
});

// Helper to recursively copy a directory
async function copyDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      const content = await readFile(srcPath);
      await writeFile(destPath, content);
    }
  }
}

// Mock the execa module BEFORE importing sync
mock.module('execa', () => ({
  execa: execaMock,
}));

// Now import syncWorkspace after mocking
const { syncWorkspace } = await import('../../src/core/sync.js');

describe('Skill duplicate handling with GitHub sources', () => {
  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-github-skill-'));
    cacheBaseDir = join(testDir, 'home');

    // Set HOME to our test directory so cache goes there
    process.env.HOME = cacheBaseDir;

    // Clear the map and mocks
    githubToLocalMap.clear();
    execaMock.mockClear();
  });

  afterEach(async () => {
    // Restore HOME
    process.env.HOME = originalHome;
    await rm(testDir, { recursive: true, force: true });
  });

  /**
   * Helper to create a plugin with skills
   */
  async function createPlugin(
    pluginPath: string,
    pluginName: string,
    skillNames: string[],
  ): Promise<void> {
    await mkdir(pluginPath, { recursive: true });

    // Create plugin.json
    await writeFile(
      join(pluginPath, 'plugin.json'),
      JSON.stringify({
        name: pluginName,
        version: '1.0.0',
        description: `Test plugin ${pluginName}`,
      }),
    );

    // Create skills
    for (const skillName of skillNames) {
      const skillDir = join(pluginPath, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: ${skillName}
description: Skill ${skillName} from ${pluginName}
---

# ${skillName}

This skill is from ${pluginName}.
`,
      );
    }
  }

  /**
   * Helper to create workspace.yaml with specific plugin sources
   */
  async function createWorkspaceConfig(plugins: string[]): Promise<void> {
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
${plugins.map((p) => `  - ${p}`).join('\n')}
clients:
  - claude
`,
    );
  }

  /**
   * Helper to get all skill directory names after sync
   */
  async function getSyncedSkills(): Promise<string[]> {
    const skillsDir = join(testDir, '.claude', 'skills');
    if (!existsSync(skillsDir)) {
      return [];
    }
    return readdir(skillsDir);
  }

  /**
   * Helper to register a GitHub source with its local cache path
   * Uses gh: prefix which is recognized by both isGitHubUrl and extractOrgFromSource
   */
  function registerGitHubSource(org: string, repo: string, localPath: string): string {
    const key = `${org}/${repo}`;
    githubToLocalMap.set(key, localPath);
    return `gh:${key}`;
  }

  describe('Scenario: Skill + plugin conflict with GitHub sources - {org}_{plugin}_{skill} format', () => {
    it('should use org prefix when same plugin name exists in different GitHub orgs', async () => {
      // Setup: Two plugins with same name from different GitHub orgs
      const path1 = join(testDir, 'source', 'acme-corp', 'tools');
      const path2 = join(testDir, 'source', 'beta-inc', 'tools');

      await createPlugin(path1, 'tools', ['deploy']);
      await createPlugin(path2, 'tools', ['deploy']);

      // Register GitHub sources
      const source1 = registerGitHubSource('acme-corp', 'plugins', path1);
      const source2 = registerGitHubSource('beta-inc', 'plugins', path2);

      await createWorkspaceConfig([source1, source2]);

      // Sync
      const result = await syncWorkspace(testDir);

      if (!result.success) {
        console.error('Sync failed:', result.error);
        console.error('Plugin results:', JSON.stringify(result.pluginResults, null, 2));
      }
      expect(result.success).toBe(true);

      // Verify: Skills should be prefixed with org name
      // Format: {org}_{plugin}_{skill}
      const skills = await getSyncedSkills();
      expect(skills).toHaveLength(2);
      expect(skills).toContain('acme-corp_tools_deploy');
      expect(skills).toContain('beta-inc_tools_deploy');
    });

    it('should handle three-way plugin name conflict with GitHub orgs', async () => {
      // Setup: Three plugins with same name from different orgs
      const path1 = join(testDir, 'source', 'org-alpha', 'shared');
      const path2 = join(testDir, 'source', 'org-beta', 'shared');
      const path3 = join(testDir, 'source', 'org-gamma', 'shared');

      await createPlugin(path1, 'shared-plugin', ['common-skill']);
      await createPlugin(path2, 'shared-plugin', ['common-skill']);
      await createPlugin(path3, 'shared-plugin', ['common-skill']);

      const source1 = registerGitHubSource('org-alpha', 'plugins', path1);
      const source2 = registerGitHubSource('org-beta', 'plugins', path2);
      const source3 = registerGitHubSource('org-gamma', 'plugins', path3);

      await createWorkspaceConfig([source1, source2, source3]);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      // Verify: All three should have org prefix
      const skills = await getSyncedSkills();
      expect(skills).toHaveLength(3);
      expect(skills).toContain('org-alpha_shared-plugin_common-skill');
      expect(skills).toContain('org-beta_shared-plugin_common-skill');
      expect(skills).toContain('org-gamma_shared-plugin_common-skill');
    });

    it('should preserve skill content when using org prefix', async () => {
      // Setup: Two plugins with same name, different content
      const path1 = join(testDir, 'source', 'company-a', 'my-plugin');
      const path2 = join(testDir, 'source', 'company-b', 'my-plugin');

      await mkdir(join(path1, 'skills', 'coding'), { recursive: true });
      await mkdir(join(path2, 'skills', 'coding'), { recursive: true });

      await writeFile(
        join(path1, 'plugin.json'),
        JSON.stringify({ name: 'my-plugin', version: '1.0.0', description: 'Company A plugin' }),
      );
      await writeFile(
        join(path2, 'plugin.json'),
        JSON.stringify({ name: 'my-plugin', version: '1.0.0', description: 'Company B plugin' }),
      );

      await writeFile(
        join(path1, 'skills', 'coding', 'SKILL.md'),
        `---
name: coding
description: Company A coding
---
# Coding
Company A implementation.
`,
      );

      await writeFile(
        join(path2, 'skills', 'coding', 'SKILL.md'),
        `---
name: coding
description: Company B coding
---
# Coding
Company B implementation.
`,
      );

      const source1 = registerGitHubSource('company-a', 'plugins', path1);
      const source2 = registerGitHubSource('company-b', 'plugins', path2);

      await createWorkspaceConfig([source1, source2]);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      // Verify content is correct
      const contentA = await readFile(
        join(testDir, '.claude', 'skills', 'company-a_my-plugin_coding', 'SKILL.md'),
        'utf-8',
      );
      const contentB = await readFile(
        join(testDir, '.claude', 'skills', 'company-b_my-plugin_coding', 'SKILL.md'),
        'utf-8',
      );

      expect(contentA).toContain('Company A implementation');
      expect(contentB).toContain('Company B implementation');
    });
  });

  describe('Scenario: Mixed GitHub + local sources with conflicts', () => {
    it('should use org prefix for GitHub and hash prefix for local sources', async () => {
      // Setup: One GitHub plugin and one local plugin with same name
      const githubPath = join(testDir, 'source', 'acme', 'my-plugin');
      const localPath = join(testDir, 'local', 'my-plugin');

      await createPlugin(githubPath, 'my-plugin', ['build']);
      await createPlugin(localPath, 'my-plugin', ['build']);

      const githubSource = registerGitHubSource('acme', 'plugins', githubPath);
      const localSource = './local/my-plugin';

      await createWorkspaceConfig([githubSource, localSource]);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      // Verify: GitHub source uses org prefix, local uses hash prefix
      const skills = await getSyncedSkills();
      expect(skills).toHaveLength(2);

      // GitHub source should have org prefix
      expect(skills).toContain('acme_my-plugin_build');

      // Local source should have hash prefix
      const localHash = getShortId(localSource);
      expect(skills).toContain(`${localHash}_my-plugin_build`);
    });

    it('should handle mixed sources where only some conflict', async () => {
      // Setup:
      // - GitHub plugin from acme: has "shared" and "unique-github" skills
      // - Local plugin: has "shared" and "unique-local" skills
      // - Another GitHub plugin from beta: has "other" skill (no conflict)

      const acmePath = join(testDir, 'source', 'acme', 'devtools');
      const localPath = join(testDir, 'local', 'devtools');
      const betaPath = join(testDir, 'source', 'beta', 'utilities');

      await createPlugin(acmePath, 'devtools', ['shared', 'unique-github']);
      await createPlugin(localPath, 'devtools', ['shared', 'unique-local']);
      await createPlugin(betaPath, 'utilities', ['other']);

      const acmeSource = registerGitHubSource('acme', 'devtools', acmePath);
      const betaSource = registerGitHubSource('beta', 'utilities', betaPath);
      const localSource = './local/devtools';

      await createWorkspaceConfig([acmeSource, localSource, betaSource]);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      const skills = await getSyncedSkills();

      // Unique skills should keep original names
      expect(skills).toContain('unique-github');
      expect(skills).toContain('unique-local');
      expect(skills).toContain('other');

      // Conflicting skills should be fully qualified
      // Both have same plugin name "devtools" and same skill "shared"
      const localHash = getShortId(localSource);
      expect(skills).toContain('acme_devtools_shared');
      expect(skills).toContain(`${localHash}_devtools_shared`);
    });

    it('should handle multiple GitHub orgs and multiple local paths all conflicting', async () => {
      // Setup: Four plugins all with same name and same skill
      const acmePath = join(testDir, 'source', 'acme', 'builder');
      const betaPath = join(testDir, 'source', 'beta', 'builder');
      const local1Path = join(testDir, 'vendor', 'builder');
      const local2Path = join(testDir, 'custom', 'builder');

      await createPlugin(acmePath, 'builder', ['compile']);
      await createPlugin(betaPath, 'builder', ['compile']);
      await createPlugin(local1Path, 'builder', ['compile']);
      await createPlugin(local2Path, 'builder', ['compile']);

      const acmeSource = registerGitHubSource('acme', 'builder', acmePath);
      const betaSource = registerGitHubSource('beta', 'builder', betaPath);
      const local1Source = './vendor/builder';
      const local2Source = './custom/builder';

      await createWorkspaceConfig([acmeSource, betaSource, local1Source, local2Source]);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      const skills = await getSyncedSkills();
      expect(skills).toHaveLength(4);

      // GitHub sources use org prefix
      expect(skills).toContain('acme_builder_compile');
      expect(skills).toContain('beta_builder_compile');

      // Local sources use hash prefix
      const hash1 = getShortId(local1Source);
      const hash2 = getShortId(local2Source);
      expect(skills).toContain(`${hash1}_builder_compile`);
      expect(skills).toContain(`${hash2}_builder_compile`);
    });

    it('should track renamed skills correctly in sync state for mixed sources', async () => {
      // Setup: One GitHub and one local with same plugin name
      const githubPath = join(testDir, 'source', 'myorg', 'analyzer');
      const localPath = join(testDir, 'local', 'analyzer');

      await createPlugin(githubPath, 'analyzer', ['lint']);
      await createPlugin(localPath, 'analyzer', ['lint']);

      const githubSource = registerGitHubSource('myorg', 'analyzer', githubPath);
      const localSource = './local/analyzer';

      await createWorkspaceConfig([githubSource, localSource]);

      // Sync
      await syncWorkspace(testDir);

      // Verify state file contains renamed skill paths
      const statePath = join(testDir, CONFIG_DIR, 'sync-state.json');
      const stateContent = await readFile(statePath, 'utf-8');
      const state = JSON.parse(stateContent);

      const localHash = getShortId(localSource);

      // Both renamed paths should be in state
      expect(state.files.claude).toContain('.claude/skills/myorg_analyzer_lint/');
      expect(state.files.claude).toContain(`.claude/skills/${localHash}_analyzer_lint/`);
    });
  });

  describe('Scenario: GitHub shorthand formats', () => {
    it('should extract org from gh: shorthand format', async () => {
      // Setup: Using gh: prefix (registered via helper)
      const path1 = join(testDir, 'source', 'team-x', 'tools');
      const path2 = join(testDir, 'source', 'team-y', 'tools');

      await createPlugin(path1, 'tools', ['run']);
      await createPlugin(path2, 'tools', ['run']);

      const source1 = registerGitHubSource('team-x', 'tools', path1);
      const source2 = registerGitHubSource('team-y', 'tools', path2);

      await createWorkspaceConfig([source1, source2]);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      const skills = await getSyncedSkills();
      expect(skills).toContain('team-x_tools_run');
      expect(skills).toContain('team-y_tools_run');
    });
  });
});
