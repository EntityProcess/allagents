import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dump } from 'js-yaml';
import { syncWorkspace } from '../../../src/core/sync.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';

describe('sync with lifecycle hooks', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-lifecycle-'));
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeWorkspaceConfig(config: Record<string, unknown>) {
    const yaml = dump(config, { lineWidth: -1 });
    await writeFile(join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE), yaml, 'utf-8');
  }

  it('should run preSync hooks before plugin sync', async () => {
    await writeWorkspaceConfig({
      repositories: [],
      plugins: [],
      clients: ['claude'],
      lifecycleHooks: {
        preSync: [
          'echo "presync-ran" > .allagents/presync-marker.txt',
        ],
      },
    });

    const result = await syncWorkspace(testDir, { dryRun: false });

    expect(result.success).toBe(true);
    expect(result.lifecycleResults).toBeDefined();
    expect(result.lifecycleResults!.preSync).toBeDefined();
    expect(result.lifecycleResults!.preSync.results).toHaveLength(1);
    expect(result.lifecycleResults!.preSync.results[0].success).toBe(true);

    // Verify the script actually ran
    const marker = await readFile(join(testDir, '.allagents', 'presync-marker.txt'), 'utf-8');
    expect(marker.trim()).toBe('presync-ran');
  });

  it('should run multiple preSync hooks in order', async () => {
    await writeWorkspaceConfig({
      repositories: [],
      plugins: [],
      clients: ['claude'],
      lifecycleHooks: {
        preSync: [
          'echo "first" > .allagents/order.txt',
          'echo "second" >> .allagents/order.txt',
        ],
      },
    });

    const result = await syncWorkspace(testDir, { dryRun: false });

    expect(result.success).toBe(true);
    expect(result.lifecycleResults!.preSync.results).toHaveLength(2);

    const content = await readFile(join(testDir, '.allagents', 'order.txt'), 'utf-8');
    expect(content).toBe('first\nsecond\n');
  });

  it('should abort sync on required preSync script failure', async () => {
    await writeWorkspaceConfig({
      repositories: [],
      plugins: [],
      clients: ['claude'],
      lifecycleHooks: {
        preSync: [
          { script: 'exit 42', name: 'failing-hook' },
        ],
      },
    });

    const result = await syncWorkspace(testDir, { dryRun: false });

    expect(result.success).toBe(false);
    expect(result.error).toContain('failing-hook');
    expect(result.lifecycleResults!.preSync.results[0].exitCode).toBe(42);
  });

  it('should continue sync on optional preSync script failure', async () => {
    await writeWorkspaceConfig({
      repositories: [],
      plugins: [],
      clients: ['claude'],
      lifecycleHooks: {
        preSync: [
          { script: 'exit 1', name: 'optional-hook', optional: true },
          { script: 'echo "ok"', name: 'required-hook' },
        ],
      },
    });

    const result = await syncWorkspace(testDir, { dryRun: false });

    expect(result.success).toBe(true);
    expect(result.lifecycleResults!.preSync.results).toHaveLength(2);
    expect(result.lifecycleResults!.preSync.results[0].success).toBe(false);
    expect(result.lifecycleResults!.preSync.results[1].success).toBe(true);
  });

  it('should not execute hooks in dry-run mode', async () => {
    await writeWorkspaceConfig({
      repositories: [],
      plugins: [],
      clients: ['claude'],
      lifecycleHooks: {
        preSync: [
          'echo "should-not-run" > .allagents/dryrun-marker.txt',
        ],
      },
    });

    const result = await syncWorkspace(testDir, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.lifecycleResults!.preSync.results[0].skipped).toBe(true);
    expect(existsSync(join(testDir, '.allagents', 'dryrun-marker.txt'))).toBe(false);
  });

  it('should not include lifecycleResults when no hooks configured', async () => {
    await writeWorkspaceConfig({
      repositories: [],
      plugins: [],
      clients: ['claude'],
    });

    const result = await syncWorkspace(testDir, { dryRun: false });

    expect(result.success).toBe(true);
    expect(result.lifecycleResults).toBeUndefined();
  });

  it('should include lifecycleResults in failed sync result', async () => {
    await writeWorkspaceConfig({
      repositories: [],
      plugins: [],
      clients: ['claude'],
      lifecycleHooks: {
        preSync: [
          'echo "ran-before-fail" > .allagents/partial.txt',
          { script: 'exit 1', name: 'abort-hook' },
        ],
      },
    });

    const result = await syncWorkspace(testDir, { dryRun: false });

    expect(result.success).toBe(false);
    expect(result.lifecycleResults!.preSync.results).toHaveLength(2);
    expect(result.lifecycleResults!.preSync.results[0].success).toBe(true);
    expect(result.lifecycleResults!.preSync.results[1].success).toBe(false);
  });

  it('should parse lifecycleHooks from workspace config correctly', async () => {
    await writeWorkspaceConfig({
      repositories: [],
      plugins: [],
      clients: ['claude'],
      lifecycleHooks: {
        preSync: [
          'scripts/one.sh',
          { script: 'scripts/two.sh', name: 'Two' },
          { script: 'scripts/three.sh', name: 'Three', optional: true },
        ],
      },
    });

    const result = await syncWorkspace(testDir, { dryRun: true });

    expect(result.success).toBe(true);
    const scripts = result.lifecycleResults!.preSync.results;
    expect(scripts).toHaveLength(3);
    expect(scripts[0].name).toBe('scripts/one.sh');
    expect(scripts[0].skipped).toBe(true);
    expect(scripts[1].name).toBe('Two');
    expect(scripts[2].name).toBe('Three');
  });
});
