import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  saveNativeStateResources,
  saveSyncState,
  loadSyncState,
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
  it('isolates exact native resource identity by client, scope, and root', async () => {
    await saveSyncState(testDir, {
      files: {},
      nativeResources: {
        version: 1,
        resources: [
          {
            client: 'claude',
            scope: 'project',
            nativeScope: 'project',
            kind: 'plugin',
            requestedIdentity: 'plugin@market',
            resolvedIdentity: 'plugin@market',
            context: '/workspace/a',
            provenance: { source: 'plugin@owner/market' },
            transition: 'managed',
          },
          {
            client: 'copilot',
            scope: 'user',
            nativeScope: 'user',
            kind: 'plugin',
            requestedIdentity: 'plugin@market',
            resolvedIdentity: 'plugin@market',
            context: '/home/test',
            provenance: { source: 'plugin@owner/market' },
            transition: 'cleanup-failed',
            error: 'busy',
          },
        ],
      },
    });

    const state = await loadSyncState(testDir);
    expect(state?.nativeResources?.resources).toHaveLength(2);
    expect(state?.nativeResources?.resources[1]?.transition).toBe(
      'cleanup-failed',
    );
  });

  it('preserves unrelated legacy fields when writing valid state', async () => {
    const stateDir = join(testDir, '.allagents');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'sync-state.json'),
      JSON.stringify({
        version: 1,
        lastSync: 'old',
        files: {},
        futureField: { keep: true },
      }),
    );
    await saveSyncState(testDir, { files: { claude: ['skill.md'] } });
    const raw = JSON.parse(
      await readFile(join(stateDir, 'sync-state.json'), 'utf-8'),
    );
    expect(raw.futureField).toEqual({ keep: true });
  });

  it('patches malformed native state without discarding valid file ownership', async () => {
    const stateDir = join(testDir, '.allagents');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'sync-state.json'),
      JSON.stringify({
        version: 1,
        lastSync: 'old',
        files: { pi: ['.pi/skills/review/SKILL.md'] },
        nativeResources: { resources: 'malformed' },
      }),
    );

    await saveNativeStateResources(testDir, [{
      client: 'pi',
      scope: 'user',
      nativeScope: 'user',
      kind: 'package',
      requestedIdentity: 'review',
      resolvedIdentity: 'npm:review@1.0.0',
      context: '/tmp/pi',
      provenance: {},
      transition: 'managed',
    }]);

    const raw = JSON.parse(
      await readFile(join(stateDir, 'sync-state.json'), 'utf-8'),
    );
    expect(raw.files).toEqual({ pi: ['.pi/skills/review/SKILL.md'] });
    expect(raw.nativeResources.resources).toHaveLength(1);
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

});
