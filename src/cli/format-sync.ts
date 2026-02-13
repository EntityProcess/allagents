import type { SyncResult } from '../core/sync.js';
import type { McpMergeResult } from '../core/vscode-mcp.js';

/**
 * Format MCP server sync results as display lines.
 * Returns an array of strings (one per line), or empty array if no changes.
 */
export function formatMcpResult(mcpResult: McpMergeResult): string[] {
  const { added, overwritten, removed, skipped } = mcpResult;
  if (added === 0 && overwritten === 0 && removed === 0 && skipped === 0) {
    return [];
  }

  const lines: string[] = [];

  const parts = [`${added} added`];
  if (overwritten > 0) parts.push(`${overwritten} updated`);
  if (removed > 0) parts.push(`${removed} removed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  lines.push(`MCP servers: ${parts.join(', ')}`);

  for (const name of mcpResult.addedServers) {
    lines.push(`  + ${name}`);
  }
  for (const name of mcpResult.overwrittenServers) {
    lines.push(`  ~ ${name}`);
  }
  for (const name of mcpResult.removedServers) {
    lines.push(`  - ${name}`);
  }
  if (mcpResult.configPath) {
    lines.push(`File modified: ${mcpResult.configPath}`);
  }

  return lines;
}

/**
 * Build a JSON-friendly sync data object from a sync result.
 */
export function buildSyncData(result: SyncResult) {
  return {
    copied: result.totalCopied,
    generated: result.totalGenerated,
    failed: result.totalFailed,
    skipped: result.totalSkipped,
    plugins: result.pluginResults.map((pr) => ({
      plugin: pr.plugin,
      success: pr.success,
      error: pr.error,
      copied: pr.copyResults.filter((r) => r.action === 'copied').length,
      generated: pr.copyResults.filter((r) => r.action === 'generated').length,
      failed: pr.copyResults.filter((r) => r.action === 'failed').length,
      copyResults: pr.copyResults,
    })),
    purgedPaths: result.purgedPaths ?? [],
    ...(result.mcpResult && {
      mcpServers: {
        added: result.mcpResult.added,
        skipped: result.mcpResult.skipped,
        overwritten: result.mcpResult.overwritten,
        removed: result.mcpResult.removed,
        addedServers: result.mcpResult.addedServers,
        skippedServers: result.mcpResult.skippedServers,
        overwrittenServers: result.mcpResult.overwrittenServers,
        removedServers: result.mcpResult.removedServers,
        ...(result.mcpResult.configPath && { configPath: result.mcpResult.configPath }),
      },
    }),
  };
}
