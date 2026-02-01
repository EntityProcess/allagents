#!/usr/bin/env node

import { subcommands, run } from 'cmd-ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceCmd } from './commands/workspace.js';
import { pluginCmd } from './commands/plugin.js';
import { selfCmd } from './commands/self.js';
import { extractJsonFlag, setJsonMode } from './json-output.js';
import { extractAgentHelpFlag, printAgentHelp } from './agent-help.js';

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

const rawArgs = process.argv.slice(2);
const { args: argsNoJson, json } = extractJsonFlag(rawArgs);
const { args: finalArgs, agentHelp } = extractAgentHelpFlag(argsNoJson);
setJsonMode(json);

if (agentHelp) {
  printAgentHelp(finalArgs, packageJson.version);
} else {
  run(app, finalArgs);
}
