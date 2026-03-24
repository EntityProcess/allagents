import { describe, it, expect, beforeEach } from 'bun:test';
import {
  seedFetchCache,
  resetFetchCache,
  fetchPlugin,
} from '../plugin.js';

describe('seedFetchCache', () => {
  beforeEach(() => {
    resetFetchCache();
  });

  it('causes fetchPlugin to return seeded path without git operations', async () => {
    const marketplacePath = '/home/user/.allagents/plugins/marketplaces/WTG.AI.Prompts';

    // Seed the cache with the marketplace path
    seedFetchCache('WiseTechGlobal/WTG.AI.Prompts', marketplacePath);

    // fetchPlugin should return the seeded result, not attempt git operations
    const result = await fetchPlugin('WiseTechGlobal/WTG.AI.Prompts', {}, {
      // These deps should never be called since the cache is seeded
      existsSync: () => { throw new Error('existsSync should not be called'); },
      mkdir: () => { throw new Error('mkdir should not be called'); },
      cloneTo: () => { throw new Error('cloneTo should not be called'); },
      pull: () => { throw new Error('pull should not be called'); },
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe('skipped');
    expect(result.cachePath).toBe(marketplacePath);
  });

  it('accepts full GitHub URL format', async () => {
    const marketplacePath = '/tmp/marketplace';

    seedFetchCache('https://github.com/owner/repo', marketplacePath);

    const result = await fetchPlugin('owner/repo', {}, {
      existsSync: () => { throw new Error('should not be called'); },
      mkdir: () => { throw new Error('should not be called'); },
      cloneTo: () => { throw new Error('should not be called'); },
      pull: () => { throw new Error('should not be called'); },
    });

    expect(result.success).toBe(true);
    expect(result.cachePath).toBe(marketplacePath);
  });

  it('does not overwrite existing cache entry', async () => {
    const firstPath = '/first/path';
    const secondPath = '/second/path';

    seedFetchCache('owner/repo', firstPath);
    seedFetchCache('owner/repo', secondPath);

    const result = await fetchPlugin('owner/repo', {}, {
      existsSync: () => { throw new Error('should not be called'); },
      mkdir: () => { throw new Error('should not be called'); },
      cloneTo: () => { throw new Error('should not be called'); },
      pull: () => { throw new Error('should not be called'); },
    });

    expect(result.cachePath).toBe(firstPath);
  });

  it('seeds branch-qualified key via explicit branch parameter', async () => {
    const marketplacePath = '/home/user/.allagents/plugins/marketplaces/WTG.AI.Prompts';

    // Seed with explicit branch (as seedFetchCacheFromMarketplaces does after reading .git/HEAD)
    seedFetchCache('WiseTechGlobal/WTG.AI.Prompts', marketplacePath, 'main');

    // fetchPlugin with explicit branch should hit the seeded cache
    const result = await fetchPlugin('WiseTechGlobal/WTG.AI.Prompts', { branch: 'main' }, {
      existsSync: () => { throw new Error('should not be called'); },
      mkdir: () => { throw new Error('should not be called'); },
      cloneTo: () => { throw new Error('should not be called'); },
      pull: () => { throw new Error('should not be called'); },
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe('skipped');
    expect(result.cachePath).toBe(marketplacePath);
  });

  it('ignores invalid URLs', () => {
    // Should not throw, just silently skip
    seedFetchCache('not-a-valid-url', '/some/path');

    // Cache should be empty — fetchPlugin will proceed normally
    // (we can't easily verify the cache is empty, but the no-throw is the test)
  });

  it('is cleared by resetFetchCache', async () => {
    seedFetchCache('owner/repo', '/marketplace/path');
    resetFetchCache();

    // After reset, fetchPlugin should attempt git operations (clone since not cached)
    let cloneCalled = false;
    const result = await fetchPlugin('owner/repo', {}, {
      existsSync: () => false,
      mkdir: async () => undefined,
      cloneTo: async () => { cloneCalled = true; },
      pull: async () => {},
    });

    expect(cloneCalled).toBe(true);
    expect(result.action).toBe('fetched');
  });
});
