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
  if (result.signal) return `Claude CLI terminated by ${result.signal}`;
  return `Claude CLI exited with code ${result.exitCode ?? 'unknown'}`;
}

function inventoryEntries(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['plugins', 'installedPlugins', 'installed_plugins']) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return null;
}

function entryIdentity(
  entry: unknown,
  scope: 'user' | 'project',
): string | null {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  if (
    typeof record.scope === 'string' &&
    record.scope !== scope &&
    !(scope === 'project' && record.scope === 'local')
  ) {
    return null;
  }
  for (const key of ['id', 'spec', 'plugin', 'name']) {
    if (typeof record[key] === 'string' && record[key].length > 0) {
      return record[key];
    }
  }
  return null;
}

export class ClaudeNativeClient implements NativeClient {
  readonly client = 'claude';

  async isAvailable(context?: NativeOperationContext): Promise<boolean> {
    const result = await executeCommand(
      'claude',
      ['--version'],
      context ? commandOptions(context) : undefined,
    );
    return result.success;
  }

  supportsScope(_scope: 'user' | 'project'): boolean {
    return true;
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

  resolveSource(
    source: string,
    context: NativeOperationContext,
    provenance: Readonly<Record<string, string>> = {},
  ): NativeSourceResolution {
    const spec = this.toPluginSpec(source);
    if (!spec) {
      return {
        success: false,
        error: `Claude native install does not support source '${source}'`,
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
      'claude',
      ['plugin', 'list', '--json'],
      commandOptions(context),
    );
    if (!result.success) {
      return { success: false, resources: [], error: commandError(result) };
    }

    try {
      const parsed = result.output ? JSON.parse(result.output) : [];
      const entries = inventoryEntries(parsed);
      if (!entries) throw new Error('expected a plugin array');
      return {
        success: true,
        resources: entries.flatMap((entry) => {
          const identity = entryIdentity(entry, context.scope);
          return identity
            ? [{
                kind: 'plugin' as const,
                requestedIdentity: identity,
                resolvedIdentity: identity,
                context,
                provenance: {},
              }]
            : [];
        }),
      };
    } catch (error) {
      return {
        success: false,
        resources: [],
        error: `Could not parse Claude plugin inventory: ${error instanceof Error ? error.message : String(error)}`,
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
        'claude',
        ['plugin', 'marketplace', 'add', marketplaceSource],
        commandOptions(context),
      );
      if (!registration.success) {
        return { success: false, error: commandError(registration) };
      }
      registrations.push(marketplaceSource);
    }
    const result = await executeCommand(
      'claude',
      [
        'plugin',
        'install',
        resource.resolvedIdentity,
        '--scope',
        context.nativeScope,
      ],
      commandOptions(context),
    );
    return result.success
      ? { success: true, ...(registrations.length > 0 && { registrations }) }
      : {
          success: false,
          error: commandError(result),
          ...(registrations.length > 0 && { registrations }),
        };
  }

  async update(
    resource: NativeResource,
    _current: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    const result = await executeCommand(
      'claude',
      [
        'plugin',
        'update',
        resource.resolvedIdentity,
        '--scope',
        context.nativeScope,
      ],
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
      'claude',
      [
        'plugin',
        'uninstall',
        resource.resolvedIdentity,
        '--scope',
        context.nativeScope,
      ],
      commandOptions(context),
    );
    return result.success
      ? { success: true }
      : { success: false, error: commandError(result) };
  }
}
