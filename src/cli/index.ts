#!/usr/bin/env node

import { subcommands, run } from 'cmd-ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceCmd } from './commands/workspace.js';
import { pluginCmd } from './commands/plugin.js';
import { selfCmd } from './commands/self.js';

// Read version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

const app = subcommands({
  name: 'allagents',
  description: 'CLI tool for managing multi-repo AI agent workspaces with plugin synchronization',
  version: packageJson.version,
  cmds: {
    workspace: workspaceCmd,
    plugin: pluginCmd,
    self: selfCmd,
  },
});

run(app, process.argv.slice(2));
