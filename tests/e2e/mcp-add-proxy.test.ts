import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(workdir: string, homeDir: string, args: string[]): CliResult {
  const cliEntry = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');
  const proc = Bun.spawnSync(['bun', 'run', cliEntry, '--json', ...args], {
    cwd: workdir,
    env: {
      ...process.env,
      HOME: homeDir,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });

  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

function readWorkspaceConfig(workspaceDir: string): Record<string, unknown> {
  return load(readFileSync(join(workspaceDir, '.allagents', 'workspace.yaml'), 'utf-8')) as Record<
    string,
    unknown
  >;
}

describe('mcp add --proxy e2e', () => {
  let workspaceDir: string;
  let homeDir: string;

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `allagents-e2e-mcp-add-proxy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    homeDir = join(tmpdir(), `allagents-e2e-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(workspaceDir, '.allagents'), { recursive: true });
    mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  test('adds deepwiki with proxy enabled for all configured MCP clients', () => {
    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      `repositories: []
plugins: []
clients:
  - claude
  - codex
  - vscode
  - copilot
`,
      'utf-8',
    );

    const result = runCli(workspaceDir, homeDir, [
      'mcp',
      'add',
      'deepwiki',
      'https://mcp.deepwiki.com/mcp',
      '--proxy',
    ]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.success).toBe(true);

    const workspace = readWorkspaceConfig(workspaceDir);
    expect(workspace.mcpServers).toEqual({
      deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' },
    });
    expect(workspace.mcpProxy).toEqual({
      clients: [],
      servers: {
        deepwiki: {
          proxy: ['claude', 'codex', 'vscode', 'copilot'],
        },
      },
    });

    const claudeConfig = JSON.parse(readFileSync(join(workspaceDir, '.mcp.json'), 'utf-8'));
    expect(claudeConfig.mcpServers.deepwiki.command).toBe('allagents');
    expect(claudeConfig.mcpServers.deepwiki.args).toEqual([
      'mcp',
      'proxy-stdio',
      'https://mcp.deepwiki.com/mcp',
    ]);

    const codexConfig = readFileSync(join(workspaceDir, '.codex', 'config.toml'), 'utf-8');
    expect(codexConfig).toContain('proxy-stdio');
    expect(codexConfig).toContain('https://mcp.deepwiki.com/mcp');

    const vscodeConfig = JSON.parse(readFileSync(join(workspaceDir, '.vscode', 'mcp.json'), 'utf-8'));
    expect(vscodeConfig.servers.deepwiki.command).toBe('allagents');
    expect(vscodeConfig.servers.deepwiki.args[0]).toBe('mcp');

    const copilotConfig = JSON.parse(readFileSync(join(workspaceDir, '.copilot', 'mcp-config.json'), 'utf-8'));
    expect(copilotConfig.mcpServers.deepwiki.command).toBe('allagents');
    expect(copilotConfig.mcpServers.deepwiki.args[0]).toBe('mcp');

    const rerun = runCli(workspaceDir, homeDir, ['mcp', 'update']);
    expect(rerun.exitCode).toBe(0);
    const rerunPayload = JSON.parse(rerun.stdout);
    expect(rerunPayload.success).toBe(true);
    expect(rerunPayload.data.mcpResults.claude.added).toBe(0);
    expect(rerunPayload.data.mcpResults.codex.added).toBe(0);
    expect(rerunPayload.data.mcpResults.vscode.added).toBe(0);
    expect(rerunPayload.data.mcpResults.copilot.added).toBe(0);
  });

  test('scopes proxying to selected clients with --client', () => {
    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      `repositories: []
plugins: []
clients:
  - claude
  - codex
  - vscode
`,
      'utf-8',
    );

    const result = runCli(workspaceDir, homeDir, [
      'mcp',
      'add',
      'secure-api',
      'https://api.example.com/mcp',
      '--proxy',
      '--client',
      'claude,codex',
    ]);

    expect(result.exitCode).toBe(0);

    const workspace = readWorkspaceConfig(workspaceDir);
    expect(workspace.mcpServers).toEqual({
      'secure-api': {
        type: 'http',
        url: 'https://api.example.com/mcp',
        clients: ['claude', 'codex'],
      },
    });
    expect(workspace.mcpProxy).toEqual({
      clients: [],
      servers: {
        'secure-api': {
          proxy: ['claude', 'codex'],
        },
      },
    });

    expect(existsSync(join(workspaceDir, '.mcp.json'))).toBe(true);
    expect(existsSync(join(workspaceDir, '.codex', 'config.toml'))).toBe(true);
    expect(existsSync(join(workspaceDir, '.vscode', 'mcp.json'))).toBe(false);
  });
});
