#!/usr/bin/env node

import { run } from 'cmd-ts';
import { conciseSubcommands } from './help.js';
import { workspaceCmd, syncCmd, initCmd, statusCmd } from './commands/workspace.js';
import { pluginCmd } from './commands/plugin.js';
import { mcpCmd } from './commands/mcp.js';
import { selfCmd } from './commands/self.js';
import { skillsCmd } from './commands/plugin-skills.js';
import { profileCmd } from './commands/profile.js';
import {
  extractJsonFlag,
  extractJqFlag,
  setJsonMode,
  validateJsonFields,
} from './json-output.js';
import {
  extractAgentHelpFlag,
  findMetaByCommand,
  printAgentHelp,
} from './agent-help.js';
import { getUpdateNotice } from './update-check.js';
import { normalizeSkillArgs, normalizeSkillHelpArgs } from './skill-arg-normalizer.js';
import packageJson from '../../package.json';

const app = conciseSubcommands({
  name: 'allagents',
  description:
    'CLI tool for managing multi-repo AI agent workspaces with plugin synchronization\n\n' +
    'For AI agents: use --agent-help for machine-readable help, or --json for structured output',
  version: packageJson.version,
  cmds: {
    init: initCmd,
    update: syncCmd,
    status: statusCmd,
    workspace: workspaceCmd,
    plugin: pluginCmd,
    mcp: mcpCmd,
    self: selfCmd,
    skill: skillsCmd,
    profile: profileCmd,
  },
});

const rawArgs = process.argv.slice(2);
const { args: argsNoJson, json, jsonFields } = extractJsonFlag(rawArgs);
const { args: argsNoJq, jqExpr } = extractJqFlag(argsNoJson);
const { args: argsAfterAgentHelp, agentHelp } = extractAgentHelpFlag(argsNoJq);
const finalArgs = normalizeSkillArgs(argsAfterAgentHelp);
const commandPath = finalArgs.filter((arg) => !arg.startsWith('-')).join(' ');
const commandMeta = findMetaByCommand(commandPath);

// `--jq` requires `--json` so we have an envelope to pipe through.
if (jqExpr && !json) {
  process.stderr.write('Error: --jq requires --json.\n');
  process.exit(2);
}

// Validate `--json=<fields>` against the meta allowlist for the invoked command.
let validatedFields: string[] | undefined;
if (jsonFields) {
  const result = validateJsonFields(jsonFields, commandMeta);
  validatedFields = result ? [...result] : undefined;
}

setJsonMode(json, {
  ...(validatedFields && { fields: validatedFields }),
  ...(jqExpr && { jqExpr }),
});

// Kick off the update check for ordinary non-JSON invocations unless the
// resolved command metadata marks the command as strictly read-only.
const isWizard = finalArgs.length === 0 && process.stdout.isTTY && !json;
if (!agentHelp && !json && !isWizard && !commandMeta?.skipUpdateCheck) {
  const notice = await getUpdateNotice(packageJson.version);
  if (notice) process.stderr.write(`${notice}\n\n`);
}

if (agentHelp) {
  printAgentHelp(normalizeSkillHelpArgs(argsAfterAgentHelp), packageJson.version);
} else if (isWizard) {
  // Interactive wizard when no args and running in a terminal
  const { runWizard } = await import('./tui/wizard.js');
  await runWizard();
} else {
  run(app, finalArgs);
}
