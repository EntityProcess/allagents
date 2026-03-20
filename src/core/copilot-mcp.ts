import { join } from 'node:path';
import { getHomeDir } from '../constants.js';

/**
 * Get the path to Copilot CLI's user-level MCP config file.
 * Copilot CLI stores MCP server configs in ~/.copilot/mcp-config.json
 * using the same { "mcpServers": { ... } } format as Claude's .mcp.json.
 */
export function getCopilotMcpConfigPath(): string {
  return join(getHomeDir(), '.copilot', 'mcp-config.json');
}
