import { describe, expect, test } from 'bun:test';
import { applyMcpProxy } from '../../../src/core/mcp-proxy.js';
import type { McpProxyConfig } from '../../../src/models/workspace-config.js';

describe('applyMcpProxy in sync context', () => {
  const metadataPath = '/home/user/.allagents/mcp-remote/mcp-metadata-settings.json';

  test('different clients get different configs for same server set', () => {
    const servers = new Map<string, unknown>([
      ['http-api', { url: 'https://api.example.com/mcp' }],
      ['local-tool', { command: 'node', args: ['tool.js'] }],
    ]);

    const config: McpProxyConfig = { clients: ['copilot'] };

    const copilotServers = applyMcpProxy(servers, 'copilot', config, metadataPath);
    expect((copilotServers.get('http-api') as Record<string, unknown>).command).toBe('npx');
    expect(copilotServers.get('local-tool')).toEqual({ command: 'node', args: ['tool.js'] });

    const claudeServers = applyMcpProxy(servers, 'claude', config, metadataPath);
    expect(claudeServers.get('http-api')).toEqual({ url: 'https://api.example.com/mcp' });
    expect(claudeServers.get('local-tool')).toEqual({ command: 'node', args: ['tool.js'] });
  });
});
