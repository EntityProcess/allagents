import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import simpleGit from 'simple-git';
import type { ProfileResourceRelationship, ProfileState } from '../../models/profile-state.js';
import {
  getPluginRef,
  getPluginSource,
  type ClientType,
  type InstallMode,
  type ProfileDeclaration,
  type ProfilePluginEntry,
  ProfileNameSchema,
  type UserWorkspaceConfig,
} from '../../models/workspace-config.js';
import { cloneToTemp, gitHubUrl } from '../git.js';
import { isPluginSpec, parsePluginSpec, resolvePluginSpec } from '../marketplace.js';
import type { NativeInspectionResult, NativeResource } from '../native/types.js';
import {
  inspectOmpMarketplaceRegistry,
  parseOmpPluginId,
} from '../native/index.js';
import { sanitizeNativeProvenance } from '../native/types.js';
import { copyPluginToWorkspace, collectPluginSkills } from '../transform.js';
import { parseUserWorkspaceConfig } from '../../utils/workspace-parser.js';
import {
  getPluginCachePath,
  isGitHubUrl,
  parseGitHubUrl,
  validatePluginSource,
} from '../../utils/plugin-path.js';
import { parseMarketplaceManifest } from '../../utils/marketplace-manifest-parser.js';
import { getProfileAdapter } from './adapters/registry.js';
import { assertSafeProfilePath, fingerprintProfileFile, sha256Fingerprint } from './files.js';
import { renderProfileLaunchers } from './launcher.js';
import { hashProfileDeclaration, loadProfileState, sanitizeProfileError } from './state.js';
import type {
  ProfileAdapter,
  ProfileClientContext,
  ProfileResolvedPlugin,
} from './types.js';
import type {
  ProfileOperationKind,
  ProfilePlan,
  ProfilePlanAction,
  ProfilePlanClient,
  ProfilePlanCommand,
  ProfilePlanMcpServer,
  ProfilePlanStep,
  ProfilePlanStepDetail,
  ProfileRuntimeOptions,
  ProfileStepKind,
} from './index.js';

export interface ResolvedProfileRuntime {
  readonly userConfigPath: string;
  readonly workspaceDirectory: string;
  readonly homeDir: string;
  readonly binDir: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly offline: boolean;
  readonly dryRun: boolean;
}

export interface ProfilePlanDependencies {
  readonly getAdapter?: (client: ClientType) => ProfileAdapter | null;
  readonly parseWorkspace?: typeof parseUserWorkspaceConfig;
}

interface ResolvedFileSource {
  readonly path: string;
  readonly source: string;
  readonly requestedRef?: string;
  readonly resolvedRef?: string;
  readonly resolvedSha?: string;
  readonly marketplace?: string;
  readonly pluginName?: string;
  readonly cleanup?: () => Promise<void>;
}

export interface InternalProfilePlanStep {
  readonly public: ProfilePlanStep;
  readonly relationship: ProfileResourceRelationship;
  readonly root?: string;
  readonly path?: string;
  readonly content?: string | Uint8Array;
  readonly mode?: number;
  readonly previousFingerprint?: string;
  readonly nativeResource?: NativeResource;
  readonly currentNativeResource?: NativeResource;
  readonly context?: ProfileClientContext;
  /** Revalidate Pi's same-root MCP adapter immediately before MCP materialization. */
  readonly requiresPiMcpAdapter?: boolean;
}

export interface InternalProfilePlan {
  readonly public: ProfilePlan;
  readonly runtime: ResolvedProfileRuntime;
  readonly declaration?: ProfileDeclaration;
  readonly clients: readonly ClientType[];
  readonly contexts: ReadonlyMap<ClientType, ProfileClientContext>;
  readonly adapters: ReadonlyMap<ClientType, ProfileAdapter>;
  readonly priorState: ProfileState | null;
  readonly steps: readonly InternalProfilePlanStep[];
}

const INTERNAL_PLANS = new WeakMap<ProfilePlan, InternalProfilePlan>();
const OMP_MARKETPLACE_REGISTRATION_SOURCE =
  new WeakMap<ProfileResolvedPlugin, string>();
const SENSITIVE_FIELD = /(?:^|[-_.])(auth|credential|key|password|secret|signature|token)(?:$|[-_.])/i;

export function resolveProfileRuntimeOptions(options: ProfileRuntimeOptions = {}): ResolvedProfileRuntime {
  const home = resolve(options.homeDir ?? homedir());
  return Object.freeze({
    userConfigPath: resolve(options.userConfigPath ?? join(home, '.allagents', 'workspace.yaml')),
    workspaceDirectory: resolve(options.workspaceDirectory ?? home),
    homeDir: home,
    binDir: resolve(options.binDir ?? join(home, '.local', 'bin')),
    environment: Object.freeze({ ...options.environment }),
    platform: options.platform ?? process.platform,
    offline: options.offline ?? false,
    dryRun: options.dryRun ?? false,
  });
}

export function getProfileRoot(runtime: ResolvedProfileRuntime, profile: string): string {
  return join(runtime.homeDir, '.allagents', 'profiles', profile);
}

export async function readProfileWorkspace(
  runtime: ResolvedProfileRuntime,
  dependencies: ProfilePlanDependencies = {},
): Promise<UserWorkspaceConfig> {
  return (dependencies.parseWorkspace ?? parseUserWorkspaceConfig)(
    runtime.userConfigPath,
  );
}

export async function readOptionalProfileWorkspace(
  runtime: ResolvedProfileRuntime,
  dependencies: ProfilePlanDependencies = {},
): Promise<UserWorkspaceConfig> {
  try {
    return await readProfileWorkspace(runtime, dependencies);
  } catch (error) {
    const missing =
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error instanceof Error &&
        error.message.includes('workspace.yaml not found at'));
    if (!missing) throw error;
    return {
      repositories: [],
      plugins: [],
      clients: [],
    };
  }
}

