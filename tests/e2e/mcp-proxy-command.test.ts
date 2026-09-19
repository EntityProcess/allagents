import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

function runCli(args: string[], env: Record<string, string> = {}) {
  const cliEntry = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');
  const proc = Bun.spawnSync(['bun', 'run', cliEntry, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stderr: 'pipe',
    stdout: 'pipe',
  });

  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

describe('mcp public command help', () => {
  test('lists setup and reauthentication without exposing the proxy helper', () => {
    const result = runCli(['mcp', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('- add - Add an MCP server');
    expect(result.stdout).toContain('- reauth - Reauthenticate a configured HTTP MCP server');
    expect(result.stdout).not.toContain('- auth -');
    expect(result.stdout).not.toContain('- proxy -');
    expect(result.stdout).not.toContain('- proxy-stdio -');
  });

  test('keeps proxy hidden when help uses ANSI color', () => {
    const result = runCli(['mcp', '--help'], { FORCE_COLOR: '1' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Expose a remote HTTP MCP server locally over stdio');
  });

  test('exposes add and reauth through structured JSON help', () => {
    const addResult = runCli(['mcp', 'add', '--help', '--json']);
    const reauthResult = runCli(['--json', 'mcp', 'reauth', '-h']);

    expect(addResult.exitCode).toBe(0);
    expect(JSON.parse(addResult.stdout).command).toBe('mcp add');
    expect(reauthResult.exitCode).toBe(0);
    expect(JSON.parse(reauthResult.stdout).command).toBe('mcp reauth');
  });

  test('keeps exact bare command help human-readable', () => {
    const result = runCli(['mcp', 'add', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Add an MCP server');
    expect(result.stdout).toContain('--arg');
    expect(result.stdout).not.toContain('"when_to_use"');
  });

  test('resolves structured help from the longest command prefix', () => {
    const positionalResult = runCli([
      'skill',
      'search',
      'terraform',
      '--help',
      '--json',
    ]);
    const optionResult = runCli([
      'mcp',
      'list',
      '--scope',
      'user',
      '--help',
      '--json',
    ]);

    expect(positionalResult.exitCode).toBe(0);
    expect(JSON.parse(positionalResult.stdout)).toMatchObject({
      command: 'skill search',
      positionals: [{ name: 'query', required: true }],
      output_schema: { total: 'number' },
    });
    expect(optionResult.exitCode).toBe(0);
    expect(JSON.parse(optionResult.stdout).command).toBe('mcp list');
  });

  test('applies jq to the existing bare structured-help value', () => {
    const result = runCli(['--help', '--json', '--jq', '.name']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('"allagents"');
  });

  test('covers workspace aliases and workspace-only command metadata', () => {
    const groupResult = runCli(['workspace', '--help', '--json']);
    const repoResult = runCli([
      'workspace',
      'repo',
      'add',
      '../project',
      '--help',
      '--json',
    ]);

    expect(groupResult.exitCode).toBe(0);
    const group = JSON.parse(groupResult.stdout) as {
      commands: Array<{ command: string }>;
    };
    expect(group.commands.map(({ command }) => command)).toEqual([
      'workspace init',
      'workspace setup',
      'workspace sync',
      'workspace status',
      'workspace prune',
      'workspace repo add',
      'workspace repo remove',
      'workspace repo list',
    ]);
    expect(repoResult.exitCode).toBe(0);
    expect(JSON.parse(repoResult.stdout)).toMatchObject({
      command: 'workspace repo add',
      positionals: [{ name: 'path', required: true }],
      output_schema: { repo: 'string | null' },
    });
  });

  test('covers canonical and compatibility skill command paths', () => {
    const pluginGroupResult = runCli([
      'plugin',
      'skills',
      '--help',
      '--json',
    ]);
    const pluginLeafResult = runCli([
      'plugin',
      'skills',
      'list',
      '--help',
      '--json',
    ]);
    const pluralAliasResult = runCli(['skills', 'list', '--help', '--json']);

    expect(pluginGroupResult.exitCode).toBe(0);
    const pluginGroup = JSON.parse(pluginGroupResult.stdout) as {
      commands: Array<{ command: string }>;
    };
    expect(pluginGroup.commands.map(({ command }) => command)).toEqual([
      'plugin skills list',
      'plugin skills add',
      'plugin skills remove',
      'plugin skills search',
      'plugin skills update',
    ]);
    expect(pluginLeafResult.exitCode).toBe(0);
    expect(JSON.parse(pluginLeafResult.stdout).command).toBe(
      'plugin skills list',
    );
    expect(pluralAliasResult.exitCode).toBe(0);
    expect(JSON.parse(pluralAliasResult.stdout).command).toBe('skill list');
  });

  test('does not treat a registered string option value as structured help', () => {
    const result = runCli(['mcp', 'add', '--arg', '--help', '--json']);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('"when_to_use"');
  });

  test('does not treat positional help after -- as structured help', () => {
    const result = runCli(['--json', 'mcp', 'add', '--', '--help']);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('"when_to_use"');
  });

  test('exposes the full command tree through structured JSON help', () => {
    const result = runCli(['--help', '--json']);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      name: string;
      commands: Array<{ command: string }>;
    };
    expect(parsed.name).toBe('allagents');
    expect(
      parsed.commands.some((command) => command.command === 'mcp add'),
    ).toBe(true);
    expect(
      parsed.commands.some(
        (command) => command.command === 'plugin skills list',
      ),
    ).toBe(true);
  });

  test('rejects field selection for structured JSON help', () => {
    const result = runCli(['mcp', 'add', '--help', '--json=command']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      '--json=<fields> is not supported with --help; use --json',
    );
  });

  test('rejects proxy-stdio after the rename', () => {
    const result = runCli(['mcp', 'proxy-stdio']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Not a valid subcommand name');
  });
});
