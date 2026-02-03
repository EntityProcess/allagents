import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execa } from 'execa';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = resolve(import.meta.dir, '../../dist/index.js');

async function runCli(args: string[], options?: { env?: Record<string, string>; cwd?: string }) {
  try {
    const result = await execa('node', [CLI, ...args], {
      ...(options?.env && { env: { ...process.env, ...options.env } }),
      ...(options?.cwd && { cwd: options.cwd }),
    });
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
  let mockHome: string;

  beforeAll(async () => {
    mockHome = await mkdtemp(join(tmpdir(), 'allagents-e2e-json-'));
  });

  afterAll(async () => {
    await rm(mockHome, { recursive: true, force: true });
  });

  it('workspace sync --json in non-workspace dir with no user config returns success JSON', async () => {
    const { stdout, exitCode } = await runCli(['workspace', 'sync', '--json'], { env: { HOME: mockHome }, cwd: mockHome });
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.success).toBe(true);
    expect(json.command).toBe('workspace sync');
  });

  it('workspace status --json in non-workspace dir falls back to user workspace', async () => {
    const { stdout, exitCode } = await runCli(['workspace', 'status', '--json'], { env: { HOME: mockHome }, cwd: mockHome });
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.success).toBe(true);
    expect(json.command).toBe('workspace status');
    expect(json.data.plugins).toEqual([]);
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

  it('workspace sync without --json in non-workspace dir outputs guidance', async () => {
    const mockHome2 = await mkdtemp(join(tmpdir(), 'allagents-e2e-human-'));
    try {
      const { stdout, exitCode } = await runCli(['workspace', 'sync'], { env: { HOME: mockHome2 }, cwd: mockHome2 });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('No plugins configured');
    } finally {
      await rm(mockHome2, { recursive: true, force: true });
    }
  });

  it('plugin marketplace list without --json outputs human text', async () => {
    const { stdout, exitCode } = await runCli(['plugin', 'marketplace', 'list']);
    expect(exitCode).toBe(0);
    // Should contain human-readable text, not JSON
    expect(() => JSON.parse(stdout)).toThrow();
  });
});
