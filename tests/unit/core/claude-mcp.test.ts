import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { syncClaudeMcpConfig } from '../../../src/core/claude-mcp.js';
import type { ValidatedPlugin } from '../../../src/core/sync.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `allagents-claude-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makePlugin(resolved: string, plugin = 'test-plugin'): ValidatedPlugin {
  return { plugin, resolved, success: true };
}

describe('syncClaudeMcpConfig', () => {
  let tempDir: string;
  let pluginDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    pluginDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(pluginDir, { recursive: true, force: true });
  });

  test('creates settings.json with mcpServers when none exists', () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } } }),
    );

    const configPath = join(tempDir, '.claude', 'settings.json');
    const result = syncClaudeMcpConfig([makePlugin(pluginDir)], { configPath });

    expect(result.added).toBe(1);
    expect(result.addedServers).toEqual(['deepwiki']);
    expect(result.trackedServers).toEqual(['deepwiki']);
    expect(existsSync(configPath)).toBe(true);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers.deepwiki).toEqual({ type: 'http', url: 'https://mcp.deepwiki.com/mcp' });
  });

  test('preserves existing settings when adding mcpServers', () => {
    const configPath = join(tempDir, 'settings.json');
    writeFileSync(configPath, JSON.stringify({ allowedTools: ['Read', 'Write'] }));

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } } }),
    );

    syncClaudeMcpConfig([makePlugin(pluginDir)], { configPath });

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.allowedTools).toEqual(['Read', 'Write']);
    expect(written.mcpServers.deepwiki).toEqual({ type: 'http', url: 'https://mcp.deepwiki.com/mcp' });
  });

  test('skips user-managed servers with conflicting names', () => {
    const configPath = join(tempDir, 'settings.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { deepwiki: { type: 'http', url: 'https://my-custom-deepwiki.com' } },
    }));

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } } }),
    );

    const result = syncClaudeMcpConfig([makePlugin(pluginDir)], { configPath });

    expect(result.skipped).toBe(1);
    expect(result.added).toBe(0);
    // User's config should be preserved
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers.deepwiki.url).toBe('https://my-custom-deepwiki.com');
  });

  test('updates tracked servers when config changes', () => {
    const configPath = join(tempDir, 'settings.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { deepwiki: { type: 'http', url: 'https://old.deepwiki.com' } },
    }));

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: { type: 'http', url: 'https://new.deepwiki.com' } } }),
    );

    const result = syncClaudeMcpConfig([makePlugin(pluginDir)], {
      configPath,
      trackedServers: ['deepwiki'],
    });

    expect(result.overwritten).toBe(1);
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers.deepwiki.url).toBe('https://new.deepwiki.com');
  });

  test('removes orphaned tracked servers', () => {
    const configPath = join(tempDir, 'settings.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { old_server: { type: 'http', url: 'https://old.com' } },
    }));

    // No plugins have MCP servers
    const result = syncClaudeMcpConfig([], {
      configPath,
      trackedServers: ['old_server'],
    });

    expect(result.removed).toBe(1);
    expect(result.removedServers).toEqual(['old_server']);
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers.old_server).toBeUndefined();
  });

  test('does not write in dry-run mode', () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } } }),
    );

    const configPath = join(tempDir, 'settings.json');
    const result = syncClaudeMcpConfig([makePlugin(pluginDir)], { configPath, dryRun: true });

    expect(result.added).toBe(1);
    expect(existsSync(configPath)).toBe(false);
  });
});
