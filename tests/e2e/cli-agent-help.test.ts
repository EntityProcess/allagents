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
// Full command tree
// =============================================================================

describe('allagents --agent-help (full tree)', () => {
  it('outputs valid JSON with name, version, description, and commands', async () => {
    const { stdout, exitCode } = await runCli(['--agent-help']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.name).toBe('allagents');
    expect(typeof json.version).toBe('string');
    expect(json.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof json.description).toBe('string');
    expect(json.commands).toBeInstanceOf(Array);
  });

  it('contains all 12 commands', async () => {
    const { stdout } = await runCli(['--agent-help']);
    const json = parseJson(stdout);
    expect(json.commands.length).toBe(12);

    const commandNames = json.commands.map((c: any) => c.command).sort();
    expect(commandNames).toEqual([
      'plugin list',
      'plugin marketplace add',
      'plugin marketplace list',
      'plugin marketplace remove',
      'plugin marketplace update',
      'plugin validate',
      'self update',
      'workspace init',
      'workspace plugin install',
      'workspace plugin uninstall',
      'workspace status',
      'workspace sync',
    ]);
  });

  it('every command has required fields', async () => {
    const { stdout } = await runCli(['--agent-help']);
    const json = parseJson(stdout);
    for (const cmd of json.commands) {
      expect(typeof cmd.command).toBe('string');
      expect(typeof cmd.description).toBe('string');
      expect(typeof cmd.when_to_use).toBe('string');
      expect(cmd.examples).toBeInstanceOf(Array);
      expect(cmd.examples.length).toBeGreaterThan(0);
      expect(cmd.output_schema).toBeDefined();
    }
  });
});

// =============================================================================
// Single command metadata
// =============================================================================

describe('allagents <command> --agent-help (single command)', () => {
  it('workspace sync --agent-help outputs single-command metadata', async () => {
    const { stdout, exitCode } = await runCli(['workspace', 'sync', '--agent-help']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.command).toBe('workspace sync');
    expect(typeof json.description).toBe('string');
    expect(typeof json.when_to_use).toBe('string');
    expect(json.examples).toBeInstanceOf(Array);
    expect(json.output_schema).toBeDefined();
    // Should not have top-level commands array (that's the tree format)
    expect(json.commands).toBeUndefined();
  });

  it('workspace sync options include type and short where applicable', async () => {
    const { stdout } = await runCli(['workspace', 'sync', '--agent-help']);
    const json = parseJson(stdout);
    expect(json.options).toBeInstanceOf(Array);
    expect(json.options.length).toBe(3);

    const dryRun = json.options.find((o: any) => o.flag === '--dry-run');
    expect(dryRun).toBeDefined();
    expect(dryRun.type).toBe('boolean');
    expect(dryRun.short).toBe('-n');

    const client = json.options.find((o: any) => o.flag === '--client');
    expect(client).toBeDefined();
    expect(client.type).toBe('string');
    expect(client.short).toBe('-c');

    const offline = json.options.find((o: any) => o.flag === '--offline');
    expect(offline).toBeDefined();
    expect(offline.type).toBe('boolean');
    expect(offline.short).toBeUndefined();
  });

  it('workspace plugin install --agent-help includes positionals', async () => {
    const { stdout, exitCode } = await runCli(['workspace', 'plugin', 'install', '--agent-help']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.command).toBe('workspace plugin install');
    expect(json.positionals).toBeInstanceOf(Array);
    expect(json.positionals.length).toBe(1);
    expect(json.positionals[0].name).toBe('plugin');
    expect(json.positionals[0].type).toBe('string');
    expect(json.positionals[0].required).toBe(true);
  });

  it('self update --agent-help includes options', async () => {
    const { stdout, exitCode } = await runCli(['self', 'update', '--agent-help']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.command).toBe('self update');
    expect(json.options).toBeInstanceOf(Array);
    expect(json.options.length).toBe(2);

    const npmOpt = json.options.find((o: any) => o.flag === '--npm');
    expect(npmOpt).toBeDefined();
    expect(npmOpt.type).toBe('boolean');

    const bunOpt = json.options.find((o: any) => o.flag === '--bun');
    expect(bunOpt).toBeDefined();
    expect(bunOpt.type).toBe('boolean');
  });

  it('workspace status --agent-help omits positionals and options when none exist', async () => {
    const { stdout, exitCode } = await runCli(['workspace', 'status', '--agent-help']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.command).toBe('workspace status');
    expect(json.positionals).toBeUndefined();
    expect(json.options).toBeUndefined();
  });
});

// =============================================================================
// Subcommand group
// =============================================================================

describe('allagents <group> --agent-help (subcommand group)', () => {
  it('workspace --agent-help outputs group with workspace commands', async () => {
    const { stdout, exitCode } = await runCli(['workspace', '--agent-help']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.name).toBe('workspace');
    expect(json.commands).toBeInstanceOf(Array);
    expect(json.commands.length).toBe(5);

    const commandNames = json.commands.map((c: any) => c.command).sort();
    expect(commandNames).toEqual([
      'workspace init',
      'workspace plugin install',
      'workspace plugin uninstall',
      'workspace status',
      'workspace sync',
    ]);
  });

  it('plugin --agent-help outputs group with plugin commands', async () => {
    const { stdout, exitCode } = await runCli(['plugin', '--agent-help']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.name).toBe('plugin');
    expect(json.commands).toBeInstanceOf(Array);
    expect(json.commands.length).toBe(6);
  });

  it('plugin marketplace --agent-help outputs group with marketplace commands', async () => {
    const { stdout, exitCode } = await runCli(['plugin', 'marketplace', '--agent-help']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.name).toBe('plugin marketplace');
    expect(json.commands).toBeInstanceOf(Array);
    expect(json.commands.length).toBe(4);
  });
});

// =============================================================================
// Flag position
// =============================================================================

describe('--agent-help flag position', () => {
  it('--agent-help can appear before the subcommand', async () => {
    const { stdout, exitCode } = await runCli(['--agent-help', 'workspace', 'sync']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.command).toBe('workspace sync');
  });

  it('--agent-help can appear between subcommands', async () => {
    const { stdout, exitCode } = await runCli(['workspace', '--agent-help', 'sync']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.command).toBe('workspace sync');
  });
});

// =============================================================================
// Error cases
// =============================================================================

describe('--agent-help error cases', () => {
  it('unknown command returns exit code 1', async () => {
    const { exitCode, stderr } = await runCli(['nonexistent', '--agent-help']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Unknown command');
  });
});