export function getInternalProfilePlan(plan: ProfilePlan): InternalProfilePlan {
  const internal = INTERNAL_PLANS.get(plan);
  if (!internal) throw new Error('Profile plan was not created by this process or has expired');
  return internal;
}

function validateDisplaySafe(value: string, label: string): string {
  let containsControl = false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      containsControl = true;
      break;
    }
  }
  if (!value || containsControl) {
    throw new Error(`${label} is empty or contains control characters`);
  }
  if (/\bbearer\s+\S+/i.test(value) || /\b(?:authorization|credential|password|secret|token|api[-_]?key)\s*[:=]\s*\S+/i.test(value)) {
    throw new Error(`${label} contains credential-bearing text`);
  }
  try {
    const url = new URL(value);
    if (url.username || url.password) throw new Error(`${label} contains URL credentials`);
    for (const [key, queryValue] of url.searchParams) {
      if (queryValue && SENSITIVE_FIELD.test(key)) {
        throw new Error(`${label} contains a secret query parameter`);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
  }
  return value;
}

function normalizedPlugin(
  entry: ProfilePluginEntry,
  declarationIndex: number,
  install: InstallMode,
): ProfileResolvedPlugin {
  const source = getPluginSource(entry);
  validateDisplaySafe(source, `Profile plugin ${declarationIndex} source`);
  const requestedRef = getPluginRef(entry);
  if (requestedRef) validateDisplaySafe(requestedRef, `Profile plugin ${declarationIndex} ref`);
  return Object.freeze({
    declarationIndex,
    source,
    ...(requestedRef && { requestedRef }),
    install,
    ...(typeof entry === 'object' && entry.skills !== undefined && { skills: entry.skills }),
    ...(typeof entry === 'object' && entry.clients !== undefined && { clients: entry.clients }),
  });
}

function selectedForClient(entry: ProfilePluginEntry, client: ClientType): boolean {
  return typeof entry === 'string' || !entry.clients || entry.clients.includes(client);
}

function keyFor(kind: ProfileStepKind, client: ClientType, identity: string): string {
  return `${kind}:${client}:${sha256Fingerprint(identity)}`;
}

function relationship(input: {
  kind: ProfileStepKind;
  client: ClientType;
  identity: string;
  path?: string;
  ownership: 'managed' | 'referenced';
  transition?: ProfileResourceRelationship['transition'];
  fingerprint?: string;
  cleanup: ProfileResourceRelationship['cleanup'];
  requestedRef?: string;
  resolvedRef?: string;
  provenance?: Readonly<Record<string, string>>;
}): ProfileResourceRelationship {
  return {
    key: keyFor(input.kind, input.client, input.identity),
    client: input.client,
    kind: input.kind,
    identity: validateDisplaySafe(input.identity, 'Profile resource identity'),
    ...(input.path && { path: input.path }),
    ownership: input.ownership,
    transition: input.transition ?? 'planned',
    ...(input.fingerprint && { fingerprint: input.fingerprint }),
    cleanup: input.cleanup,
    ...(input.requestedRef && { requestedRef: input.requestedRef }),
    ...(input.resolvedRef && { resolvedRef: input.resolvedRef }),
    ...(input.provenance && Object.keys(input.provenance).length > 0 && {
      provenance: sanitizeNativeProvenance(input.provenance),
    }),
  };
}

function publicStep(
  client: ClientType,
  kind: ProfileStepKind,
  identity: string,
  action: ProfilePlanAction,
  refs: { requestedRef?: string; resolvedRef?: string } = {},
  detail?: ProfilePlanStepDetail,
): ProfilePlanStep {
  return Object.freeze({
    client,
    kind,
    identity,
    action,
    ...refs,
    ...(detail && { detail }),
  });
}
function previousResource(
  state: ProfileState | null,
  kind: ProfileStepKind,
  client: ClientType,
  identity: string,
): ProfileResourceRelationship | undefined {
  return state?.resources.find(
    (entry) =>
      entry.kind === kind &&
      entry.client === client &&
      entry.identity === identity &&
      entry.transition !== 'removed',
  );
}

async function resolveRemoteRepository(
  source: string,
  requestedRef: string | undefined,
  runtime: ResolvedProfileRuntime,
): Promise<ResolvedFileSource> {
  const parsed = parseGitHubUrl(source);
  if (!parsed) throw new Error(`Unsupported profile file plugin source '${source}'`);
  const ref = requestedRef ?? parsed.branch;
  if (runtime.offline) {
    const cachePath = getPluginCachePath(parsed.owner, parsed.repo, ref);
    if (!existsSync(cachePath)) {
      throw new Error(
        `Profile plugin '${source}' is not available in the offline cache`,
      );
    }
    let resolvedSha: string | undefined;
    try {
      resolvedSha =
        (await simpleGit(cachePath).revparse(['HEAD'])).trim() || undefined;
    } catch {
      resolvedSha = undefined;
    }
    return {
      path: parsed.subpath ? join(cachePath, parsed.subpath) : cachePath,
      source,
      ...(requestedRef && { requestedRef }),
      ...(ref && { resolvedRef: ref }),
      ...(resolvedSha && { resolvedSha }),
    };
  }
  const temporary = await cloneToTemp(gitHubUrl(parsed.owner, parsed.repo), ref);
  let resolvedSha: string | undefined;
  try {
    resolvedSha = (await simpleGit(temporary).revparse(['HEAD'])).trim() || undefined;
  } catch {
    resolvedSha = undefined;
  }
  return {
    path: parsed.subpath ? join(temporary, parsed.subpath) : temporary,
    source,
    ...(requestedRef && { requestedRef }),
    ...(ref && { resolvedRef: ref }),
    ...(resolvedSha && { resolvedSha }),
    cleanup: () => rm(temporary, { recursive: true, force: true }),
  };
}

async function resolveFileSource(
  plugin: ProfileResolvedPlugin,
  runtime: ResolvedProfileRuntime,
): Promise<ResolvedFileSource> {
  if (plugin.requestedRef && !isGitHubUrl(plugin.source)) {
    throw new Error(
      `Profile plugin ref '${plugin.requestedRef}' requires a GitHub repository source`,
    );
  }
  if (isPluginSpec(plugin.source)) {
    const parsed = parsePluginSpec(plugin.source);
    const resolved = await resolvePluginSpec(plugin.source, {
      offline: runtime.offline || runtime.dryRun,
      workspacePath: runtime.workspaceDirectory,
    });
    if (!resolved || !parsed) {
      throw new Error(`Profile marketplace plugin '${plugin.source}' is not registered and cached`);
    }
    return {
      path: resolved.path,
      source: plugin.source,
      ...(plugin.requestedRef && { requestedRef: plugin.requestedRef }),
      marketplace: resolved.marketplace,
      pluginName: resolved.plugin,
    };
  }
  if (isGitHubUrl(plugin.source)) {
    return resolveRemoteRepository(plugin.source, plugin.requestedRef, runtime);
  }
  const candidate = isAbsolute(plugin.source)
    ? resolve(plugin.source)
    : resolve(runtime.workspaceDirectory, plugin.source);
  const validation = validatePluginSource(candidate);
  if (!validation.valid) {
    throw new Error(validation.error ?? `Invalid profile plugin source '${plugin.source}'`);
  }
  const stats = await lstat(candidate).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Profile file plugin source must be a real directory: ${candidate}`);
  }
  return {
    path: candidate,
    source: plugin.source,
    ...(plugin.requestedRef && { requestedRef: plugin.requestedRef }),
  };
}

async function expandCopyResult(
  source: string,
  destination: string,
): Promise<Array<{ source: string; destination: string; content: Uint8Array; mode: number }>> {
  const stats = await lstat(source);
  if (stats.isSymbolicLink()) throw new Error(`Profile plugin contains a symbolic link: ${source}`);
  if (stats.isFile()) {
    return [{ source, destination, content: await readFile(source), mode: stats.mode & 0o777 }];
  }
  if (!stats.isDirectory()) throw new Error(`Profile plugin contains a non-file resource: ${source}`);
  const files: Array<{ source: string; destination: string; content: Uint8Array; mode: number }> = [];
  for (const entry of (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Profile plugin contains a symbolic link: ${sourcePath}`);
    if (entry.isDirectory()) files.push(...await expandCopyResult(sourcePath, destinationPath));
    else if (entry.isFile()) {
      const fileStats = await lstat(sourcePath);
      files.push({ source: sourcePath, destination: destinationPath, content: await readFile(sourcePath), mode: fileStats.mode & 0o777 });
    } else throw new Error(`Profile plugin contains a non-file resource: ${sourcePath}`);
  }
  return files;
}

