import { describe, it, expect } from 'bun:test';
import { getTuiContext } from '../../../src/cli/tui/context.js';
import { TuiCache } from '../../../src/cli/tui/cache.js';

describe('getTuiContext with cache', () => {
  it('should return cached context when cache has one', async () => {
    const cache = new TuiCache();
    const fakeContext = {
      hasWorkspace: true,
      workspacePath: '/tmp/fake',
      projectPluginCount: 99,
      userPluginCount: 88,
      needsSync: false,
      hasUserConfig: true,
      marketplaceCount: 77,
    };
    cache.setContext(fakeContext);

    const result = await getTuiContext('/tmp/nonexistent-dir-xyz', cache);

    // Should return cached context, NOT compute a fresh one
    expect(result.projectPluginCount).toBe(99);
    expect(result.userPluginCount).toBe(88);
    expect(result.marketplaceCount).toBe(77);
  });

  it('should compute and cache context when cache is empty', async () => {
    const cache = new TuiCache();

    // Call with a non-workspace dir so it computes a fresh context
    const result = await getTuiContext('/tmp', cache);

    expect(result.hasWorkspace).toBe(false);
    // Should now be cached
    expect(cache.hasCachedContext()).toBe(true);
    expect(cache.getContext()).toEqual(result);
  });

  it('should work without cache (backward compatible)', async () => {
    const result = await getTuiContext('/tmp');
    expect(result.hasWorkspace).toBe(false);
  });
});
