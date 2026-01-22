import { Command } from 'commander';
import { initWorkspace } from '../../core/workspace.js';

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
  .action(() => {
    console.log('TODO: Sync workspace');
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