async function inspectClient(adapter: ProfileAdapter, context: ProfileClientContext): Promise<NativeInspectionResult> {
  if (!await adapter.nativeClient.isAvailable(context.operationContext)) {
    throw new Error(`${context.client} CLI is unavailable or unsupported`);
  }
  const inspection = await adapter.nativeClient.inspect(context.operationContext);
  if (!inspection.success) throw new Error(inspection.error ?? `Could not inspect ${context.client} profile state`);
  return inspection;
}

function sameNativeIdentity(left: NativeResource, right: NativeResource): boolean {
  return left.kind === right.kind && left.resolvedIdentity === right.resolvedIdentity;
}

async function planManagedFile(input: {
  client: ClientType;
  kind: 'file' | 'settings' | 'mcp' | 'launcher';
  root: string;
  path: string;
  content: string | Uint8Array;
  mode: number;
  priorState: ProfileState | null;
  provenance?: Readonly<Record<string, string>>;
  requestedRef?: string;
  resolvedRef?: string;
}): Promise<InternalProfilePlanStep> {
  await assertSafeProfilePath(input.root, input.path);
  const desiredFingerprint = sha256Fingerprint(input.content);
  const currentFingerprint = await fingerprintProfileFile(input.path);
  const prior = previousResource(input.priorState, input.kind, input.client, input.path);
  let ownership: 'managed' | 'referenced' = prior?.ownership ?? 'managed';
  let action: ProfilePlanAction;
  if (currentFingerprint === null) {
    if (prior?.ownership === 'referenced') {
      throw new Error(`Referenced profile file is missing: ${input.path}`);
    }
    action = 'create';
    ownership = 'managed';
  } else if (!prior) {
    if (currentFingerprint !== desiredFingerprint) {
      throw new Error(`Profile ${input.kind} collides with an unowned file: ${input.path}`);
    }
    action = 'reference';
    ownership = 'referenced';
  } else if (prior.ownership === 'referenced') {
    if (currentFingerprint !== desiredFingerprint) {
      throw new Error(`Referenced profile file conflicts with the declaration: ${input.path}`);
    }
    action = 'reference';
  } else {
    if (!prior.fingerprint || currentFingerprint !== prior.fingerprint) {
      throw new Error(`Managed profile file was modified outside AllAgents: ${input.path}`);
    }
    action = currentFingerprint === desiredFingerprint ? 'unchanged' : 'update';
  }
  const next = relationship({
    kind: input.kind,
    client: input.client,
    identity: input.path,
    path: input.path,
    ownership,
    fingerprint: desiredFingerprint,
    cleanup: input.kind === 'launcher' ? 'launcher' : 'file',
    ...(input.requestedRef && { requestedRef: input.requestedRef }),
    ...(input.resolvedRef && { resolvedRef: input.resolvedRef }),
    ...(input.provenance && { provenance: input.provenance }),
  });
  return {
    public: publicStep(input.client, input.kind, input.path, action, {
      ...(input.requestedRef && { requestedRef: input.requestedRef }),
      ...(input.resolvedRef && { resolvedRef: input.resolvedRef }),
    }),
    relationship: next,
    root: input.root,
    path: input.path,
    content: input.content,
    mode: input.mode,
    ...(prior?.fingerprint && { previousFingerprint: prior.fingerprint }),
  };
}

