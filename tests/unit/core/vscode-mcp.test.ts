import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  getVscodeMcpConfigPath,
  readPluginMcpConfig,
  collectMcpServers,
  syncVscodeMcpConfig,
} from '../../../src/core/vscode-mcp.js';
import type { ValidatedPlugin } from '../../../src/core/sync.js';

/** Create a temp directory for each test */
function makeTempDir(): string {
  const dir = join(tmpdir(), `allagents-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Helper to create a validated plugin with a resolved path */
function makePlugin(resolved: string, plugin = 'test-plugin'): ValidatedPlugin {
  return { plugin, resolved, success: true };
}

describe('getVscodeMcpConfigPath', () => {
  test('returns a valid path for current platform', () => {
    const path = getVscodeMcpConfigPath();
    expect(path).toContain('mcp.json');
    expect(path).toContain('Code');
  });
});

describe('readPluginMcpConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns null when no .mcp.json exists', () => {
    const result = readPluginMcpConfig(tempDir);
    expect(result).toBeNull();
  });

  test('returns servers when valid .mcp.json exists', () => {
    writeFileSync(
      join(tempDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          ediprod: { type: 'http', url: 'https://ediprod.mcp.wtg.zone' },
        },
      }),
    );

    const result = readPluginMcpConfig(tempDir);
    expect(result).toEqual({
      ediprod: { type: 'http', url: 'https://ediprod.mcp.wtg.zone' },
    });
  });

  test('returns null for invalid JSON', () => {
    writeFileSync(join(tempDir, '.mcp.json'), 'not valid json {{{');
    const result = readPluginMcpConfig(tempDir);
    expect(result).toBeNull();
  });
});

describe('collectMcpServers', () => {
  let tempDir1: string;
  let tempDir2: string;

  beforeEach(() => {
    tempDir1 = makeTempDir();
    tempDir2 = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir1, { recursive: true, force: true });
    rmSync(tempDir2, { recursive: true, force: true });
  });

  test('merges servers from multiple plugins', () => {
    writeFileSync(
      join(tempDir1, '.mcp.json'),
      JSON.stringify({ mcpServers: { server1: { type: 'http', url: 'https://a.test' } } }),
    );
    writeFileSync(
      join(tempDir2, '.mcp.json'),
      JSON.stringify({ mcpServers: { server2: { type: 'http', url: 'https://b.test' } } }),
    );

    const { servers, warnings } = collectMcpServers([
      makePlugin(tempDir1, 'plugin-a'),
      makePlugin(tempDir2, 'plugin-b'),
    ]);

    expect(servers.size).toBe(2);
    expect(servers.get('server1')).toEqual({ type: 'http', url: 'https://a.test' });
    expect(servers.get('server2')).toEqual({ type: 'http', url: 'https://b.test' });
    expect(warnings).toHaveLength(0);
  });

  test('warns on duplicate server names, first plugin wins', () => {
    writeFileSync(
      join(tempDir1, '.mcp.json'),
      JSON.stringify({ mcpServers: { dup: { type: 'http', url: 'https://first.test' } } }),
    );
    writeFileSync(
      join(tempDir2, '.mcp.json'),
      JSON.stringify({ mcpServers: { dup: { type: 'http', url: 'https://second.test' } } }),
    );

    const { servers, warnings } = collectMcpServers([
      makePlugin(tempDir1, 'plugin-a'),
      makePlugin(tempDir2, 'plugin-b'),
    ]);

    expect(servers.size).toBe(1);
    expect(servers.get('dup')).toEqual({ type: 'http', url: 'https://first.test' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('plugin-b');
    expect(warnings[0]).toContain('dup');
  });
});

describe('syncVscodeMcpConfig', () => {
  let tempDir: string;
  let pluginDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    pluginDir = makeTempDir();
    configPath = join(tempDir, 'mcp.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(pluginDir, { recursive: true, force: true });
  });

  test('adds new servers to empty config', () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          ediprod: { type: 'http', url: 'https://ediprod.mcp.wtg.zone' },
          wtgkb: { type: 'http', url: 'https://wtgkb.mcp.wtg.zone' },
        },
      }),
    );

    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], { configPath });

    expect(result.added).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.addedServers).toEqual(['ediprod', 'wtgkb']);

    // Verify file was written
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.servers.ediprod).toEqual({ type: 'http', url: 'https://ediprod.mcp.wtg.zone' });
    expect(written.servers.wtgkb).toEqual({ type: 'http', url: 'https://wtgkb.mcp.wtg.zone' });
  });

  test('preserves existing servers and other keys', () => {
    // Pre-existing VS Code config with existing server and custom key
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          existing: { type: 'http', url: 'https://existing.test' },
        },
        customKey: 'preserved',
      }),
    );

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { newserver: { type: 'http', url: 'https://new.test' } },
      }),
    );

    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], { configPath });

    expect(result.added).toBe(1);
    expect(result.addedServers).toEqual(['newserver']);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.servers.existing).toEqual({ type: 'http', url: 'https://existing.test' });
    expect(written.servers.newserver).toEqual({ type: 'http', url: 'https://new.test' });
    expect(written.customKey).toBe('preserved');
  });

  test('skips servers that already exist', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          ediprod: { type: 'http', url: 'https://user-configured.test' },
        },
      }),
    );

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { ediprod: { type: 'http', url: 'https://plugin.test' } },
      }),
    );

    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], { configPath });

    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.skippedServers).toEqual(['ediprod']);

    // Verify original value is preserved
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.servers.ediprod.url).toBe('https://user-configured.test');
  });

  test('dry-run does not write file', () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { ediprod: { type: 'http', url: 'https://ediprod.test' } },
      }),
    );

    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], { configPath, dryRun: true });

    expect(result.added).toBe(1);
    expect(result.addedServers).toEqual(['ediprod']);
    // File should NOT have been created
    expect(existsSync(configPath)).toBe(false);
  });

  test('no-op when no plugins have .mcp.json', () => {
    // pluginDir has no .mcp.json
    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], { configPath });

    expect(result.added).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.addedServers).toEqual([]);
    expect(result.skippedServers).toEqual([]);
    expect(existsSync(configPath)).toBe(false);
  });
});
