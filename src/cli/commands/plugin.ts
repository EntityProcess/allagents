import { command, positional, option, string, optional, multioption, array, flag } from 'cmd-ts';
import {
  addMarketplace,
  listMarketplaces,
  removeMarketplace,
  updateMarketplace,
  listMarketplacePlugins,
  findMarketplace,
  parsePluginSpec,
  getAllagentsDir,
  getMarketplaceVersion,
  listMarketplacesWithScope,
  getRegistryPath,
  getProjectRegistryPath,
  loadRegistryFromPath,
  type ScopedMarketplaceEntry,
  getMarketplaceOverrides,
} from '../../core/marketplace.js';
import { syncWorkspace, syncUserWorkspace } from '../../core/sync.js';
import { loadSyncState } from '../../core/sync-state.js';
import { addPlugin, removePlugin, hasPlugin, ensureWorkspace, addEnabledSkill, extractPluginNames } from '../../core/workspace-modify.js';
import {
  addUserPlugin,
  removeUserPlugin,
  hasUserPlugin,
  isUserConfigPath,
  getInstalledUserPlugins,
  getInstalledProjectPlugins,
  getUserWorkspaceConfig,
  addUserEnabledSkill,
  type InstalledPluginInfo,
} from '../../core/user-workspace.js';
import { updatePlugin, type InstalledPluginUpdateResult } from '../../core/plugin.js';
import { getAllSkillsFromPlugins } from '../../core/skills.js';
import { parseMarketplaceManifest } from '../../utils/marketplace-manifest-parser.js';
import { isJsonMode, jsonOutput } from '../json-output.js';
import { buildDescription, conciseSubcommands } from '../help.js';
import {
  marketplaceListMeta,
  marketplaceAddMeta,
  marketplaceRemoveMeta,
  marketplaceUpdateMeta,
  marketplaceBrowseMeta,
  pluginListMeta,
  pluginValidateMeta,
  pluginInstallMeta,
  pluginUninstallMeta,
  pluginUpdateMeta,
} from '../metadata/plugin.js';
import { skillsCmd } from './plugin-skills.js';
import { formatMcpResult, formatNativeResult, buildSyncData, formatPluginArtifacts, formatPluginHeader } from '../format-sync.js';
import {
  getPluginSource,
  getPluginClients,
  getClientTypes,
  type PluginEntry,
  type WorkspaceConfig,
} from '../../models/workspace-config.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE, getHomeDir } from '../../constants.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';


/**
 * Run sync and print results. Returns true if sync succeeded.
 */
async function runSyncAndPrint(options?: { skipAgentFiles?: boolean }): Promise<{ ok: boolean; syncData: ReturnType<typeof buildSyncData> | null }> {
  if (!isJsonMode()) {
    console.log('\nUpdating workspace...\n');
  }
  const result = await syncWorkspace(process.cwd(), options);

  if (!result.success && result.error) {
    if (!isJsonMode()) {
      console.error(`Sync error: ${result.error}`);
    }
    return { ok: false, syncData: null };
  }

  const syncData = buildSyncData(result);

  if (!isJsonMode()) {
    for (const pluginResult of result.pluginResults) {
      console.log(formatPluginHeader(pluginResult));

      if (pluginResult.error) {
        console.log(`  Error: ${pluginResult.error}`);
      }

      for (const line of formatPluginArtifacts(pluginResult.copyResults)) {
        console.log(line);
      }

      const generated = pluginResult.copyResults.filter(
        (r) => r.action === 'generated',
      ).length;
      const failed = pluginResult.copyResults.filter(
        (r) => r.action === 'failed',
      ).length;

      if (generated > 0) console.log(`  Generated: ${generated} files`);
      if (failed > 0) {
        console.log(`  Failed: ${failed} files`);
        for (const failedResult of pluginResult.copyResults.filter(
          (r) => r.action === 'failed',
        )) {
          console.log(
            `    - ${failedResult.destination}: ${failedResult.error}`,
          );
        }
      }
    }

    // Print MCP server sync results
    if (result.mcpResults) {
      for (const [scope, mcpResult] of Object.entries(result.mcpResults)) {
        if (!mcpResult) continue;
        const mcpLines = formatMcpResult(mcpResult, scope);
        if (mcpLines.length > 0) {
          console.log('');
          for (const line of mcpLines) {
            console.log(line);
          }
        }
      }
    }

    // Print native plugin sync results
    if (result.nativeResult) {
      const nativeLines = formatNativeResult(result.nativeResult);
      if (nativeLines.length > 0) {
        console.log('\nnative:');
        for (const line of nativeLines) {
          console.log(line);
        }
      }
    }

    if (result.warnings && result.warnings.length > 0) {
      console.log('\nWarnings:');
      for (const warning of result.warnings) {
        console.log(`  \u26A0 ${warning}`);
      }
    }
  }

  return { ok: result.success && result.totalFailed === 0, syncData };
}

/**
 * Run user-scope sync and print results. Returns true if sync succeeded.
 */
