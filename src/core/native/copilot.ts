import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  executeCommand,
  compareNativeVersions,
  type NativeClient,
  type NativeCommandOptions,
  type NativeCommandResult,
  type NativeInspectionResult,
  type NativeMutationResult,
  type NativeOperationContext,
  type NativeResource,
  type NativeSourceResolution,
} from './types.js';

type CopilotCommandRunner = (
  binary: string,
  args: string[],
  options?: NativeCommandOptions,
) => Promise<NativeCommandResult>;

export interface CopilotNativeClientOptions {
  execute?: CopilotCommandRunner;
  minimumVersion?: readonly [number, number, number];
}

export interface CopilotMarketplaceRegistrationInspection {
  success: boolean;
  present: boolean;
  source?: string;
  error?: string;
}

const PLUGIN_LINE =
  /^\s*[•*-]\s+([^\s]+@[^\s]+?)(?:\s+\(v[^)]*\))?(?:\s+\[[^\]]+\])?\s*$/;
const MARKETPLACE_LINE =
  /^\s*[•◆*-]\s+([^\s]+)\s+\((?:GitHub|Directory|Git):\s*([^)]+)\)\s*$/;
const MARKETPLACE_PLUGIN_LINE = /^\s*[•*-]\s+([^\s]+)\s+-\s+/;

function commandOptions(context: NativeOperationContext): NativeCommandOptions {
  return {
    ...(context.cwd && { cwd: context.cwd }),
    ...(context.env && { env: context.env }),
  };
}

async function profileRootExists(
  context: NativeOperationContext,
): Promise<boolean> {
  const root = context.roots?.config ?? context.root;
  return access(root).then(
    () => true,
    (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    },
  );
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

function versionTuple(output: string): readonly number[] | null {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?=\D|$)/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function parseCopilotPluginInventory(output: string): string[] | null {
  if (output.includes('No plugins installed.')) return [];
  if (!output.includes('Installed plugins:')) return null;
  return output
    .split(/\r?\n/)
    .flatMap((line) => PLUGIN_LINE.exec(line)?.[1] ?? []);
}

function parseCopilotMarketplaceInventory(
  output: string,
): ReadonlyMap<string, string> | null {
  if (
    !output.includes('Included with GitHub Copilot:') &&
    !output.includes('Registered marketplaces:')
  ) {
    return null;
  }
  const marketplaces = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = MARKETPLACE_LINE.exec(line);
    if (match?.[1] && match[2]) marketplaces.set(match[1], match[2]);
  }
  return marketplaces;
}

function parseCopilotMarketplacePlugins(output: string): string[] | null {
  if (!output.startsWith('Plugins in "')) return null;
  return output
    .split(/\r?\n/)
    .flatMap((line) => MARKETPLACE_PLUGIN_LINE.exec(line)?.[1] ?? []);
}

export function parseCopilotPluginId(
  source: string,
): { plugin: string; marketplace: string } | null {
  const atIndex = source.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === source.length - 1) return null;
  const plugin = source.slice(0, atIndex);
  const marketplace = source.slice(atIndex + 1);
  if (
    plugin.includes('/') ||
    plugin.includes('\\') ||
    marketplace.includes('/') ||
    marketplace.includes('\\') ||
    marketplace.includes('://')
  ) {
    return null;
  }
  return { plugin, marketplace };
}

export class CopilotNativeClient implements NativeClient {
  readonly client = 'copilot';
  private readonly run: CopilotCommandRunner;
  private readonly minimumVersion:
    | readonly [number, number, number]
    | undefined;

  constructor(options: CopilotNativeClientOptions = {}) {
    this.run = options.execute ?? executeCommand;
    this.minimumVersion = options.minimumVersion;
  }

