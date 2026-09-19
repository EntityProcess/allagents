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

  test('exposes add and reauth through machine-readable agent help', () => {
    const addResult = runCli(['--agent-help', 'mcp', 'add']);
    const reauthResult = runCli(['--agent-help', 'mcp', 'reauth']);

    expect(addResult.exitCode).toBe(0);
    expect(JSON.parse(addResult.stdout).command).toBe('mcp add');
    expect(reauthResult.exitCode).toBe(0);
    expect(JSON.parse(reauthResult.stdout).command).toBe('mcp reauth');
  });

  test('rejects proxy-stdio after the rename', () => {
    const result = runCli(['mcp', 'proxy-stdio']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Not a valid subcommand name');
  });
});
