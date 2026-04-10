import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import type { ClientType, WorkspaceConfig } from '../models/workspace-config.js';
import type { SyncState } from '../models/sync-state.js';
import {
  buildPluginSyncPlans,
  collectSyncClients,
  seedFetchCacheFromMarketplaces,
  validateAllPlugins,
  type ValidatedPlugin,
} from './sync.js';
import type { McpMergeResult } from './vscode-mcp.js';
import { collectMcpServers, syncVscodeMcpConfig } from './vscode-mcp.js';
import { syncClaudeMcpConfig } from './claude-mcp.js';
import { syncCodexProjectMcpConfig } from './codex-mcp.js';
import { applyMcpProxy, ensureProxyMetadata, getProxyMetadataPath } from './mcp-proxy.js';
import {
  getPreviouslySyncedMcpServers,
  loadSyncState,
  saveSyncState,
  type McpScope,
} from './sync-state.js';
import { ensureMarketplacesRegistered } from './marketplace.js';
import { parseWorkspaceConfig } from '../utils/workspace-parser.js';
import { migrateWorkspaceSkillsV1toV2 } from './workspace-modify.js';

/**
 * Clients that support project-scoped MCP server sync.
 */
const PROJECT_MCP_CLIENTS: ReadonlySet<ClientType> = new Set<ClientType>([
  'claude',
  'codex',
  'vscode',
  'copilot',
  'universal',
]);

/**
 * Result of running the MCP sync pipeline across all scopes.
 */
export interface SyncMcpServersResult {
  /** Per-scope merge results keyed by McpScope ('vscode' | 'claude' | 'codex' | 'copilot') */
  mcpResults: Partial<Record<McpScope, McpMergeResult>>;
  /** Warnings from collection, proxy, or per-client sync */
  warnings: string[];
  /** Per-scope tracked server names, for persisting into sync state */
  trackedServers: Partial<Record<McpScope, string[]>>;
}

interface McpSyncSpec {
  client: ClientType;
  scope: McpScope;
  configPath: string;
  syncFn: (
    validatedPlugins: ValidatedPlugin[],
    options: {
      dryRun?: boolean;
      configPath?: string;
      force?: boolean;
      trackedServers?: string[];
      serverOverrides?: Map<string, unknown>;
    },
  ) => McpMergeResult;
}

function buildSyncSpecs(workspacePath: string): McpSyncSpec[] {
  return [
    {
      client: 'vscode',
      scope: 'vscode',
      configPath: join(workspacePath, '.vscode', 'mcp.json'),
      syncFn: syncVscodeMcpConfig,
    },
    {
      client: 'claude',
      scope: 'claude',
      configPath: join(workspacePath, '.mcp.json'),
      syncFn: syncClaudeMcpConfig,
    },
    {
      client: 'codex',
      scope: 'codex',
      configPath: join(workspacePath, '.codex', 'config.toml'),
      syncFn: syncCodexProjectMcpConfig,
    },
    {
      client: 'copilot',
      scope: 'copilot',
      configPath: join(workspacePath, '.copilot', 'mcp-config.json'),
      syncFn: syncClaudeMcpConfig,
    },
  ];
}

/**
 * Sync MCP servers from plugins and workspace config into every configured
 * project-scoped client. Respects the ownership model (trackedServers) so
 * user-managed entries are never overwritten.
 *
 * This is the single source of truth for MCP-only sync behavior. It is
 * invoked both from the full `syncWorkspace` pipeline and from the
 * standalone `allagents mcp update` command.
 */
export function syncMcpServers(
  workspacePath: string,
  validPlugins: ValidatedPlugin[],
  config: WorkspaceConfig,
  previousState: SyncState | null,
  syncClients: ClientType[],
  options: { dryRun?: boolean } = {},
): SyncMcpServersResult {
  const { dryRun = false } = options;
  const warnings: string[] = [];
  const mcpResults: Partial<Record<McpScope, McpMergeResult>> = {};
  const trackedServers: Partial<Record<McpScope, string[]>> = {};

  // Prepare MCP proxy transform if configured
  const mcpProxyConfig = config.mcpProxy;
  let proxyMetadataPath: string | undefined;
  if (mcpProxyConfig) {
    if (!dryRun) {
      ensureProxyMetadata();
    }
    proxyMetadataPath = getProxyMetadataPath();
  }

  // Emit collection warnings once (e.g. workspace overriding plugin server)
  // rather than repeating them for every client scope.
  let collectWarningsEmitted = false;
  function getServersForClient(client: ClientType): Map<string, unknown> {
    const { servers, warnings: collectWarnings } = collectMcpServers(
      validPlugins,
      config.mcpServers,
      client,
    );
    if (!collectWarningsEmitted) {
      warnings.push(...collectWarnings);
      collectWarningsEmitted = true;
    }
    if (mcpProxyConfig && proxyMetadataPath) {
      return applyMcpProxy(servers, client, mcpProxyConfig, proxyMetadataPath);
    }
    return servers;
  }

  const specs = buildSyncSpecs(workspacePath);
  for (const spec of specs) {
    if (!syncClients.includes(spec.client)) continue;
    const tracked = getPreviouslySyncedMcpServers(previousState, spec.scope);
    const serverOverrides = getServersForClient(spec.client);
    const result = spec.syncFn(validPlugins, {
      dryRun,
      force: false,
      configPath: spec.configPath,
      trackedServers: tracked,
      serverOverrides,
    });
    if (result.warnings.length > 0) {
      warnings.push(...result.warnings);
    }
    mcpResults[spec.scope] = result;
    trackedServers[spec.scope] = result.trackedServers;
  }

  // Warn about configured clients that don't support project-scoped MCP sync
  // when there are servers that would otherwise have been synced.
  const anyServers = collectMcpServers(validPlugins, config.mcpServers).servers;
  if (anyServers.size > 0) {
    for (const client of syncClients) {
      if (!PROJECT_MCP_CLIENTS.has(client)) {
        warnings.push(`MCP servers not synced for ${client} (not supported at project scope)`);
      }
    }
  }

  return { mcpResults, warnings, trackedServers };
}

