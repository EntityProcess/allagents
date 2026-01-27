#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceCommand } from './commands/workspace.js';
import { pluginCommand } from './commands/plugin.js';
import { updateCommand } from './commands/update.js';

// Read version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

const program = new Command();

program
  .name('allagents')
  .description(
    'CLI tool for managing multi-repo AI agent workspaces with plugin synchronization',
  )
  .version(packageJson.version);

// Add commands
program.addCommand(workspaceCommand);
program.addCommand(pluginCommand);
program.addCommand(updateCommand);

program.parse();