async function resolveOmpMetadata(
  plugin: ProfileResolvedPlugin,
  runtime: ResolvedProfileRuntime,
  context: ProfileClientContext,
): Promise<ProfileResolvedPlugin> {
  const exact = parseOmpPluginId(plugin.source);
  if (exact) {
    const registry = await inspectOmpMarketplaceRegistry(
      context.operationContext,
      { allowMissing: true },
    );
    if (!registry.success) {
      throw new Error(
        registry.error ?? 'Could not inspect the selected OMP profile marketplace registry',
      );
    }
    const marketplace = registry.marketplaces.find(
      (candidate) => candidate.name === exact.marketplace,
    );
    const catalogMatches = marketplace?.catalog.plugins.filter(
      (candidate) => candidate.name === exact.name,
    ) ?? [];
    if (!marketplace || catalogMatches.length !== 1) {
      throw new Error(
        `OMP plugin '${plugin.source}' is not an authoritative single catalog identity in the selected profile`,
      );
    }
    return Object.freeze({
      ...plugin,
      marketplace: marketplace.name,
      pluginName: exact.name,
      path: marketplace.catalogPath,
      marketplaceSource: marketplace.sourceUri,
    });
  }
  const source = await resolveFileSource({ ...plugin, install: 'file' }, runtime);
  try {
    const catalog = await parseMarketplaceManifest(source.path);
    if (!catalog.success) throw new Error(catalog.error);
    if (catalog.data.plugins.length !== 1 || !catalog.data.plugins[0]) {
      throw new Error(
        `OMP marketplace source '${plugin.source}' must expose exactly one catalog plugin`,
      );
    }
    const registry = await inspectOmpMarketplaceRegistry(
      context.operationContext,
      { allowMissing: true },
    );
    if (!registry.success) {
      throw new Error(
        registry.error ?? 'Could not inspect the selected OMP profile marketplace registry',
      );
    }
    const candidate = resolve(source.path);
    const marketplaceCacheRoot = resolve(
      join(runtime.homeDir, '.allagents', 'plugins', 'marketplaces'),
    );
    const registrationSource =
      candidate === marketplaceCacheRoot ||
      candidate.startsWith(`${marketplaceCacheRoot}${sep}`)
        ? candidate
        : source.source;
    const resolved = Object.freeze({
      ...plugin,
      marketplace: catalog.data.name,
      pluginName: catalog.data.plugins[0].name,
      path: source.path,
      marketplaceSource: registrationSource,
      ...(source.resolvedRef && { resolvedRef: source.resolvedRef }),
      ...(source.resolvedSha && { resolvedSha: source.resolvedSha }),
    });
    if (!registry.marketplaces.some(({ name }) => name === catalog.data.name)) {
      OMP_MARKETPLACE_REGISTRATION_SOURCE.set(
        resolved,
        registrationSource,
      );
    }
    return resolved;
  } finally {
    await source.cleanup?.();
  }
}
function hasSelectedMcp(declaration: ProfileDeclaration, client: ClientType): boolean {
  return Object.values(declaration.mcpServers ?? {}).some(
    (server) => !server.clients || server.clients.includes(client),
  );
}

