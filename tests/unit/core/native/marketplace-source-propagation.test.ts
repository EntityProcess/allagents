import { describe, it, expect } from 'bun:test';
import { collectNativePluginSources, type ValidatedPlugin } from '../../../../src/core/sync.js';

/**
 * Tests that marketplace source info (owner/repo) is propagated to native
 * sync even when the plugin spec uses marketplace-name format (not owner/repo).
 *
 * Bug: When workspace.yaml has "plugin@marketplace-name" and the marketplace
 * is a GitHub repo, the native CLI needs "owner/repo" to register the
 * marketplace. Without marketplaceSource propagation, addMarketplace is
 * never called and the native install fails with "Plugin not found in
 * marketplace".
 */
describe('collectNativePluginSources — marketplace source propagation', () => {
  function makeValidatedPlugin(overrides: Partial<ValidatedPlugin>): ValidatedPlugin {
    return {
      plugin: '',
      resolved: '/path/to/plugin',
      success: true,
      clients: [],
      nativeClients: [],
      ...overrides,
    };
  }

  it('propagates marketplaceSource when spec uses marketplace name (no owner/repo)', () => {
    // Spec: "agentv-dev@agentv" (marketplace name, no owner/repo)
    // The marketplace was resolved from GitHub repo EntityProcess/agentv
    const vp = makeValidatedPlugin({
      plugin: 'agentv-dev@agentv',
      nativeClients: ['claude'],
      marketplaceSource: 'EntityProcess/agentv',
    });

    const { marketplaceSourcesByClient } = collectNativePluginSources([vp]);
    const sources = marketplaceSourcesByClient.get('claude');

    expect(sources).toBeDefined();
    expect(sources!.has('EntityProcess/agentv')).toBe(true);
  });

  it('propagates marketplaceSource even when registeredAs is not set', () => {
    // When marketplace canonical name matches spec, registeredAs is not set.
    // But we still need marketplaceSource for native CLI registration.
    const vp = makeValidatedPlugin({
      plugin: 'my-plugin@my-marketplace',
      nativeClients: ['claude'],
      marketplaceSource: 'owner/my-marketplace',
      // registeredAs is NOT set
    });

    const { marketplaceSourcesByClient } = collectNativePluginSources([vp]);
    const sources = marketplaceSourcesByClient.get('claude');

    expect(sources).toBeDefined();
    expect(sources!.has('owner/my-marketplace')).toBe(true);
  });

  it('uses owner/repo from spec when registeredAs is set', () => {
    // When spec has owner/repo format AND registeredAs differs,
    // the owner/repo from the spec is used as marketplace source.
    const vp = makeValidatedPlugin({
      plugin: 'code-review@owner/WTG.AI.Prompts',
      nativeClients: ['claude'],
      registeredAs: 'wtg-ai-prompts',
      marketplaceSource: 'owner/WTG.AI.Prompts',
    });

    const { pluginsByClient, marketplaceSourcesByClient } = collectNativePluginSources([vp]);
    const sources = marketplaceSourcesByClient.get('claude');

    // Marketplace source should be from the spec's owner/repo
    expect(sources).toBeDefined();
    expect(sources!.has('owner/WTG.AI.Prompts')).toBe(true);

    // Plugin spec should use canonical name
    const specs = pluginsByClient.get('claude');
    expect(specs).toEqual(['code-review@wtg-ai-prompts']);
  });

  it('no marketplace source for local plugins', () => {
    const vp = makeValidatedPlugin({
      plugin: './local-plugin',
      nativeClients: ['claude'],
      // No marketplaceSource for local plugins
    });

    const { marketplaceSourcesByClient } = collectNativePluginSources([vp]);
    const sources = marketplaceSourcesByClient.get('claude');

    // No marketplace source should be collected
    expect(sources).toBeUndefined();
  });
});
