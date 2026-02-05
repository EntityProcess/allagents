#!/usr/bin/env node

import { run } from 'cmd-ts';
import { conciseSubcommands } from './help.js';
import { workspaceCmd } from './commands/workspace.js';
import { pluginCmd } from './commands/plugin.js';
import { selfCmd } from './commands/self.js';
import { extractJsonFlag, setJsonMode } from './json-output.js';
import { extractAgentHelpFlag, printAgentHelp } from './agent-help.js';
import { getUpdateNotice } from './update-check.js';
import packageJson from '../../package.json';

const app = conciseSubcommands({
  name: 'allagents',
  description:
    'CLI tool for managing multi-repo AI agent workspaces with plugin synchronization\n\n' +
    'For AI agents: use --agent-help for machine-readable help, or --json for structured output',
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

// Kick off update check for non-json, non-agent-help invocations.
// Reads from local cache (fast), spawns a detached child to refresh if stale.
// The notice is printed on process exit so it appears after command output,
// even if the command calls process.exit() directly.
const isWizard = finalArgs.length === 0 && process.stdout.isTTY && !json;
if (!agentHelp && !json && !isWizard) {
  getUpdateNotice(packageJson.version).then((notice) => {
    if (notice) {
      process.on('exit', () => {
        process.stderr.write(`\n${notice}\n`);
      });
    }
  });
}

if (agentHelp) {
  printAgentHelp(finalArgs, packageJson.version);
} else if (isWizard) {
  // Interactive wizard when no args and running in a terminal
  const { runWizard } = await import('./tui/wizard.js');
  await runWizard();
} else {
  run(app, finalArgs);
}
