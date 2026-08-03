import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashServerUrl } from '../../src/core/mcp-http-stdio-proxy.ts';
import {
  type DummyMcpOAuthServer,
  FIXTURE_ANSWER,
  FIXTURE_TOOL_NAME,
  startDummyMcpOAuthServer,
} from '../helpers/dummy-mcp-oauth-server.ts';
import {
  connectToMcpProxy,
  type McpProxyConnection,
} from '../helpers/mcp-proxy-client.ts';

function connectAndAutoAuthorize(
  serverUrl: string,
  homeDir: string,
): Promise<McpProxyConnection> {
  return connectToMcpProxy({
    serverUrl,
    env: { HOME: homeDir, ALLAGENTS_MCP_OAUTH_NO_BROWSER: '1' },
    // Simulates the browser: the dummy IdP auto-approves and 302s straight to the
    // loopback callback, so a plain fetch completes the flow with no human involved.
    onAuthorizationUrl: (url) => {
      fetch(url).catch((error) => {
        console.error('auto-authorize fetch failed:', error);
      });
    },
  });
}

describe('mcp proxy OAuth e2e', () => {
  let homeDir: string;
  let dummy: DummyMcpOAuthServer | undefined;

  beforeEach(() => {
    homeDir = join(
      tmpdir(),
      `allagents-e2e-oauth-home-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(homeDir, { recursive: true });
  });

  afterEach(async () => {
    rmSync(homeDir, { recursive: true, force: true });
    await dummy?.stop();
    dummy = undefined;
  });

  test('completes OAuth and calls a tool on the first connection', async () => {
    dummy = await startDummyMcpOAuthServer();
    const connection = await connectAndAutoAuthorize(dummy.mcpUrl, homeDir);

    try {
      const { tools } = await connection.client.listTools();
      expect(tools.map((t) => t.name)).toContain(FIXTURE_TOOL_NAME);

      const result = await connection.client.callTool({
        name: FIXTURE_TOOL_NAME,
        arguments: { question: 'how to rename a company branch' },
      });
      expect(result.content).toEqual([{ type: 'text', text: FIXTURE_ANSWER }]);
      expect(dummy.authorizeCallCount).toBe(1);

      const cacheDir = join(
        homeDir,
        '.allagents',
        'oauth-proxy',
        hashServerUrl(dummy.mcpUrl),
      );
      const clientInfo = JSON.parse(
        readFileSync(join(cacheDir, 'client-info.json'), 'utf-8'),
      );
      const tokens = JSON.parse(
        readFileSync(join(cacheDir, 'tokens.json'), 'utf-8'),
      );
      expect(clientInfo.client_id).toBeTruthy();
      expect(tokens.access_token).toBeTruthy();
    } finally {
      await connection.close();
    }
  }, 15000);

  test('reuses the cached token on a second connection without re-authorizing', async () => {
    dummy = await startDummyMcpOAuthServer();

    const first = await connectAndAutoAuthorize(dummy.mcpUrl, homeDir);
    await first.close();
    expect(dummy.authorizeCallCount).toBe(1);

    const second = await connectAndAutoAuthorize(dummy.mcpUrl, homeDir);
    try {
      const result = await second.client.callTool({
        name: FIXTURE_TOOL_NAME,
        arguments: { question: 'how to rename a company branch' },
      });
      expect(result.content).toEqual([{ type: 'text', text: FIXTURE_ANSWER }]);
      expect(dummy.authorizeCallCount).toBe(1);
    } finally {
      await second.close();
    }
  }, 20000);

  test('refreshes an expired access token without a new browser flow', async () => {
    dummy = await startDummyMcpOAuthServer({ accessTokenTtlMs: 1500 });

    const first = await connectAndAutoAuthorize(dummy.mcpUrl, homeDir);
    await first.close();
    expect(dummy.authorizeCallCount).toBe(1);
    expect(dummy.tokenCallCounts.authorization_code).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const second = await connectAndAutoAuthorize(dummy.mcpUrl, homeDir);
    try {
      const result = await second.client.callTool({
        name: FIXTURE_TOOL_NAME,
        arguments: { question: 'how to rename a company branch' },
      });
      expect(result.content).toEqual([{ type: 'text', text: FIXTURE_ANSWER }]);
      expect(dummy.authorizeCallCount).toBe(1);
      expect(dummy.tokenCallCounts.refresh_token).toBeGreaterThanOrEqual(1);
    } finally {
      await second.close();
    }
  }, 20000);
});
