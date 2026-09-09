import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import { parseWorkspaceConfig } from '../utils/workspace-parser.js';

export interface SetupCommandResult {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
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

  for (const command of config.setup ?? []) {
    output.write(`$ ${command}\n`);

    const commandResult = await runShellCommand(
      command,
      workspaceRoot,
      jsonMode,
    );
    results.push({ command, ...commandResult });
    if (commandResult.exitCode !== 0 || commandResult.signal !== null) break;
  }

  return { commands: results };
}
