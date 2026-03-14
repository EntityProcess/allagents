import type { NativeSyncResult } from '../core/native/types.js';
import type { SyncResult, DeletedArtifact } from '../core/sync.js';
import type { CopyResult } from '../core/transform.js';
import type { McpMergeResult } from '../core/vscode-mcp.js';
import { CLIENT_MAPPINGS, USER_CLIENT_MAPPINGS, getDisplayName } from '../models/client-mapping.js';
import type { ClientMapping } from '../models/client-mapping.js';

type ArtifactType = 'skill' | 'command' | 'agent' | 'hook';

interface ArtifactCounts {
  skills: number;
  commands: number;
  agents: number;
  hooks: number;
}

interface PathEntry {
  path: string;
  client: string;
  artifactType: ArtifactType;
}

/**
 * Build a reverse lookup from client mapping paths to client name + artifact type.
 * Sorted by path length descending so longer (more specific) paths match first.
 */
function buildPathLookup(): PathEntry[] {
  const entries: PathEntry[] = [];
  const seen = new Set<string>();

  for (const mappings of [CLIENT_MAPPINGS, USER_CLIENT_MAPPINGS]) {
    for (const [client, mapping] of Object.entries(mappings) as [string, ClientMapping][]) {
      const paths: [string | undefined, ArtifactType][] = [
        [mapping.skillsPath, 'skill'],
        [mapping.commandsPath, 'command'],
        [mapping.agentsPath, 'agent'],
        [mapping.hooksPath, 'hook'],
      ];
      for (const [path, artifactType] of paths) {
        if (!path) continue;
        // Dedup by path+artifactType so the first client to register a path wins
        // (e.g., vscode and universal both use .agents/skills/)
        const key = `${path}|${artifactType}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ path, client, artifactType });
      }
    }
  }

  entries.sort((a, b) => b.path.length - a.path.length);
  return entries;
}

let cachedLookup: PathEntry[] | null = null;

function getPathLookup(): PathEntry[] {
  if (!cachedLookup) cachedLookup = buildPathLookup();
  return cachedLookup;
}

/**
 * Classify a CopyResult's destination into client + artifact type
 * by matching against known client mapping paths.
 */
function classifyDestination(dest: string): { client: string; artifactType: ArtifactType } | null {
  const normalized = dest.replace(/\\/g, '/');
  for (const entry of getPathLookup()) {
    if (normalized.includes(`/${entry.path}`) || normalized.startsWith(entry.path)) {
      return { client: entry.client, artifactType: entry.artifactType };
    }
  }
  return null;
}

/**
 * Classify CopyResults into per-client artifact counts.
 * Only counts results with action 'copied'.
 */
export function classifyCopyResults(copyResults: CopyResult[]): Map<string, ArtifactCounts> {
  const clientCounts = new Map<string, ArtifactCounts>();

  for (const result of copyResults) {
    if (result.action !== 'copied') continue;
    const classification = classifyDestination(result.destination);
    if (!classification) continue;

    const { artifactType } = classification;
    const client = getDisplayName(classification.client);
    let counts = clientCounts.get(client);
    if (!counts) {
      counts = { skills: 0, commands: 0, agents: 0, hooks: 0 };
      clientCounts.set(client, counts);
    }
    switch (artifactType) {
      case 'skill': counts.skills++; break;
      case 'command': counts.commands++; break;
      case 'agent': counts.agents++; break;
      case 'hook': counts.hooks++; break;
    }
  }

  return clientCounts;
}

/**
 * Format per-client artifact counts as display lines.
 * Example: "  claude: 2 commands, 3 skills, 1 agent"
 */
export function formatArtifactLines(
  clientCounts: Map<string, ArtifactCounts>,
  indent = '  ',
): string[] {
  const lines: string[] = [];

  for (const [client, counts] of clientCounts) {
    const parts: string[] = [];
    if (counts.commands > 0) parts.push(`${counts.commands} ${counts.commands === 1 ? 'command' : 'commands'}`);
    if (counts.skills > 0) parts.push(`${counts.skills} ${counts.skills === 1 ? 'skill' : 'skills'}`);
    if (counts.agents > 0) parts.push(`${counts.agents} ${counts.agents === 1 ? 'agent' : 'agents'}`);
    if (counts.hooks > 0) parts.push(`${counts.hooks} ${counts.hooks === 1 ? 'hook' : 'hooks'}`);

    if (parts.length > 0) {
      lines.push(`${indent}${client}: ${parts.join(', ')}`);
    }
  }

  return lines;
}

/**
 * Format artifact summary for a set of copy results.
 * Returns formatted lines showing per-client artifact counts,
 * or falls back to file count if no artifacts could be classified.
 */
export function formatPluginArtifacts(copyResults: CopyResult[], indent = '  '): string[] {
  const copied = copyResults.filter((r) => r.action === 'copied');
  if (copied.length === 0) return [];

  const classified = classifyCopyResults(copied);
  if (classified.size === 0) {
    // Fallback: unclassifiable files
    return [`${indent}Copied: ${copied.length} ${copied.length === 1 ? 'file' : 'files'}`];
  }

  return formatArtifactLines(classified, indent);
}

/**
 * Format the overall sync summary with per-client artifact counts.
 */
export function formatSyncSummary(
  result: SyncResult,
  { dryRun = false, label = 'Sync' }: { dryRun?: boolean; label?: string } = {},
): string[] {
  const lines: string[] = [];
  const allCopied = result.pluginResults.flatMap((pr) =>
    pr.copyResults.filter((r) => r.action === 'copied'),
  );

  lines.push(`${label} complete${dryRun ? ' (dry run)' : ''}:`);

  const classified = classifyCopyResults(allCopied);
  if (classified.size > 0) {
    lines.push(...formatArtifactLines(classified));
  } else if (allCopied.length > 0) {
    lines.push(`  Total ${dryRun ? 'would copy' : 'copied'}: ${result.totalCopied}`);
  }

  if (result.totalGenerated > 0) lines.push(`  Total generated: ${result.totalGenerated}`);
  if (result.totalFailed > 0) lines.push(`  Total failed: ${result.totalFailed}`);
  if (result.totalSkipped > 0) lines.push(`  Total skipped: ${result.totalSkipped}`);

  if (result.deletedArtifacts && result.deletedArtifacts.length > 0) {
    lines.push(...formatDeletedArtifacts(result.deletedArtifacts));
  }

  return lines;
}

/**
 * Format deleted artifacts as a single deduplicated line.
 * Artifacts are deduplicated by type:name across all clients since
 * the user cares about what was removed, not which client directories
 * contained it.
 * Example: "  Deleted: skill 'old-skill', command 'deprecated-cmd'"
 */
export function formatDeletedArtifacts(artifacts: DeletedArtifact[]): string[] {
  const seen = new Set<string>();
  const unique: DeletedArtifact[] = [];
  for (const a of artifacts) {
    const key = `${a.type}:${a.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(a);
  }

  if (unique.length === 0) return [];

  const names = unique.map((a) => `${a.type} '${a.name}'`).join(', ');
  return [`  Deleted: ${names}`];
}

/**
 * Format MCP server sync results as display lines.
 * Returns an array of strings (one per line), or empty array if no changes.
 */
export function formatMcpResult(
  mcpResult: McpMergeResult,
  scope?: string,
): string[] {
  const { added, overwritten, removed, skipped } = mcpResult;
  if (added === 0 && overwritten === 0 && removed === 0 && skipped === 0) {
    return [];
  }

  const lines: string[] = [];

  const parts = [`${added} added`];
  if (overwritten > 0) parts.push(`${overwritten} updated`);
  if (removed > 0) parts.push(`${removed} removed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  const label = scope ? `MCP servers (${scope})` : 'MCP servers';
  lines.push(`${label}: ${parts.join(', ')}`);

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
    lines.push(
      `Marketplaces registered: ${nativeResult.marketplacesAdded.join(', ')}`,
    );
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
    ...(result.messages &&
      result.messages.length > 0 && { messages: result.messages }),
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
    deletedArtifacts: result.deletedArtifacts ?? [],
    ...(result.mcpResults && {
      mcpServers: Object.fromEntries(
        Object.entries(result.mcpResults)
          .filter((entry): entry is [string, McpMergeResult] => entry[1] != null)
          .map(([scope, r]) => [
            scope,
            {
              added: r.added,
              skipped: r.skipped,
              overwritten: r.overwritten,
              removed: r.removed,
              addedServers: r.addedServers,
              skippedServers: r.skippedServers,
              overwrittenServers: r.overwrittenServers,
              removedServers: r.removedServers,
              ...(r.configPath && { configPath: r.configPath }),
            },
          ]),
      ),
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
