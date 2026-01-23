#!/usr/bin/env node

import { Command } from 'commander';
import { workspaceCommand } from './commands/workspace.js';
import { pluginCommand } from './commands/plugin.js';

const program = new Command();

program
  .name('allagents')
  .description('CLI tool for managing multi-repo AI agent workspaces with plugin synchronization')
  .version('0.1.0');

// Add commands
program.addCommand(workspaceCommand);
program.addCommand(pluginCommand);

program.parse();
