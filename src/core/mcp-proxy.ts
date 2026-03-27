import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getHomeDir } from '../constants.js';
import type { McpProxyConfig } from '../models/workspace-config.js';

/**
 * Get the path to the mcp-remote metadata settings file.
 */
export function getProxyMetadataPath(): string {
  return join(getHomeDir(), '.allagents', 'mcp-remote', 'mcp-metadata-settings.json');
}

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
function isHttpServer(config: unknown): config is { url: string } {
  return (
    typeof config === 'object' &&
    config !== null &&
    'url' in config &&
    typeof (config as Record<string, unknown>).url === 'string'
  );
}

/**
 * Rewrite an HTTP server config to a stdio config using mcp-remote.
 */
function toProxiedConfig(url: string, metadataPath: string): Record<string, unknown> {
  return {
    command: 'npx',
    args: [
      'mcp-remote',
      url,
      '--http',
      '--static-oauth-client-metadata',
      `@${metadataPath}`,
    ],
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
  metadataPath: string,
): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const [name, serverConfig] of servers) {
    if (isHttpServer(serverConfig) && shouldProxy(name, client, config)) {
      result.set(name, toProxiedConfig(serverConfig.url, metadataPath));
    } else {
      result.set(name, serverConfig);
    }
  }
  return result;
}

/**
 * Ensure the mcp-remote metadata file exists. Creates it with default
 * content if missing. Does not overwrite existing files.
 */
export function ensureProxyMetadata(metadataPath?: string): void {
  const path = metadataPath ?? getProxyMetadataPath();
  if (existsSync(path)) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ client_uri: 'http://localhost' }, null, 2), 'utf-8');
}
