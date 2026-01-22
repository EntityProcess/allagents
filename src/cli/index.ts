#!/usr/bin/env node

import { Command } from 'commander';
import { workspaceCommand } from './commands/workspace.js';

const program = new Command();

program
  .name('allagents')
  .description('CLI tool for managing multi-repo AI agent workspaces with plugin synchronization')
  .version('0.1.0');

// Add workspace commands
program.addCommand(workspaceCommand);

// Plugin commands (to be implemented)
const pluginCmd = program
  .command('plugin')
  .description('Manage plugins');

pluginCmd
  .command('fetch <url>')
  .description('Fetch remote plugin to cache')
  .action((url: string) => {
    console.log(`TODO: Fetch plugin from ${url}`);
  });

pluginCmd
  .command('list')
  .description('List cached plugins')
  .action(() => {
    console.log('TODO: List cached plugins');
  });

pluginCmd
  .command('update [name]')
  .description('Update cached plugin(s) from remote')
  .action((name?: string) => {
    console.log(`TODO: Update plugin ${name || 'all'}`);
  });

program.parse();
