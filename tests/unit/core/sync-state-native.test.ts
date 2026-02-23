import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  saveSyncState,
  loadSyncState,
  getPreviouslySyncedNativePlugins,
} from '../../../src/core/sync-state.js';

describe('sync-state nativePlugins', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-native-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('saves and loads native plugins per-client', async () => {
    await saveSyncState(testDir, {
      files: { claude: ['file1.md'] },
      nativePlugins: { claude: ['plugin-a', 'plugin-b'] },
    });

    const state = await loadSyncState(testDir);
    expect(state).not.toBeNull();
    expect(state!.nativePlugins).toEqual({ claude: ['plugin-a', 'plugin-b'] });
  });

  it('omits nativePlugins when not provided', async () => {
    await saveSyncState(testDir, {
      files: { claude: ['file1.md'] },
    });

    const raw = JSON.parse(
      await readFile(
        join(testDir, '.allagents', 'sync-state.json'),
        'utf-8',
      ),
    );
    expect(raw).not.toHaveProperty('nativePlugins');

    const state = await loadSyncState(testDir);
    expect(state).not.toBeNull();
    expect(state!.nativePlugins).toBeUndefined();
  });

  it('getPreviouslySyncedNativePlugins returns empty for null state', () => {
    expect(getPreviouslySyncedNativePlugins(null, 'claude')).toEqual([]);
  });

  it('getPreviouslySyncedNativePlugins returns plugins for matching client', async () => {
    await saveSyncState(testDir, {
      files: {},
      nativePlugins: { cursor: ['cursor-plugin-1'] },
    });

    const state = await loadSyncState(testDir);
    expect(getPreviouslySyncedNativePlugins(state, 'cursor')).toEqual([
      'cursor-plugin-1',
    ]);
  });

  it('getPreviouslySyncedNativePlugins returns empty for non-matching client', async () => {
    await saveSyncState(testDir, {
      files: {},
      nativePlugins: { claude: ['plugin-a'] },
    });

    const state = await loadSyncState(testDir);
    expect(getPreviouslySyncedNativePlugins(state, 'copilot')).toEqual([]);
  });
});
