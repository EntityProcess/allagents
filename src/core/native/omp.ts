import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import { z } from 'zod';
import {
  compareNativeVersions,
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

const OMP_MINIMUM_VERSION = [18, 1, 17] as const;
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const GITHUB_SHORTHAND_PATTERN = /^([^/\s]+)\/([^/\s]+)$/;
const CONTROL_CHARACTER_PATTERN = /[\0\r\n]/;
const SENSITIVE_QUERY_KEY =
  /(?:^|[-_.])(auth|credential|key|password|secret|signature|token)(?:$|[-_.])/i;

type OmpCommandRunner = (
  binary: string,
  args: string[],
  options?: NativeCommandOptions,
) => Promise<NativeCommandResult>;

type OmpFileReader = (path: string) => Promise<string>;

export interface OmpProfileNativeScope {
  readonly kind: 'profile';
  readonly name: string;
}

export interface OmpNativeClientOptions {
  execute?: OmpCommandRunner;
  readFile?: OmpFileReader;
  nativeScope?: OmpProfileNativeScope;
}

export interface OmpMarketplaceCatalogPlugin {
  name: string;
  source: unknown;
  version?: string;
}

export interface OmpMarketplaceCatalog {
  name: string;
  plugins: OmpMarketplaceCatalogPlugin[];
}

export interface OmpMarketplaceRegistryEntry {
  name: string;
  sourceType: 'github' | 'git' | 'url' | 'local';
  sourceUri: string;
  sourceIdentity: string;
  catalogPath: string;
  catalog: OmpMarketplaceCatalog;
}

export interface OmpMarketplaceInspection {
  success: boolean;
  registryPath: string;
  marketplaces: OmpMarketplaceRegistryEntry[];
  missing: boolean;
  error?: string;
}

export interface OmpMarketplaceRegistrationRequest {
  readonly name: string;
  readonly source: string;
}

interface ParsedPluginId {
  id: string;
  name: string;
  marketplace: string;
}

interface OmpInventoryEntry {
  id: string;
  scope: 'user' | 'project';
  installPath: string;
  version: string;
  enabled: boolean;
  shadowedByProject: boolean;
}

const MarketplacePluginSourceSchema = z.union([
  z
    .string()
    .refine(
      (value) =>
        value.startsWith('./') && !CONTROL_CHARACTER_PATTERN.test(value),
    ),
  z
    .object({
      source: z.literal('github'),
      repo: z
        .string()
        .min(1)
        .refine((value) => githubRepository(value) !== null),
      ref: z.string().min(1).optional(),
      sha: z.string().min(1).optional(),
    })
    .passthrough(),
  z
    .object({
      source: z.literal('url'),
      url: z.string().url().refine(supportedRemoteUrl),
      ref: z.string().min(1).optional(),
      sha: z.string().min(1).optional(),
    })
    .passthrough(),
  z
    .object({
      source: z.literal('git-subdir'),
      url: z.string().min(1).refine(supportedRemoteUrl),
      path: z
        .string()
        .min(1)
        .refine(
          (value) =>
            !absolutePath(value) &&
            !value.split(/[\\/]/).includes('..') &&
            !CONTROL_CHARACTER_PATTERN.test(value),
        ),
      ref: z.string().min(1).optional(),
      sha: z.string().min(1).optional(),
    })
    .passthrough(),
  z
    .object({
      source: z.literal('npm'),
      package: z.string().min(1),
      version: z.string().min(1).optional(),
      registry: z.string().min(1).optional(),
    })
    .passthrough(),
]);

const MarketplaceCatalogSchema = z
  .object({
    name: z.string(),
    owner: z.object({ name: z.string().min(1) }).passthrough(),
    plugins: z.array(
      z
        .object({
          name: z.string(),
          source: MarketplacePluginSourceSchema,
          version: z.string().min(1).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const MarketplaceRegistrySchema = z
  .object({
    version: z.literal(1),
    marketplaces: z.array(
      z
        .object({
          name: z.string(),
          sourceType: z.enum(['github', 'git', 'url', 'local']),
          sourceUri: z.string().min(1),
          catalogPath: z.string().refine(absolutePath),
          addedAt: z.string().refine(validTimestamp),
          updatedAt: z.string().refine(validTimestamp),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const PluginInventorySchema = z
  .object({
    npm: z.array(z.object({}).passthrough()),
    marketplace: z.array(
      z
        .object({
          id: z.string(),
          scope: z.enum(['user', 'project']),
          entries: z.array(
            z
              .object({
                scope: z.enum(['user', 'project']),
                installPath: z.string().refine(absolutePath),
                version: z.string().min(1),
                installedAt: z.string().refine(validTimestamp),
                lastUpdated: z.string().refine(validTimestamp),
                enabled: z.boolean().optional(),
                gitCommitSha: z.string().optional(),
              })
              .passthrough(),
          ),
          shadowedBy: z.literal('project').optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

function isName(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 64 && NAME_PATTERN.test(value)
  );
}

export type OmpNativeScope = 'user' | 'project' | `profile:${string}`;

export function ompProfileNativeScope(
  profileName: string,
): `profile:${string}` {
  if (
    !isName(profileName) ||
    profileName === 'default' ||
    profileName === '.' ||
    profileName === '..' ||
    profileName.endsWith('.')
  ) {
    throw new Error(`Invalid OMP profile name '${profileName}'`);
  }
  return `profile:${profileName}`;
}

function profileNameFromNativeScope(
  nativeScope: string | undefined,
): string | undefined {
  if (!nativeScope?.startsWith('profile:')) return undefined;
  const profileName = nativeScope.slice('profile:'.length);
  return ompProfileNativeScope(profileName).slice('profile:'.length);
}

function absolutePath(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path);
}

function contextCwd(context: NativeOperationContext): string {
  return resolve(context.cwd ?? process.cwd());
}

function commandOptions(
  context?: NativeOperationContext,
): NativeCommandOptions {
  return {
    ...(context?.cwd && { cwd: contextCwd(context) }),
    env: {
      ...context?.env,
      // Ordinary AllAgents operations always address OMP's unnamed profile.
      // Undefined is significant to executeCommand: it removes inherited values.
      OMP_PROFILE: undefined,
      PI_PROFILE: undefined,
      PI_CONFIG_FILES: undefined,
    },
  };
}

function commandError(result: NativeCommandResult): string {
  if (result.error) return result.error;
  if (result.signal) return `OMP CLI terminated by ${result.signal}`;
  return `OMP CLI exited with code ${result.exitCode ?? 'unknown'}`;
}

function parseVersion(output: string): [number, number, number] | null {
  const match = /^(?:omp\/)?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(
    output.trim(),
  );
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const version: [number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  return version.every(Number.isSafeInteger) ? version : null;
}

export function parseOmpPluginId(value: string): ParsedPluginId | null {
  const separator = value.lastIndexOf('@');
  if (separator <= 0 || separator === value.length - 1) return null;
  const name = value.slice(0, separator);
  const marketplace = value.slice(separator + 1);
  if (!isName(name) || !isName(marketplace)) return null;
  const id = `${name}@${marketplace}`;
  return id.length <= 128 ? { id, name, marketplace } : null;
}

function parseAllAgentsMarketplaceSpec(value: string): ParsedPluginId | null {
  const separator = value.lastIndexOf('@');
  if (separator <= 0 || separator === value.length - 1) return null;
  const name = value.slice(0, separator);
  const marketplaceSource = value.slice(separator + 1);
  if (!isName(name) || CONTROL_CHARACTER_PATTERN.test(marketplaceSource)) {
    return null;
  }
  const parts = marketplaceSource.split('/');
  const marketplace = parts[1];
  if (
    parts.length < 2 ||
    !parts[0] ||
    !marketplace ||
    marketplace === '.' ||
    marketplace === '..'
  ) {
    return null;
  }
  const normalizedMarketplace = marketplace
    .replace(/\.git$/i, '')
    .toLowerCase();
  if (!isName(normalizedMarketplace)) return null;
  const id = `${name}@${normalizedMarketplace}`;
  return id.length <= 128
    ? { id, name, marketplace: normalizedMarketplace }
    : null;
}

function expandHome(value: string, context: NativeOperationContext): string {
  if (value !== '~' && !value.startsWith('~/') && !value.startsWith('~\\')) {
    return value;
  }
  const home = context.env?.HOME ?? context.env?.USERPROFILE;
  return home ? join(home, value.slice(2)) : value;
}

function normalizedRemoteUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'http:' &&
      url.protocol !== 'https:' &&
      url.protocol !== 'ssh:'
    ) {
      return null;
    }
    if (url.username || url.password) return null;
    for (const [key, queryValue] of url.searchParams) {
      if (queryValue && SENSITIVE_QUERY_KEY.test(key)) return null;
    }
    url.hostname = url.hostname.toLowerCase();
    url.searchParams.sort();
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function githubRepository(source: string): string | null {
  const trimmed = source.trim();
  const shorthand = GITHUB_SHORTHAND_PATTERN.exec(trimmed);
  if (shorthand?.[1] && shorthand[2]) {
    return `${shorthand[1]}/${shorthand[2].replace(/\.git$/i, '')}`.toLowerCase();
  }
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/i.exec(trimmed);
  if (ssh?.[1] && ssh[2]) {
    return `${ssh[1]}/${ssh[2].replace(/\.git$/i, '')}`.toLowerCase();
  }
  const normalized = normalizedRemoteUrl(trimmed);
  if (!normalized) return null;
  const url = new URL(normalized);
  if (url.hostname !== 'github.com' || url.search) return null;
  const segments = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (!segments[0] || !segments[1] || segments.length !== 2) return null;
  return `${segments[0]}/${segments[1].replace(/\.git$/i, '')}`.toLowerCase();
}

function supportedRemoteUrl(value: string): boolean {
  return normalizedRemoteUrl(value) !== null;
}

function normalizeMarketplaceSource(
  source: string,
  sourceType: OmpMarketplaceRegistryEntry['sourceType'] | undefined,
  context: NativeOperationContext,
): { identity: string; source: string } | null {
  const trimmed = source.trim();
  if (!trimmed || CONTROL_CHARACTER_PATTERN.test(trimmed)) return null;

  const github = githubRepository(trimmed);
  if (github) return { identity: `github:${github}`, source: github };

  const looksLocal =
    sourceType === 'local' ||
    trimmed === '~' ||
    trimmed.startsWith('~/') ||
    trimmed.startsWith('~\\') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    absolutePath(trimmed);
  if (looksLocal) {
    const expanded = expandHome(trimmed, context);
    if (expanded.startsWith('~')) return null;
    const local = resolve(contextCwd(context), expanded);
    return { identity: `local:${local}`, source: local };
  }

  const remote = normalizedRemoteUrl(trimmed);
  if (remote) return { identity: `remote:${remote}`, source: remote };
  if (/^(?:git@|[^\s]+:[^\s]+$)/.test(trimmed)) {
    return { identity: `git:${trimmed}`, source: trimmed };
  }
  return sourceType === 'github'
    ? null
    : { identity: `remote:${trimmed}`, source: trimmed };
}

function marketplaceSourceIdentity(
  source: string,
  sourceType: OmpMarketplaceRegistryEntry['sourceType'] | undefined,
  context: NativeOperationContext,
): string | null {
  return (
    normalizeMarketplaceSource(source, sourceType, context)?.identity ?? null
  );
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !Number.isNaN(Date.parse(value))
  );
}

function parseCatalog(
  value: unknown,
  path: string,
): { catalog?: OmpMarketplaceCatalog; error?: string } {
  const parsed = MarketplaceCatalogSchema.safeParse(value);
  if (!parsed.success || !isName(parsed.data.name)) {
    return { error: `OMP marketplace catalog is malformed: ${path}` };
  }

  const names = new Set<string>();
  const plugins: OmpMarketplaceCatalogPlugin[] = [];
  for (const raw of parsed.data.plugins) {
    if (!isName(raw.name)) {
      return {
        error: `OMP marketplace catalog contains an invalid plugin name: ${path}`,
      };
    }
    if (names.has(raw.name)) {
      return {
        error: `OMP marketplace catalog contains duplicate plugin '${raw.name}': ${path}`,
      };
    }
    names.add(raw.name);
    plugins.push({
      name: raw.name,
      source: raw.source,
      ...(raw.version && { version: raw.version }),
    });
  }
  return { catalog: { name: parsed.data.name, plugins } };
}

/**
 * Resolve a native plugin from a catalog that has already been fetched.
 *
 * An exact plugin id may select one entry from a larger catalog. A marketplace
 * source has no plugin selector, so it is accepted only when the catalog has a
 * single valid plugin. Keeping this pure lets profile planning reject
 * ambiguity before registration or installation.
 */
export function resolveOmpMarketplacePluginSource(
  source: string,
  catalogValue: unknown,
  context: NativeOperationContext,
  provenance: Readonly<Record<string, string>> = {},
): NativeSourceResolution {
  const parsedCatalog = parseCatalog(catalogValue, '<fetched marketplace>');
  const catalog = parsedCatalog.catalog;
  if (!catalog) {
    return {
      success: false,
      error:
        parsedCatalog.error ?? 'Fetched OMP marketplace catalog is malformed',
    };
  }

  const exact = parseOmpPluginId(source);
  let plugin: OmpMarketplaceCatalogPlugin | undefined;
  let marketplaceSource: string | undefined;
  if (exact) {
    if (exact.marketplace !== catalog.name) {
      return {
        success: false,
        error: `OMP plugin marketplace '${exact.marketplace}' does not match fetched catalog '${catalog.name}'`,
      };
    }
    plugin = catalog.plugins.find((candidate) => candidate.name === exact.name);
    if (!plugin) {
      return {
        success: false,
        error: `OMP catalog '${catalog.name}' has no plugin '${exact.name}'`,
      };
    }
  } else {
    const trimmed = source.trim();
    const isLocal =
      trimmed === '~' ||
      trimmed.startsWith('~/') ||
      trimmed.startsWith('~\\') ||
      trimmed.startsWith('./') ||
      trimmed.startsWith('../') ||
      absolutePath(trimmed);
    const sourceType = githubRepository(trimmed)
      ? 'github'
      : isLocal
        ? 'local'
        : undefined;
    const normalized = sourceType
      ? normalizeMarketplaceSource(trimmed, sourceType, context)
      : null;
    if (!normalized) {
      return {
        success: false,
        error: `OMP marketplace source must be an exact plugin id, GitHub repository, or local path: '${source}'`,
      };
    }
    if (catalog.plugins.length !== 1) {
      return {
        success: false,
        error: `OMP marketplace source '${source}' must resolve exactly one plugin, but catalog '${catalog.name}' contains ${catalog.plugins.length}`,
      };
    }
    plugin = catalog.plugins[0];
    marketplaceSource = normalized.source;
  }

  if (!plugin) {
    return {
      success: false,
      error: `OMP catalog '${catalog.name}' did not resolve a plugin`,
    };
  }
  const resolvedIdentity = `${plugin.name}@${catalog.name}`;
  return {
    success: true,
    resource: {
      kind: 'plugin',
      requestedIdentity: source,
      resolvedIdentity,
      context,
      provenance: {
        ...provenance,
        pluginName: plugin.name,
        marketplaceName: catalog.name,
        ...(marketplaceSource && { marketplaceSource }),
        ...(plugin.version && { catalogVersion: plugin.version }),
      },
    },
  };
}

async function readJson(
  path: string,
  reader: OmpFileReader,
): Promise<{ value?: unknown; missing: boolean; error?: string }> {
  try {
    const contents = await reader(path);
    if (!contents.trim())
      return { missing: false, error: `OMP JSON file is empty: ${path}` };
    return {
      value: JSON.parse(contents.replace(/^\uFEFF/, '')),
      missing: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { missing: true };
    return {
      missing: false,
      error: `Could not read OMP JSON file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
async function readOptionalText(
  path: string,
  reader: OmpFileReader,
): Promise<{ contents?: string; error?: string }> {
  try {
    return { contents: await reader(path) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return {
      error: `Could not read OMP marketplace checkout ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function marketplaceCheckoutRevision(
  marketplace: OmpMarketplaceRegistryEntry,
  reader: OmpFileReader,
): Promise<{ sha?: string; error?: string }> {
  if (marketplace.sourceType === 'url') {
    return {
      error: `OMP marketplace '${marketplace.name}' is not backed by a verifiable Git checkout`,
    };
  }
  const checkoutRoot =
    marketplace.sourceType === 'local'
      ? marketplace.sourceUri
      : resolve(marketplace.catalogPath, '..');
  if (!absolutePath(checkoutRoot)) {
    return {
      error: `OMP marketplace '${marketplace.name}' checkout path is not absolute`,
    };
  }
  const gitDirectory = join(checkoutRoot, '.git');
  const head = await readOptionalText(join(gitDirectory, 'HEAD'), reader);
  if (head.error) return { error: head.error };
  const headValue = head.contents?.trim();
  if (!headValue) {
    return {
      error: `OMP marketplace '${marketplace.name}' checkout has no readable HEAD`,
    };
  }
  if (/^[0-9a-f]{40,64}$/i.test(headValue)) {
    return { sha: headValue.toLowerCase() };
  }
  const reference = /^ref: (refs\/[A-Za-z0-9._/-]+)$/.exec(headValue)?.[1];
  if (
    !reference ||
    reference.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    return {
      error: `OMP marketplace '${marketplace.name}' checkout has an invalid HEAD`,
    };
  }
  const loose = await readOptionalText(
    join(gitDirectory, ...reference.split('/')),
    reader,
  );
  if (loose.error) return { error: loose.error };
  const looseSha = loose.contents?.trim();
  if (looseSha && /^[0-9a-f]{40,64}$/i.test(looseSha)) {
    return { sha: looseSha.toLowerCase() };
  }
  const packed = await readOptionalText(
    join(gitDirectory, 'packed-refs'),
    reader,
  );
  if (packed.error) return { error: packed.error };
  const packedSha = packed.contents
    ?.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/, 2))
    .find(([, name]) => name === reference)?.[0];
  return packedSha && /^[0-9a-f]{40,64}$/i.test(packedSha)
    ? { sha: packedSha.toLowerCase() }
    : {
        error: `OMP marketplace '${marketplace.name}' checkout does not resolve HEAD`,
      };
}

async function verifyMarketplaceRevision(
  resource: NativeResource,
  marketplace: OmpMarketplaceRegistryEntry,
  reader: OmpFileReader,
): Promise<string | null> {
  const requestedRef = resource.provenance.requestedRef;
  const resolvedRef = resource.provenance.resolvedRef;
  const expectedSha = resource.provenance.resolvedSha;
  if (requestedRef && requestedRef !== resolvedRef) {
    return `OMP marketplace requested ref '${requestedRef}' resolved as '${resolvedRef ?? 'unknown'}'`;
  }
  if (resolvedRef && resolvedRef !== 'main') {
    return `OMP CLI cannot enforce marketplace ref '${resolvedRef}'`;
  }
  if (!expectedSha) {
    return requestedRef || resolvedRef
      ? `OMP marketplace ref '${requestedRef ?? resolvedRef}' has no authoritative resolved revision`
      : null;
  }
  if (!/^[0-9a-f]{40,64}$/i.test(expectedSha)) {
    return 'OMP marketplace resolved revision is malformed';
  }
  const actual = await marketplaceCheckoutRevision(marketplace, reader);
  if (!actual.sha) {
    return (
      actual.error ??
      `Could not verify OMP marketplace '${marketplace.name}' revision`
    );
  }
  return actual.sha === expectedSha.toLowerCase()
    ? null
    : `OMP marketplace '${marketplace.name}' resolved revision does not match requested '${requestedRef ?? resolvedRef ?? expectedSha}'`;
}

function marketplaceRegistryPath(
  context: NativeOperationContext,
): string | null {
  const dataRoot = context.roots?.data;
  return dataRoot && absolutePath(dataRoot)
    ? join(dataRoot, 'marketplaces.json')
    : null;
}

export async function inspectOmpMarketplaceRegistry(
  context: NativeOperationContext,
  options: { readFile?: OmpFileReader; allowMissing?: boolean } = {},
): Promise<OmpMarketplaceInspection> {
  const registryPath = marketplaceRegistryPath(context);
  if (!registryPath) {
    return {
      success: false,
      registryPath: '',
      marketplaces: [],
      missing: false,
      error: 'OMP operation context has no authoritative absolute data root',
    };
  }
  const reader = options.readFile ?? ((path) => readFile(path, 'utf8'));
  const loaded = await readJson(registryPath, reader);
  if (loaded.error) {
    return {
      success: false,
      registryPath,
      marketplaces: [],
      missing: false,
      error: loaded.error,
    };
  }
  if (loaded.missing) {
    return options.allowMissing
      ? { success: true, registryPath, marketplaces: [], missing: true }
      : {
          success: false,
          registryPath,
          marketplaces: [],
          missing: true,
          error: `OMP marketplace registry is missing: ${registryPath}`,
        };
  }
  const parsedRegistry = MarketplaceRegistrySchema.safeParse(loaded.value);
  if (!parsedRegistry.success) {
    return {
      success: false,
      registryPath,
      marketplaces: [],
      missing: false,
      error: `OMP marketplace registry has an unsupported or malformed version: ${registryPath}`,
    };
  }

  const names = new Set<string>();
  const sources = new Set<string>();
  const catalogPaths = new Set<string>();
  const marketplaces: OmpMarketplaceRegistryEntry[] = [];
  for (const raw of parsedRegistry.data.marketplaces) {
    if (!isName(raw.name)) {
      return {
        success: false,
        registryPath,
        marketplaces: [],
        missing: false,
        error: `OMP marketplace registry contains an invalid name: ${registryPath}`,
      };
    }
    const normalizedSource = normalizeMarketplaceSource(
      raw.sourceUri,
      raw.sourceType,
      context,
    );
    if (!normalizedSource) {
      return {
        success: false,
        registryPath,
        marketplaces: [],
        missing: false,
        error: `OMP marketplace '${raw.name}' has an invalid or credential-bearing source identity`,
      };
    }
    const sourceIdentity = normalizedSource.identity;
    if (
      names.has(raw.name) ||
      sources.has(sourceIdentity) ||
      catalogPaths.has(raw.catalogPath)
    ) {
      return {
        success: false,
        registryPath,
        marketplaces: [],
        missing: false,
        error: `OMP marketplace registry contains an ambiguous identity for '${raw.name}'`,
      };
    }

    const catalogFile = await readJson(raw.catalogPath, reader);
    if (catalogFile.error || catalogFile.missing) {
      return {
        success: false,
        registryPath,
        marketplaces: [],
        missing: false,
        error:
          catalogFile.error ??
          `OMP marketplace catalog is missing: ${raw.catalogPath}`,
      };
    }
    const parsedCatalog = parseCatalog(catalogFile.value, raw.catalogPath);
    if (!parsedCatalog.catalog) {
      return {
        success: false,
        registryPath,
        marketplaces: [],
        missing: false,
        error:
          parsedCatalog.error ??
          `Malformed OMP marketplace catalog: ${raw.catalogPath}`,
      };
    }
    if (parsedCatalog.catalog.name !== raw.name) {
      return {
        success: false,
        registryPath,
        marketplaces: [],
        missing: false,
        error: `OMP marketplace registry name '${raw.name}' conflicts with catalog name '${parsedCatalog.catalog.name}'`,
      };
    }

    names.add(raw.name);
    sources.add(sourceIdentity);
    catalogPaths.add(raw.catalogPath);
    marketplaces.push({
      name: raw.name,
      sourceType: raw.sourceType,
      sourceUri: normalizedSource.source,
      sourceIdentity,
      catalogPath: raw.catalogPath,
      catalog: parsedCatalog.catalog,
    });
  }

  return { success: true, registryPath, marketplaces, missing: false };
}

function parseInventory(output: string): {
  entries?: OmpInventoryEntry[];
  error?: string;
} {
  let value: unknown;
  try {
    if (!output.trim()) throw new Error('empty output');
    value = JSON.parse(output.replace(/^\uFEFF/, ''));
  } catch (error) {
    return {
      error: `OMP plugin inventory is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsedInventory = PluginInventorySchema.safeParse(value);
  if (!parsedInventory.success) {
    return { error: 'OMP plugin inventory has an unsupported shape' };
  }

  const entries: OmpInventoryEntry[] = [];
  const keys = new Set<string>();
  const installPaths = new Map<string, string>();
  for (const raw of parsedInventory.data.marketplace) {
    const entry = raw.entries[0];
    if (!parseOmpPluginId(raw.id) || raw.entries.length !== 1 || !entry) {
      return {
        error:
          'OMP plugin inventory contains a malformed or ambiguous marketplace entry',
      };
    }
    const key = `${raw.scope}:${raw.id}`;
    if (keys.has(key))
      return {
        error: `OMP plugin inventory contains duplicate identity '${key}'`,
      };
    keys.add(key);
    if (entry.scope !== raw.scope) {
      return {
        error: `OMP plugin inventory contains scope-conflicting details for '${key}'`,
      };
    }
    const priorPathOwner = installPaths.get(entry.installPath);
    if (priorPathOwner && priorPathOwner !== key) {
      return {
        error: `OMP plugin inventory reuses one install path for '${priorPathOwner}' and '${key}'`,
      };
    }
    installPaths.set(entry.installPath, key);

    const shadowedByProject = raw.shadowedBy === 'project';
    if (raw.shadowedBy !== undefined && !shadowedByProject) {
      return {
        error: `OMP plugin inventory has an invalid shadow marker for '${key}'`,
      };
    }
    entries.push({
      id: raw.id,
      scope: raw.scope,
      installPath: entry.installPath,
      version: entry.version,
      enabled: entry.enabled !== false,
      shadowedByProject,
    });
  }

  for (const entry of entries) {
    if (!entry.shadowedByProject) continue;
    const project = entries.find(
      (candidate) => candidate.id === entry.id && candidate.scope === 'project',
    );
    if (entry.scope !== 'user' || !project?.enabled) {
      return {
        error: `OMP plugin inventory has an uncorroborated shadow marker for '${entry.id}'`,
      };
    }
  }
  return { entries };
}

function desiredPlugin(resource: NativeResource): ParsedPluginId | null {
  return parseOmpPluginId(resource.resolvedIdentity);
}

function validateContext(
  context: NativeOperationContext,
  fixedProfileName?: string,
): string | null {
  if (context.client !== 'omp') {
    return `OMP adapter received context for '${context.client}'`;
  }
  let contextProfileName: string | undefined;
  try {
    contextProfileName = profileNameFromNativeScope(context.nativeScope);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const profileName = fixedProfileName ?? contextProfileName;
  const expectedNativeScope = profileName
    ? `profile:${profileName}`
    : context.scope;
  if (context.nativeScope !== expectedNativeScope) {
    return `OMP native scope '${context.nativeScope}' conflicts with selected scope '${expectedNativeScope}'`;
  }
  if (profileName && context.scope !== 'user') {
    return 'OMP named profiles support only the AllAgents user scope';
  }
  if (!absolutePath(context.root)) {
    return 'OMP operation context root must be absolute';
  }
  if (!marketplaceRegistryPath(context)) {
    return 'OMP operation context has no authoritative absolute data root';
  }
  return null;
}

function validateResourceContext(
  resource: NativeResource,
  context: NativeOperationContext,
  profileName?: string,
): string | null {
  const contextError = validateContext(context, profileName);
  if (contextError) return contextError;
  if (resource.kind !== 'plugin' || !desiredPlugin(resource)) {
    return 'OMP mutation requires one valid marketplace plugin identity';
  }
  if (
    resource.context.client !== context.client ||
    resource.context.scope !== context.scope ||
    resource.context.nativeScope !== context.nativeScope ||
    resolve(resource.context.root) !== resolve(context.root)
  ) {
    return 'OMP resource context does not match the selected operation context';
  }
  return null;
}

function marketplaceForResource(
  resource: NativeResource,
  registry: OmpMarketplaceInspection,
  context: NativeOperationContext,
): {
  marketplace?: OmpMarketplaceRegistryEntry;
  missing?: boolean;
  error?: string;
} {
  const plugin = desiredPlugin(resource);
  if (!plugin) return { error: 'OMP resource has no valid plugin identity' };
  const marketplace = registry.marketplaces.find(
    (candidate) => candidate.name === plugin.marketplace,
  );
  const requestedSource = resource.provenance.marketplaceSource;
  const requestedSourceIdentity = requestedSource
    ? marketplaceSourceIdentity(requestedSource, undefined, context)
    : null;
  if (requestedSource && !requestedSourceIdentity) {
    return { error: `OMP marketplace source is invalid: ${requestedSource}` };
  }
  if (!marketplace) {
    if (requestedSourceIdentity) {
      const conflicting = registry.marketplaces.find(
        (candidate) => candidate.sourceIdentity === requestedSourceIdentity,
      );
      if (conflicting) {
        return {
          error: `OMP marketplace source is already registered as '${conflicting.name}', not '${plugin.marketplace}'`,
        };
      }
    }
    return {
      missing: true,
      error: `OMP marketplace '${plugin.marketplace}' is not registered`,
    };
  }
  if (
    requestedSourceIdentity &&
    marketplace.sourceIdentity !== requestedSourceIdentity
  ) {
    return {
      error: `OMP marketplace '${plugin.marketplace}' is registered from a conflicting source`,
    };
  }
  const matches = marketplace.catalog.plugins.filter(
    (candidate) => candidate.name === plugin.name,
  );
  if (matches.length !== 1) {
    return {
      error: `OMP catalog '${plugin.marketplace}' does not resolve exactly one plugin '${plugin.name}'`,
    };
  }
  return { marketplace };
}

export class OmpNativeClient implements NativeClient {
  readonly client = 'omp';
  private readonly run: OmpCommandRunner;
  private readonly reader: OmpFileReader;
  private readonly profileName: string | undefined;
  private versionResult: { success: boolean; error?: string } | undefined;

  constructor(options: OmpNativeClientOptions = {}) {
    this.run = options.execute ?? executeCommand;
    this.reader = options.readFile ?? ((path) => readFile(path, 'utf8'));
    this.profileName = options.nativeScope?.name;
    if (this.profileName !== undefined) {
      ompProfileNativeScope(this.profileName);
    }
  }

  private execute(
    args: string[],
    context?: NativeOperationContext,
  ): Promise<NativeCommandResult> {
    const profileName =
      this.profileName ?? profileNameFromNativeScope(context?.nativeScope);
    return this.run(
      'omp',
      profileName ? ['--profile', profileName, ...args] : args,
      commandOptions(context),
    );
  }

  private async supportedVersion(
    context?: NativeOperationContext,
  ): Promise<{ success: boolean; error?: string }> {
    if (this.versionResult) return this.versionResult;
    const result = await this.execute(['--version'], context);
    if (!result.success) {
      this.versionResult = { success: false, error: commandError(result) };
      return this.versionResult;
    }
    const version = parseVersion(result.output);
    if (!version) {
      this.versionResult = {
        success: false,
        error: `Could not parse OMP version: ${JSON.stringify(result.output)}`,
      };
      return this.versionResult;
    }
    if (compareNativeVersions(version, OMP_MINIMUM_VERSION) < 0) {
      this.versionResult = {
        success: false,
        error: `OMP ${version.join('.')} is unsupported; version 18.1.17 or newer is required`,
      };
      return this.versionResult;
    }
    this.versionResult = { success: true };
    return this.versionResult;
  }

  async isAvailable(context?: NativeOperationContext): Promise<boolean> {
    if (context && validateContext(context, this.profileName)) return false;
    return (await this.supportedVersion(context)).success;
  }

  supportsScope(_scope: 'user' | 'project'): boolean {
    return true;
  }

  resolveSource(
    source: string,
    context: NativeOperationContext,
    provenance: Readonly<Record<string, string>> = {},
  ): NativeSourceResolution {
    const plugin =
      parseOmpPluginId(source) ?? parseAllAgentsMarketplaceSpec(source);
    if (!plugin) {
      return {
        success: false,
        error: `OMP native install requires a valid plugin@marketplace source, not '${source}'`,
      };
    }
    return {
      success: true,
      resource: {
        kind: 'plugin',
        requestedIdentity: source,
        resolvedIdentity: plugin.id,
        context,
        provenance: {
          ...provenance,
          pluginName: plugin.name,
          marketplaceName: plugin.marketplace,
        },
      },
    };
  }

  async inspect(
    context: NativeOperationContext,
  ): Promise<NativeInspectionResult> {
    const contextError = validateContext(context, this.profileName);
    if (contextError)
      return {
        success: false,
        resources: [],
        observations: [],
        error: contextError,
      };
    const supported = await this.supportedVersion(context);
    if (!supported.success) {
      return {
        success: false,
        resources: [],
        observations: [],
        error: supported.error ?? 'OMP version inspection failed',
      };
    }

    const result = await this.execute(['plugin', 'list', '--json'], context);
    if (!result.success) {
      return {
        success: false,
        resources: [],
        observations: [],
        error: `Could not inspect OMP plugins: ${commandError(result)}`,
      };
    }
    const inventory = parseInventory(result.output);
    if (!inventory.entries) {
      return {
        success: false,
        resources: [],
        observations: [],
        error: inventory.error ?? 'Could not parse OMP plugin inventory',
      };
    }

    const registry = await inspectOmpMarketplaceRegistry(context, {
      readFile: this.reader,
      allowMissing: inventory.entries.length === 0,
    });
    if (!registry.success) {
      return {
        success: false,
        resources: [],
        observations: [],
        error: registry.error ?? 'Could not inspect OMP marketplaces',
      };
    }

    const observations: NativeResourceObservation[] = [];
    for (const entry of inventory.entries) {
      const parsed = parseOmpPluginId(entry.id);
      if (!parsed) {
        return {
          success: false,
          resources: [],
          observations,
          error: `Installed OMP plugin '${entry.id}' has invalid identity`,
        };
      }
      const marketplace = registry.marketplaces.find(
        (candidate) => candidate.name === parsed.marketplace,
      );
      if (!marketplace) {
        return {
          success: false,
          resources: [],
          observations,
          error: `Installed OMP plugin '${entry.id}' references missing marketplace '${parsed.marketplace}'`,
        };
      }
      const catalogMatches = marketplace.catalog.plugins.filter(
        (candidate) => candidate.name === parsed.name,
      );
      const catalogPlugin = catalogMatches[0];
      if (catalogMatches.length !== 1 || !catalogPlugin) {
        return {
          success: false,
          resources: [],
          observations,
          error: `Installed OMP plugin '${entry.id}' has no unambiguous catalog identity`,
        };
      }
      const resource: NativeResource = {
        kind: 'plugin',
        requestedIdentity: entry.id,
        resolvedIdentity: entry.id,
        context: {
          ...context,
          scope: entry.scope,
          nativeScope: context.nativeScope.startsWith('profile:')
            ? context.nativeScope
            : entry.scope,
        },
        provenance: {
          pluginName: parsed.name,
          marketplaceName: parsed.marketplace,
          marketplaceSource: marketplace.sourceUri,
          installedVersion: entry.version,
          installPath: entry.installPath,
          ...(catalogPlugin.version && {
            catalogVersion: catalogPlugin.version,
          }),
          ...(entry.shadowedByProject && { shadowedBy: 'project' }),
        },
      };
      observations.push({
        resource,
        status: entry.enabled ? 'installed' : 'disabled',
        installedPath: entry.installPath,
      });
    }

    const selected = observations.filter(
      (observation) => observation.resource.context.scope === context.scope,
    );
    return {
      success: true,
      resources: selected
        .filter((observation) => observation.status === 'installed')
        .map((observation) => observation.resource),
      observations: selected,
    };
  }

  private async inspectForMutation(
    resource: NativeResource,
    context: NativeOperationContext,
  ): Promise<{ inspection?: NativeInspectionResult; error?: string }> {
    const validationError = validateResourceContext(
      resource,
      context,
      this.profileName,
    );
    if (validationError) return { error: validationError };
    const inspection = await this.inspect(context);
    if (!inspection.success) {
      return {
        error: inspection.error ?? 'Could not inspect OMP native state',
      };
    }
    const disabled = inspection.observations?.find(
      (candidate) =>
        candidate.resource.resolvedIdentity === resource.resolvedIdentity &&
        candidate.status === 'disabled',
    );
    if (disabled) {
      return {
        error: `OMP plugin '${resource.resolvedIdentity}' is installed but disabled in ${context.scope} scope`,
      };
    }
    return { inspection };
  }

  private async registry(
    context: NativeOperationContext,
    allowMissing: boolean,
  ): Promise<OmpMarketplaceInspection> {
    return inspectOmpMarketplaceRegistry(context, {
      readFile: this.reader,
      allowMissing,
    });
  }

  async registerMarketplace(
    registration: OmpMarketplaceRegistrationRequest,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    const contextError = validateContext(context, this.profileName);
    if (contextError) return { success: false, error: contextError };
    if (!isName(registration.name)) {
      return {
        success: false,
        error: `Invalid OMP marketplace name '${registration.name}'`,
      };
    }
    const requested = normalizeMarketplaceSource(
      registration.source,
      undefined,
      context,
    );
    if (!requested) {
      return {
        success: false,
        error: `OMP marketplace source is invalid: ${registration.source}`,
      };
    }

    const before = await this.registry(context, true);
    if (!before.success) {
      return {
        success: false,
        error:
          before.error ?? 'Could not inspect OMP marketplace registrations',
      };
    }
    const named = before.marketplaces.find(
      ({ name }) => name === registration.name,
    );
    if (named) {
      return named.sourceIdentity === requested.identity
        ? { success: true }
        : {
            success: false,
            error: `OMP marketplace '${registration.name}' is registered from a conflicting source`,
          };
    }
    const sourceOwner = before.marketplaces.find(
      ({ sourceIdentity }) => sourceIdentity === requested.identity,
    );
    if (sourceOwner) {
      return {
        success: false,
        error: `OMP marketplace source is already registered as '${sourceOwner.name}', not '${registration.name}'`,
      };
    }

    const result = await this.execute(
      ['plugin', 'marketplace', 'add', registration.source],
      context,
    );
    if (!result.success) {
      return {
        success: false,
        error: `Could not register OMP marketplace '${registration.source}': ${commandError(result)}`,
      };
    }
    const after = await this.registry(context, false);
    if (!after.success) {
      return {
        success: false,
        registrations: [registration.source],
        error: `OMP marketplace registration completed but could not be verified: ${after.error ?? 'registry inspection failed'}`,
      };
    }
    const registered = after.marketplaces.find(
      ({ name }) => name === registration.name,
    );
    if (!registered || registered.sourceIdentity !== requested.identity) {
      return {
        success: false,
        registrations: [registration.source],
        error: `OMP marketplace registration completed with an unexpected identity for '${registration.name}'`,
      };
    }
    return { success: true, registrations: [registration.source] };
  }

  async removeMarketplaceRegistration(
    marketplaceName: string,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    const contextError = validateContext(context, this.profileName);
    if (contextError) return { success: false, error: contextError };
    if (!profileNameFromNativeScope(context.nativeScope)) {
      return {
        success: false,
        error: 'OMP marketplace registration cleanup requires a named profile',
      };
    }
    if (!isName(marketplaceName)) {
      return {
        success: false,
        error: `Invalid OMP marketplace name '${marketplaceName}'`,
      };
    }

    const inspection = await this.inspect(context);
    if (!inspection.success) {
      return {
        success: false,
        error:
          inspection.error ?? 'Could not inspect OMP profile marketplace usage',
      };
    }
    const referenced = inspection.observations?.find(
      ({ resource }) => resource.provenance.marketplaceName === marketplaceName,
    );
    if (referenced) {
      return {
        success: false,
        error: `OMP marketplace '${marketplaceName}' is still referenced by '${referenced.resource.resolvedIdentity}'`,
      };
    }

    const before = await this.registry(context, true);
    if (!before.success) {
      return {
        success: false,
        error:
          before.error ?? 'Could not inspect OMP marketplace registrations',
      };
    }
    if (!before.marketplaces.some(({ name }) => name === marketplaceName)) {
      return { success: true };
    }

    const removal = await this.execute(
      ['plugin', 'marketplace', 'remove', marketplaceName],
      context,
    );
    if (!removal.success) {
      return {
        success: false,
        error: `Could not remove OMP marketplace '${marketplaceName}': ${commandError(removal)}`,
      };
    }
    const after = await this.registry(context, true);
    if (!after.success) {
      return {
        success: false,
        error:
          after.error ??
          `OMP marketplace '${marketplaceName}' removal could not be verified`,
      };
    }
    return after.marketplaces.some(({ name }) => name === marketplaceName)
      ? {
          success: false,
          error: `OMP marketplace '${marketplaceName}' remains registered after removal`,
        }
      : { success: true };
  }

  async install(
    resource: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    const before = await this.inspectForMutation(resource, context);
    if (!before.inspection) {
      return { success: false, error: before.error ?? 'OMP preflight failed' };
    }
    let registry = await this.registry(context, true);
    if (!registry.success) {
      return {
        success: false,
        error: registry.error ?? 'OMP marketplace inspection failed',
      };
    }
    let resolved = marketplaceForResource(resource, registry, context);
    const alreadyInstalled = before.inspection.resources.some(
      (candidate) => candidate.resolvedIdentity === resource.resolvedIdentity,
    );
    if (alreadyInstalled && !resolved.marketplace) {
      return {
        success: false,
        error: resolved.error ?? 'OMP marketplace identity is unresolved',
      };
    }

    const registrations: string[] = [];
    if (!resolved.marketplace) {
      const source = resource.provenance.marketplaceSource;
      const marketplaceName = resource.provenance.marketplaceName;
      if (!source || !marketplaceName || !resolved.missing) {
        return {
          success: false,
          error: resolved.error ?? 'OMP marketplace identity is unresolved',
        };
      }
      const registration = await this.registerMarketplace(
        { name: marketplaceName, source },
        context,
      );
      if (!registration.success) return registration;
      registrations.push(...(registration.registrations ?? []));
      registry = await this.registry(context, false);
      if (!registry.success) {
        return {
          success: false,
          error:
            registry.error ??
            'OMP marketplace registration verification failed',
          ...(registrations.length > 0 && { registrations }),
        };
      }
      resolved = marketplaceForResource(resource, registry, context);
      if (!resolved.marketplace) {
        return {
          success: false,
          error:
            resolved.error ??
            'OMP marketplace registration has an unexpected identity',
          ...(registrations.length > 0 && { registrations }),
        };
      }
    }
    const revisionError = resolved.marketplace
      ? await verifyMarketplaceRevision(
          resource,
          resolved.marketplace,
          this.reader,
        )
      : 'OMP marketplace identity is unresolved';
    if (revisionError) {
      return {
        success: false,
        error: revisionError,
        ...(registrations.length > 0 && { registrations }),
      };
    }
    if (alreadyInstalled) return { success: true };

    const install = await this.execute(
      [
        'plugin',
        'install',
        '--scope',
        context.scope,
        resource.resolvedIdentity,
      ],
      context,
    );
    if (!install.success) {
      return {
        success: false,
        error: `Could not install OMP plugin '${resource.resolvedIdentity}': ${commandError(install)}`,
        ...(registrations.length > 0 && { registrations }),
      };
    }
    const after = await this.inspect(context);
    if (
      !after.success ||
      !after.resources.some(
        (candidate) => candidate.resolvedIdentity === resource.resolvedIdentity,
      )
    ) {
      return {
        success: false,
        error:
          after.error ??
          `OMP install completed but '${resource.resolvedIdentity}' is absent from ${context.scope} inventory`,
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
    current: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    if (resource.resolvedIdentity !== current.resolvedIdentity) {
      return {
        success: false,
        error: `Refusing OMP targeted update from '${current.resolvedIdentity}' to '${resource.resolvedIdentity}'`,
      };
    }
    const before = await this.inspectForMutation(resource, context);
    if (!before.inspection) {
      return { success: false, error: before.error ?? 'OMP preflight failed' };
    }
    if (
      !before.inspection.resources.some(
        (candidate) => candidate.resolvedIdentity === resource.resolvedIdentity,
      )
    ) {
      return {
        success: false,
        error: `OMP plugin '${resource.resolvedIdentity}' is not installed in ${context.scope} scope`,
      };
    }
    const registry = await this.registry(context, false);
    if (!registry.success) {
      return {
        success: false,
        error: registry.error ?? 'OMP marketplace inspection failed',
      };
    }
    const resolved = marketplaceForResource(resource, registry, context);
    if (!resolved.marketplace) {
      return {
        success: false,
        error: resolved.error ?? 'OMP marketplace identity is unresolved',
      };
    }
    const revisionError = await verifyMarketplaceRevision(
      resource,
      resolved.marketplace,
      this.reader,
    );
    if (revisionError) return { success: false, error: revisionError };

    const result = await this.execute(
      [
        'plugin',
        'upgrade',
        '--scope',
        context.scope,
        resource.resolvedIdentity,
      ],
      context,
    );
    if (!result.success) {
      return {
        success: false,
        error: `Could not upgrade OMP plugin '${resource.resolvedIdentity}': ${commandError(result)}`,
      };
    }
    const after = await this.inspect(context);
    return after.success &&
      after.resources.some(
        (candidate) => candidate.resolvedIdentity === resource.resolvedIdentity,
      )
      ? { success: true }
      : {
          success: false,
          error:
            after.error ??
            `OMP upgrade completed but '${resource.resolvedIdentity}' is absent from ${context.scope} inventory`,
        };
  }

  async remove(
    resource: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    const before = await this.inspectForMutation(resource, context);
    if (!before.inspection) {
      return { success: false, error: before.error ?? 'OMP preflight failed' };
    }
    if (
      !before.inspection.resources.some(
        (candidate) => candidate.resolvedIdentity === resource.resolvedIdentity,
      )
    ) {
      return { success: true };
    }
    const result = await this.execute(
      [
        'plugin',
        'uninstall',
        '--scope',
        context.scope,
        resource.resolvedIdentity,
      ],
      context,
    );
    if (!result.success) {
      return {
        success: false,
        error: `Could not uninstall OMP plugin '${resource.resolvedIdentity}': ${commandError(result)}`,
      };
    }
    const after = await this.inspect(context);
    if (!after.success) {
      return {
        success: false,
        error: after.error ?? 'OMP removal verification failed',
      };
    }
    if (
      after.resources.some(
        (candidate) => candidate.resolvedIdentity === resource.resolvedIdentity,
      )
    ) {
      return {
        success: false,
        error: `OMP uninstall completed but '${resource.resolvedIdentity}' remains in ${context.scope} inventory`,
      };
    }

    // Marketplace registrations are shared by both plugin scopes and may be
    // referenced by other AllAgents workspaces. Ordinary state cannot prove
    // exclusive ownership, so PR 1 deliberately preserves the registration.
    return { success: true };
  }
}
