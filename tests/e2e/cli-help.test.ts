import { describe, it, expect } from 'bun:test';
import { execa } from 'execa';
import { resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '../../dist/index.js');

async function runCli(args: string[]) {
  try {
    const result = await execa('node', [CLI, ...args]);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error: any) {
    return { stdout: error.stdout || '', stderr: error.stderr || '', exitCode: error.exitCode || 1 };
  }
}

describe('CLI e2e help output', () => {
  // 1. Root help
  it('allagents --help outputs help text with workspace, plugin, self subcommands', async () => {
    const { stdout, exitCode } = await runCli(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('workspace');
    expect(stdout).toContain('plugin');
    expect(stdout).toContain('self');
  });

  // 2. Workspace help
  it('allagents workspace --help lists init, sync, status subcommands', async () => {
    const { stdout, exitCode } = await runCli(['workspace', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('init');
    expect(stdout).toContain('sync');
    expect(stdout).toContain('status');
  });

  // 4. Workspace sync help
  it('allagents workspace sync --help shows --offline, --dry-run/-n, --client/-c flags', async () => {
    const { stdout, exitCode } = await runCli(['workspace', 'sync', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('--offline');
    expect(stdout).toContain('--dry-run');
    expect(stdout).toMatch(/-n[\s,]/);
    expect(stdout).toContain('--client');
    expect(stdout).toMatch(/-c[\s,]/);
  });

  // 5. Workspace init help
  it('allagents workspace init --help shows optional path positional and --from option', async () => {
    const { stdout, exitCode } = await runCli(['workspace', 'init', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('path');
    expect(stdout).toContain('--from');
  });

  // 6. Workspace status help
  it('allagents workspace status --help exits 0', async () => {
    const { stdout, exitCode } = await runCli(['workspace', 'status', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  // 7. Plugin help includes install and uninstall
  it('allagents plugin --help lists install and uninstall subcommands', async () => {
    const { stdout, exitCode } = await runCli(['plugin', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('install');
    expect(stdout).toContain('uninstall');
  });

  // 8. Plugin install help
  it('allagents plugin install --help shows required plugin positional', async () => {
    const { stdout, exitCode } = await runCli(['plugin', 'install', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('plugin');
  });

  // 9. Plugin uninstall help and alias shown in parent
  it('allagents plugin uninstall --help exits 0', async () => {
    const { stdout, exitCode } = await runCli(['plugin', 'uninstall', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('plugin');
  });

  it('allagents plugin --help shows remove alias for uninstall', async () => {
    const { stdout, exitCode } = await runCli(['plugin', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('remove');
  });

  // 10. Plugin help also lists marketplace, list, validate
  it('allagents plugin --help lists marketplace, list, validate subcommands', async () => {
    const { stdout, exitCode } = await runCli(['plugin', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('marketplace');
    expect(stdout).toContain('list');
    expect(stdout).toContain('validate');
  });

  // 11. Plugin marketplace help
  it('allagents plugin marketplace --help lists list, add, remove, update', async () => {
    const { stdout, exitCode } = await runCli(['plugin', 'marketplace', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('list');
    expect(stdout).toContain('add');
    expect(stdout).toContain('remove');
    expect(stdout).toContain('update');
  });

  // 12. Plugin marketplace add help
  it('allagents plugin marketplace add --help shows --name/-n option', async () => {
    const { stdout, exitCode } = await runCli(['plugin', 'marketplace', 'add', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('--name');
    expect(stdout).toMatch(/-n[\s,]/);
  });

  // 13. Plugin list help
  it('allagents plugin list --help shows optional marketplace positional', async () => {
    const { stdout, exitCode } = await runCli(['plugin', 'list', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/marketplace/i);
  });

  // 14. Plugin validate help
  it('allagents plugin validate --help shows required path positional', async () => {
    const { stdout, exitCode } = await runCli(['plugin', 'validate', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('path');
  });

  // 15. Self help
  it('allagents self --help lists update subcommand', async () => {
    const { stdout, exitCode } = await runCli(['self', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('update');
  });

  // 16. Self update help
  it('allagents self update --help shows --npm and --bun flags', async () => {
    const { stdout, exitCode } = await runCli(['self', 'update', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('--npm');
    expect(stdout).toContain('--bun');
  });
});

describe('CLI e2e error cases', () => {
  // 17. Unknown subcommand
  it('allagents unknown exits with non-zero and stderr has error message', async () => {
    const { stderr, exitCode } = await runCli(['unknown']);
    expect(exitCode).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });

  // 18. Missing required arg
  it('allagents plugin install (no plugin arg) exits with non-zero', async () => {
    const { exitCode } = await runCli(['plugin', 'install']);
    expect(exitCode).not.toBe(0);
  });
});
