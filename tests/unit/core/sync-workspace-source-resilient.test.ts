import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncWorkspace } from '../../../src/core/sync.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';

describe('syncWorkspace - workspace.source validation resilience', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-ws-source-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should sync plugins even when workspace.source validation fails', async () => {
    // Setup: Create a local plugin with a command
    const pluginDir = join(testDir, 'my-plugin');
    await mkdir(join(pluginDir, 'commands'), { recursive: true });
    await writeFile(
      join(pluginDir, 'commands', 'my-command.md'),
      '# My Command',
    );

    // workspace.yaml with workspace.source pointing to nonexistent path
    // (simulates a failed workspace.source validation, like a private repo clone failure)
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
workspace:
  source: ./nonexistent-source-dir
  files:
    - AGENTS.md
repositories:
  - path: ./repo
    source: github
    repo: test/repo
    description: Test repo
plugins:
  - ./my-plugin
clients:
  - claude
`,
    );

    const result = await syncWorkspace(testDir);

    // Sync should succeed overall (plugins were synced)
    expect(result.success).toBe(true);

    // Plugin should have been synced
    expect(result.pluginResults.length).toBeGreaterThan(0);
    expect(result.pluginResults[0].success).toBe(true);

    // Should have a warning about workspace source failure
    expect(result.warnings?.some((w) => w.includes('Workspace source'))).toBe(
      true,
    );

    // Plugin command should have been copied
    expect(
      existsSync(join(testDir, '.claude', 'commands', 'my-command.md')),
    ).toBe(true);
  });

  it('should skip workspace files but still sync plugins when source fails', async () => {
    // Setup: local plugin
    const pluginDir = join(testDir, 'my-plugin');
    await mkdir(join(pluginDir, 'commands'), { recursive: true });
    await writeFile(
      join(pluginDir, 'commands', 'my-command.md'),
      '# My Command',
    );

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
workspace:
  source: ./nonexistent-source-dir
  files:
    - AGENTS.md
    - CLAUDE.md
repositories:
  - path: ./repo
    source: github
    repo: test/repo
    description: Test repo
plugins:
  - ./my-plugin
clients:
  - claude
`,
    );

    const result = await syncWorkspace(testDir);

    // Plugins synced successfully
    expect(result.success).toBe(true);
    expect(result.pluginResults[0].success).toBe(true);
    // Plugin command was copied despite workspace source failure
    expect(
      existsSync(join(testDir, '.claude', 'commands', 'my-command.md')),
    ).toBe(true);

    // Should have a warning about workspace source failure
    expect(result.warnings?.some((w) => w.includes('Workspace source'))).toBe(
      true,
    );
  });

  it('should sync workspace files normally when workspace.source is valid', async () => {
    // Setup: valid workspace source with agent file
    const sourceDir = join(testDir, 'workspace-source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'AGENTS.md'), '# Agents\n');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
workspace:
  source: ./workspace-source
  files:
    - AGENTS.md
repositories:
  - path: ./repo
    source: github
    repo: test/repo
    description: Test repo
plugins: []
clients:
  - claude
`,
    );

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    // No workspace source warnings
    expect(
      result.warnings?.some((w) => w.includes('Workspace source')),
    ).toBeFalsy();
    // Agent file should have been copied
    expect(existsSync(join(testDir, 'AGENTS.md'))).toBe(true);
  });
});