  private async runIsolated(
    args: string[],
    context: NativeOperationContext,
  ): Promise<NativeCommandResult> {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), 'allagents-copilot-inspection-'),
    );
    try {
      return await this.run('copilot', args, {
        ...(context.cwd && { cwd: context.cwd }),
        env: {
          ...context.env,
          COPILOT_HOME: join(temporaryRoot, 'home'),
          COPILOT_CACHE_HOME: join(temporaryRoot, 'cache'),
        },
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  private async runForInspection(
    args: string[],
    context: NativeOperationContext,
  ): Promise<NativeCommandResult> {
    return (await profileRootExists(context))
      ? this.run('copilot', args, commandOptions(context))
      : this.runIsolated(args, context);
  }

  async isAvailable(context?: NativeOperationContext): Promise<boolean> {
    const result = context
      ? await this.runIsolated(['--version'], context)
      : await this.run('copilot', ['--version']);
    if (!result.success) return false;
    if (!this.minimumVersion) return true;
    const version = versionTuple(result.output);
    return Boolean(
      version && compareNativeVersions(version, this.minimumVersion) >= 0,
    );
  }

  supportsScope(scope: 'user' | 'project'): boolean {
    return scope === 'user';
  }

  toPluginSpec(allagentsSource: string): string | null {
    const atIndex = allagentsSource.lastIndexOf('@');
    if (atIndex <= 0 || atIndex === allagentsSource.length - 1) return null;
    const plugin = allagentsSource.slice(0, atIndex);
    const marketplacePart = allagentsSource.slice(atIndex + 1);
    if (
      plugin.includes('/') ||
      plugin.includes('\\') ||
      marketplacePart.includes('://') ||
      marketplacePart.includes('\\')
    ) {
      return null;
    }
    if (!marketplacePart.includes('/')) return allagentsSource;
    const parts = marketplacePart.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return `${plugin}@${basename(marketplacePart)}`;
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
    const parsed = parseCopilotPluginId(spec);
    const marketplaceSource =
      provenance.marketplaceSource ?? this.extractMarketplaceSource(source);
    const marketplaceName = provenance.marketplaceName ?? parsed?.marketplace;
    return {
      success: true,
      resource: {
        kind: 'plugin',
        requestedIdentity: source,
        resolvedIdentity: spec,
        context,
        provenance: {
          ...provenance,
          ...(marketplaceSource && { marketplaceSource }),
          ...(marketplaceName && { marketplaceName }),
        },
      },
    };
  }

  async inspect(
    context: NativeOperationContext,
  ): Promise<NativeInspectionResult> {
    if (!(await profileRootExists(context))) {
      return { success: true, resources: [] };
    }
    const result = await this.runForInspection(['plugin', 'list'], context);
    if (!result.success) {
      return { success: false, resources: [], error: commandError(result) };
    }
    const identities = parseCopilotPluginInventory(result.output);
    if (!identities) {
      return {
        success: false,
        resources: [],
        error: 'Could not parse Copilot plugin inventory',
      };
    }
    return {
      success: true,
      resources: identities.map((identity) => {
        const parsed = parseCopilotPluginId(identity);
        return {
          kind: 'plugin',
          requestedIdentity: identity,
          resolvedIdentity: identity,
          context,
          provenance: {
            ...(parsed && { marketplaceName: parsed.marketplace }),
          },
        };
      }),
    };
  }

  async inspectMarketplaceRegistration(
    marketplaceName: string,
    context: NativeOperationContext,
  ): Promise<CopilotMarketplaceRegistrationInspection> {
    const result = await this.runForInspection(
      ['plugin', 'marketplace', 'list'],
      context,
    );
    if (!result.success) {
      return {
        success: false,
        present: false,
        error: commandError(result),
      };
    }
    const marketplaces = parseCopilotMarketplaceInventory(result.output);
    if (!marketplaces) {
      return {
        success: false,
        present: false,
        error: 'Could not parse Copilot marketplace inventory',
      };
    }
    const source = marketplaces.get(marketplaceName);
    return {
      success: true,
      present: source !== undefined,
      ...(source && { source }),
    };
  }

  async inspectMarketplacePlugin(
    marketplaceName: string,
    pluginName: string,
    context: NativeOperationContext,
  ): Promise<{ success: boolean; present: boolean; error?: string }> {
    const result = await this.runForInspection(
      ['plugin', 'marketplace', 'browse', marketplaceName],
      context,
    );
    if (!result.success) {
      return {
        success: false,
        present: false,
        error: commandError(result),
      };
    }
    const plugins = parseCopilotMarketplacePlugins(result.output);
    if (!plugins) {
      return {
        success: false,
        present: false,
        error: `Could not parse Copilot marketplace '${marketplaceName}'`,
      };
    }
    return { success: true, present: plugins.includes(pluginName) };
  }

  async install(
    resource: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    const registrations: string[] = [];
    const marketplaceSource = resource.provenance.marketplaceSource;
    const marketplaceName = resource.provenance.marketplaceName;
    if (marketplaceSource && marketplaceName) {
      const inspection = await this.inspectMarketplaceRegistration(
        marketplaceName,
        context,
      );
      if (!inspection.success) {
        return {
          success: false,
          error:
            inspection.error ??
            `Could not inspect Copilot marketplace '${marketplaceName}'`,
        };
      }
      if (!inspection.present) {
        const registration = await this.run(
          'copilot',
          ['plugin', 'marketplace', 'add', marketplaceSource],
          commandOptions(context),
        );
        if (!registration.success) {
          return { success: false, error: commandError(registration) };
        }
      }
      if (resource.provenance.managedMarketplaceRegistration === 'true') {
        registrations.push(marketplaceName);
      }
    }
    const result = await this.run(
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
    const result = await this.run(
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
    const result = await this.run(
      'copilot',
      ['plugin', 'uninstall', resource.resolvedIdentity],
      commandOptions(context),
    );
    return result.success
      ? { success: true }
      : { success: false, error: commandError(result) };
  }

  async removeMarketplaceRegistration(
    marketplaceName: string,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    const inspection = await this.inspectMarketplaceRegistration(
      marketplaceName,
      context,
    );
    if (!inspection.success) {
      return {
        success: false,
        error:
          inspection.error ??
          `Could not inspect Copilot marketplace '${marketplaceName}'`,
      };
    }
    if (!inspection.present) return { success: true };
    const result = await this.run(
      'copilot',
      ['plugin', 'marketplace', 'remove', marketplaceName],
      commandOptions(context),
    );
    return result.success
      ? { success: true }
      : { success: false, error: commandError(result) };
  }
}