async function runUserSyncAndPrint(): Promise<{ ok: boolean; syncData: ReturnType<typeof buildSyncData> | null }> {
  const result = await syncUserWorkspace();

  if (!result.success && result.error) {
    if (!isJsonMode()) {
      console.error(`Sync error: ${result.error}`);
    }
    return { ok: false, syncData: null };
  }

  const syncData = buildSyncData(result);

  if (!isJsonMode()) {
    for (const pluginResult of result.pluginResults) {
      console.log(formatPluginHeader(pluginResult));

      if (pluginResult.error) {
        console.log(`  Error: ${pluginResult.error}`);
      }

      for (const line of formatPluginArtifacts(pluginResult.copyResults)) {
        console.log(line);
      }

      const generated = pluginResult.copyResults.filter(
        (r) => r.action === 'generated',
      ).length;
      const failed = pluginResult.copyResults.filter(
        (r) => r.action === 'failed',
      ).length;

      if (generated > 0) console.log(`  Generated: ${generated} files`);
      if (failed > 0) {
        console.log(`  Failed: ${failed} files`);
        for (const failedResult of pluginResult.copyResults.filter(
          (r) => r.action === 'failed',
        )) {
          console.log(
            `    - ${failedResult.destination}: ${failedResult.error}`,
          );
        }
      }
    }

    // Print MCP server sync results
    if (result.mcpResults) {
      for (const [scope, mcpResult] of Object.entries(result.mcpResults)) {
        if (!mcpResult) continue;
        const mcpLines = formatMcpResult(mcpResult, scope);
        if (mcpLines.length > 0) {
          console.log('');
          for (const line of mcpLines) {
            console.log(line);
          }
        }
      }
    }

    // Print native plugin sync results
    if (result.nativeResult) {
      const nativeLines = formatNativeResult(result.nativeResult);
      if (nativeLines.length > 0) {
        console.log('\nnative:');
        for (const line of nativeLines) {
          console.log(line);
        }
      }
    }

  }

  return { ok: result.success && result.totalFailed === 0, syncData };
}

// =============================================================================
// plugin marketplace list
// =============================================================================

const marketplaceListCmd = command({
  name: 'list',
  description: buildDescription(marketplaceListMeta),
  args: {
    scope: option({ type: optional(string), long: 'scope', short: 's', description: 'Filter by scope: user or project' }),
  },
  handler: async ({ scope }) => {
    try {
      if (scope && scope !== 'user' && scope !== 'project') {
        const msg = `Invalid scope '${scope}'. Must be 'user' or 'project'.`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace list', error: msg });
          process.exit(1);
        }
        console.error(`Error: ${msg}`);
        process.exit(1);
      }

      let marketplaces: ScopedMarketplaceEntry[];
      let overrideNames: string[] = [];

      if (!scope) {
        // Default: show all scopes merged
        const scopedResult = await listMarketplacesWithScope(getRegistryPath(), getProjectRegistryPath(process.cwd()));
        marketplaces = scopedResult.entries;
        overrideNames = scopedResult.overrides;
      } else if (scope === 'user') {
        const registry = await loadRegistryFromPath(getRegistryPath());
        marketplaces = Object.values(registry.marketplaces).map((mp) => ({ ...mp, scope: 'user' as const }));
      } else {
        const registry = await loadRegistryFromPath(getProjectRegistryPath(process.cwd()));
        marketplaces = Object.values(registry.marketplaces).map((mp) => ({ ...mp, scope: 'project' as const }));
      }

      if (isJsonMode()) {
        const enriched = await Promise.all(
          marketplaces.map(async (mp) => {
            const version = await getMarketplaceVersion(mp.path);
            return {
              ...mp,
              ...(version && {
                commitHash: version.hash,
                commitTimestamp: version.date.toISOString(),
              }),
            };
          }),
        );
        jsonOutput({
          success: true,
          command: 'plugin marketplace list',
          data: { marketplaces: enriched },
        });
        return;
      }

      // Emit override warnings when listing all scopes
      for (const overrideName of overrideNames) {
        console.warn(`Warning: Workspace marketplace '${overrideName}' overrides user marketplace of the same name.`);
      }

      if (marketplaces.length === 0) {
        console.log('No marketplaces registered.\n');
        console.log('Add a marketplace with:');
        console.log('  allagents plugin marketplace add <source>\n');
        console.log('Examples:');
        console.log('  allagents plugin marketplace add owner/repo');
        console.log('  allagents plugin marketplace add https://github.com/owner/repo');
        return;
      }

      console.log('Registered marketplaces:\n');

      for (const mp of marketplaces) {
        let sourceLabel: string;
        switch (mp.source.type) {
          case 'github':
            sourceLabel = `GitHub: ${mp.source.location}`;
            break;
          case 'git':
            sourceLabel = `Git: ${mp.source.location}`;
            break;
          default:
            sourceLabel = `Local: ${mp.source.location}`;
        }

        console.log(`  ❯ ${mp.name} (${mp.scope})`);
        console.log(`    Source: ${sourceLabel}`);

        const version = await getMarketplaceVersion(mp.path);
        if (version) {
          const ts = version.date.toISOString().replace('T', ' ').slice(0, 16);
          console.log(`    Version: ${version.hash} (${ts})`);
        }

        console.log();
      }

      console.log(`Total: ${marketplaces.length} marketplace(s)`);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace list', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// plugin marketplace add
// =============================================================================

const marketplaceAddCmd = command({
  name: 'add',
  description: buildDescription(marketplaceAddMeta),
  args: {
    source: positional({ type: string, displayName: 'source' }),
    name: option({ type: optional(string), long: 'name', short: 'n', description: 'Custom name for the marketplace' }),
    branch: option({ type: optional(string), long: 'branch', short: 'b', description: 'Branch to checkout after cloning' }),
    force: flag({ long: 'force', short: 'f', description: 'Replace marketplace if it already exists' }),
    scope: option({ type: optional(string), long: 'scope', short: 's', description: 'Scope: user (default) or project' }),
  },
  handler: async ({ source, name, branch, force, scope }) => {
    try {
      const effectiveScope = (scope ?? 'user') as import('../../core/marketplace.js').MarketplaceScope;
      if (effectiveScope !== 'user' && effectiveScope !== 'project') {
        const msg = `Invalid scope '${scope}'. Must be 'user' or 'project'.`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace add', error: msg });
          process.exit(1);
        }
        console.error(`Error: ${msg}`);
        process.exit(1);
      }

      if (effectiveScope === 'project') {
        if (!existsSync(join(process.cwd(), CONFIG_DIR, WORKSPACE_CONFIG_FILE))) {
          const msg = 'No workspace found in current directory. Run "allagents workspace init" first.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'plugin marketplace add', error: msg });
            process.exit(1);
          }
          console.error(`Error: ${msg}`);
          process.exit(1);
        }
      }

      if (!isJsonMode()) {
        console.log(`Adding marketplace: ${source}...`);
      }

      const result = await addMarketplace(source, name, branch, force, {
        scope: effectiveScope,
        workspacePath: process.cwd(),
      });

      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace add', error: result.error ?? 'Unknown error' });
          process.exit(1);
        }
        console.error(`\nError: ${result.error}`);
        process.exit(1);
      }

      if (result.replaced && !isJsonMode()) {
        console.log(`Marketplace '${result.marketplace?.name}' already exists. Replacing with new source.`);
      }

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'plugin marketplace add',
          data: {
            marketplace: {
              name: result.marketplace?.name,
              path: result.marketplace?.path,
              replaced: result.replaced,
            },
          },
        });
        return;
      }

      console.log(`\u2713 Marketplace '${result.marketplace?.name}' added`);
      console.log(`  Path: ${result.marketplace?.path}`);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace add', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// plugin marketplace remove
