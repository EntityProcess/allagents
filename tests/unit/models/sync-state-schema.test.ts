import { describe, expect, test } from 'bun:test';
import { SyncStateSchema } from '../../../src/models/sync-state.js';

describe('SyncStateSchema vscode workspace fields', () => {
  test('accepts state with vscodeWorkspaceHash and vscodeWorkspaceRepos', () => {
    const state = {
      version: 1,
      lastSync: '2026-03-01T00:00:00.000Z',
      files: {},
      vscodeWorkspaceHash: 'abc123',
      vscodeWorkspaceRepos: ['/home/user/backend', '/home/user/frontend'],
    };
    const result = SyncStateSchema.safeParse(state);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.vscodeWorkspaceHash).toBe('abc123');
      expect(result.data.vscodeWorkspaceRepos).toEqual(['/home/user/backend', '/home/user/frontend']);
    }
  });

  test('accepts state without vscode workspace fields (backward compat)', () => {
    const state = {
      version: 1,
      lastSync: '2026-03-01T00:00:00.000Z',
      files: {},
    };
    const result = SyncStateSchema.safeParse(state);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.vscodeWorkspaceHash).toBeUndefined();
      expect(result.data.vscodeWorkspaceRepos).toBeUndefined();
    }
  });
});

test('accepts catalog install provenance and legacy repo-only records', () => {
  const state = SyncStateSchema.parse({
    version: 1,
    lastSync: '2026-08-24T00:00:00.000Z',
    files: {},
    sources: {
      'recommended:hermes-core@main#skills': {
        pluginSpec: 'NousResearch/hermes-agent@main/skills',
        resolvedRef: 'main',
        resolvedSha: 'abc123',
        resolvedRoot: 'skills',
        catalogSource: {
          catalog: 'recommended',
          catalogVersion: 1,
          sourceId: 'hermes-core',
          repo: 'NousResearch/hermes-agent',
          effectiveRef: 'main',
          approvedRoot: 'skills',
          installSource: 'NousResearch/hermes-agent@main/skills',
          installRoot: 'skills',
          sourceKind: 'subtree',
          installPolicy: 'direct-selective',
        },
      },
      'legacy/repo': {
        pluginSpec: 'legacy/repo',
        resolvedRef: 'main',
        resolvedSha: 'def456',
      },
    },
  });
  expect(state.version).toBe(1);
  expect(
    state.sources?.['recommended:hermes-core@main#skills']?.resolvedRoot,
  ).toBe('skills');
  expect(state.sources?.['legacy/repo']?.catalogSource).toBeUndefined();
});
