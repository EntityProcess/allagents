import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import { parseWorkspaceConfig } from '../utils/workspace-parser.js';
import type { SetupCommand } from '../models/workspace-config.js';

export type SetupCommandStatus = 'succeeded' | 'failed' | 'skipped';

export interface SetupCommandResult {
  command: string;
  status: SetupCommandStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  reason: string | null;
}

export interface WorkspaceSetupResult {
  commands: SetupCommandResult[];
}

async function runShellCommand(
  command: string,
  workspaceRoot: string,
  jsonMode: boolean,
): Promise<Pick<SetupCommandResult, 'exitCode' | 'signal'>> {
  const child = spawn(command, {
    cwd: workspaceRoot,
    shell: true,
    stdio: jsonMode ? ['inherit', process.stderr, process.stderr] : 'inherit',
  });

  const [exitCode, signal] = (await once(child, 'close')) as [
    number | null,
    NodeJS.Signals | null,
  ];
  return { exitCode, signal };
}

/**
 * Run the configured setup commands in declaration order from the workspace
 * root. This function is intentionally called only by the explicit setup CLI
 * action; init and update must treat setup commands as inert configuration.
 */
export async function runWorkspaceSetup(
  workspacePath: string,
  options: { jsonMode?: boolean } = {},
): Promise<WorkspaceSetupResult> {
  const workspaceRoot = resolve(workspacePath);
  const config = await parseWorkspaceConfig(
    join(workspaceRoot, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
  );
  const results: SetupCommandResult[] = [];
  const jsonMode = options.jsonMode ?? false;
  const output = jsonMode ? process.stderr : process.stdout;

  for (const entry of config.setup ?? []) {
    const command = typeof entry === 'string' ? entry : entry.run;
    const reason = getSkipReason(entry);

    if (reason !== null) {
      output.write(`- Skipped: ${command} (${reason})\n`);
      results.push({
        command,
        status: 'skipped',
        exitCode: null,
        signal: null,
        reason,
      });
      continue;
    }

    output.write(`$ ${command}\n`);
    const commandResult = await runShellCommand(
      command,
      workspaceRoot,
      jsonMode,
    );
    const status =
      commandResult.exitCode === 0 && commandResult.signal === null
        ? 'succeeded'
        : 'failed';
    results.push({
      command,
      status,
      ...commandResult,
      reason: null,
    });
    if (status === 'failed') break;
  }

  return { commands: results };
}

function getSkipReason(command: SetupCommand): string | null {
  if (typeof command === 'string') return null;

  if (command.platforms && !command.platforms.includes(process.platform)) {
    return `platform ${process.platform} does not match ${command.platforms.join(', ')}`;
  }
  if (command.architectures && !command.architectures.includes(process.arch)) {
    return `architecture ${process.arch} does not match ${command.architectures.join(', ')}`;
  }
  return null;
}
