import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncWorkspace, deduplicateClientsByPath, collectSyncedPaths } from '../../../src/core/sync.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';
import { CLIENT_MAPPINGS, USER_CLIENT_MAPPINGS } from '../../../src/models/client-mapping.js';
import type { CopyResult } from '../../../src/core/transform.js';

describe('deduplicateClientsByPath', () => {
  it('should group clients that share the same skillsPath', () => {
    // copilot and vscode both use .github/skills/
    const clients = ['copilot', 'vscode'] as const;
    const result = deduplicateClientsByPath([...clients], CLIENT_MAPPINGS);

    // Should have only one representative client
    expect(result.representativeClients).toHaveLength(1);
    expect(result.representativeClients[0]).toBe('copilot');

    // The group should contain both clients
    const group = result.clientGroups.get('copilot');
    expect(group).toBeDefined();
    expect(group).toHaveLength(2);
    expect(group).toContain('copilot');
    expect(group).toContain('vscode');
  });

  it('should keep clients with different skillsPaths separate', () => {
    // claude uses .claude/skills/, cursor uses .cursor/skills/, codex uses .codex/skills/
    const clients = ['claude', 'cursor', 'codex'] as const;
    const result = deduplicateClientsByPath([...clients], CLIENT_MAPPINGS);

    expect(result.representativeClients).toHaveLength(3);
    expect(result.representativeClients).toContain('claude');
    expect(result.representativeClients).toContain('cursor');
    expect(result.representativeClients).toContain('codex');

    // Each group should have only one client
    expect(result.clientGroups.get('claude')).toEqual(['claude']);
    expect(result.clientGroups.get('cursor')).toEqual(['cursor']);
    expect(result.clientGroups.get('codex')).toEqual(['codex']);
  });

  it('should handle mixed unique and shared paths', () => {
    // claude (unique .claude/skills/), copilot+vscode (shared .github/skills/), codex (unique .codex/skills/)
    const clients = ['claude', 'copilot', 'vscode', 'codex'] as const;
    const result = deduplicateClientsByPath([...clients], CLIENT_MAPPINGS);

    // Should have 3 representative clients
    expect(result.representativeClients).toHaveLength(3);
    expect(result.representativeClients).toContain('claude');
    expect(result.representativeClients).toContain('codex');
    // copilot should be representative for the shared group
    expect(result.representativeClients).toContain('copilot');

    // copilot group should have both copilot and vscode
    const copilotGroup = result.clientGroups.get('copilot');
    expect(copilotGroup).toHaveLength(2);
    expect(copilotGroup).toContain('copilot');
    expect(copilotGroup).toContain('vscode');
  });

  it('should work with USER_CLIENT_MAPPINGS', () => {
    // copilot uses .copilot/skills/, codex uses .codex/skills/, opencode uses .opencode/skills/
    const clients = ['copilot', 'codex', 'opencode'] as const;
    const result = deduplicateClientsByPath([...clients], USER_CLIENT_MAPPINGS);

    // All three have different user-level paths, so no grouping
    expect(result.representativeClients).toHaveLength(3);
    expect(result.clientGroups.get('copilot')).toEqual(['copilot']);
    expect(result.clientGroups.get('codex')).toEqual(['codex']);
    expect(result.clientGroups.get('opencode')).toEqual(['opencode']);
  });

  it('should handle empty clients array', () => {
    const result = deduplicateClientsByPath([], CLIENT_MAPPINGS);

    expect(result.representativeClients).toHaveLength(0);
    expect(result.clientGroups.size).toBe(0);
  });

  it('should handle single client', () => {
    const result = deduplicateClientsByPath(['claude'], CLIENT_MAPPINGS);

    expect(result.representativeClients).toHaveLength(1);
    expect(result.representativeClients[0]).toBe('claude');
    expect(result.clientGroups.get('claude')).toEqual(['claude']);
  });

  it('should group vscode with copilot (both use .github/skills/)', () => {
    const clients = ['copilot', 'vscode', 'codex'] as const;
    const result = deduplicateClientsByPath([...clients], CLIENT_MAPPINGS);

    // copilot and vscode share .github/skills/, codex uses .codex/skills/
    expect(result.representativeClients).toHaveLength(2);
    expect(result.representativeClients).toContain('copilot');
    expect(result.representativeClients).toContain('codex');

    const copilotGroup = result.clientGroups.get('copilot');
    expect(copilotGroup).toHaveLength(2);
    expect(copilotGroup).toContain('copilot');
    expect(copilotGroup).toContain('vscode');

    const codexGroup = result.clientGroups.get('codex');
    expect(codexGroup).toHaveLength(1);
    expect(codexGroup).toContain('codex');
  });
});

