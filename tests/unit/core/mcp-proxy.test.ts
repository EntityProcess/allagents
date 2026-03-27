import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  shouldProxy,
  applyMcpProxy,
  ensureProxyMetadata,
} from '../../../src/core/mcp-proxy.js';
import type { McpProxyConfig } from '../../../src/models/workspace-config.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `allagents-mcp-proxy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('shouldProxy', () => {
  test('returns true when client is in proxy clients list', () => {
    const config: McpProxyConfig = { clients: ['claude', 'copilot'] };
    expect(shouldProxy('any-server', 'claude', config)).toBe(true);
    expect(shouldProxy('any-server', 'copilot', config)).toBe(true);
  });

  test('returns false when client is not in proxy clients list', () => {
    const config: McpProxyConfig = { clients: ['claude'] };
    expect(shouldProxy('any-server', 'codex', config)).toBe(false);
  });

  test('returns true when server has per-server override for client', () => {
    const config: McpProxyConfig = {
      clients: ['claude'],
      servers: { 'my-api': { proxy: ['codex'] } },
    };
    expect(shouldProxy('my-api', 'codex', config)).toBe(true);
  });

  test('returns true when client is in both default and per-server', () => {
    const config: McpProxyConfig = {
      clients: ['claude'],
      servers: { 'my-api': { proxy: ['claude'] } },
    };
    expect(shouldProxy('my-api', 'claude', config)).toBe(true);
  });

  test('returns false for server not in overrides and client not in defaults', () => {
    const config: McpProxyConfig = {
      clients: ['claude'],
      servers: { 'other-api': { proxy: ['codex'] } },
    };
    expect(shouldProxy('my-api', 'codex', config)).toBe(false);
  });
});

describe('applyMcpProxy', () => {
  const metadataPath = '/home/testuser/.allagents/mcp-remote/mcp-metadata-settings.json';

  test('rewrites HTTP server config to stdio for proxied client', () => {
    const servers = new Map<string, unknown>([
      ['deepwiki', { url: 'https://mcp.deepwiki.com/mcp' }],
    ]);
    const config: McpProxyConfig = { clients: ['claude'] };
    const result = applyMcpProxy(servers, 'claude', config, metadataPath);
    expect(result.get('deepwiki')).toEqual({
      command: 'npx',
      args: [
        'mcp-remote',
        'https://mcp.deepwiki.com/mcp',
        '--http',
        '--static-oauth-client-metadata',
        `@${metadataPath}`,
      ],
    });
  });

  test('does not rewrite HTTP server for non-proxied client', () => {
    const servers = new Map<string, unknown>([
      ['deepwiki', { url: 'https://mcp.deepwiki.com/mcp' }],
    ]);
    const config: McpProxyConfig = { clients: ['claude'] };
    const result = applyMcpProxy(servers, 'codex', config, metadataPath);
    expect(result.get('deepwiki')).toEqual({ url: 'https://mcp.deepwiki.com/mcp' });
  });

  test('does not rewrite stdio server even for proxied client', () => {
    const servers = new Map<string, unknown>([
      ['local-server', { command: 'node', args: ['server.js'] }],
    ]);
    const config: McpProxyConfig = { clients: ['claude'] };
    const result = applyMcpProxy(servers, 'claude', config, metadataPath);
    expect(result.get('local-server')).toEqual({ command: 'node', args: ['server.js'] });
  });

  test('handles mix of HTTP and stdio servers', () => {
    const servers = new Map<string, unknown>([
      ['http-server', { url: 'https://example.com/mcp' }],
      ['stdio-server', { command: 'npx', args: ['some-mcp'] }],
    ]);
    const config: McpProxyConfig = { clients: ['copilot'] };
    const result = applyMcpProxy(servers, 'copilot', config, metadataPath);
    expect((result.get('http-server') as Record<string, unknown>).command).toBe('npx');
    expect((result.get('stdio-server') as Record<string, unknown>).command).toBe('npx');
    expect((result.get('stdio-server') as Record<string, unknown>).args).toEqual(['some-mcp']);
  });

  test('applies per-server override for additional client', () => {
    const servers = new Map<string, unknown>([
      ['my-api', { url: 'https://api.example.com/mcp' }],
      ['other-api', { url: 'https://other.example.com/mcp' }],
    ]);
    const config: McpProxyConfig = {
      clients: ['claude'],
      servers: { 'my-api': { proxy: ['codex'] } },
    };
    const result = applyMcpProxy(servers, 'codex', config, metadataPath);
    expect((result.get('my-api') as Record<string, unknown>).command).toBe('npx');
    expect(result.get('other-api')).toEqual({ url: 'https://other.example.com/mcp' });
  });
});

describe('ensureProxyMetadata', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('creates metadata file if it does not exist', () => {
    const metadataPath = join(tempDir, 'mcp-remote', 'mcp-metadata-settings.json');
    ensureProxyMetadata(metadataPath);
    expect(existsSync(metadataPath)).toBe(true);
    const content = JSON.parse(readFileSync(metadataPath, 'utf-8'));
    expect(content).toEqual({ client_uri: 'http://localhost' });
  });

  test('does not overwrite existing metadata file', () => {
    const dir = join(tempDir, 'mcp-remote');
    mkdirSync(dir, { recursive: true });
    const metadataPath = join(dir, 'mcp-metadata-settings.json');
    writeFileSync(metadataPath, JSON.stringify({ client_uri: 'http://custom' }));

    ensureProxyMetadata(metadataPath);
    const content = JSON.parse(readFileSync(metadataPath, 'utf-8'));
    expect(content).toEqual({ client_uri: 'http://custom' });
  });
});