/**
 * Result of the standalone `mcp update` pipeline.
 */
export interface SyncMcpOnlyResult {
  success: boolean;
  mcpResults: Partial<Record<McpScope, McpMergeResult>>;
  warnings: string[];
  error?: string;
}

/**
 * Standalone MCP-only sync for the `allagents mcp update` command.
 *
 * Does the minimal amount of work needed to sync MCP servers:
 * - Parse workspace config
 * - Validate plugins (so `.mcp.json` can be discovered)
 * - Run the MCP sync pipeline
 * - Persist `mcpServers` tracking into sync state (preserving other fields)
 *
 * Does NOT copy plugin files, run managed repos, generate agent files, or
 * touch native plugin installs.
 */
export async function syncMcpOnly(
  workspacePath: string = process.cwd(),
  options: { offline?: boolean; dryRun?: boolean } = {},
): Promise<SyncMcpOnlyResult> {
  const { offline = false, dryRun = false } = options;
  await migrateWorkspaceSkillsV1toV2(workspacePath);

  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) {
    return {
      success: false,
      mcpResults: {},
      warnings: [],
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}\n  Run 'allagents workspace init' to create a new workspace`,
    };
  }

  let config: WorkspaceConfig;
  try {
    config = await parseWorkspaceConfig(configPath);
  } catch (error) {
    return {
      success: false,
      mcpResults: {},
      warnings: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const warnings: string[] = [];

  const { plans, warnings: planWarnings } = buildPluginSyncPlans(
    config.plugins,
    config.clients,
    'project',
  );
  warnings.push(...planWarnings);

  const filteredPlans = plans.filter(
    (plan) => plan.clients.length > 0 || plan.nativeClients.length > 0,
  );
  const syncClients = collectSyncClients(config.clients, filteredPlans);

  // Pre-register marketplaces so that plugin validation can resolve them.
  // Skip in offline mode to avoid network calls.
  if (!offline) {
    const marketplaceResults = await ensureMarketplacesRegistered(
      filteredPlans.map((plan) => plan.source),
    );
    await seedFetchCacheFromMarketplaces(marketplaceResults);
  }

  // Validate plugins so we can read their .mcp.json files
  const validatedPlugins = await validateAllPlugins(filteredPlans, workspacePath, offline);
  const validPlugins = validatedPlugins.filter((v): v is ValidatedPlugin => v.success);
  warnings.push(
    ...validatedPlugins.filter((v) => !v.success).map((v) => `${v.plugin}: ${v.error} (skipped)`),
  );

  const previousState = await loadSyncState(workspacePath);

  const syncResult = syncMcpServers(
    workspacePath,
    validPlugins,
    config,
    previousState,
    syncClients,
    { dryRun },
  );

  warnings.push(...syncResult.warnings);

  // Persist mcpServers tracking into sync state (preserve other fields)
  if (!dryRun) {
    const hasMcpChanges = Object.values(syncResult.mcpResults).some(
      (r) => r && (r.added > 0 || r.overwritten > 0 || r.removed > 0),
    );
    if (hasMcpChanges) {
      await saveSyncState(workspacePath, {
        files: (previousState?.files as Record<ClientType, string[]>) ?? {},
        mcpServers: syncResult.trackedServers,
        ...(previousState?.nativePlugins && { nativePlugins: previousState.nativePlugins }),
        ...(previousState?.vscodeWorkspaceHash && { vscodeWorkspaceHash: previousState.vscodeWorkspaceHash }),
        ...(previousState?.vscodeWorkspaceRepos && { vscodeWorkspaceRepos: previousState.vscodeWorkspaceRepos }),
        ...(previousState?.skillsIndex && { skillsIndex: previousState.skillsIndex }),
      });
    }
  }

  return {
    success: true,
    mcpResults: syncResult.mcpResults,
    warnings,
  };
}
