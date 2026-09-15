import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkpointProfileResource,
  createProfileState,
  hashProfileDeclaration,
  loadProfileState,
  profileStateForCleanup,
  saveProfileState,
} from '../../../src/core/profile/state.js';
import type { ProfileResourceRelationship } from '../../../src/models/profile-state.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'allagents-profile-state-'));
  roots.push(root);
  return root;
}

function relationship(
  key: string,
  client: 'pi' | 'omp',
): ProfileResourceRelationship {
  return {
    key,
    client,
    kind: 'native',
    identity: `owner/${key}`,
    ownership: 'managed',
    transition: 'installed',
    cleanup: 'native',
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile state', () => {
  it('round-trips ordered multi-client relationships through incremental 0600 checkpoints', async () => {
    const root = await temporaryRoot();
    let state = createProfileState({
      profile: 'work',
      clients: ['pi', 'omp'],
      declaration: { clients: ['pi', 'omp'], plugins: ['owner/plugin'] },
      operation: {
        id: 'operation-1',
        kind: 'install',
        startedAt: '2026-09-14T12:00:00.000Z',
      },
    });

    state = await checkpointProfileResource(
      root,
      state,
      relationship('pi-package', 'pi'),
      { clientStatus: 'installed', now: '2026-09-14T12:00:01.000Z' },
    );
    let loaded = await loadProfileState(root);
    expect(loaded.status).toBe('loaded');
    if (loaded.status !== 'loaded') throw new Error('expected loaded state');
    expect(loaded.state.resources.map((resource) => resource.key)).toEqual(['pi-package']);
    expect(loaded.state.status).toBe('partial');
    expect(loaded.state.clientStatuses).toEqual([
      { client: 'pi', status: 'installed' },
      { client: 'omp', status: 'partial' },
    ]);

    state = await checkpointProfileResource(
      root,
      state,
      relationship('omp-plugin', 'omp'),
      {
        clientStatus: 'installed',
        now: '2026-09-14T12:00:02.000Z',
        operation: { completedAt: '2026-09-14T12:00:02.000Z' },
      },
    );
    loaded = await loadProfileState(root);
    expect(loaded.status).toBe('loaded');
    if (loaded.status !== 'loaded') throw new Error('expected loaded state');
    expect(loaded.state.clients).toEqual(['pi', 'omp']);
    expect(loaded.state.clientStatuses).toEqual([
      { client: 'pi', status: 'installed' },
      { client: 'omp', status: 'installed' },
    ]);
    expect(loaded.state.resources.map((resource) => resource.key)).toEqual([
      'pi-package',
      'omp-plugin',
    ]);
    expect(loaded.state.status).toBe('installed');
    expect((await stat(join(root, 'state.json'))).mode & 0o777).toBe(0o600);
  });

  it('distinguishes missing state from malformed state and refuses cleanup or replacement', async () => {
    const root = await temporaryRoot();
    const missing = await loadProfileState(root);
    expect(missing.status).toBe('missing');
    expect(profileStateForCleanup(missing)).toBeNull();

    await writeFile(join(root, 'state.json'), '{not-json', 'utf8');
    const malformed = await loadProfileState(root);
    expect(malformed.status).toBe('malformed');
    expect(() => profileStateForCleanup(malformed)).toThrow('Refusing profile cleanup');

    const valid = createProfileState({
      profile: 'work',
      clients: ['pi'],
      declaration: {},
      operation: {
        id: 'operation-2',
        kind: 'update',
        startedAt: '2026-09-14T12:00:00.000Z',
      },
    });
    await expect(saveProfileState(root, valid)).rejects.toThrow('Refusing to replace malformed');
    expect(await readFile(join(root, 'state.json'), 'utf8')).toBe('{not-json');
  });

  it('sanitizes credentials, terminal controls, provenance, and refs before persistence', async () => {
    const root = await temporaryRoot();
    const state = createProfileState({
      profile: 'safe',
      clients: ['pi'],
      declaration: {},
      operation: {
        id: 'operation-3',
        kind: 'install',
        startedAt: '2026-09-14T12:00:00.000Z',
      },
    });
    await checkpointProfileResource(root, state, {
      key: 'secret-source',
      client: 'pi',
      kind: 'native',
      identity: 'https://user:identity-secret@example.com/owner/repo?token=query-secret',
      ownership: 'managed',
      transition: 'failed',
      cleanup: 'native',
      requestedRef: 'https://user:ref-secret@example.com/repo?password=query-ref-secret',
      provenance: {
        token: 'provenance-secret',
        source: 'https://user:source-secret@example.com/repo?api_key=query-source-secret',
        resolvedSha: 'abc123',
      },
      error: '\u001b[31mfailed token=error-secret Bearer bearer-secret\u001b[0m',
    });

    const serialized = await readFile(join(root, 'state.json'), 'utf8');
    for (const secret of [
      'identity-secret',
      'query-secret',
      'ref-secret',
      'query-ref-secret',
      'provenance-secret',
      'source-secret',
      'query-source-secret',
      'error-secret',
      'bearer-secret',
      '\u001b',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('resolvedSha');
  });

  it('requires unique client identities and keeps each resource tied to a declared client', async () => {
    expect(() => createProfileState({
      profile: 'duplicate',
      clients: ['pi', 'pi'],
      declaration: {},
      operation: {
        id: 'operation-4',
        kind: 'install',
        startedAt: '2026-09-14T12:00:00.000Z',
      },
    })).toThrow('clients must be unique');

    const root = await temporaryRoot();
    const state = createProfileState({
      profile: 'pi-only',
      clients: ['pi'],
      declaration: {},
      operation: {
        id: 'operation-5',
        kind: 'install',
        startedAt: '2026-09-14T12:00:00.000Z',
      },
    });
    await expect(
      checkpointProfileResource(root, state, relationship('omp-plugin', 'omp')),
    ).rejects.toThrow('included in profile state clients');
  });

  it('produces full deterministic declaration hashes independent of object key order', () => {
    const left = hashProfileDeclaration({
      profile: 'work',
      nested: { z: true, a: 1 },
      clients: ['pi', 'omp'],
    });
    const right = hashProfileDeclaration({
      clients: ['pi', 'omp'],
      nested: { a: 1, z: true },
      profile: 'work',
    });
    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(left).toBe(right);
    expect(left).not.toBe(hashProfileDeclaration({ clients: ['omp', 'pi'] }));
  });
});
