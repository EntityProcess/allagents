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

  it('should treat pull failure as non-fatal when cached', async () => {
    existsSyncMock.mockReturnValueOnce(true);
    pullMock.mockRejectedValueOnce(new Error('not something we can merge'));

    const result = await fetchPlugin('https://github.com/owner/repo', {}, deps);
    expect(result.success).toBe(true);
    expect(result.action).toBe('skipped');
    expect(result.cachePath).toContain('owner-repo');
  });

  it('should coalesce concurrent fetches for the same repo', async () => {
    existsSyncMock.mockReturnValue(true);
    pullMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 10)),
    );

    const [result1, result2] = await Promise.all([
      fetchPlugin('https://github.com/owner/repo', {}, deps),
      fetchPlugin('https://github.com/owner/repo', {}, deps),
    ]);

    // Both callers get the exact same result object
    expect(result1).toBe(result2);
    expect(result1.success).toBe(true);
    // Only one pull should have occurred despite two concurrent calls
    expect(pullMock).toHaveBeenCalledTimes(1);
  });
});
