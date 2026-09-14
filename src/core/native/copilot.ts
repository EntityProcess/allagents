import {
  executeCommand,
  type NativeClient,
  type NativeCommandOptions,
  type NativeInspectionResult,
  type NativeMutationResult,
  type NativeOperationContext,
  type NativeResource,
  type NativeSourceResolution,
} from './types.js';

function commandOptions(context: NativeOperationContext): NativeCommandOptions {
  return {
    ...(context.cwd && { cwd: context.cwd }),
    ...(context.env && { env: context.env }),
  };
}

function commandError(result: {
  error?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}): string {
  if (result.error) return result.error;
  if (result.signal) return `Copilot CLI terminated by ${result.signal}`;
  return `Copilot CLI exited with code ${result.exitCode ?? 'unknown'}`;
}

function inventoryIdentities(value: unknown): string[] | null {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  const entries = Array.isArray(value)
    ? value
    : (record?.plugins ?? record?.installedPlugins ?? record?.installed_plugins);
  if (!Array.isArray(entries)) return null;
  return entries.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (!entry || typeof entry !== 'object') return [];
    const plugin = entry as Record<string, unknown>;
    for (const key of ['id', 'spec', 'plugin', 'name']) {
      if (typeof plugin[key] === 'string' && plugin[key].length > 0) {
        return [plugin[key]];
      }
    }
    return [];
  });
}

export class CopilotNativeClient implements NativeClient {
  readonly client = 'copilot';

  async isAvailable(context?: NativeOperationContext): Promise<boolean> {
    const result = await executeCommand(
      'copilot',
      ['--version'],
      context ? commandOptions(context) : undefined,
    );
    return result.success;
  }

  supportsScope(scope: 'user' | 'project'): boolean {
    return scope === 'user';
  }

  toPluginSpec(allagentsSource: string): string | null {
    const atIndex = allagentsSource.lastIndexOf('@');
    if (atIndex <= 0 || atIndex === allagentsSource.length - 1) return null;

    const marketplacePart = allagentsSource.slice(atIndex + 1);
    if (marketplacePart.includes('://')) return null;
    if (marketplacePart.includes('/')) {
      const parts = marketplacePart.split('/');
      if (!parts[1]) return null;
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

  resolveSource(
    source: string,
    context: NativeOperationContext,
    provenance: Readonly<Record<string, string>> = {},
  ): NativeSourceResolution {
    const spec = this.toPluginSpec(source);
    if (!spec) {
      return {
        success: false,
        error: `Copilot native install does not support source '${source}'`,
      };
    }
    return {
      success: true,
      resource: {
        kind: 'plugin',
        requestedIdentity: source,
        resolvedIdentity: spec,
        context,
        provenance,
      },
    };
  }

  async inspect(
    context: NativeOperationContext,
  ): Promise<NativeInspectionResult> {
    const result = await executeCommand(
      'copilot',
      ['plugin', 'list', '--json'],
      commandOptions(context),
    );
    if (!result.success) {
      return { success: false, resources: [], error: commandError(result) };
    }

    try {
      const parsed = result.output ? JSON.parse(result.output) : [];
      const identities = inventoryIdentities(parsed);
      if (!identities) throw new Error('expected a plugin array');
      return {
        success: true,
        resources: identities.map((identity) => ({
          kind: 'plugin',
          requestedIdentity: identity,
          resolvedIdentity: identity,
          context,
          provenance: {},
        })),
      };
    } catch (error) {
      return {
        success: false,
        resources: [],
        error: `Could not parse Copilot plugin inventory: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async install(
    resource: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    const registrations: string[] = [];
    const marketplaceSource = resource.provenance.marketplaceSource;
    if (marketplaceSource) {
      const registration = await executeCommand(
        'copilot',
        ['plugin', 'marketplace', 'add', marketplaceSource],
        commandOptions(context),
      );
      if (!registration.success) {
        return { success: false, error: commandError(registration) };
      }
      registrations.push(marketplaceSource);
    }
    const result = await executeCommand(
      'copilot',
      ['plugin', 'install', resource.resolvedIdentity],
      commandOptions(context),
    );
    if (result.success) {
      return {
        success: true,
        ...(registrations.length > 0 && { registrations }),
      };
    }
    const rawError = commandError(result);
    const error = rawError.includes('Plugin path escapes marketplace directory')
      ? `${rawError} (Copilot rejected a plugin path from this marketplace manifest. Use file install for copilot to avoid native install for this plugin.)`
      : rawError;
    return {
      success: false,
      error,
      ...(registrations.length > 0 && { registrations }),
    };
  }

  async update(
    resource: NativeResource,
    _current: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    const result = await executeCommand(
      'copilot',
      ['plugin', 'update', resource.resolvedIdentity],
      commandOptions(context),
    );
    return result.success
      ? { success: true }
      : { success: false, error: commandError(result) };
  }

  async remove(
    resource: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    const result = await executeCommand(
      'copilot',
      ['plugin', 'uninstall', resource.resolvedIdentity],
      commandOptions(context),
    );
    return result.success
      ? { success: true }
      : { success: false, error: commandError(result) };
  }
}
