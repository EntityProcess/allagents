import { command, subcommands, positional, option, flag, string, optional } from 'cmd-ts';
import { initWorkspace } from '../../core/workspace.js';
import { syncWorkspace } from '../../core/sync.js';
import { getWorkspaceStatus } from '../../core/status.js';
import { addPlugin, removePlugin } from '../../core/workspace-modify.js';

/**
 * Run sync and print results. Returns true if sync succeeded.
 */
async function runSyncAndPrint(): Promise<boolean> {
  console.log('\nSyncing workspace...\n');
  const result = await syncWorkspace();

  if (!result.success && result.error) {
    console.error(`Sync error: ${result.error}`);
    return false;
  }

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

  return result.success && result.totalFailed === 0;
}

// =============================================================================
// workspace init
// =============================================================================

const initCmd = command({
  name: 'init',
  description: 'Create new workspace and sync plugins',
  args: {
    path: positional({ type: optional(string), displayName: 'path' }),
    from: option({ type: optional(string), long: 'from', description: 'Copy workspace.yaml from existing template/workspace' }),
  },
  handler: async ({ path, from }) => {
    try {
      const targetPath = path ?? '.';
      const result = await initWorkspace(targetPath, from ? { from } : {});

      // Print sync results if sync was performed
      if (result.syncResult) {
        const syncResult = result.syncResult;

        if (syncResult.pluginResults.length > 0) {
          console.log('\nPlugin sync results:');
          for (const pluginResult of syncResult.pluginResults) {
            const status = pluginResult.success ? '\u2713' : '\u2717';
            console.log(`  ${status} ${pluginResult.plugin}`);
            if (pluginResult.error) {
              console.log(`    Error: ${pluginResult.error}`);
            }
          }
        }

        console.log(`\nSync complete: ${syncResult.totalCopied} files copied`);
        if (syncResult.totalFailed > 0) {
          console.log(`  Failed: ${syncResult.totalFailed}`);
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// workspace sync
// =============================================================================

const syncCmd = command({
  name: 'sync',
  description: 'Sync plugins to workspace',
  args: {
    offline: flag({ long: 'offline', description: 'Use cached plugins without fetching latest from remote' }),
    dryRun: flag({ long: 'dry-run', short: 'n', description: 'Simulate sync without making changes' }),
    client: option({ type: optional(string), long: 'client', short: 'c', description: 'Sync only the specified client (e.g., opencode, claude)' }),
  },
  handler: async ({ offline, dryRun, client }) => {
    try {
      if (dryRun) {
        console.log('Dry run mode - no changes will be made\n');
      }
      if (client) {
        console.log(`Syncing client: ${client}\n`);
      }
      console.log('Syncing workspace...\n');
      const result = await syncWorkspace(process.cwd(), {
        offline,
        dryRun,
        ...(client && { clients: [client] }),
      });

      // Early exit only for top-level errors (e.g., missing .allagents/workspace.yaml)
      // Plugin-level errors are handled in the loop below
      if (!result.success && result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      // Show purge plan in dry-run mode
      if (dryRun && result.purgedPaths && result.purgedPaths.length > 0) {
        console.log('Would purge managed directories:');
        for (const purgePath of result.purgedPaths) {
          console.log(`  ${purgePath.client}:`);
          for (const path of purgePath.paths) {
            console.log(`    - ${path}`);
          }
        }
        console.log('');
      }

      // Print plugin results
      for (const pluginResult of result.pluginResults) {
        const status = pluginResult.success ? '\u2713' : '\u2717';
        console.log(`${status} Plugin: ${pluginResult.plugin}`);

        if (pluginResult.error) {
          console.log(`  Error: ${pluginResult.error}`);
        }

        // Count by action
        const copied = pluginResult.copyResults.filter(
          (r) => r.action === 'copied',
        ).length;
        const generated = pluginResult.copyResults.filter(
          (r) => r.action === 'generated',
        ).length;
        const failed = pluginResult.copyResults.filter(
          (r) => r.action === 'failed',
        ).length;

        if (copied > 0) {
          console.log(`  Copied: ${copied} files`);
        }
        if (generated > 0) {
          console.log(`  Generated: ${generated} files`);
        }
        if (failed > 0) {
          console.log(`  Failed: ${failed} files`);
          // Show failure details
          for (const failedResult of pluginResult.copyResults.filter(
            (r) => r.action === 'failed',
          )) {
            console.log(
              `    - ${failedResult.destination}: ${failedResult.error}`,
            );
          }
        }
      }

      // Print summary
      console.log(`\nSync complete${dryRun ? ' (dry run)' : ''}:`);
      console.log(
        `  Total ${dryRun ? 'would copy' : 'copied'}: ${result.totalCopied}`,
      );
      if (result.totalGenerated > 0) {
        console.log(`  Total generated: ${result.totalGenerated}`);
      }
      if (result.totalFailed > 0) {
        console.log(`  Total failed: ${result.totalFailed}`);
      }
      if (result.totalSkipped > 0) {
        console.log(`  Total skipped: ${result.totalSkipped}`);
      }

      // Exit with error if any failures occurred (plugin-level or copy-level)
      if (!result.success || result.totalFailed > 0) {
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// workspace status
// =============================================================================

const statusCmd = command({
  name: 'status',
  description: 'Show sync status of plugins',
  args: {},
  handler: async () => {
    try {
      const result = await getWorkspaceStatus();

      if (!result.success) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      // Display plugins
      console.log(`Plugins (${result.plugins.length}):`);
      if (result.plugins.length === 0) {
        console.log('  No plugins configured');
      } else {
        for (const plugin of result.plugins) {
          const status = plugin.available ? '\u2713' : '\u2717';
          let typeLabel: string;
          if (plugin.type === 'marketplace') {
            typeLabel = plugin.available ? 'marketplace' : 'not synced';
          } else if (plugin.type === 'github') {
            typeLabel = plugin.available ? 'cached' : 'not cached';
          } else {
            typeLabel = 'local';
          }
          console.log(`  ${status} ${plugin.source} (${typeLabel})`);
        }
      }

      // Display clients
      console.log(`\nClients (${result.clients.length}):`);
      if (result.clients.length === 0) {
        console.log('  No clients configured');
      } else {
        console.log(`  ${result.clients.join(', ')}`);
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// workspace plugin install
// =============================================================================

const pluginInstallCmd = command({
  name: 'install',
  description: 'Install plugin to .allagents/workspace.yaml (supports plugin@marketplace, GitHub URL, or local path)',
  args: {
    plugin: positional({ type: string, displayName: 'plugin' }),
  },
  handler: async ({ plugin }) => {
    try {
      const result = await addPlugin(plugin);

      if (!result.success) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      if (result.autoRegistered) {
        console.log(`\u2713 Auto-registered marketplace: ${result.autoRegistered}`);
      }
      console.log(`\u2713 Installed plugin: ${plugin}`);

      const syncOk = await runSyncAndPrint();
      if (!syncOk) {
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// workspace plugin uninstall
// =============================================================================

const pluginUninstallCmd = command({
  name: 'uninstall',
  description: 'Uninstall plugin from .allagents/workspace.yaml',
  aliases: ['remove'],
  args: {
    plugin: positional({ type: string, displayName: 'plugin' }),
  },
  handler: async ({ plugin }) => {
    try {
      const result = await removePlugin(plugin);

      if (!result.success) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      console.log(`\u2713 Uninstalled plugin: ${plugin}`);

      const syncOk = await runSyncAndPrint();
      if (!syncOk) {
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// workspace plugin subcommands group
// =============================================================================

const workspacePluginCmd = subcommands({
  name: 'plugin',
  description: 'Manage plugins in .allagents/workspace.yaml',
  cmds: {
    install: pluginInstallCmd,
    uninstall: pluginUninstallCmd,
  },
});

// =============================================================================
// workspace subcommands group
// =============================================================================

export const workspaceCmd = subcommands({
  name: 'workspace',
  description: 'Manage AI agent workspaces - initialize, sync, and configure plugins',
  cmds: {
    init: initCmd,
    sync: syncCmd,
    status: statusCmd,
    plugin: workspacePluginCmd,
  },
});
