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
