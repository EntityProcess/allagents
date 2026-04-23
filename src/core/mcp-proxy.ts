import type { McpProxyConfig } from '../models/workspace-config.js';

/**
 * Determine if a server+client pair should be proxied.
 */
export function shouldProxy(
  serverName: string,
  client: string,
  config: McpProxyConfig,
): boolean {
  if (config.clients.includes(client)) {
    return true;
  }
  const serverOverride = config.servers?.[serverName];
  if (serverOverride?.proxy.includes(client)) {
    return true;
  }
  return false;
}

/**
 * Check if a server config uses HTTP transport (has a `url` field).
 */
function isHttpServer(
  config: unknown,
): config is { url: string; headers?: Record<string, string> } {
  return (
    typeof config === 'object' &&
    config !== null &&
    'url' in config &&
    typeof (config as Record<string, unknown>).url === 'string'
  );
}

/**
 * Rewrite an HTTP server config to a stdio config using the built-in
 * AllAgents HTTP-to-stdio proxy helper.
 */
function toProxiedConfig(
  url: string,
  headers?: Record<string, string>,
): Record<string, unknown> {
  const args = ['mcp', 'proxy-stdio', url];
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      args.push('--header', `${key}=${value}`);
    }
  }

  return {
    command: 'allagents',
    args,
  };
}

/**
 * Apply MCP proxy transform to collected servers for a given client.
 * Returns a new Map with HTTP configs rewritten to stdio where applicable.
 * Non-HTTP servers and non-proxied clients are passed through unchanged.
 */
export function applyMcpProxy(
  servers: Map<string, unknown>,
  client: string,
  config: McpProxyConfig,
): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const [name, serverConfig] of servers) {
    if (isHttpServer(serverConfig) && shouldProxy(name, client, config)) {
      result.set(name, toProxiedConfig(serverConfig.url, serverConfig.headers));
    } else {
      result.set(name, serverConfig);
    }
  }
  return result;
}
