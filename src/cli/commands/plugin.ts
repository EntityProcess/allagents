import { command, positional, option, string, optional } from 'cmd-ts';
import {
  addMarketplace,
  listMarketplaces,
  removeMarketplace,
  updateMarketplace,
  listMarketplacePlugins,
  getWellKnownMarketplaces,
} from '../../core/marketplace.js';
import { syncWorkspace, syncUserWorkspace } from '../../core/sync.js';
import { addPlugin, removePlugin, hasPlugin } from '../../core/workspace-modify.js';
import { addUserPlugin, removeUserPlugin, hasUserPlugin } from '../../core/user-workspace.js';
import { isJsonMode, jsonOutput } from '../json-output.js';
import { buildDescription, conciseSubcommands } from '../help.js';
import {
  marketplaceListMeta,
  marketplaceAddMeta,
  marketplaceRemoveMeta,
  marketplaceUpdateMeta,
  pluginListMeta,
  pluginValidateMeta,
  pluginInstallMeta,
  pluginUninstallMeta,
} from '../metadata/plugin.js';

/**
 * Build a JSON-friendly sync data object from a sync result.
 */
function buildSyncData(result: Awaited<ReturnType<typeof syncWorkspace>>) {
  return {
    copied: result.totalCopied,
    generated: result.totalGenerated,
    failed: result.totalFailed,
    skipped: result.totalSkipped,
    plugins: result.pluginResults.map((pr) => ({
      plugin: pr.plugin,
      success: pr.success,
      error: pr.error,
      copied: pr.copyResults.filter((r) => r.action === 'copied').length,
      generated: pr.copyResults.filter((r) => r.action === 'generated').length,
      failed: pr.copyResults.filter((r) => r.action === 'failed').length,
      copyResults: pr.copyResults,
    })),
    purgedPaths: result.purgedPaths ?? [],
  };
}

/**
 * Run sync and print results. Returns true if sync succeeded.
 */
