import { Command } from 'commander';
import { initWorkspace } from '../../core/workspace.js';
import { syncWorkspace } from '../../core/sync.js';

export const workspaceCommand = new Command('workspace').description('Manage workspaces');

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
  .action(async () => {
    try {
      console.log('Syncing workspace...\n');
      const result = await syncWorkspace();

      if (!result.success) {
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
        const copied = pluginResult.copyResults.filter((r) => r.action === 'copied').length;
        const failed = pluginResult.copyResults.filter((r) => r.action === 'failed').length;

        if (copied > 0) {
          console.log(`  Copied: ${copied} files`);
        }
        if (failed > 0) {
          console.log(`  Failed: ${failed} files`);
          // Show failure details
          for (const failedResult of pluginResult.copyResults.filter((r) => r.action === 'failed')) {
            console.log(`    - ${failedResult.destination}: ${failedResult.error}`);
          }
        }
      }

      // Print summary
      console.log(`\nSync complete:`);
      console.log(`  Total copied: ${result.totalCopied}`);
      if (result.totalFailed > 0) {
        console.log(`  Total failed: ${result.totalFailed}`);
      }
      if (result.totalSkipped > 0) {
        console.log(`  Total skipped: ${result.totalSkipped}`);
      }

      if (result.totalFailed > 0) {
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
  .action(() => {
    console.log('TODO: Show workspace status');
  });

workspaceCommand
  .command('add <plugin>')
  .description('Add plugin to workspace.yaml')
  .action((plugin: string) => {
    console.log(`TODO: Add plugin ${plugin}`);
  });

workspaceCommand
  .command('remove <plugin>')
  .description('Remove plugin from workspace.yaml')
  .action((plugin: string) => {
    console.log(`TODO: Remove plugin ${plugin}`);
  });
