import { Command } from 'commander';
import { initWorkspace } from '../../core/workspace.js';
import { syncWorkspace } from '../../core/sync.js';
import { getWorkspaceStatus } from '../../core/status.js';
import { addPlugin, removePlugin } from '../../core/workspace-modify.js';

export const workspaceCommand = new Command('workspace').description(
  'Manage AI agent workspaces - initialize, sync, and configure plugins',
);

workspaceCommand
  .command('init <path>')
  .description('Create new workspace from template')
  .action(async (path: string) => {
    try {
      await initWorkspace(path);
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
  .option('-f, --force', 'Force re-fetch of remote plugins even if cached')
  .option('-n, --dry-run', 'Simulate sync without making changes')
  .action(async (options: { force?: boolean; dryRun?: boolean }) => {
    try {
      const force = options.force ?? false;
      const dryRun = options.dryRun ?? false;

      if (dryRun) {
        console.log('Dry run mode - no changes will be made\n');
      }
      console.log('Syncing workspace...\n');
      const result = await syncWorkspace(process.cwd(), { force, dryRun });

      // Early exit only for top-level errors (e.g., missing workspace.yaml)
      // Plugin-level errors are handled in the loop below
      if (!result.success && result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
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
        const failed = pluginResult.copyResults.filter(
          (r) => r.action === 'failed',
        ).length;

        if (copied > 0) {
          console.log(`  Copied: ${copied} files`);
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
          const typeLabel =
            plugin.type === 'github'
              ? plugin.available
                ? 'cached'
                : 'not cached'
              : 'local';
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

workspaceCommand
  .command('add <plugin>')
  .description('Add plugin to workspace.yaml')
  .action(async (plugin: string) => {
    try {
      const result = await addPlugin(plugin);

      if (!result.success) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      console.log(`✓ Added plugin: ${plugin}`);
      console.log(
        '\nRun "allagents workspace sync" to fetch and sync the plugin.',
      );
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  });

workspaceCommand
  .command('remove <plugin>')
  .description('Remove plugin from workspace.yaml')
  .action(async (plugin: string) => {
    try {
      const result = await removePlugin(plugin);

      if (!result.success) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      console.log(`✓ Removed plugin: ${plugin}`);
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  });