describe('collectSyncedPaths with shared paths', () => {
  it('should track file for all clients sharing the same skillsPath', () => {
    // copilot and vscode both use .github/skills/
    const copyResults: CopyResult[] = [
      {
        source: '/some/plugin/skills/my-skill',
        destination: '/workspace/.github/skills/my-skill',
        action: 'copied',
      },
    ];

    const clients = ['copilot', 'vscode'] as const;
    const result = collectSyncedPaths(copyResults, '/workspace', [...clients], CLIENT_MAPPINGS);

    // Both clients should track the same skill
    expect(result.copilot).toContain('.github/skills/my-skill/');
    expect(result.vscode).toContain('.github/skills/my-skill/');
  });

  it('should track files correctly when clients have different paths', () => {
    const copyResults: CopyResult[] = [
      {
        source: '/some/plugin/skills/skill1',
        destination: '/workspace/.claude/skills/skill1',
        action: 'copied',
      },
      {
        source: '/some/plugin/skills/skill2',
        destination: '/workspace/.github/skills/skill2',
        action: 'copied',
      },
    ];

    const clients = ['claude', 'copilot'] as const;
    const result = collectSyncedPaths(copyResults, '/workspace', [...clients], CLIENT_MAPPINGS);

    // claude should only track .claude/skills/skill1
    expect(result.claude).toContain('.claude/skills/skill1/');
    expect(result.claude).not.toContain('.github/skills/skill2/');

    // copilot should only track .github/skills/skill2
    expect(result.copilot).toContain('.github/skills/skill2/');
    expect(result.copilot).not.toContain('.claude/skills/skill1/');
  });
});

describe('syncWorkspace deduplication', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-dedup-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /**
   * Helper to create a plugin with a skill
   */
  async function createPluginWithSkill(name: string, skillName: string): Promise<string> {
    const pluginDir = join(testDir, name);
    const skillDir = join(pluginDir, 'skills', skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: ${skillName}
description: A test skill
---

# ${skillName}`,
    );
    return pluginDir;
  }

  it('should copy skill only once when multiple clients share .github/skills/', async () => {
    const pluginDir = await createPluginWithSkill('my-plugin', 'test-skill');

    // Setup workspace config with clients that share .github/skills/
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - copilot
  - vscode
`,
    );

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    // Should only copy once (not 2 times)
    expect(result.totalCopied).toBe(1);

    // Skill should exist in .github/skills/
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);

    // Verify sync state tracks the skill for both clients
    const statePath = join(testDir, CONFIG_DIR, 'sync-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8'));

    expect(state.files.copilot).toContain('.github/skills/test-skill/');
    expect(state.files.vscode).toContain('.github/skills/test-skill/');
  });

  it('should copy skill to different paths for clients with unique skillsPaths', async () => {
    const pluginDir = await createPluginWithSkill('my-plugin', 'test-skill');

    // Setup workspace config with clients that have different skillsPaths
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
  - copilot
`,
    );

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    // Should copy 3 times (one for each unique path)
    expect(result.totalCopied).toBe(3);

    // Skills should exist in each client's directory
    expect(existsSync(join(testDir, '.claude', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(testDir, '.cursor', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);
  });

  it('should properly purge when a client sharing path is removed', async () => {
    const pluginDir = await createPluginWithSkill('my-plugin', 'test-skill');

    // First sync with copilot and vscode (both share .github/skills/)
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - copilot
  - vscode
`,
    );

    const result1 = await syncWorkspace(testDir);
    expect(result1.success).toBe(true);
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);

    // Now remove vscode from clients
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

    const result2 = await syncWorkspace(testDir);
    expect(result2.success).toBe(true);

    // Skill should still exist (copilot still uses it)
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);

    // State should only have copilot now
    const statePath = join(testDir, CONFIG_DIR, 'sync-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(state.files.copilot).toBeDefined();
    expect(state.files.vscode).toBeUndefined();
  });

  it('should purge shared path when all clients using it are removed', async () => {
    const pluginDir = await createPluginWithSkill('my-plugin', 'test-skill');

    // First sync with copilot and vscode (using copy mode for predictable behavior)
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - copilot
  - vscode
syncMode: copy
`,
    );

    await syncWorkspace(testDir);
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill'))).toBe(true);

    // Remove both clients (replace with claude)
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

    await syncWorkspace(testDir);

    // .github/skills/test-skill should be purged
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill'))).toBe(false);

    // .claude/skills/test-skill should exist
    expect(existsSync(join(testDir, '.claude', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);
  });
});