async function runSyncAndPrint(): Promise<{ ok: boolean; syncData: ReturnType<typeof buildSyncData> | null }> {
  if (!isJsonMode()) {
    console.log('\nSyncing workspace...\n');
  }
  const result = await syncWorkspace();

  if (!result.success && result.error) {
    if (!isJsonMode()) {
      console.error(`Sync error: ${result.error}`);
    }
    return { ok: false, syncData: null };
  }

  const syncData = buildSyncData(result);

  if (!isJsonMode()) {
    for (const pluginResult of result.pluginResults) {
      const status = pluginResult.success ? '\u2713' : '\u2717';
      console.log(`${status} Plugin: ${pluginResult.plugin}`);

      if (pluginResult.error) {
        console.log(`  Error: ${pluginResult.error}`);
      }

      const copied = pluginResult.copyResults.filter(
        (r) => r.action === 'copied',
      ).length;
      const generated = pluginResult.copyResults.filter(
        (r) => r.action === 'generated',
      ).length;
      const failed = pluginResult.copyResults.filter(
        (r) => r.action === 'failed',
      ).length;

      if (copied > 0) console.log(`  Copied: ${copied} files`);
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

    console.log('\nSync complete:');
    console.log(`  Total copied: ${result.totalCopied}`);
    if (result.totalGenerated > 0) {
      console.log(`  Total generated: ${result.totalGenerated}`);
    }
    if (result.totalFailed > 0) {
      console.log(`  Total failed: ${result.totalFailed}`);
    }
    if (result.totalSkipped > 0) {
      console.log(`  Total skipped: ${result.totalSkipped}`);
    }
  }

  return { ok: result.success && result.totalFailed === 0, syncData };
}

/**
 * Run user-scope sync and print results. Returns true if sync succeeded.
 */
async function runUserSyncAndPrint(): Promise<{ ok: boolean; syncData: ReturnType<typeof buildSyncData> | null }> {
  if (!isJsonMode()) {
    console.log('\nSyncing user workspace...\n');
  }
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
      const status = pluginResult.success ? '\u2713' : '\u2717';
      console.log(`${status} Plugin: ${pluginResult.plugin}`);

      if (pluginResult.error) {
        console.log(`  Error: ${pluginResult.error}`);
      }

      const copied = pluginResult.copyResults.filter(
        (r) => r.action === 'copied',
      ).length;
      const generated = pluginResult.copyResults.filter(
        (r) => r.action === 'generated',
      ).length;
      const failed = pluginResult.copyResults.filter(
        (r) => r.action === 'failed',
      ).length;

      if (copied > 0) console.log(`  Copied: ${copied} files`);
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

    console.log('\nUser sync complete:');
    console.log(`  Total copied: ${result.totalCopied}`);
    if (result.totalGenerated > 0) {
      console.log(`  Total generated: ${result.totalGenerated}`);
    }
    if (result.totalFailed > 0) {
      console.log(`  Total failed: ${result.totalFailed}`);
    }
    if (result.totalSkipped > 0) {
      console.log(`  Total skipped: ${result.totalSkipped}`);
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
  args: {},
  handler: async () => {
    try {
      const marketplaces = await listMarketplaces();

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'plugin marketplace list',
          data: { marketplaces },
        });
        return;
      }

      if (marketplaces.length === 0) {
        console.log('No marketplaces registered.\n');
        console.log('Add a marketplace with:');
        console.log('  allagents plugin marketplace add <source>\n');
        console.log('Well-known marketplaces:');
        const wellKnown = getWellKnownMarketplaces();
        for (const [name, repo] of Object.entries(wellKnown)) {
          console.log(`  ${name} \u2192 ${repo}`);
        }
        return;
      }

      console.log('Registered marketplaces:\n');

      for (const mp of marketplaces) {
        const sourceInfo =
          mp.source.type === 'github'
            ? `GitHub: ${mp.source.location}`
            : `Local: ${mp.source.location}`;
        const updated = mp.lastUpdated
          ? new Date(mp.lastUpdated).toLocaleDateString()
          : 'never';

        console.log(`  ${mp.name}`);
        console.log(`    Source: ${sourceInfo}`);
        console.log(`    Path: ${mp.path}`);
        console.log(`    Last updated: ${updated}`);
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
  },
  handler: async ({ source, name }) => {
    try {
      if (!isJsonMode()) {
        console.log(`Adding marketplace: ${source}...`);
      }

      const result = await addMarketplace(source, name);

      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace add', error: result.error ?? 'Unknown error' });
          process.exit(1);
        }
        console.error(`\nError: ${result.error}`);
        process.exit(1);
      }

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'plugin marketplace add',
          data: {
            marketplace: {
              name: result.marketplace?.name,
              path: result.marketplace?.path,
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
  },
  handler: async ({ name }) => {
    try {
      const result = await removeMarketplace(name);

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
          },
        });
        return;
      }

      console.log(`\u2713 Marketplace '${name}' removed from registry`);
      if (result.removedUserPlugins && result.removedUserPlugins.length > 0) {
        console.log(`  Removed ${result.removedUserPlugins.length} user plugin(s):`);
        for (const p of result.removedUserPlugins) {
          console.log(`    - ${p}`);
        }
      }
      console.log(`  Note: Files at ${result.marketplace?.path} were not deleted`);
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

      const results = await updateMarketplace(name);

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
// plugin marketplace subcommands group
// =============================================================================

const marketplaceCmd = conciseSubcommands({
  name: 'marketplace',
  description: 'Manage plugin marketplaces',
  cmds: {
    list: marketplaceListCmd,
    add: marketplaceAddCmd,
    remove: marketplaceRemoveCmd,
    update: marketplaceUpdateCmd,
  },
});

// =============================================================================
// plugin list command - list plugins from marketplaces
// =============================================================================

const pluginListCmd = command({
  name: 'list',
  description: buildDescription(pluginListMeta),
  args: {
    marketplace: positional({ type: optional(string), displayName: 'marketplace' }),
  },
  handler: async ({ marketplace }) => {
    try {
      const marketplaces = await listMarketplaces();

      if (marketplaces.length === 0) {
        if (isJsonMode()) {
          jsonOutput({
            success: true,
            command: 'plugin list',
            data: { plugins: [], total: 0 },
          });
          return;
        }
        console.log('No marketplaces registered.\n');
        console.log('Add a marketplace first:');
        console.log('  allagents plugin marketplace add <source>');
        return;
      }

      // Filter to specific marketplace if provided
      const toList = marketplace
        ? marketplaces.filter((m) => m.name === marketplace)
        : marketplaces;

      if (marketplace && toList.length === 0) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin list', error: `Marketplace '${marketplace}' not found` });
          process.exit(1);
        }
        console.error(`Marketplace '${marketplace}' not found`);
        process.exit(1);
      }

      if (isJsonMode()) {
        const allPlugins: Array<{ name: string; marketplace: string }> = [];
        const allWarnings: string[] = [];
        for (const mp of toList) {
          const result = await listMarketplacePlugins(mp.name);
          for (const plugin of result.plugins) {
            allPlugins.push({ name: plugin.name, marketplace: mp.name });
          }
          for (const warning of result.warnings) {
            allWarnings.push(`${mp.name}: ${warning}`);
          }
        }
        jsonOutput({
          success: true,
          command: 'plugin list',
          data: {
            plugins: allPlugins,
            total: allPlugins.length,
            ...(allWarnings.length > 0 && { warnings: allWarnings }),
          },
        });
        return;
      }

      let totalPlugins = 0;

      for (const mp of toList) {
        const result = await listMarketplacePlugins(mp.name);

        if (result.plugins.length === 0 && result.warnings.length === 0) {
          console.log(`${mp.name}: (no plugins found)`);
          continue;
        }

        console.log(`${mp.name}:`);
        for (const warning of result.warnings) {
          console.log(`  Warning: ${warning}`);
        }
        if (result.plugins.length === 0) {
          console.log('  (no plugins found)');
        }
        for (const plugin of result.plugins) {
          console.log(`  - ${plugin.name}@${mp.name}`);
          totalPlugins++;
        }
        console.log();
      }

      if (totalPlugins === 0) {
        console.log('No plugins found in registered marketplaces.');
      } else {
        console.log(`Total: ${totalPlugins} plugin(s)`);
      }
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
  },
  handler: async ({ plugin, scope }) => {
    try {
      const isUser = scope === 'user';
      const result = isUser
        ? await addUserPlugin(plugin)
        : await addPlugin(plugin);

      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin install', error: result.error ?? 'Unknown error' });
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
          command: 'plugin install',
          data: {
            plugin,
            scope: isUser ? 'user' : 'project',
            autoRegistered: result.autoRegistered ?? null,
            syncResult: syncData,
          },
          ...(!ok && { error: 'Sync completed with failures' }),
        });
        if (!ok) {
          process.exit(1);
        }
        return;
      }

      if (result.autoRegistered) {
        console.log(`\u2713 Auto-registered marketplace: ${result.autoRegistered}`);
      }
      console.log(`\u2713 Installed plugin (${isUser ? 'user' : 'project'} scope): ${plugin}`);

      const { ok: syncOk } = isUser
        ? await runUserSyncAndPrint()
        : await runSyncAndPrint();
      if (!syncOk) {
        process.exit(1);
      }
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
      const inProject = await hasPlugin(plugin);
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
// plugin subcommands group
// =============================================================================

export const pluginCmd = conciseSubcommands({
  name: 'plugin',
  description: 'Manage plugins and marketplaces',
  cmds: {
    install: pluginInstallCmd,
    uninstall: pluginUninstallCmd,
    marketplace: marketplaceCmd,
    list: pluginListCmd,
    validate: pluginValidateCmd,
  },
});
