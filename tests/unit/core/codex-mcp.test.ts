import { describe, expect, test } from 'bun:test';
import { buildCodexMcpAddArgs } from '../../../src/core/codex-mcp.js';

describe('buildCodexMcpAddArgs', () => {
  test('maps URL-based server to --url flag', () => {
    const args = buildCodexMcpAddArgs('deepwiki', {
      url: 'https://mcp.deepwiki.com/mcp',
    });
    expect(args).toEqual(['mcp', 'add', 'deepwiki', '--url', 'https://mcp.deepwiki.com/mcp']);
  });

  test('maps stdio server to -- command args', () => {
    const args = buildCodexMcpAddArgs('context7', {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@latest'],
    });
    expect(args).toEqual(['mcp', 'add', 'context7', '--', 'npx', '-y', '@upstash/context7-mcp@latest']);
  });

  test('maps stdio server with env vars to --env flags', () => {
    const args = buildCodexMcpAddArgs('myserver', {
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'abc', MODE: 'prod' },
    });
    expect(args).toEqual([
      'mcp', 'add', 'myserver',
      '--env', 'API_KEY=abc', '--env', 'MODE=prod',
      '--', 'node', 'server.js',
    ]);
  });

  test('maps stdio server with no args', () => {
    const args = buildCodexMcpAddArgs('simple', {
      command: 'my-mcp-server',
    });
    expect(args).toEqual(['mcp', 'add', 'simple', '--', 'my-mcp-server']);
  });

  test('returns null for unsupported config (no url or command)', () => {
    const args = buildCodexMcpAddArgs('bad', { type: 'sse' });
    expect(args).toBeNull();
  });
});
