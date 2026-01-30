import { Command } from 'commander';
import { initWorkspace } from '../../core/workspace.js';
import { syncWorkspace } from '../../core/sync.js';
import { getWorkspaceStatus } from '../../core/status.js';
import { addPlugin, removePlugin } from '../../core/workspace-modify.js';

export const workspaceCommand = new Command('workspace').description(
  'Manage AI agent workspaces - initialize, sync, and configure plugins',
);

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
    const status = pluginResult.success ? '✓' : '✗';
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

  console.log(`\nSync complete:`);
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

workspaceCommand
  .command('init [path]')
  .description('Create new workspace and sync plugins')
  .option('--from <template>', 'Copy workspace.yaml from existing template/workspace')
  .action(async (path: string | undefined, options: { from?: string }) => {
    try {
      const targetPath = path ?? '.';
      const result = await initWorkspace(targetPath, options.from ? { from: options.from } : {});

      // Print sync results if sync was performed
      if (result.syncResult) {
        const syncResult = result.syncResult;

        if (syncResult.pluginResults.length > 0) {
          console.log('\nPlugin sync results:');
          for (const pluginResult of syncResult.pluginResults) {
            const status = pluginResult.success ? '✓' : '✗';
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
  });

workspaceCommand
  .command('sync')
  .description('Sync plugins to workspace')
  .option('--offline', 'Use cached plugins without fetching latest from remote')
  .option('-n, --dry-run', 'Simulate sync without making changes')
  .action(async (options: { offline?: boolean; dryRun?: boolean }) => {
    try {
      const offline = options.offline ?? false;
      const dryRun = options.dryRun ?? false;

      if (dryRun) {
        console.log('Dry run mode - no changes will be made\n');
      }
      console.log('Syncing workspace...\n');
      const result = await syncWorkspace(process.cwd(), { offline, dryRun });

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
        const status = pluginResult.success ? '✓' : '✗';
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
  });

workspaceCommand
  .command('status')
  .description('Show sync status of plugins')
  .action(async () => {
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
          const status = plugin.available ? '✓' : '✗';
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
  });

// =============================================================================
// workspace plugin subcommand group
// =============================================================================

const pluginSubcommand = new Command('plugin').description(
  'Manage plugins in .allagents/workspace.yaml',
);

pluginSubcommand
  .command('add <plugin>')
  .description(
    'Add plugin to .allagents/workspace.yaml (supports plugin@marketplace, GitHub URL, or local path)',
  )
  .action(async (plugin: string) => {
    try {
      const result = await addPlugin(plugin);

      if (!result.success) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      if (result.autoRegistered) {
        console.log(`✓ Auto-registered marketplace: ${result.autoRegistered}`);
      }
      console.log(`✓ Added plugin: ${plugin}`);

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
  });

pluginSubcommand
  .command('remove <plugin>')
  .description('Remove plugin from .allagents/workspace.yaml')
  .action(async (plugin: string) => {
    try {
      const result = await removePlugin(plugin);

      if (!result.success) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      console.log(`✓ Removed plugin: ${plugin}`);

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
  });

workspaceCommand.addCommand(pluginSubcommand);
