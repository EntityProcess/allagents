import { describe, it, expect } from 'bun:test';
import { ClaudeNativeClient } from '../../../../src/core/native/claude.js';

/**
 * Demonstrates the native uninstall bug when a marketplace manifest
 * overrides the repo name.
 *
 * Example: repo "owner/WTG.AI.Prompts" has a manifest that sets
 * name: "wtg-ai-prompts". The native CLI registers the marketplace
 * under the canonical name "wtg-ai-prompts", but allagents stores
 * the spec using the repo name "WTG.AI.Prompts".
 *
 * On uninstall, allagents passes "plugin@WTG.AI.Prompts" to the
 * native CLI, which doesn't recognize it — it only knows
 * "plugin@wtg-ai-prompts".
 */
describe('native uninstall — canonical name mismatch', () => {
  const client = new ClaudeNativeClient();

  it('toPluginSpec uses repo name, not the canonical marketplace name', () => {
    // The plugin source as stored in ValidatedPlugin.plugin
    const pluginSource = 'code-review@owner/WTG.AI.Prompts';

    // toPluginSpec drops the owner but keeps the repo name verbatim
    const spec = client.toPluginSpec(pluginSource);
    expect(spec).toBe('code-review@WTG.AI.Prompts');

    // But the native CLI registered the marketplace under canonical name
    // from the manifest: "wtg-ai-prompts"
    const canonicalSpec = 'code-review@wtg-ai-prompts';

    // BUG: The spec we'd use for uninstall doesn't match
    // what the native CLI actually knows
    expect(spec).not.toBe(canonicalSpec);
  });

  it('uninstall flow uses wrong spec when marketplace name differs from repo', () => {
    // Simulate the sync flow without the fix:
    //
    // 1. Install: vp.plugin is pushed to nativePluginsByClient
    const vpPlugin = 'code-review@owner/WTG.AI.Prompts';

    // 2. toPluginSpec converts for install and state storage
    const installedSpec = client.toPluginSpec(vpPlugin);
    expect(installedSpec).toBe('code-review@WTG.AI.Prompts');

    // 3. This spec is saved in sync state as nativePlugins.claude
    const syncState = [installedSpec!]; // ["code-review@WTG.AI.Prompts"]

    // 4. On next sync, plugin is removed from config
    const currentSpecs: string[] = []; // no plugins

    // 5. Diff: previousPlugins - currentSpecs = removed
    const removed = syncState.filter((p) => !currentSpecs.includes(p));
    expect(removed).toEqual(['code-review@WTG.AI.Prompts']);

    // 6. uninstallPlugin is called with "code-review@WTG.AI.Prompts"
    //    but native CLI only knows "code-review@wtg-ai-prompts"
    //    → uninstall fails silently (caught as warning)
    expect(removed[0]).not.toBe('code-review@wtg-ai-prompts');
  });

  it('canonical spec works correctly for uninstall', () => {
    // With the fix: resolveNativePluginSource returns canonical spec
    // when registeredAs is set
    const canonicalSource = 'code-review@wtg-ai-prompts';

    // toPluginSpec leaves it unchanged (no owner/repo to strip)
    const spec = client.toPluginSpec(canonicalSource);
    expect(spec).toBe('code-review@wtg-ai-prompts');

    // This matches what the native CLI knows → uninstall works
    const syncState = [spec!];
    const currentSpecs: string[] = [];
    const removed = syncState.filter((p) => !currentSpecs.includes(p));
    expect(removed[0]).toBe('code-review@wtg-ai-prompts');
  });
});
