import { executeCommand, type NativeClient, type NativeCommandResult, type NativeSyncResult } from './types.js';

export class CopilotNativeClient implements NativeClient {
  async isAvailable(): Promise<boolean> {
    const result = await executeCommand('copilot', ['--version']);
    return result.success;
  }

  supportsScope(scope: 'user' | 'project'): boolean {
    return scope === 'user';
  }

  toPluginSpec(allagentsSource: string): string | null {
    const atIndex = allagentsSource.lastIndexOf('@');
    if (atIndex <= 0 || atIndex === allagentsSource.length - 1) return null;

    const marketplacePart = allagentsSource.slice(atIndex + 1);

    // Must have a marketplace part (not a URL)
    if (marketplacePart.includes('://')) return null;

    // Validate non-empty marketplace name
    if (marketplacePart.includes('/')) {
      const parts = marketplacePart.split('/');
      if (!parts[1]) return null; // trailing slash
    }

    // Keep the full source as-is (copilot uses owner/repo format)
    return allagentsSource;
  }

  extractMarketplaceSource(pluginSpec: string): string | null {
    const atIndex = pluginSpec.lastIndexOf('@');
    if (atIndex <= 0 || atIndex === pluginSpec.length - 1) return null;
    const marketplacePart = pluginSpec.slice(atIndex + 1);
    if (marketplacePart.includes('/') && !marketplacePart.includes('://')) {
      return marketplacePart;
    }
    return null;
  }

  addMarketplace(source: string, options?: { cwd?: string }): Promise<NativeCommandResult> {
    return executeCommand('copilot', ['plugin', 'marketplace', 'add', source], options);
  }

  installPlugin(spec: string, _scope: 'user' | 'project', options?: { cwd?: string }): Promise<NativeCommandResult> {
    // Copilot has no scope flag — plugins install globally
    return executeCommand('copilot', ['plugin', 'install', spec], options);
  }

  uninstallPlugin(spec: string, _scope: 'user' | 'project', options?: { cwd?: string }): Promise<NativeCommandResult> {
    // Copilot has no scope flag — plugins uninstall globally
    return executeCommand('copilot', ['plugin', 'uninstall', spec], options);
  }

  async syncPlugins(
    plugins: string[],
    scope: 'user' | 'project' = 'user',
    options: { cwd?: string; dryRun?: boolean } = {},
  ): Promise<NativeSyncResult> {
    const result: NativeSyncResult = {
      marketplacesAdded: [],
      pluginsInstalled: [],
      pluginsFailed: [],
      skipped: [],
    };

    if (options.dryRun) {
      for (const plugin of plugins) {
        const spec = this.toPluginSpec(plugin);
        if (spec) {
          result.pluginsInstalled.push(spec);
        } else {
          result.skipped.push(plugin);
        }
      }
      return result;
    }

    const marketplaceSources = new Set<string>();
    for (const plugin of plugins) {
      const source = this.extractMarketplaceSource(plugin);
      if (source) marketplaceSources.add(source);
    }

    for (const source of marketplaceSources) {
      const addResult = await this.addMarketplace(source, options);
      if (addResult.success) {
        result.marketplacesAdded.push(source);
      }
    }

    for (const plugin of plugins) {
      const spec = this.toPluginSpec(plugin);
      if (!spec) {
        result.skipped.push(plugin);
        continue;
      }
      const installResult = await this.installPlugin(spec, scope, options);
      if (installResult.success) {
        result.pluginsInstalled.push(spec);
      } else {
        const rawError = installResult.error ?? 'Unknown error';
        const error = rawError.includes('Plugin path escapes marketplace directory')
          ? `${rawError} (Copilot rejected a plugin path from this marketplace manifest. Use file install for copilot to avoid native install for this plugin.)`
          : rawError;
        result.pluginsFailed.push({
          plugin: spec,
          error,
        });
      }
    }

    return result;
  }
}
