import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncWorkspace } from '../../src/core/sync.js';

describe('vscode project-scoped MCP sync e2e', () => {
  let testDir: string;
  let pluginDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `allagents-e2e-mcp-${Date.now()}`);
    pluginDir = join(testDir, 'test-plugin');
    mkdirSync(join(testDir, '.allagents'), { recursive: true });
    mkdirSync(pluginDir, { recursive: true });

    // Create a plugin with an MCP server
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'test-plugin', version: '1.0.0' }),
    );
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' },
        },
      }),
    );
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('sync writes MCP servers to project .vscode/mcp.json when vscode client is configured', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins:
  - ${pluginDir}
clients:
  - vscode
`,
    );

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);

    // MCP servers should be synced to project-scoped .vscode/mcp.json
    const mcpConfigPath = join(testDir, '.vscode', 'mcp.json');
    expect(existsSync(mcpConfigPath)).toBe(true);

    const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
    expect(mcpConfig.servers).toBeDefined();
    expect(mcpConfig.servers.deepwiki).toEqual({
      type: 'http',
      url: 'https://mcp.deepwiki.com/mcp',
    });

    // mcpResults should be returned
    expect(result.mcpResults).toBeDefined();
    expect(result.mcpResults!.vscode).toBeDefined();
    expect(result.mcpResults!.vscode!.added).toBe(1);
    expect(result.mcpResults!.vscode!.addedServers).toContain('deepwiki');
  });

  test('sync does not write MCP config when vscode client is absent', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins:
  - ${pluginDir}
clients:
  - claude
`,
    );

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);

    const mcpConfigPath = join(testDir, '.vscode', 'mcp.json');
    expect(existsSync(mcpConfigPath)).toBe(false);
    expect(result.mcpResults).toBeUndefined();
  });

  test('sync tracks MCP servers in project sync state', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins:
  - ${pluginDir}
clients:
  - vscode
`,
    );

    // First sync - adds the server
    const result1 = await syncWorkspace(testDir);
    expect(result1.mcpResults?.vscode?.added).toBe(1);

    // Second sync - server already exists, no changes
    const result2 = await syncWorkspace(testDir);
    expect(result2.mcpResults?.vscode?.added).toBe(0);

    // Remove plugin and sync again - server should be removed
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins: []
clients:
  - vscode
`,
    );
    const result3 = await syncWorkspace(testDir);
    expect(result3.mcpResults?.vscode?.removed).toBe(1);
    expect(result3.mcpResults?.vscode?.removedServers).toContain('deepwiki');

    // Verify the server was removed from the file
    const mcpConfigPath = join(testDir, '.vscode', 'mcp.json');
    const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
    expect(mcpConfig.servers.deepwiki).toBeUndefined();
  });
});
