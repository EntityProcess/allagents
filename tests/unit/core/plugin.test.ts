import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { fetchPlugin, type FetchDeps } from '../../../src/core/plugin.js';
import { GitCloneError } from '../../../src/core/git.js';

// Create mock functions for dependency injection
const existsSyncMock = mock(() => false);
const mkdirMock = mock(() => Promise.resolve());
const cloneToMock = mock(() => Promise.resolve());
const pullMock = mock(() => Promise.resolve());

// Dependencies object passed to fetchPlugin
const deps: FetchDeps = {
  existsSync: existsSyncMock as unknown as FetchDeps['existsSync'],
  mkdir: mkdirMock as unknown as FetchDeps['mkdir'],
  cloneTo: cloneToMock as unknown as FetchDeps['cloneTo'],
  pull: pullMock as unknown as FetchDeps['pull'],
};

beforeEach(() => {
  existsSyncMock.mockClear();
  mkdirMock.mockClear();
  cloneToMock.mockClear();
  pullMock.mockClear();
});

describe('fetchPlugin', () => {
  it('should validate GitHub URL', async () => {
    const result = await fetchPlugin('not-a-github-url', {}, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
  });

  it('should update cached plugin by default (pull latest)', async () => {
    existsSyncMock.mockReturnValueOnce(true);

    const result = await fetchPlugin('https://github.com/owner/repo', {}, deps);
    expect(result.success).toBe(true);
    expect(result.action).toBe('updated');
  });

  it('should skip fetching when offline is true and plugin is cached', async () => {
    existsSyncMock.mockReturnValueOnce(true);

    const result = await fetchPlugin('https://github.com/owner/repo', { offline: true }, deps);
    expect(result.success).toBe(true);
    expect(result.action).toBe('skipped');
  });

  it('should fetch new plugin when not cached', async () => {
    existsSyncMock.mockReturnValueOnce(false);

    const result = await fetchPlugin('https://github.com/owner/repo', {}, deps);
    expect(result.success).toBe(true);
    expect(result.action).toBe('fetched');
    expect(result.cachePath).toContain('owner-repo');
  });

  it('should handle authentication errors', async () => {
    existsSyncMock.mockReturnValueOnce(false);
    cloneToMock.mockRejectedValueOnce(
      new GitCloneError('Authentication failed', 'https://github.com/owner/repo.git', false, true),
    );

    const result = await fetchPlugin('https://github.com/owner/repo', {}, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Authentication failed');
  });

  it('should handle clone timeout errors', async () => {
    existsSyncMock.mockReturnValueOnce(false);
    cloneToMock.mockRejectedValueOnce(
      new GitCloneError('Clone timed out', 'https://github.com/owner/repo.git', true, false),
    );

    const result = await fetchPlugin('https://github.com/owner/repo', {}, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('should parse different GitHub URL formats', async () => {
    const urls = [
      'https://github.com/owner/repo',
      'https://github.com/owner/repo.git',
      'github.com/owner/repo',
      'gh:owner/repo',
    ];

    for (const url of urls) {
      existsSyncMock.mockReturnValueOnce(true);
      pullMock.mockResolvedValueOnce(undefined);

      const result = await fetchPlugin(url, {}, deps);
      expect(result.success).toBe(true);
    }
  });
});
