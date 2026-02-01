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

function parseJson(stdout: string) {
  return JSON.parse(stdout);
}

// =============================================================================
// JSON envelope structure
// =============================================================================

describe('CLI --json output envelope', () => {
  it('plugin validate --json returns valid JSON with success and command fields', async () => {
    const { stdout, exitCode } = await runCli(['plugin', 'validate', '/tmp/test', '--json']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.success).toBe(true);
    expect(json.command).toBe('plugin validate');
    expect(json.data).toBeDefined();
  });

  it('plugin marketplace list --json returns valid JSON with success and command fields', async () => {
    const { stdout, exitCode } = await runCli(['plugin', 'marketplace', 'list', '--json']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.success).toBe(true);
    expect(json.command).toBe('plugin marketplace list');
    expect(json.data).toBeDefined();
    expect(json.data.marketplaces).toBeInstanceOf(Array);
  });

  it('plugin list --json returns valid JSON with plugins array and total', async () => {
    const { stdout, exitCode } = await runCli(['plugin', 'list', '--json']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.success).toBe(true);
    expect(json.command).toBe('plugin list');
    expect(json.data.plugins).toBeInstanceOf(Array);
    expect(typeof json.data.total).toBe('number');
  });

  it('plugin marketplace update --json returns valid JSON with results array', async () => {
    const { stdout, exitCode } = await runCli(['plugin', 'marketplace', 'update', '--json']);
    // May succeed or fail depending on network, but should always be valid JSON
    const json = parseJson(stdout);
    expect(typeof json.success).toBe('boolean');
    expect(json.command).toBe('plugin marketplace update');
    expect(json.data).toBeDefined();
    expect(json.data.results).toBeInstanceOf(Array);
    expect(typeof json.data.succeeded).toBe('number');
    expect(typeof json.data.failed).toBe('number');
  });
});

// =============================================================================
// Error cases with --json
// =============================================================================

describe('CLI --json error cases', () => {
  it('workspace sync --json in non-workspace dir returns error JSON with exit code 1', async () => {
    const { stdout, exitCode } = await runCli(['workspace', 'sync', '--json']);
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json.success).toBe(false);
    expect(json.command).toBe('workspace sync');
    expect(typeof json.error).toBe('string');
    expect(json.error.length).toBeGreaterThan(0);
  });

  it('workspace status --json in non-workspace dir returns error JSON with exit code 1', async () => {
    const { stdout, exitCode } = await runCli(['workspace', 'status', '--json']);
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json.success).toBe(false);
    expect(json.command).toBe('workspace status');
    expect(typeof json.error).toBe('string');
  });

  it('plugin install --json with bad plugin returns error JSON', async () => {
    const { stdout, exitCode } = await runCli(['plugin', 'install', 'nonexistent-plugin-xyz', '--json']);
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json.success).toBe(false);
    expect(json.command).toBe('plugin install');
    expect(typeof json.error).toBe('string');
  });

  it('plugin uninstall --json with bad plugin returns error JSON', async () => {
    const { stdout, exitCode } = await runCli(['plugin', 'uninstall', 'nonexistent-plugin-xyz', '--json']);
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json.success).toBe(false);
    expect(json.command).toBe('plugin uninstall');
    expect(typeof json.error).toBe('string');
  });

  it('plugin marketplace remove --json with nonexistent marketplace returns error JSON', async () => {
    const { stdout, exitCode } = await runCli(['plugin', 'marketplace', 'remove', 'nonexistent-mp', '--json']);
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json.success).toBe(false);
    expect(json.command).toBe('plugin marketplace remove');
    expect(typeof json.error).toBe('string');
  });
});

// =============================================================================
// --json flag position
// =============================================================================

describe('CLI --json flag position', () => {
  it('--json can appear before the subcommand', async () => {
    const { stdout, exitCode } = await runCli(['--json', 'plugin', 'validate', '/tmp/test']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.success).toBe(true);
    expect(json.command).toBe('plugin validate');
  });

  it('--json can appear between subcommands', async () => {
    const { stdout, exitCode } = await runCli(['plugin', '--json', 'validate', '/tmp/test']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.success).toBe(true);
    expect(json.command).toBe('plugin validate');
  });
});

// =============================================================================
// Human output is unchanged without --json
// =============================================================================

describe('CLI output without --json is unchanged', () => {
  it('plugin validate without --json outputs human text', async () => {
    const { stdout, exitCode } = await runCli(['plugin', 'validate', '/tmp/test']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Validating plugin at: /tmp/test');
    expect(stdout).toContain('(validation not yet implemented)');
    // Ensure it's not JSON
    expect(() => JSON.parse(stdout)).toThrow();
  });

  it('workspace sync without --json in non-workspace dir outputs human error', async () => {
    const { stderr, exitCode } = await runCli(['workspace', 'sync']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Error');
  });

  it('plugin marketplace list without --json outputs human text', async () => {
    const { stdout, exitCode } = await runCli(['plugin', 'marketplace', 'list']);
    expect(exitCode).toBe(0);
    // Should contain human-readable text, not JSON
    expect(() => JSON.parse(stdout)).toThrow();
  });
});
