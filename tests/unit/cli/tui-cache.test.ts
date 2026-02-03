import { describe, it, expect, beforeEach } from 'bun:test';
import { TuiCache } from '../../../src/cli/tui/cache.js';

describe('TuiCache', () => {
  let cache: TuiCache;

  beforeEach(() => {
    cache = new TuiCache();
  });

  it('should start with empty cache', () => {
    expect(cache.hasCachedRegistry()).toBe(false);
    expect(cache.hasCachedContext()).toBe(false);
  });

  it('should store and return cached registry', () => {
    const registry = { version: 1 as const, marketplaces: {} };
    cache.setRegistry(registry);
    expect(cache.hasCachedRegistry()).toBe(true);
    expect(cache.getRegistry()).toEqual(registry);
  });

  it('should store and return cached context', () => {
    const context = {
      hasWorkspace: true,
      workspacePath: '/tmp/test',
      projectPluginCount: 2,
      userPluginCount: 1,
      needsSync: false,
      hasUserConfig: true,
      marketplaceCount: 1,
    };
    cache.setContext(context);
    expect(cache.hasCachedContext()).toBe(true);
    expect(cache.getContext()).toEqual(context);
  });

  it('should clear all caches on invalidate()', () => {
    const registry = { version: 1 as const, marketplaces: {} };
    cache.setRegistry(registry);
    cache.setContext({
      hasWorkspace: false,
      workspacePath: null,
      projectPluginCount: 0,
      userPluginCount: 0,
      needsSync: false,
      hasUserConfig: false,
      marketplaceCount: 0,
    });

    cache.invalidate();

    expect(cache.hasCachedRegistry()).toBe(false);
    expect(cache.hasCachedContext()).toBe(false);
  });

  it('should store and return cached marketplace plugins', () => {
    const plugins = [{ name: 'test-plugin', path: '/tmp/plugin' }];
    cache.setMarketplacePlugins('my-marketplace', { plugins, warnings: [] });
    expect(cache.getMarketplacePlugins('my-marketplace')).toEqual({ plugins, warnings: [] });
  });

  it('should return undefined for uncached marketplace plugins', () => {
    expect(cache.getMarketplacePlugins('nonexistent')).toBeUndefined();
  });

  it('should clear marketplace plugins on invalidate()', () => {
    cache.setMarketplacePlugins('my-marketplace', { plugins: [], warnings: [] });
    cache.invalidate();
    expect(cache.getMarketplacePlugins('my-marketplace')).toBeUndefined();
  });
});