function managedContextRoot(context: ProfileClientContext): string {
  return context.operationContext.roots?.config ?? context.root;
}
const EXACT_SECRET_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function requestedSecretNames(value: unknown): string[] {
  const names = new Set<string>();
  const visit = (entry: unknown): void => {
    if (typeof entry === 'string') {
      const match = EXACT_SECRET_REFERENCE.exec(entry);
      if (match?.[1]) names.add(match[1]);
      try {
        const url = new URL(entry);
        for (const queryValue of url.searchParams.values()) visit(queryValue);
      } catch {
        // Non-URL strings have already been checked as exact references.
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (entry && typeof entry === 'object') {
      for (const item of Object.values(entry as Record<string, unknown>)) {
        visit(item);
      }
    }
  };
  visit(value);
  return [...names].sort();
}

function mcpDisclosures(
  declaration: ProfileDeclaration,
  client: ClientType,
): readonly ProfilePlanMcpServer[] {
  const servers: ProfilePlanMcpServer[] = [];
  for (const [name, server] of Object.entries(declaration.mcpServers ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (server.clients && !server.clients.includes(client)) continue;
    if ('url' in server) {
      servers.push({
        name,
        transport: 'http',
        endpoint: server.url,
        requestedSecrets: requestedSecretNames(server),
      });
    } else {
      servers.push({
        name,
        transport: 'stdio',
        command: {
          command: server.command,
          args: Object.freeze(
            (server.args ?? []).map((argument) =>
              EXACT_SECRET_REFERENCE.test(argument) ? '[REDACTED]' : argument,
            ),
          ),
        },
        requestedSecrets: requestedSecretNames(server),
      });
    }
  }
  return Object.freeze(servers);
}

function nativeCommandDisclosure(
  profile: string,
  client: ClientType,
  action: ProfilePlanAction,
  resource: NativeResource,
): ProfilePlanCommand | undefined {
  if (!['create', 'update', 'remove'].includes(action)) return undefined;
  if (client === 'pi') {
    const verb = action === 'create'
      ? 'install'
      : action === 'remove'
        ? 'remove'
        : 'update';
    return {
      command: 'pi',
      args: [
        verb,
        resource.provenance.commandSource ?? resource.requestedIdentity,
        '--no-approve',
      ],
    };
  }
  if (client === 'omp') {
    const verb = action === 'create'
      ? 'install'
      : action === 'remove'
        ? 'uninstall'
        : 'upgrade';
    return {
      command: 'omp',
      args: [
        '--profile',
        profile,
        'plugin',
        verb,
        '--scope',
        'user',
        resource.resolvedIdentity,
      ],
    };
  }
  return undefined;
}

async function planRoot(
  client: ClientType,
  context: ProfileClientContext,
  priorState: ProfileState | null,
): Promise<InternalProfilePlanStep> {
  const selectedRoot = managedContextRoot(context);
  await assertSafeProfilePath(selectedRoot, selectedRoot);
  const prior = previousResource(priorState, 'root', client, selectedRoot);
  const stats = await lstat(selectedRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (stats?.isSymbolicLink()) {
    throw new Error(`Profile client root cannot be a symbolic link: ${selectedRoot}`);
  }
  const ownership = prior?.ownership ?? (stats ? 'referenced' : 'managed');
  const action: ProfilePlanAction = prior
    ? 'unchanged'
    : stats
      ? 'reference'
      : 'create';
  return {
    public: publicStep(client, 'root', selectedRoot, action),
    relationship: relationship({
      kind: 'root',
      client,
      identity: selectedRoot,
      path: selectedRoot,
      ownership,
      cleanup: ownership === 'managed' ? 'file' : 'none',
    }),
    root: selectedRoot,
    path: selectedRoot,
    context,
  };
}

function staleFileStep(
  resource: ProfileResourceRelationship,
  currentFingerprint: string | null,
  root: string,
  context?: ProfileClientContext,
): InternalProfilePlanStep {
  let action: ProfilePlanAction = 'retain';
  if (resource.ownership === 'managed') {
    if (currentFingerprint === null) action = 'unchanged';
    else if (resource.fingerprint && currentFingerprint === resource.fingerprint) {
      action = 'remove';
    }
  }
  return {
    public: publicStep(resource.client, resource.kind, resource.identity, action),
    relationship: resource,
    ...(resource.path && { path: resource.path }),
    root,
    ...(context && { context }),
  };
}

export async function planProfileOperation(
  profile: string,
  operation: ProfileOperationKind,
  options: ProfileRuntimeOptions = {},
  dependencies: ProfilePlanDependencies = {},
): Promise<ProfilePlan> {
  ProfileNameSchema.parse(profile);
  const runtime = resolveProfileRuntimeOptions(options);
  const workspace = operation === 'remove'
    ? await readOptionalProfileWorkspace(runtime, dependencies)
    : await readProfileWorkspace(runtime, dependencies);
  const declaration = workspace.profiles?.[profile];
  const profileRoot = getProfileRoot(runtime, profile);
  const loadedState = await loadProfileState(profileRoot);
  if (loadedState.status === 'malformed') {
    throw new Error(`Refusing profile ${operation} because state is malformed: ${loadedState.error}`);
  }
  const priorState = loadedState.status === 'loaded' ? loadedState.state : null;
  if (operation !== 'remove' && !declaration) throw new Error(`Profile '${profile}' is not declared`);
  if (operation === 'remove' && !priorState) throw new Error(`Profile '${profile}' is not installed`);

  const desiredClients = declaration
    ? declaration.clients.map((client) => client.name)
    : [...(priorState?.clients ?? [])];
  const resolutionClients = [...desiredClients];
  for (const client of priorState?.clients ?? []) {
    if (!resolutionClients.includes(client)) resolutionClients.push(client);
  }
  const getAdapter = dependencies.getAdapter ?? getProfileAdapter;
  const adapters = new Map<ClientType, ProfileAdapter>();
  const contexts = new Map<ClientType, ProfileClientContext>();
  for (const client of resolutionClients) {
    const adapter = getAdapter(client);
    if (!adapter) throw new Error(`Profile client '${client}' is unsupported`);
    if (!adapter.capabilities.status || !adapter.capabilities.cleanup || !adapter.capabilities.launchers) {
      throw new Error(`Profile client '${client}' lacks required profile lifecycle capabilities`);
    }
    const context = adapter.resolveContext(profile, runtime);
    adapters.set(client, adapter);
    contexts.set(client, context);
  }

  const warnings: string[] = [];
  const steps: InternalProfilePlanStep[] = [];
  const desiredKeys = new Set<string>();
  const inspections = new Map<ClientType, NativeInspectionResult>();
  const inspectionFor = async (client: ClientType) => {
    const existing = inspections.get(client);
    if (existing) return existing;
    const adapter = adapters.get(client);
    const context = contexts.get(client);
    if (!adapter || !context) throw new Error(`Missing resolved context for ${client}`);
    const inspection = await inspectClient(adapter, context);
    inspections.set(client, inspection);
    return inspection;
  };

  if (operation === 'remove') {
    const removalOrder: Record<ProfileStepKind, number> = {
      launcher: 0,
      mcp: 1,
      settings: 1,
      file: 1,
      native: 2,
      marketplace: 3,
      root: 4,
    };
    const resources = [...(priorState?.resources ?? [])].sort(
      (left, right) => removalOrder[left.kind] - removalOrder[right.kind],
    );
    for (const resource of resources) {
      if (resource.transition === 'removed') continue;
      const context = contexts.get(resource.client);
      const adapter = adapters.get(resource.client);
      if (!context || !adapter) {
        throw new Error(`Cannot resolve cleanup adapter for ${resource.client}`);
      }
      if (resource.kind === 'native') {
        const inspection = await inspectionFor(resource.client);
        const live = inspection.resources.find(
          (candidate) => candidate.resolvedIdentity === resource.identity,
        );
        const action: ProfilePlanAction =
          resource.ownership === 'managed'
            ? live
              ? 'remove'
              : 'unchanged'
            : 'retain';
        const command = live
          ? nativeCommandDisclosure(profile, resource.client, action, live)
          : undefined;
        steps.push({
          public: publicStep(
            resource.client,
            'native',
            resource.identity,
            action,
            {},
            command
              ? {
                  ...(live?.requestedIdentity && {
                    source: live.requestedIdentity,
                  }),
                  commands: [command],
                }
              : undefined,
          ),
          relationship: resource,
          ...(live && { nativeResource: live }),
          context,
        });
      } else if (
        resource.path &&
        ['file', 'settings', 'mcp', 'launcher'].includes(resource.kind)
      ) {
        const writeRoot =
          resource.kind === 'launcher' ? runtime.binDir : context.root;
        steps.push(
          staleFileStep(
            resource,
            await fingerprintProfileFile(resource.path),
            writeRoot,
            context,
          ),
        );
      } else if (resource.kind === 'marketplace') {
        const action: ProfilePlanAction =
          resource.ownership === 'managed' ? 'remove' : 'retain';
        const marketplaceName =
          resource.provenance?.marketplaceName ?? resource.identity;
        steps.push({
          public: publicStep(
            resource.client,
            'marketplace',
            resource.identity,
            action,
            {},
            action === 'remove' && resource.client === 'omp'
              ? {
                  commands: [{
                    command: 'omp',
                    args: [
                      '--profile',
                      profile,
                      'plugin',
                      'marketplace',
                      'remove',
                      marketplaceName,
                    ],
                  }],
                }
              : undefined,
          ),
          relationship: resource,
          context,
        });
      } else if (resource.kind === 'root') {
        const action: ProfilePlanAction =
          resource.ownership === 'managed' ? 'remove' : 'retain';
        steps.push({
          public: publicStep(resource.client, 'root', resource.identity, action),
          relationship: resource,
          root: resource.path ?? managedContextRoot(context),
          path: resource.path ?? resource.identity,
          context,
        });
      } else {
        steps.push({
          public: publicStep(
            resource.client,
            resource.kind,
            resource.identity,
            'retain',
          ),
          relationship: resource,
          context,
        });
      }
    }
  } else if (declaration) {
    for (const declaredClient of declaration.clients) {
      const client = declaredClient.name;
      const adapter = adapters.get(client);
      const context = contexts.get(client);
      if (!adapter || !context) throw new Error(`Missing resolved context for ${client}`);
      const root = await planRoot(client, context, priorState);
      steps.push(root);
      desiredKeys.add(root.relationship.key);

      const nativePlugins: Array<{ plugin: ProfileResolvedPlugin; resource: NativeResource; current?: NativeResource }> = [];
      const filePlugins: ProfileResolvedPlugin[] = [];
      for (let index = 0; index < declaration.plugins.length; index++) {
        const entry = declaration.plugins[index];
        if (!entry || !selectedForClient(entry, client)) continue;
        const install = typeof entry === 'object' && entry.install ? entry.install : declaredClient.install;
        let plugin = normalizedPlugin(entry, index, install);
        if (plugin.skills !== undefined && !adapter.capabilities.skillFilters) {
          throw new Error(`Profile client '${client}' does not support plugin skill filters`);
        }
        if (install === 'native') {
          if (!adapter.capabilities.nativeInstall) throw new Error(`Profile client '${client}' does not support native plugins`);
          if (client === 'omp') {
            plugin = await resolveOmpMetadata(plugin, runtime, context);
          }
          const resolved = adapter.resolveNativeSource(plugin, context);
          if (!resolved.success || !resolved.resource) {
            throw new Error(
              resolved.error ??
                `Could not resolve native profile plugin '${plugin.source}'`,
            );
          }
          const inspection = await inspectionFor(client);
          const current = inspection.resources.find((candidate) =>
            sameNativeIdentity(candidate, resolved.resource as NativeResource),
          );
          nativePlugins.push({
            plugin,
            resource: resolved.resource,
            ...(current && { current }),
          });
        } else {
          if (!adapter.capabilities.fileInstall) throw new Error(`Profile client '${client}' does not support file plugins`);
          filePlugins.push(plugin);
        }
      }

      const piNeedsMcp = client === 'pi' && hasSelectedMcp(declaration, client);
      const plannedPiAdapter = nativePlugins.find(({ resource }) =>
        resource.provenance.packageIdentity === 'npm:pi-mcp-adapter' || resource.resolvedIdentity === 'npm:pi-mcp-adapter',
      );
      let referencedPiAdapter: NativeResource | undefined;
      if (piNeedsMcp && !plannedPiAdapter) {
        const inspectMcpAdapter = (adapter as ProfileAdapter & { inspectMcpAdapter?: (context: ProfileClientContext) => Promise<{ classification: string; packageSource?: string }> }).inspectMcpAdapter;
        if (!inspectMcpAdapter) throw new Error('Pi profile adapter cannot inspect the MCP prerequisite');
        const prerequisite = await inspectMcpAdapter.call(adapter, context);
        if (prerequisite.classification !== 'usable' || !prerequisite.packageSource) {
          throw new Error(`Pi profile MCP requires a usable pi-mcp-adapter in ${context.root}; found ${prerequisite.classification}`);
        }
        const resolved = adapter.resolveNativeSource({ declarationIndex: -1, source: prerequisite.packageSource, install: 'native' }, context);
        if (!resolved.success || !resolved.resource) throw new Error(resolved.error ?? 'Could not resolve referenced pi-mcp-adapter');
        referencedPiAdapter = resolved.resource;
      }

      const orderedNative = plannedPiAdapter
        ? [plannedPiAdapter, ...nativePlugins.filter((entry) => entry !== plannedPiAdapter)]
        : nativePlugins;
      if (referencedPiAdapter) {
        const rel = relationship({ kind: 'native', client, identity: referencedPiAdapter.resolvedIdentity, ownership: 'referenced', transition: 'referenced', cleanup: 'none', provenance: referencedPiAdapter.provenance });
        steps.push({ public: publicStep(client, 'native', rel.identity, 'reference'), relationship: rel, nativeResource: referencedPiAdapter, context });
        desiredKeys.add(rel.key);
      }
      for (const entry of orderedNative) {
        const prior = previousResource(priorState, 'native', client, entry.resource.resolvedIdentity);
        const ownership = prior?.ownership ?? (entry.current ? 'referenced' : 'managed');
        const action: ProfilePlanAction = ownership === 'referenced'
          ? 'reference'
          : entry.current
            ? operation === 'update' ? 'update' : 'unchanged'
            : 'create';
        const rel = relationship({
          kind: 'native', client, identity: entry.resource.resolvedIdentity,
          ownership, cleanup: ownership === 'managed' ? 'native' : 'none',
          ...(entry.plugin.requestedRef && { requestedRef: entry.plugin.requestedRef }),
          ...(entry.plugin.resolvedRef && { resolvedRef: entry.plugin.resolvedRef }),
          provenance: entry.resource.provenance,
        });
        const commands: ProfilePlanCommand[] = [];
        const registrationSource =
          OMP_MARKETPLACE_REGISTRATION_SOURCE.get(entry.plugin);
        if (registrationSource) {
          commands.push({
            command: 'omp',
            args: [
              '--profile',
              profile,
              'plugin',
              'marketplace',
              'add',
              registrationSource,
            ],
          });
        }
        const command = nativeCommandDisclosure(
          profile,
          client,
          action,
          entry.resource,
        );
        if (command) commands.push(command);
        const skills = entry.plugin.skills === undefined
          ? undefined
          : Array.isArray(entry.plugin.skills)
            ? entry.plugin.skills
            : entry.plugin.skills.exclude.map((name) => `!${name}`);
        steps.push({
          public: publicStep(
            client,
            'native',
            rel.identity,
            action,
            {
              ...(entry.plugin.requestedRef && {
                requestedRef: entry.plugin.requestedRef,
              }),
              ...(entry.plugin.resolvedRef && {
                resolvedRef: entry.plugin.resolvedRef,
              }),
            },
            {
              source: entry.resource.requestedIdentity,
              ...(skills && { skills }),
              ...(commands.length > 0 && { commands }),
            },
          ),
          relationship: rel,
          nativeResource: entry.resource,
          ...(entry.current && { currentNativeResource: entry.current }),
          context,
        });
        desiredKeys.add(rel.key);
        const marketplaceName = entry.resource.provenance.marketplaceName;
        if (marketplaceName) {
          const marketplace = previousResource(
            priorState,
            'marketplace',
            client,
            marketplaceName,
          );
          if (marketplace) desiredKeys.add(marketplace.key);
        }
      }

      for (const plugin of filePlugins) {
        const resolvedSource = await resolveFileSource(plugin, runtime);
        try {
          const skillWarnings: string[] = [];
          const collected = await collectPluginSkills(resolvedSource.path, plugin.source, undefined, basename(resolvedSource.path), undefined, plugin.skills, skillWarnings);
          warnings.push(...skillWarnings);
          const skillNameMap = plugin.skills !== undefined
            ? new Map(collected.map((skill) => [skill.folderName, skill.folderName]))
            : undefined;
          const copyResults = await copyPluginToWorkspace(resolvedSource.path, context.root, client, {
            dryRun: true,
            clientMappings: { [client]: context.fileMapping },
            writeRoot: context.root,
            syncMode: 'copy',
            ...(skillNameMap && { skillNameMap }),
          });
          const failed = copyResults.find((result) => result.action === 'failed');
          if (failed) throw new Error(failed.error ?? `Could not plan profile file ${failed.destination}`);
          for (const copy of copyResults) {
            for (const file of await expandCopyResult(copy.source, copy.destination)) {
              const planned = await planManagedFile({
                client, kind: 'file', root: context.root, path: file.destination,
                content: file.content, mode: file.mode, priorState,
                provenance: { source: plugin.source, declarationIndex: String(plugin.declarationIndex), ...(resolvedSource.resolvedSha && { resolvedSha: resolvedSource.resolvedSha }) },
                ...(resolvedSource.requestedRef && { requestedRef: resolvedSource.requestedRef }),
                ...(resolvedSource.resolvedRef && { resolvedRef: resolvedSource.resolvedRef }),
              });
              const duplicate = steps.find((step) => step.relationship.key === planned.relationship.key);
              if (duplicate) {
                if (duplicate.relationship.fingerprint !== planned.relationship.fingerprint) throw new Error(`Profile plugins collide at ${file.destination}`);
                continue;
              }
              steps.push(planned);
              desiredKeys.add(planned.relationship.key);
            }
          }
        } finally {
          await resolvedSource.cleanup?.();
        }
      }

      const serializationInput = { plugins: [...orderedNative.map((entry) => entry.plugin), ...filePlugins], settings: declaredClient.settings, ...(declaration.mcpServers && { mcpServers: declaration.mcpServers }) };
      if (Object.keys(declaredClient.settings).length > 0 && !adapter.capabilities.settings) throw new Error(`Profile client '${client}' does not support settings`);
      const settings = adapter.serializeSettings(context, serializationInput);
      if (settings) {
        const planned = await planManagedFile({ client, kind: 'settings', root: context.root, path: settings.path, content: settings.content, mode: settings.mode, priorState });
        steps.push(planned); desiredKeys.add(planned.relationship.key);
      }
      if (hasSelectedMcp(declaration, client) && !adapter.capabilities.mcp) throw new Error(`Profile client '${client}' does not support MCP configuration`);
      const mcp = adapter.serializeMcp(context, serializationInput);
      if (mcp) {
        const planned = await planManagedFile({ client, kind: 'mcp', root: context.root, path: mcp.path, content: mcp.content, mode: mcp.mode, priorState });
        steps.push({
          ...planned,
          public: {
            ...planned.public,
            detail: {
              mcpServers: mcpDisclosures(declaration, client),
            },
          },
          ...(client === 'pi' && { requiresPiMcpAdapter: true }),
          context,
        });
        desiredKeys.add(planned.relationship.key);
      }

      if (declaredClient.launcher) {
        const rendered = renderProfileLaunchers(declaredClient.launcher, context.launcher).filter((launcher) => runtime.platform === 'win32' ? launcher.companion !== 'posix' : launcher.companion === 'posix');
        for (const launcher of rendered) {
          const path = join(runtime.binDir, launcher.fileName);
          const planned = await planManagedFile({ client, kind: 'launcher', root: runtime.binDir, path, content: launcher.content, mode: launcher.mode, priorState, provenance: { launcherName: declaredClient.launcher, companion: launcher.companion } });
          steps.push(planned); desiredKeys.add(planned.relationship.key);
        }
      }
    }

    if (operation === 'update' && priorState) {
      const removalOrder: Record<ProfileStepKind, number> = {
        launcher: 0,
        mcp: 1,
        settings: 1,
        file: 1,
        native: 2,
        marketplace: 3,
        root: 4,
      };
      const staleResources = [...priorState.resources].sort(
        (left, right) => removalOrder[left.kind] - removalOrder[right.kind],
      );
      for (const resource of staleResources) {
        if (desiredKeys.has(resource.key) || resource.transition === 'removed') {
          continue;
        }
        const context = contexts.get(resource.client);
        if (!context) {
          throw new Error(`Missing stale cleanup context for ${resource.client}`);
        }
        if (resource.kind === 'native') {
          const inspection = await inspectionFor(resource.client);
          const live = inspection.resources.find(
            (candidate) => candidate.resolvedIdentity === resource.identity,
          );
          const action: ProfilePlanAction =
            resource.ownership === 'managed'
              ? live
                ? 'remove'
                : 'unchanged'
              : 'retain';
          const command = live
            ? nativeCommandDisclosure(profile, resource.client, action, live)
            : undefined;
          steps.push({
            public: publicStep(
              resource.client,
              'native',
              resource.identity,
              action,
              {},
              command
                ? {
                    ...(live?.requestedIdentity && {
                      source: live.requestedIdentity,
                    }),
                    commands: [command],
                  }
                : undefined,
            ),
            relationship: resource,
            ...(live && { nativeResource: live }),
            context,
          });
        } else if (
          resource.path &&
          ['file', 'settings', 'mcp', 'launcher'].includes(resource.kind)
        ) {
          steps.push(
            staleFileStep(
              resource,
              await fingerprintProfileFile(resource.path),
              resource.kind === 'launcher' ? runtime.binDir : context.root,
              context,
            ),
          );
        } else if (resource.kind === 'marketplace') {
          const action: ProfilePlanAction =
            resource.ownership === 'managed' ? 'remove' : 'retain';
          const marketplaceName =
            resource.provenance?.marketplaceName ?? resource.identity;
          steps.push({
            public: publicStep(
              resource.client,
              'marketplace',
              resource.identity,
              action,
              {},
              action === 'remove' && resource.client === 'omp'
                ? {
                    commands: [{
                      command: 'omp',
                      args: [
                        '--profile',
                        profile,
                        'plugin',
                        'marketplace',
                        'remove',
                        marketplaceName,
                      ],
                    }],
                  }
                : undefined,
            ),
            relationship: resource,
            context,
          });
        } else if (resource.kind === 'root') {
          const action: ProfilePlanAction =
            resource.ownership === 'managed' ? 'remove' : 'retain';
          steps.push({
            public: publicStep(resource.client, 'root', resource.identity, action),
            relationship: resource,
            root: resource.path ?? managedContextRoot(context),
            path: resource.path ?? resource.identity,
            context,
          });
        }
      }
    }
  }

  const digest = declaration ? hashProfileDeclaration(declaration) : priorState?.declarationDigest;
  if (!digest) throw new Error(`Profile '${profile}' has no declaration digest`);
  const plannedClients: ProfilePlanClient[] = [];
  for (const client of resolutionClients) {
    const context = contexts.get(client);
    if (!context) continue;
    const declared = declaration?.clients.find((entry) => entry.name === client);
    const rendered = declared?.launcher
      ? renderProfileLaunchers(declared.launcher, context.launcher).filter(
          (launcher) =>
            runtime.platform === 'win32'
              ? launcher.companion !== 'posix'
              : launcher.companion === 'posix',
        )
      : [];
    plannedClients.push({
      client,
      mechanism: context.mechanism,
      root: managedContextRoot(context),
      agentRoot: context.root,
      ...(declared?.launcher && {
        launcher: {
          name: declared.launcher,
          command: {
            command: context.launcher.command,
            args: context.launcher.args,
          },
          destinations: rendered.map((launcher) =>
            join(runtime.binDir, launcher.fileName),
          ),
        },
      }),
    });
  }
  const result: ProfilePlan = Object.freeze({
    profile,
    operation,
    declarationDigest: digest,
    clients: Object.freeze(plannedClients),
    steps: Object.freeze(steps.map((step) => step.public)),
    warnings: Object.freeze(
      warnings.map(
        (warning) =>
          sanitizeProfileError(warning) ?? 'Profile planning warning',
      ),
    ),
  });
  const internal: InternalProfilePlan = Object.freeze({ public: result, runtime, ...(declaration && { declaration }), clients: Object.freeze(desiredClients), contexts, adapters, priorState, steps: Object.freeze(steps) });
  INTERNAL_PLANS.set(result, internal);
  return result;
}
