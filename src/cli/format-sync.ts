import type { SyncResult } from '../core/sync.js';
import type { McpMergeResult } from '../core/vscode-mcp.js';
import type { NativeSyncResult } from '../core/native/types.js';

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
 * Format native CLI plugin sync results as display lines.
 */
export function formatNativeResult(nativeResult: NativeSyncResult): string[] {
  const lines: string[] = [];

  if (nativeResult.marketplacesAdded.length > 0) {
    lines.push(`Marketplaces registered: ${nativeResult.marketplacesAdded.join(', ')}`);
  }

  for (const plugin of nativeResult.pluginsInstalled) {
    lines.push(`  + ${plugin} (installed via native CLI)`);
  }

  for (const { client, plugin, error } of nativeResult.pluginsFailed) {
    const provider = client ? `[${client}] ` : '';
    lines.push(`  \u2717 ${provider}${plugin}: ${error}`);
  }

  for (const plugin of nativeResult.skipped) {
    lines.push(`  \u2298 ${plugin} (skipped \u2014 not a marketplace plugin)`);
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
    ...(result.messages && result.messages.length > 0 && { messages: result.messages }),
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
    ...(result.nativeResult && {
      nativePlugins: {
        installed: result.nativeResult.pluginsInstalled,
        failed: result.nativeResult.pluginsFailed,
        skipped: result.nativeResult.skipped,
        marketplacesAdded: result.nativeResult.marketplacesAdded,
      },
    }),
  };
}
