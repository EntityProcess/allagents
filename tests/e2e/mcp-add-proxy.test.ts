import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import {
  type DummyMcpOAuthServer,
  startDummyMcpOAuthServer,
} from '../helpers/dummy-mcp-oauth-server.js';

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  workdir: string,
  homeDir: string,
  args: string[],
): Promise<CliResult> {
  const cliEntry = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');
  const proc = Bun.spawn(['bun', 'run', cliEntry, '--json', ...args], {
    cwd: workdir,
    env: {
      ...process.env,
      HOME: homeDir,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

function readWorkspaceConfig(workspaceDir: string): Record<string, unknown> {
  return load(readFileSync(join(workspaceDir, '.allagents', 'workspace.yaml'), 'utf-8')) as Record<
    string,
    unknown
  >;
}

describe('mcp add HTTP client routing e2e', () => {
  let workspaceDir: string;
  let homeDir: string;
  let dummy: DummyMcpOAuthServer;

  beforeEach(async () => {
    workspaceDir = join(tmpdir(), `allagents-e2e-mcp-add-proxy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    homeDir = join(tmpdir(), `allagents-e2e-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(workspaceDir, '.allagents'), { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    dummy = await startDummyMcpOAuthServer({ requireAuth: false });
  });

  afterEach(async () => {
    await dummy.stop();
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  test('adds deepwiki with proxy enabled for all configured MCP clients', async () => {
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

    const result = await runCli(workspaceDir, homeDir, [
      'mcp',
      'add',
      'deepwiki',
      dummy.mcpUrl,
    ]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.success).toBe(true);

    const workspace = readWorkspaceConfig(workspaceDir);
    expect(workspace.mcpServers).toEqual({
      deepwiki: { type: 'http', url: dummy.mcpUrl },
    });
    expect(workspace.mcpProxy).toEqual({
      clients: [],
      servers: {
        deepwiki: {
          proxy: ['*'],
        },
      },
    });

    const claudeConfig = JSON.parse(readFileSync(join(workspaceDir, '.mcp.json'), 'utf-8'));
    expect(claudeConfig.mcpServers.deepwiki.command).toBe('allagents');
    expect(claudeConfig.mcpServers.deepwiki.args).toEqual([
      'mcp',
      'proxy',
      dummy.mcpUrl,
    ]);

    const codexConfig = readFileSync(join(workspaceDir, '.codex', 'config.toml'), 'utf-8');
    expect(codexConfig).toContain('proxy');
    expect(codexConfig).toContain(dummy.mcpUrl);

    const vscodeConfig = JSON.parse(readFileSync(join(workspaceDir, '.vscode', 'mcp.json'), 'utf-8'));
    expect(vscodeConfig.servers.deepwiki.command).toBe('allagents');
    expect(vscodeConfig.servers.deepwiki.args[0]).toBe('mcp');

    const copilotConfig = JSON.parse(readFileSync(join(workspaceDir, '.copilot', 'mcp-config.json'), 'utf-8'));
    expect(copilotConfig.mcpServers.deepwiki.command).toBe('allagents');
    expect(copilotConfig.mcpServers.deepwiki.args[0]).toBe('mcp');

    const rerun = await runCli(workspaceDir, homeDir, ['mcp', 'update']);
    expect(rerun.exitCode).toBe(0);
    const rerunPayload = JSON.parse(rerun.stdout);
    expect(rerunPayload.success).toBe(true);
    expect(rerunPayload.data.mcpResults.claude.added).toBe(0);
    expect(rerunPayload.data.mcpResults.codex.added).toBe(0);
    expect(rerunPayload.data.mcpResults.vscode.added).toBe(0);
    expect(rerunPayload.data.mcpResults.copilot.added).toBe(0);
  });

  test('scopes proxying to selected clients with --client', async () => {
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

    const result = await runCli(workspaceDir, homeDir, [
      'mcp',
      'add',
      'secure-api',
      dummy.mcpUrl,
      '--client',
      'claude,codex',
    ]);

    expect(result.exitCode).toBe(0);

    const workspace = readWorkspaceConfig(workspaceDir);
    expect(workspace.mcpServers).toEqual({
      'secure-api': {
        type: 'http',
        url: dummy.mcpUrl,
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

  test('fails before mutation when a non-interactive HTTP preflight cannot connect', async () => {
    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      `repositories: []
plugins: []
clients:
  - claude
`,
      'utf-8',
    );

    const result = await runCli(workspaceDir, homeDir, [
      'mcp',
      'add',
      'unreachable',
      'http://127.0.0.1:1/mcp',
    ]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).success).toBe(false);
    expect(readWorkspaceConfig(workspaceDir).mcpServers).toBeUndefined();
  });

  test('returns a structured error for malformed workspace config', async () => {
    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories: [',
      'utf-8',
    );

    const result = await runCli(workspaceDir, homeDir, [
      'mcp',
      'add',
      'example',
      'https://example.com/mcp',
    ]);

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.success).toBe(false);
    expect(payload.command).toBe('mcp add');
  });
});
