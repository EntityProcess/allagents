import { executeCommand, type NativeClient, type NativeCommandResult, type NativeSyncResult } from './types.js';

export class ClaudeNativeClient implements NativeClient {
  async isAvailable(): Promise<boolean> {
    const result = await executeCommand('claude', ['--version']);
    return result.success;
  }

  toPluginSpec(allagentsSource: string): string | null {
    const atIndex = allagentsSource.lastIndexOf('@');
    if (atIndex <= 0 || atIndex === allagentsSource.length - 1) return null;

    const pluginName = allagentsSource.slice(0, atIndex);
    const marketplacePart = allagentsSource.slice(atIndex + 1);

    if (marketplacePart.includes('/') && !marketplacePart.includes('://')) {
      const parts = marketplacePart.split('/');
      const repoName = parts[1];
      if (!repoName) return null;
      return `${pluginName}@${repoName}`;
    }
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
    return executeCommand('claude', ['plugin', 'marketplace', 'add', source], options);
  }

  installPlugin(spec: string, scope: 'user' | 'project', options?: { cwd?: string }): Promise<NativeCommandResult> {
    return executeCommand('claude', ['plugin', 'install', spec, '--scope', scope], options);
  }

  uninstallPlugin(spec: string, scope: 'user' | 'project', options?: { cwd?: string }): Promise<NativeCommandResult> {
    return executeCommand('claude', ['plugin', 'uninstall', spec, '--scope', scope], options);
  }

  async syncPlugins(
    plugins: string[],
    scope: 'user' | 'project' = 'project',
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
        result.pluginsFailed.push({
          plugin: spec,
          error: installResult.error ?? 'Unknown error',
        });
      }
    }

    return result;
  }
}