// =============================================================================

const marketplaceRemoveCmd = command({
  name: 'remove',
  description: buildDescription(marketplaceRemoveMeta),
  args: {
    name: positional({ type: string, displayName: 'name' }),
    scope: option({ type: optional(string), long: 'scope', short: 's', description: 'Filter by scope: user or project (default: removes from both)' }),
  },
  handler: async ({ name, scope }) => {
    try {
      if (scope && scope !== 'user' && scope !== 'project') {
        const msg = `Invalid scope '${scope}'. Must be 'user' or 'project'.`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace remove', error: msg });
          process.exit(1);
        }
        console.error(`Error: ${msg}`);
        process.exit(1);
      }

      // No --scope: remove from both; --scope user/project: remove from that scope only
      const effectiveScope = (scope ?? 'all') as import('../../core/marketplace.js').MarketplaceScope | 'all';

      const result = await removeMarketplace(name, {
        scope: effectiveScope,
        workspacePath: process.cwd(),
      });

      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace remove', error: result.error ?? 'Unknown error' });
          process.exit(1);
        }
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'plugin marketplace remove',
          data: {
            name,
            path: result.marketplace?.path,
            retainedUserPlugins: result.retainedUserPlugins ?? [],
          },
        });
        return;
      }

      console.log(`\u2713 Marketplace '${name}' removed`);
      if (result.retainedUserPlugins && result.retainedUserPlugins.length > 0) {
        console.log(`\n  \u26A0 ${result.retainedUserPlugins.length} plugin(s) still reference this marketplace:`);
        for (const p of result.retainedUserPlugins) {
          console.log(`    - ${p}`);
        }
        console.log('\n  To remove them: allagents plugin remove <name>');
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace remove', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// plugin marketplace update
// =============================================================================

const marketplaceUpdateCmd = command({
  name: 'update',
  description: buildDescription(marketplaceUpdateMeta),
  args: {
    name: positional({ type: optional(string), displayName: 'name' }),
  },
  handler: async ({ name }) => {
    try {
      if (!isJsonMode()) {
        console.log(
          name
            ? `Updating marketplace: ${name}...`
            : 'Updating all marketplaces...',
        );
        console.log();
      }

      const results = await updateMarketplace(name, process.cwd());

      if (isJsonMode()) {
        const succeeded = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;
        jsonOutput({
          success: failed === 0,
          command: 'plugin marketplace update',
          data: { results, succeeded, failed },
          ...(failed > 0 && { error: `${failed} marketplace(s) failed to update` }),
        });
        if (failed > 0) {
          process.exit(1);
        }
        return;
      }

      if (results.length === 0) {
        console.log('No marketplaces to update.');
        return;
      }

      let successCount = 0;
      let failCount = 0;

      for (const result of results) {
        if (result.success) {
          console.log(`\u2713 ${result.name}`);
          successCount++;
        } else {
          console.log(`\u2717 ${result.name}: ${result.error}`);
          failCount++;
        }
      }

      console.log();
      console.log(`Updated: ${successCount}, Failed: ${failCount}`);

      if (failCount > 0) {
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace update', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// plugin marketplace browse
// =============================================================================

const marketplaceBrowseCmd = command({
  name: 'browse',
  description: buildDescription(marketplaceBrowseMeta),
  args: {
    name: positional({ type: string, displayName: 'name' }),
  },
  handler: async ({ name }) => {
    try {
      if (!await findMarketplace(name, undefined, process.cwd())) {
        const error = `Marketplace '${name}' not found`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace browse', error });
          process.exit(1);
        }
        console.error(`Error: ${error}`);
        console.log('\nTo see registered marketplaces:');
        console.log('  allagents plugin marketplace list');
        process.exit(1);
      }

      const result = await listMarketplacePlugins(name, process.cwd());

      // Build installed lookup
      const userPlugins = await getInstalledUserPlugins();
      const projectPlugins = await getInstalledProjectPlugins(process.cwd());
      const installedMap = new Map<string, InstalledPluginInfo>();

      // Build reverse lookup: repo name -> marketplace name
      const marketplaces = await listMarketplaces();
      const repoToMarketplace = new Map<string, string>();
      for (const mp of marketplaces) {
        if (mp.source.type === 'github') {
          const parts = mp.source.location.split('/');
          if (parts.length >= 2 && parts[1]) {
            repoToMarketplace.set(parts[1], mp.name);
          }
        }
      }
      const resolveMarketplaceName = (mpName: string): string => {
        return repoToMarketplace.get(mpName) ?? mpName;
      };

      for (const p of userPlugins) {
        const mpName = resolveMarketplaceName(p.marketplace);
        installedMap.set(`${p.name}@${mpName}`, p);
      }
      for (const p of projectPlugins) {
        const mpName = resolveMarketplaceName(p.marketplace);
        installedMap.set(`${p.name}@${mpName}`, p);
      }

      const plugins = result.plugins.map((plugin) => {
        const key = `${plugin.name}@${name}`;
        const installed = installedMap.get(key);
        return {
          name: plugin.name,
          description: plugin.description ?? null,
          installed: !!installed,
          scope: installed?.scope ?? null,
        };
      });

      const installedCount = plugins.filter((p) => p.installed).length;

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'plugin marketplace browse',
          data: {
            marketplace: name,
            plugins,
            total: plugins.length,
            installed: installedCount,
            ...(result.warnings.length > 0 && { warnings: result.warnings }),
          },
        });
        return;
      }

      // Print warnings
      for (const warning of result.warnings) {
        console.log(`  Warning: ${warning}`);
      }

      if (plugins.length === 0) {
        console.log(`No plugins found in "${name}" marketplace.`);
        return;
      }

      console.log(`Plugins in "${name}" marketplace:\n`);
      for (const plugin of plugins) {
        const status = plugin.installed ? ` (installed - ${plugin.scope})` : '';
        console.log(`  ❯ ${plugin.name}${status}`);
        if (plugin.description) {
          console.log(`    ${plugin.description}`);
        }
        console.log();
      }

      console.log(`Total: ${plugins.length} plugins (${installedCount} installed)`);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace browse', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// plugin marketplace subcommands group
// =============================================================================

const marketplaceCmd = conciseSubcommands({
  name: 'marketplace',
  description: 'Manage plugin marketplaces',
  cmds: {
    list: marketplaceListCmd,
    browse: marketplaceBrowseCmd,
    add: marketplaceAddCmd,
    remove: marketplaceRemoveCmd,
    update: marketplaceUpdateCmd,
  },
});

// =============================================================================
// plugin list command - list installed plugins
// =============================================================================

const pluginListCmd = command({
  name: 'list',
  description: buildDescription(pluginListMeta),
  args: {},
  handler: async () => {
    try {
      // Build per-plugin client map from workspace configs
      // key = "spec:scope" → file-sync client types
      const pluginClients = new Map<string, string[]>();

      // Canonical key for deduplication: uses parsed name+marketplace so different
      // spec formats (e.g., "plugin@owner/repo" vs "plugin@repo") resolve to the same key
      function canonicalKey(name: string, marketplace: string, scope: string): string {
        return `${name}:${marketplace}:${scope}`;
      }

      async function loadConfigClients(
        configPath: string,
        scope: 'user' | 'project',
      ): Promise<void> {
        if (!existsSync(configPath)) return;
        try {
          const content = await readFile(configPath, 'utf-8');
          const config = load(content) as WorkspaceConfig;
          if (!config?.plugins || !config?.clients) return;
          const defaultClients = getClientTypes(config.clients);
          for (const entry of config.plugins) {
            const spec = getPluginSource(entry);
            const clients = getPluginClients(entry) ?? defaultClients;
            pluginClients.set(`${spec}:${scope}`, clients);
          }
        } catch { /* ignore read/parse errors */ }
      }

      const userConfigPath = join(getAllagentsDir(), WORKSPACE_CONFIG_FILE);
      const projectConfigPath = join(process.cwd(), CONFIG_DIR, WORKSPACE_CONFIG_FILE);
      await loadConfigClients(userConfigPath, 'user');
      await loadConfigClients(projectConfigPath, 'project');

      // Get installed marketplace plugins
      const userPlugins = await getInstalledUserPlugins();
      const projectPlugins = await getInstalledProjectPlugins(process.cwd());
      const allInstalled = [...userPlugins, ...projectPlugins];

      // Load native plugins from sync state
      const userSyncState = await loadSyncState(getAllagentsDir());
      const projectSyncState = await loadSyncState(process.cwd());

      // Build merged map: key = "name:marketplace:scope" for format-independent dedup
      interface MergedPlugin {
        spec: string;
        name: string;
        marketplace: string;
        scope: 'user' | 'project';
        fileClients: string[];
        nativeClients: string[];
      }
      const merged = new Map<string, MergedPlugin>();

      for (const p of allInstalled) {
        const key = canonicalKey(p.name, p.marketplace, p.scope);
        merged.set(key, {
          spec: p.spec,
          name: p.name,
          marketplace: p.marketplace,
          scope: p.scope,
          fileClients: pluginClients.get(`${p.spec}:${p.scope}`) ?? [],
          nativeClients: [],
        });
      }

      // Merge native plugins using the same canonical key
      for (const [state, scope] of [
        [userSyncState, 'user'],
        [projectSyncState, 'project'],
      ] as const) {
        for (const [client, specs] of Object.entries(state?.nativePlugins ?? {})) {
          for (const spec of specs) {
            const parsed = parsePluginSpec(spec);
            const key = parsed
              ? canonicalKey(parsed.plugin, parsed.marketplaceName, scope)
              : `${spec}::${scope}`;
            const existing = merged.get(key);
            if (existing) {
              if (!existing.nativeClients.includes(client)) {
                existing.nativeClients.push(client);
              }
            } else {
              merged.set(key, {
                spec,
                name: parsed?.plugin ?? spec,
                marketplace: parsed?.marketplaceName ?? '',
                scope,
                fileClients: [],
                nativeClients: [client],
              });
            }
          }
        }
      }

      const plugins = [...merged.values()];

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'plugin list',
          data: {
            plugins: plugins.map((p) => ({
              name: p.name,
              marketplace: p.marketplace,
              scope: p.scope,
              ...(p.fileClients.length > 0 && { clients: p.fileClients }),
              ...(p.nativeClients.length > 0 && { nativeClients: p.nativeClients }),
            })),
            total: plugins.length,
          },
        });
        return;
      }

      if (plugins.length === 0) {
        console.log('No plugins installed.\n');
        console.log('To discover available plugins:');
        console.log('  allagents plugin marketplace browse <name>\n');
        console.log('To see registered marketplaces:');
        console.log('  allagents plugin marketplace list');
        return;
      }

      console.log('Installed plugins:\n');
      for (const p of plugins) {
        console.log(`  ❯ ${p.spec}`);
        console.log(`    Scope: ${p.scope}`);

        const hasClients = p.fileClients.length > 0 || p.nativeClients.length > 0;
        if (hasClients) {
          const parts = [
            ...p.nativeClients.map((c) => `native ${c}`),
            ...p.fileClients,
          ];
          console.log(`    Clients: ${parts.join(', ')}`);
        }
        console.log('');
      }

      console.log(`Total: ${plugins.length} installed`);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin list', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// plugin validate command - validate a plugin structure
// =============================================================================

const pluginValidateCmd = command({
  name: 'validate',
  description: buildDescription(pluginValidateMeta),
  args: {
    path: positional({ type: string, displayName: 'path' }),
  },
  handler: async ({ path }) => {
    if (isJsonMode()) {
      jsonOutput({
        success: true,
        command: 'plugin validate',
        data: { path, valid: false, message: 'not yet implemented' },
      });
      return;
    }
    // TODO: Implement plugin validation
    console.log(`Validating plugin at: ${path}`);
    console.log('(validation not yet implemented)');
  },
});

// =============================================================================
// plugin install
// =============================================================================

const pluginInstallCmd = command({
  name: 'install',
  description: buildDescription(pluginInstallMeta),
  args: {
    plugin: positional({ type: string, displayName: 'plugin' }),
    scope: option({ type: optional(string), long: 'scope', short: 's', description: 'Installation scope: "project" (default) or "user"' }),
    skills: multioption({
      type: array(string),
      long: 'skill',
      description: 'Only enable specific skills (can be repeated)',
    }),
  },
  handler: async ({ plugin, scope, skills }) => {
    try {
      // Treat as user scope if explicitly requested or if cwd resolves to user config
      const isUser = scope === 'user' || (!scope && isUserConfigPath(process.cwd()));

      // If no workspace.yaml exists for project scope, prompt for clients first
      if (!isUser) {
        const configPath = join(process.cwd(), CONFIG_DIR, WORKSPACE_CONFIG_FILE);
        if (!existsSync(configPath)) {
          const { promptForClients } = await import('../tui/prompt-clients.js');
          const clients = await promptForClients();
          if (clients === null) {
            if (isJsonMode()) {
              jsonOutput({ success: false, command: 'plugin install', error: 'Cancelled' });
            }
            return;
          }
          await ensureWorkspace(process.cwd(), clients);
        }
      }

      // Emit override warnings for project-scope installs
      if (!isUser) {
        const overrideNames = await getMarketplaceOverrides(
          getRegistryPath(),
          getProjectRegistryPath(process.cwd()),
        );
        for (const name of overrideNames) {
          console.warn(`Warning: Workspace marketplace '${name}' overrides user marketplace of the same name.`);
        }
      }

      // Always force-reinstall if the plugin already exists (no error, just overwrite)
      const result = isUser
        ? await addUserPlugin(plugin, true)
        : await addPlugin(plugin, process.cwd(), true);

      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin install', error: result.error ?? 'Unknown error' });
          process.exit(1);
        }
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      const displayPlugin = result.normalizedPlugin ?? plugin;

      // Handle --skill flag: write enabledSkills BEFORE sync so only one sync pass is needed
      if (skills.length > 0) {
        const workspacePath = isUser ? getHomeDir() : process.cwd();

        // Do an initial sync to fetch the plugin so we can discover its skills.
        const initialSync = isUser
          ? await syncUserWorkspace()
          : await syncWorkspace(workspacePath);

        if (!initialSync.success) {
          const error = `Initial sync failed: ${initialSync.error ?? 'Unknown error'}`;
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'plugin install', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }

        const allSkills = await getAllSkillsFromPlugins(workspacePath);
        const displayNames = extractPluginNames(displayPlugin);
        const pluginSkills = allSkills.filter((s) =>
          s.pluginSource === displayPlugin || displayNames.includes(s.pluginName),
        );

        if (pluginSkills.length === 0) {
          if (!isJsonMode()) {
            console.error(`Warning: No skills found in plugin ${displayPlugin}`);
          }
        } else {
          const pluginName = pluginSkills[0]?.pluginName;
          const availableNames = pluginSkills.map((s) => s.name);

          // Validate requested skill names
          const invalid = skills.filter((s) => !availableNames.includes(s));
          if (invalid.length > 0) {
            const error = `Unknown skills: ${invalid.join(', ')}. Available: ${availableNames.join(', ')}`;
            if (isJsonMode()) {
              jsonOutput({ success: false, command: 'plugin install', error });
              process.exit(1);
            }
            console.error(`Error: ${error}`);
            process.exit(1);
          }

          // Add each skill to enabledSkills
          for (const skillName of skills) {
            const skillKey = `${pluginName}:${skillName}`;
            const addResult = isUser
              ? await addUserEnabledSkill(skillKey)
              : await addEnabledSkill(skillKey, workspacePath);
            if (!addResult.success && !isJsonMode()) {
              console.error(`Warning: ${addResult.error}`);
            }
          }

          if (!isJsonMode()) {
            console.log(`\nEnabled skills: ${skills.join(', ')}`);
          }
        }
      }

      if (result.replaced && !isJsonMode()) {
        console.log(`Plugin '${displayPlugin}' already exists. Replacing with new source.`);
      }

      if (!isJsonMode()) {
        if (result.autoRegistered) {
          console.log(`  Resolved marketplace: ${result.autoRegistered}`);
        }
        console.log(`Installing plugin "${displayPlugin}"...`);
      }

      // Single sync pass (enabledSkills already written if --skill was used)
      const { ok: syncOk, syncData } = isUser
        ? await runUserSyncAndPrint()
        : await runSyncAndPrint();

      if (!isJsonMode() && syncOk) {
        console.log(`\u2714 Successfully installed plugin: ${displayPlugin} (scope: ${isUser ? 'user' : 'project'})`);
      }

      if (isJsonMode()) {
        jsonOutput({
          success: syncOk,
          command: 'plugin install',
          data: {
            plugin: displayPlugin,
            scope: isUser ? 'user' : 'project',
            autoRegistered: result.autoRegistered ?? null,
            ...(skills.length > 0 && { enabledSkills: skills }),
            replaced: result.replaced ?? false,
            syncResult: syncData,
          },
          ...(!syncOk && { error: 'Sync completed with failures' }),
        });
        if (!syncOk) process.exit(1);
        return;
      }

      if (!syncOk) process.exit(1);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin install', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// plugin uninstall
// =============================================================================

const pluginUninstallCmd = command({
  name: 'uninstall',
  description: buildDescription(pluginUninstallMeta),
  aliases: ['remove'],
  args: {
    plugin: positional({ type: string, displayName: 'plugin' }),
    scope: option({ type: optional(string), long: 'scope', short: 's', description: 'Installation scope: "project" (default) or "user"' }),
  },
  handler: async ({ plugin, scope }) => {
    try {
      // When an explicit scope is given, only uninstall from that scope
      if (scope) {
        const isUser = scope === 'user';
        const result = isUser
          ? await removeUserPlugin(plugin)
          : await removePlugin(plugin);

        if (!result.success) {
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'plugin uninstall', error: result.error ?? 'Unknown error' });
            process.exit(1);
          }
          console.error(`Error: ${result.error}`);
          process.exit(1);
        }

        if (isJsonMode()) {
          const { ok, syncData } = isUser
            ? await runUserSyncAndPrint()
            : await runSyncAndPrint();
          jsonOutput({
            success: ok,
            command: 'plugin uninstall',
            data: { plugin, scope, syncResult: syncData },
            ...(!ok && { error: 'Sync completed with failures' }),
          });
          if (!ok) process.exit(1);
          return;
        }

        console.log(`\u2713 Uninstalled plugin (${scope} scope): ${plugin}`);
        const { ok: syncOk } = isUser
          ? await runUserSyncAndPrint()
          : await runSyncAndPrint();
        if (!syncOk) process.exit(1);
        return;
      }

      // No explicit scope: uninstall from all scopes where the plugin exists
      // Skip project scope if it resolves to the user config (e.g., cwd is ~)
      const inProject = isUserConfigPath(process.cwd()) ? false : await hasPlugin(plugin);
      const inUser = await hasUserPlugin(plugin);

      if (!inProject && !inUser) {
        const error = `Plugin not found: ${plugin}`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin uninstall', error });
          process.exit(1);
        }
        console.error(`Error: ${error}`);
        process.exit(1);
      }

      const removedScopes: string[] = [];

      if (inProject) {
        const result = await removePlugin(plugin);
        if (!result.success) {
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'plugin uninstall', error: result.error ?? 'Unknown error' });
            process.exit(1);
          }
          console.error(`Error: ${result.error}`);
          process.exit(1);
        }
        removedScopes.push('project');
      }

      if (inUser) {
        const result = await removeUserPlugin(plugin);
        if (!result.success) {
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'plugin uninstall', error: result.error ?? 'Unknown error' });
            process.exit(1);
          }
          console.error(`Error: ${result.error}`);
          process.exit(1);
        }
        removedScopes.push('user');
      }

      if (isJsonMode()) {
        const syncResults: Record<string, ReturnType<typeof buildSyncData> | null> = {};
        let allOk = true;
        if (removedScopes.includes('project')) {
          const { ok, syncData } = await runSyncAndPrint();
          syncResults.project = syncData;
          if (!ok) allOk = false;
        }
        if (removedScopes.includes('user')) {
          const { ok, syncData } = await runUserSyncAndPrint();
          syncResults.user = syncData;
          if (!ok) allOk = false;
        }
        jsonOutput({
          success: allOk,
          command: 'plugin uninstall',
          data: { plugin, scopes: removedScopes, syncResults },
          ...(!allOk && { error: 'Sync completed with failures' }),
        });
        if (!allOk) process.exit(1);
        return;
      }

      const scopeLabel = removedScopes.join(' + ');
      console.log(`\u2713 Uninstalled plugin (${scopeLabel} scope): ${plugin}`);

      let syncOk = true;
      if (removedScopes.includes('project')) {
        const { ok } = await runSyncAndPrint();
        if (!ok) syncOk = false;
      }
      if (removedScopes.includes('user')) {
        const { ok } = await runUserSyncAndPrint();
        if (!ok) syncOk = false;
      }
      if (!syncOk) process.exit(1);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin uninstall', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// plugin update
// =============================================================================

const pluginUpdateCmd = command({
  name: 'update',
  description: buildDescription(pluginUpdateMeta),
  args: {
    plugin: positional({ type: optional(string), displayName: 'plugin' }),
    scope: option({ type: optional(string), long: 'scope', short: 's', description: 'Installation scope: "project" (default), "user", or "all"' }),
  },
  handler: async ({ plugin, scope }) => {
    try {
      // Determine which plugins to update based on scope
      const updateAll = scope === 'all';
      const updateUser = scope === 'user' || updateAll;
      const updateProject = scope === 'project' || (!scope && !updateAll) || updateAll;

      // Collect installed plugins based on scope
      const pluginsToUpdate: string[] = [];

      if (updateProject && !isUserConfigPath(process.cwd())) {
        const projectPlugins = await getInstalledProjectPlugins(process.cwd());
        for (const p of projectPlugins) {
          pluginsToUpdate.push(p.spec);
        }
      }

      if (updateUser) {
        const userPlugins = await getInstalledUserPlugins();
        for (const p of userPlugins) {
          // Avoid duplicates if same plugin is in both scopes
          if (!pluginsToUpdate.includes(p.spec)) {
            pluginsToUpdate.push(p.spec);
          }
        }
      }

      // Also include raw plugin entries (GitHub URLs, local paths)
      if (updateProject && !isUserConfigPath(process.cwd())) {
        const { existsSync } = await import('node:fs');
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const { load } = await import('js-yaml');
        const { CONFIG_DIR, WORKSPACE_CONFIG_FILE } = await import('../../constants.js');
        const configPath = join(process.cwd(), CONFIG_DIR, WORKSPACE_CONFIG_FILE);
        if (existsSync(configPath)) {
          const content = await readFile(configPath, 'utf-8');
          const config = load(content) as { plugins?: PluginEntry[] };
          for (const entry of config.plugins ?? []) {
            const p = getPluginSource(entry);
            if (!pluginsToUpdate.includes(p)) {
              pluginsToUpdate.push(p);
            }
          }
        }
      }

      if (updateUser) {
        const userConfig = await getUserWorkspaceConfig();
        if (userConfig) {
          for (const entry of userConfig.plugins ?? []) {
            const p = getPluginSource(entry);
            if (!pluginsToUpdate.includes(p)) {
              pluginsToUpdate.push(p);
            }
          }
        }
      }

      // Filter to specific plugin if provided
      const toUpdate = plugin
        ? pluginsToUpdate.filter((p) => {
            // Match by full spec or just plugin name
            if (p === plugin) return true;
            const parsed = parsePluginSpec(p);
            return parsed?.plugin === plugin || p.endsWith(`/${plugin}`);
          })
        : pluginsToUpdate;

      if (plugin && toUpdate.length === 0) {
        const error = `Plugin not found: ${plugin}`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin update', error });
          process.exit(1);
        }
        console.error(`Error: ${error}`);
        process.exit(1);
      }

      if (toUpdate.length === 0) {
        if (isJsonMode()) {
          jsonOutput({
            success: true,
            command: 'plugin update',
            data: { results: [], updated: 0, skipped: 0, failed: 0 },
          });
          return;
        }
        console.log('No plugins to update.');
        return;
      }

      if (!isJsonMode()) {
        console.log(plugin ? `Updating plugin: ${plugin}...` : 'Updating plugins...');
        console.log();
      }

      // Update each plugin
      const results: InstalledPluginUpdateResult[] = [];
      const updatedMarketplaces = new Set<string>();

      // Dependencies for updatePlugin (avoid circular imports)
      const deps = {
        parsePluginSpec,
        getMarketplace: (name: string, sourceLocation?: string) => findMarketplace(name, sourceLocation),
        parseMarketplaceManifest,
        updateMarketplace: async (name: string) => {
          // Skip if already updated in this run
          if (updatedMarketplaces.has(name)) {
            return [{ name, success: true }];
          }
          const result = await updateMarketplace(name);
          if (result[0]?.success) {
            updatedMarketplaces.add(name);
          }
          return result;
        },
      };

      for (const pluginSpec of toUpdate) {
        const result = await updatePlugin(pluginSpec, deps);
        results.push(result);

        if (!isJsonMode()) {
          const icon = result.success
            ? (result.action === 'updated' ? '\u2713' : '-')
            : '\u2717';
          const actionLabel = result.action === 'updated'
            ? 'updated'
            : result.action === 'skipped'
              ? 'skipped'
              : 'failed';
          console.log(`${icon} ${pluginSpec} (${actionLabel})`);
          if (result.error) {
            console.log(`  Error: ${result.error}`);
          }
        }
      }

      const updated = results.filter((r) => r.action === 'updated').length;
      const skipped = results.filter((r) => r.action === 'skipped').length;
      const failed = results.filter((r) => r.action === 'failed').length;

      // Sync plugin files only (skip AGENTS.md and other generated files)
      let syncOk = true;
      let syncData: ReturnType<typeof buildSyncData> | null = null;

      if (updated > 0) {
        if (updateProject && !isUserConfigPath(process.cwd())) {
          const { ok, syncData: data } = await runSyncAndPrint({ skipAgentFiles: true });
          if (!ok) syncOk = false;
          syncData = data;
        }
        if (updateUser) {
          const { ok, syncData: data } = await runUserSyncAndPrint();
          if (!ok) syncOk = false;
          if (!syncData) syncData = data;
        }
      }

      if (isJsonMode()) {
        jsonOutput({
          success: failed === 0 && syncOk,
          command: 'plugin update',
          data: {
            results: results.map((r) => ({
              plugin: r.plugin,
              success: r.success,
              action: r.action,
              ...(r.error && { error: r.error }),
            })),
            updated,
            skipped,
            failed,
            ...(syncData && { syncResult: syncData }),
          },
          ...(failed > 0 && { error: `${failed} plugin(s) failed to update` }),
        });
        if (failed > 0 || !syncOk) {
          process.exit(1);
        }
        return;
      }

      console.log();
      console.log(`Update complete: ${updated} updated, ${skipped} skipped, ${failed} failed`);

      if (failed > 0 || !syncOk) {
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin update', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// plugin subcommands group
// =============================================================================

export const pluginCmd = conciseSubcommands({
  name: 'plugin',
  description: 'Manage plugins and marketplaces',
  cmds: {
    install: pluginInstallCmd,
    uninstall: pluginUninstallCmd,
    update: pluginUpdateCmd,
    marketplace: marketplaceCmd,
    list: pluginListCmd,
    validate: pluginValidateCmd,
    skills: skillsCmd,
  },
});
