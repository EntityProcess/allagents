import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeCommand,
  type NativeClient,
  type NativeCommandOptions,
  type NativeCommandResult,
  type NativeInspectionResult,
  type NativeMutationResult,
  type NativeOperationContext,
  type NativeResource,
  type NativeResourceObservation,
  type NativeSourceResolution,
} from './types.js';

type CodexCommandRunner = (
  binary: string,
  args: string[],
  options?: NativeCommandOptions,
) => Promise<NativeCommandResult>;

export interface CodexNativeClientOptions {
  execute?: CodexCommandRunner;
  minimumVersion?: readonly [number, number, number];
}

export interface CodexMarketplaceRegistrationInspection {
  success: boolean;
  present: boolean;
  root?: string;
  source?: string;
  sourceType?: string;
  error?: string;
}

interface CodexPluginInventoryEntry {
  readonly pluginId: string;
  readonly name: string;
  readonly marketplaceName: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly marketplaceSource?: {
    readonly sourceType: string;
    readonly source: string;
  };
}

interface CodexMarketplaceEntry {
  readonly name: string;
  readonly root: string;
  readonly marketplaceSource?: {
    readonly sourceType: string;
    readonly source: string;
  };
}

function commandOptions(context: NativeOperationContext): NativeCommandOptions {
  return {
    ...(context.cwd && { cwd: context.cwd }),
    ...(context.env && { env: context.env }),
  };
}

async function profileRootExists(
  context: NativeOperationContext,
): Promise<boolean> {
  return access(context.root).then(
    () => true,
    (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    },
  );
}

function commandError(result: NativeCommandResult): string {
  if (result.error) return result.error;
  if (result.signal) return `Codex CLI terminated by ${result.signal}`;
  return `Codex CLI exited with code ${result.exitCode ?? 'unknown'}`;
}

function versionTuple(output: string): readonly number[] | null {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?=\D|$)/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersion(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseJsonRecord(output: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(output);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseMarketplaceSource(
  value: unknown,
): CodexMarketplaceEntry['marketplaceSource'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  return typeof source.sourceType === 'string' &&
    typeof source.source === 'string'
    ? { sourceType: source.sourceType, source: source.source }
    : undefined;
}

function parseMarketplaceEntry(value: unknown): CodexMarketplaceEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.name !== 'string' || typeof entry.root !== 'string') {
    return null;
  }
  const marketplaceSource = parseMarketplaceSource(entry.marketplaceSource);
  return {
    name: entry.name,
    root: entry.root,
    ...(marketplaceSource && { marketplaceSource }),
  };
}

export function parseCodexMarketplaceInventory(
  output: string,
): readonly CodexMarketplaceEntry[] | null {
  const parsed = parseJsonRecord(output);
  if (!parsed || !Array.isArray(parsed.marketplaces)) return null;
  const entries = parsed.marketplaces.map(parseMarketplaceEntry);
  return entries.every(
    (entry): entry is CodexMarketplaceEntry => entry !== null,
  )
    ? entries
    : null;
}

function parsePluginEntry(value: unknown): CodexPluginInventoryEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.pluginId !== 'string' ||
    typeof entry.name !== 'string' ||
    typeof entry.marketplaceName !== 'string' ||
    typeof entry.installed !== 'boolean' ||
    typeof entry.enabled !== 'boolean'
  ) {
    return null;
  }
  const marketplaceSource = parseMarketplaceSource(entry.marketplaceSource);
  return {
    pluginId: entry.pluginId,
    name: entry.name,
    marketplaceName: entry.marketplaceName,
    installed: entry.installed,
    enabled: entry.enabled,
    ...(marketplaceSource && { marketplaceSource }),
  };
}

export function parseCodexPluginInventory(output: string): {
  readonly installed: readonly CodexPluginInventoryEntry[];
  readonly available: readonly CodexPluginInventoryEntry[];
} | null {
  const parsed = parseJsonRecord(output);
  if (
    !parsed ||
    !Array.isArray(parsed.installed) ||
    !Array.isArray(parsed.available)
  ) {
    return null;
  }
  const installed = parsed.installed.map(parsePluginEntry);
  const available = parsed.available.map(parsePluginEntry);
  return installed.every(
    (entry): entry is CodexPluginInventoryEntry => entry !== null,
  ) &&
    available.every(
      (entry): entry is CodexPluginInventoryEntry => entry !== null,
    )
    ? { installed, available }
    : null;
}

