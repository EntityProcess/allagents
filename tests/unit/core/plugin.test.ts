import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { fetchPlugin, type FetchDeps } from '../../../src/core/plugin.js';

// Create mock functions for dependency injection
const execaMock = mock(() => Promise.resolve({ stdout: '', stderr: '' }));
const existsSyncMock = mock(() => false);
const mkdirMock = mock(() => Promise.resolve());

// Dependencies object passed to fetchPlugin
const deps: FetchDeps = {
  execa: execaMock as unknown as FetchDeps['execa'],
  existsSync: existsSyncMock as unknown as FetchDeps['existsSync'],
  mkdir: mkdirMock as unknown as FetchDeps['mkdir'],
};

beforeEach(() => {
  execaMock.mockClear();
  existsSyncMock.mockClear();
  mkdirMock.mockClear();
});

describe('fetchPlugin', () => {
  it('should validate GitHub URL', async () => {
    const result = await fetchPlugin('not-a-github-url', {}, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
  });

  it('should check for gh CLI availability', async () => {
    execaMock.mockRejectedValueOnce(new Error('gh not found'));

    const result = await fetchPlugin('https://github.com/owner/repo', {}, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('gh CLI not installed');
  });

  it('should skip if plugin is already cached and force is false', async () => {
    existsSyncMock.mockReturnValueOnce(true);
    execaMock.mockResolvedValue({ stdout: 'gh version' });

    const result = await fetchPlugin('https://github.com/owner/repo', {}, deps);
    expect(result.success).toBe(true);
    expect(result.action).toBe('skipped');
  });

  it('should fetch new plugin when not cached', async () => {
    existsSyncMock.mockReturnValueOnce(false);
    execaMock.mockResolvedValue({ stdout: 'gh version' });

    const result = await fetchPlugin('https://github.com/owner/repo', {}, deps);
    expect(result.success).toBe(true);
    expect(result.action).toBe('fetched');
    expect(result.cachePath).toContain('owner-repo');
  });

  it('should update cached plugin when force is true', async () => {
    existsSyncMock.mockReturnValueOnce(true);
    execaMock.mockResolvedValue({ stdout: 'gh version' });

    const result = await fetchPlugin('https://github.com/owner/repo', { force: true }, deps);
    expect(result.success).toBe(true);
    expect(result.action).toBe('updated');
  });

  it('should handle authentication errors', async () => {
    existsSyncMock.mockReturnValueOnce(false);
    execaMock
      .mockResolvedValueOnce({ stdout: 'gh version' })
      .mockRejectedValueOnce(new Error('authentication required'));

    const result = await fetchPlugin('https://github.com/owner/repo', {}, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('authentication required');
  });

  it('should handle repository not found errors', async () => {
    existsSyncMock.mockReturnValueOnce(false);
    execaMock
      .mockResolvedValueOnce({ stdout: 'gh version' })
      .mockRejectedValueOnce(new Error('404 not found'));

    const result = await fetchPlugin('https://github.com/owner/repo', {}, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
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
      execaMock.mockResolvedValue({ stdout: 'gh version' });

      const result = await fetchPlugin(url, {}, deps);
      expect(result.success).toBe(true);
    }
  });
});
