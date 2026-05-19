import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

function runCli(args: string[]) {
  const cliEntry = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');
  const proc = Bun.spawnSync(['bun', 'run', cliEntry, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stderr: 'pipe',
    stdout: 'pipe',
  });

  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

describe('mcp proxy command help', () => {
  test('lists proxy as the canonical subcommand', () => {
    const result = runCli(['mcp', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('- proxy - Expose a remote HTTP MCP server locally over stdio');
    expect(result.stdout).not.toContain('- proxy-stdio -');
  });

  test('rejects proxy-stdio after the rename', () => {
    const result = runCli(['mcp', 'proxy-stdio']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Not a valid subcommand name');
  });
});