export function parseCodexPluginId(
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

function parseMutationIdentity(
  output: string,
  expectedIdentity: string,
): boolean {
  const parsed = parseJsonRecord(output);
  return parsed?.pluginId === expectedIdentity;
}

function parseMarketplaceAdd(
  output: string,
  expectedMarketplace: string,
): { alreadyAdded: boolean } | null {
  const parsed = parseJsonRecord(output);
  return parsed?.marketplaceName === expectedMarketplace &&
    typeof parsed.alreadyAdded === 'boolean'
    ? { alreadyAdded: parsed.alreadyAdded }
    : null;
}

function parseMarketplaceUpgrade(
  output: string,
  expectedMarketplace: string,
): boolean {
  const parsed = parseJsonRecord(output);
  return Boolean(
    parsed &&
      Array.isArray(parsed.selectedMarketplaces) &&
      parsed.selectedMarketplaces.includes(expectedMarketplace) &&
      Array.isArray(parsed.upgradedRoots) &&
      Array.isArray(parsed.errors) &&
      parsed.errors.length === 0,
  );
}

export class CodexNativeClient implements NativeClient {
  readonly client = 'codex';
  private readonly run: CodexCommandRunner;
  private readonly minimumVersion:
    | readonly [number, number, number]
    | undefined;

  constructor(options: CodexNativeClientOptions = {}) {
    this.run = options.execute ?? executeCommand;
    this.minimumVersion = options.minimumVersion;
  }

  private async runIsolated(
    args: string[],
    context?: NativeOperationContext,
  ): Promise<NativeCommandResult> {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), 'allagents-codex-inspection-'),
    );
    try {
      return await this.run('codex', args, {
        ...(context?.cwd && { cwd: context.cwd }),
        env: {
          ...context?.env,
          CODEX_HOME: temporaryRoot,
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
      ? this.run('codex', args, commandOptions(context))
      : this.runIsolated(args, context);
  }

  async isAvailable(context?: NativeOperationContext): Promise<boolean> {
    const version = await this.runIsolated(['--version'], context);
    if (!version.success) return false;
    const parsedVersion = versionTuple(version.output);
    if (
      this.minimumVersion &&
      (!parsedVersion || compareVersion(parsedVersion, this.minimumVersion) < 0)
    ) {
      return false;
    }
    const pluginHelp = await this.runIsolated(['plugin', '--help'], context);
    return (
      pluginHelp.success &&
      ['add', 'list', 'marketplace', 'remove'].every((command) =>
        pluginHelp.output.includes(command),
      )
    );
  }

  supportsScope(scope: 'user' | 'project'): boolean {
    return scope === 'user';
  }

  resolveSource(
    source: string,
    context: NativeOperationContext,
    provenance: Readonly<Record<string, string>> = {},
  ): NativeSourceResolution {
    const identity = parseCodexPluginId(source);
    if (!identity) {
      return {
        success: false,
        error: `Codex native install does not support source '${source}'`,
      };
    }
    return {
      success: true,
      resource: {
        kind: 'plugin',
        requestedIdentity: source,
        resolvedIdentity: `${identity.plugin}@${identity.marketplace}`,
        context,
        provenance: {
          ...provenance,
          marketplaceName: provenance.marketplaceName ?? identity.marketplace,
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
    const result = await this.runForInspection(
      ['plugin', 'list', '--json'],
      context,
    );
    if (!result.success) {
      return { success: false, resources: [], error: commandError(result) };
    }
    const inventory = parseCodexPluginInventory(result.output);
    if (!inventory) {
      return {
        success: false,
        resources: [],
        error: 'Could not parse Codex plugin inventory',
      };
    }
    const resources: NativeResource[] = [];
    const observations: NativeResourceObservation[] = [];
    for (const entry of inventory.installed) {
      const resource: NativeResource = {
        kind: 'plugin',
        requestedIdentity: entry.pluginId,
        resolvedIdentity: entry.pluginId,
        context,
        provenance: {
          marketplaceName: entry.marketplaceName,
          ...(entry.marketplaceSource?.source && {
            marketplaceSource: entry.marketplaceSource.source,
          }),
        },
      };
      if (entry.installed && entry.enabled) resources.push(resource);
      else {
        observations.push({
          resource,
          status: entry.installed ? 'disabled' : 'configured-missing',
        });
      }
    }
    return {
      success: true,
      resources,
      ...(observations.length > 0 && { observations }),
    };
  }

  async inspectMarketplaceRegistration(
    marketplaceName: string,
    context: NativeOperationContext,
  ): Promise<CodexMarketplaceRegistrationInspection> {
    const result = await this.runForInspection(
      ['plugin', 'marketplace', 'list', '--json'],
      context,
    );
    if (!result.success) {
      return {
        success: false,
        present: false,
        error: commandError(result),
      };
    }
    const inventory = parseCodexMarketplaceInventory(result.output);
    if (!inventory) {
      return {
        success: false,
        present: false,
        error: 'Could not parse Codex marketplace inventory',
      };
    }
    const marketplace = inventory.find(
      (entry) => entry.name === marketplaceName,
    );
    return {
      success: true,
      present: Boolean(marketplace),
      ...(marketplace?.root && { root: marketplace.root }),
      ...(marketplace?.marketplaceSource?.source && {
        source: marketplace.marketplaceSource.source,
      }),
      ...(marketplace?.marketplaceSource?.sourceType && {
        sourceType: marketplace.marketplaceSource.sourceType,
      }),
    };
  }

  async inspectMarketplacePlugin(
    marketplaceName: string,
    pluginName: string,
    context: NativeOperationContext,
  ): Promise<{ success: boolean; present: boolean; error?: string }> {
    const result = await this.runForInspection(
      [
        'plugin',
        'list',
        '--marketplace',
        marketplaceName,
        '--available',
        '--json',
      ],
      context,
    );
    if (!result.success) {
      return {
        success: false,
        present: false,
        error: commandError(result),
      };
    }
    const inventory = parseCodexPluginInventory(result.output);
    if (!inventory) {
      return {
        success: false,
        present: false,
        error: `Could not parse Codex marketplace '${marketplaceName}'`,
      };
    }
    const expected = `${pluginName}@${marketplaceName}`;
    return {
      success: true,
      present: [...inventory.installed, ...inventory.available].some(
        (entry) => entry.pluginId === expected,
      ),
    };
  }

  async install(
    resource: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    const marketplaceName = resource.provenance.marketplaceName;
    if (!marketplaceName) {
      return { success: false, error: 'Codex plugin marketplace is missing' };
    }
    const registrations: string[] = [];
    const inspection = await this.inspectMarketplaceRegistration(
      marketplaceName,
      context,
    );
    if (!inspection.success) {
      return {
        success: false,
        error:
          inspection.error ??
          `Could not inspect Codex marketplace '${marketplaceName}'`,
      };
    }
    if (!inspection.present) {
      const marketplaceSource = resource.provenance.marketplaceSource;
      if (!marketplaceSource) {
        return {
          success: false,
          error: `Codex marketplace '${marketplaceName}' is not registered and has no source`,
        };
      }
      const args = ['plugin', 'marketplace', 'add', marketplaceSource];
      const resolvedRef = resource.provenance.resolvedRef;
      if (resolvedRef) args.push('--ref', resolvedRef);
      const sparsePath = resource.provenance.marketplaceSparsePath;
      if (sparsePath) args.push('--sparse', sparsePath);
      args.push('--json');
      const registration = await this.run(
        'codex',
        args,
        commandOptions(context),
      );
      if (!registration.success) {
        return { success: false, error: commandError(registration) };
      }
      const added = parseMarketplaceAdd(registration.output, marketplaceName);
      if (!added) {
        return {
          success: false,
          error: `Could not parse Codex marketplace '${marketplaceName}' registration result`,
        };
      }
      if (
        !added.alreadyAdded &&
        resource.provenance.managedMarketplaceRegistration === 'true'
      ) {
        registrations.push(marketplaceName);
      }
    }
    const result = await this.run(
      'codex',
      ['plugin', 'add', resource.resolvedIdentity, '--json'],
      commandOptions(context),
    );
    if (!result.success) {
      return {
        success: false,
        error: commandError(result),
        ...(registrations.length > 0 && { registrations }),
      };
    }
    if (!parseMutationIdentity(result.output, resource.resolvedIdentity)) {
      return {
        success: false,
        error: `Could not parse Codex plugin '${resource.resolvedIdentity}' install result`,
        ...(registrations.length > 0 && { registrations }),
      };
    }
    return {
      success: true,
      ...(registrations.length > 0 && { registrations }),
    };
  }

  async update(
    resource: NativeResource,
    _current: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    const marketplaceName = resource.provenance.marketplaceName;
    if (!marketplaceName) {
      return { success: false, error: 'Codex plugin marketplace is missing' };
    }
    const inspection = await this.inspectMarketplaceRegistration(
      marketplaceName,
      context,
    );
    if (!inspection.success || !inspection.present) {
      return {
        success: false,
        error:
          inspection.error ??
          `Codex marketplace '${marketplaceName}' is not registered`,
      };
    }
    if (inspection.sourceType === 'git') {
      const upgrade = await this.run(
        'codex',
        ['plugin', 'marketplace', 'upgrade', marketplaceName, '--json'],
        commandOptions(context),
      );
      if (!upgrade.success) {
        return { success: false, error: commandError(upgrade) };
      }
      if (!parseMarketplaceUpgrade(upgrade.output, marketplaceName)) {
        return {
          success: false,
          error: `Could not parse Codex marketplace '${marketplaceName}' upgrade result`,
        };
      }
    }
    const result = await this.run(
      'codex',
      ['plugin', 'add', resource.resolvedIdentity, '--json'],
      commandOptions(context),
    );
    return result.success &&
      parseMutationIdentity(result.output, resource.resolvedIdentity)
      ? { success: true }
      : {
          success: false,
          error: result.success
            ? `Could not parse Codex plugin '${resource.resolvedIdentity}' update result`
            : commandError(result),
        };
  }

  async remove(
    resource: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    const result = await this.run(
      'codex',
      ['plugin', 'remove', resource.resolvedIdentity, '--json'],
      commandOptions(context),
    );
    return result.success &&
      parseMutationIdentity(result.output, resource.resolvedIdentity)
      ? { success: true }
      : {
          success: false,
          error: result.success
            ? `Could not parse Codex plugin '${resource.resolvedIdentity}' removal result`
            : commandError(result),
        };
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
          `Could not inspect Codex marketplace '${marketplaceName}'`,
      };
    }
    if (!inspection.present) return { success: true };

    const plugins = await this.runForInspection(
      ['plugin', 'list', '--marketplace', marketplaceName, '--json'],
      context,
    );
    if (!plugins.success) {
      return { success: false, error: commandError(plugins) };
    }
    const inventory = parseCodexPluginInventory(plugins.output);
    if (!inventory) {
      return {
        success: false,
        error: `Could not parse Codex marketplace '${marketplaceName}' plugin inventory`,
      };
    }
    if (inventory.installed.length > 0) {
      return {
        success: false,
        error: `Codex marketplace '${marketplaceName}' is still used by installed plugins`,
      };
    }

    const result = await this.run(
      'codex',
      ['plugin', 'marketplace', 'remove', marketplaceName, '--json'],
      commandOptions(context),
    );
    if (!result.success) {
      return { success: false, error: commandError(result) };
    }
    const parsed = parseJsonRecord(result.output);
    return parsed?.marketplaceName === marketplaceName
      ? { success: true }
      : {
          success: false,
          error: `Could not parse Codex marketplace '${marketplaceName}' removal result`,
        };
  }
}
