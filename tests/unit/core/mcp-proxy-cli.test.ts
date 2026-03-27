import { describe, expect, test } from 'bun:test';
import { buildClaudeMcpAddArgs } from '../../../src/core/claude-mcp.js';
import { buildCodexMcpAddArgs } from '../../../src/core/codex-mcp.js';
import { applyMcpProxy } from '../../../src/core/mcp-proxy.js';
import type { McpProxyConfig } from '../../../src/models/workspace-config.js';

describe('CLI args with proxy transform', () => {
  const metadataPath = '/home/user/.allagents/mcp-remote/mcp-metadata-settings.json';

  test('buildClaudeMcpAddArgs handles proxied HTTP config', () => {
    const servers = new Map<string, unknown>([
      ['deepwiki', { url: 'https://mcp.deepwiki.com/mcp' }],
    ]);
    const config: McpProxyConfig = { clients: ['claude'] };
    const proxied = applyMcpProxy(servers, 'claude', config, metadataPath);
    const proxiedConfig = proxied.get('deepwiki') as Record<string, unknown>;

    const args = buildClaudeMcpAddArgs('deepwiki', proxiedConfig);
    expect(args).toEqual([
      'mcp', 'add', '--scope', 'user',
      'deepwiki', '--', 'npx',
      'mcp-remote',
      'https://mcp.deepwiki.com/mcp',
      '--http',
      '--static-oauth-client-metadata',
      `@${metadataPath}`,
    ]);
  });

  test('buildCodexMcpAddArgs handles proxied HTTP config', () => {
    const servers = new Map<string, unknown>([
      ['deepwiki', { url: 'https://mcp.deepwiki.com/mcp' }],
    ]);
    const config: McpProxyConfig = { clients: ['codex'] };
    const proxied = applyMcpProxy(servers, 'codex', config, metadataPath);
    const proxiedConfig = proxied.get('deepwiki') as Record<string, unknown>;

    const args = buildCodexMcpAddArgs('deepwiki', proxiedConfig);
    expect(args).toEqual([
      'mcp', 'add',
      'deepwiki', '--', 'npx',
      'mcp-remote',
      'https://mcp.deepwiki.com/mcp',
      '--http',
      '--static-oauth-client-metadata',
      `@${metadataPath}`,
    ]);
  });
});
