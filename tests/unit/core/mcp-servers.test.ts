import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import {
  addWorkspaceMcpServer,
  buildMcpServerConfigFromFlags,
  getWorkspaceMcpServer,
  listWorkspaceMcpServers,
  parseKeyValuePairs,
  removeWorkspaceMcpServer,
} from '../../../src/core/mcp-servers.js';

function makeTempWorkspace(): string {
  const dir = join(
    tmpdir(),
    `mcp-servers-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, '.allagents'), { recursive: true });
  writeFileSync(
    join(dir, '.allagents', 'workspace.yaml'),
    'repositories: []\nplugins: []\nclients:\n  - claude\n',
    'utf-8',
  );
  return dir;
}

function readWorkspace(dir: string): Record<string, unknown> {
  return load(readFileSync(join(dir, '.allagents', 'workspace.yaml'), 'utf-8')) as Record<
    string,
    unknown
  >;
}

describe('addWorkspaceMcpServer', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempWorkspace();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('adds an http server', async () => {
    const result = await addWorkspaceMcpServer(
      'deepwiki',
      { type: 'http', url: 'https://mcp.deepwiki.com/mcp' },
      dir,
    );
    expect(result.success).toBe(true);

    const cfg = readWorkspace(dir);
    expect(cfg.mcpServers).toEqual({
      deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' },
    });
  });

  test('rejects duplicate without force', async () => {
    await addWorkspaceMcpServer('a', { command: 'x' }, dir);
    const result = await addWorkspaceMcpServer('a', { command: 'y' }, dir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
  });

  test('replaces duplicate with force', async () => {
    await addWorkspaceMcpServer('a', { command: 'x' }, dir);
    const result = await addWorkspaceMcpServer('a', { command: 'y' }, dir, true);
    expect(result.success).toBe(true);
    const cfg = readWorkspace(dir);
    expect((cfg.mcpServers as Record<string, { command: string }>).a.command).toBe('y');
  });

  test('rejects invalid config', async () => {
    // Neither command nor url
    const result = await addWorkspaceMcpServer(
      'bad',
      { type: 'http' } as unknown as Parameters<typeof addWorkspaceMcpServer>[1],
      dir,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid MCP server config');
  });

  test('preserves other workspace.yaml fields on add', async () => {
    await addWorkspaceMcpServer('a', { command: 'x' }, dir);
    const cfg = readWorkspace(dir);
    expect(cfg.repositories).toEqual([]);
    expect(cfg.plugins).toEqual([]);
    expect(cfg.clients).toEqual(['claude']);
  });
});

describe('removeWorkspaceMcpServer', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempWorkspace();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('removes an existing server', async () => {
    await addWorkspaceMcpServer('a', { command: 'x' }, dir);
    const result = await removeWorkspaceMcpServer('a', dir);
    expect(result.success).toBe(true);
    const cfg = readWorkspace(dir);
    expect(cfg.mcpServers).toBeUndefined();
  });

  test('fails when server does not exist', async () => {
    const result = await removeWorkspaceMcpServer('nonexistent', dir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('getWorkspaceMcpServer / listWorkspaceMcpServers', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempWorkspace();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('get returns null for missing server', async () => {
    const cfg = await getWorkspaceMcpServer('missing', dir);
    expect(cfg).toBeNull();
  });

  test('get returns server config', async () => {
    await addWorkspaceMcpServer('a', { command: 'x' }, dir);
    const cfg = await getWorkspaceMcpServer('a', dir);
    expect(cfg).toEqual({ command: 'x' } as unknown as typeof cfg);
  });

  test('list returns all servers', async () => {
    await addWorkspaceMcpServer('a', { command: 'x' }, dir);
    await addWorkspaceMcpServer(
      'b',
      { type: 'http', url: 'https://b.test' },
      dir,
    );
    const servers = await listWorkspaceMcpServers(dir);
    expect(Object.keys(servers).sort()).toEqual(['a', 'b']);
  });

  test('list returns empty object when none defined', async () => {
    const servers = await listWorkspaceMcpServers(dir);
    expect(servers).toEqual({});
  });
});

describe('buildMcpServerConfigFromFlags', () => {
  test('auto-detects http transport from URL', () => {
    const result = buildMcpServerConfigFromFlags({
      commandOrUrl: 'https://mcp.example.com',
    });
    expect('config' in result).toBe(true);
    if ('config' in result) {
      expect(result.config).toEqual({ type: 'http', url: 'https://mcp.example.com' });
    }
  });

  test('builds stdio config with args and env', () => {
    const result = buildMcpServerConfigFromFlags({
      commandOrUrl: 'npx',
      args: ['-y', 'mcp-server'],
      env: { KEY: 'value' },
    });
    expect('config' in result).toBe(true);
    if ('config' in result) {
      expect(result.config).toEqual({
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-server'],
        env: { KEY: 'value' },
      });
    }
  });

  test('rejects args for http transport', () => {
    const result = buildMcpServerConfigFromFlags({
      commandOrUrl: 'https://mcp.example.com',
      args: ['foo'],
    });
    expect('error' in result).toBe(true);
  });

  test('rejects explicit http transport for non-URL', () => {
    const result = buildMcpServerConfigFromFlags({
      commandOrUrl: 'npx',
      transport: 'http',
    });
    expect('error' in result).toBe(true);
  });

  test('rejects explicit stdio transport for URL', () => {
    const result = buildMcpServerConfigFromFlags({
      commandOrUrl: 'https://mcp.example.com',
      transport: 'stdio',
    });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('stdio transport requires a command');
    }
  });

  test('applies client filter', () => {
    const result = buildMcpServerConfigFromFlags({
      commandOrUrl: 'npx',
      clients: ['claude'],
    });
    expect('config' in result).toBe(true);
    if ('config' in result) {
      expect(result.config.clients).toEqual(['claude']);
    }
  });
});

describe('parseKeyValuePairs', () => {
  test('parses KEY=VALUE pairs', () => {
    const result = parseKeyValuePairs(['A=1', 'B=two'], '-e');
    expect('values' in result).toBe(true);
    if ('values' in result) {
      expect(result.values).toEqual({ A: '1', B: 'two' });
    }
  });

  test('rejects pair missing =', () => {
    const result = parseKeyValuePairs(['bad'], '-e');
    expect('error' in result).toBe(true);
  });

  test('preserves = in value', () => {
    const result = parseKeyValuePairs(['URL=http://x?a=1'], '-e');
    if ('values' in result) {
      expect(result.values.URL).toBe('http://x?a=1');
    }
  });
});
