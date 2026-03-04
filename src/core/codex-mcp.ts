import { executeCommand } from './native/types.js';
import type { NativeCommandResult } from './native/types.js';
import type { ValidatedPlugin } from './sync.js';
import { collectMcpServers } from './vscode-mcp.js';
import type { McpMergeResult } from './vscode-mcp.js';

type ExecuteFn = (
  binary: string,
  args: string[],
) => NativeCommandResult | Promise<NativeCommandResult>;

/**
 * Build CLI args for `codex mcp add <name>` from a .mcp.json server config.
 * Returns null if the config format is unsupported.
 */
export function buildCodexMcpAddArgs(
  name: string,
  config: Record<string, unknown>,
): string[] | null {
  // URL-based (streamable HTTP)
  if (typeof config.url === 'string') {
    return ['mcp', 'add', name, '--url', config.url];
  }

  // stdio-based (command + args)
  if (typeof config.command === 'string') {
    const args: string[] = ['mcp', 'add', name];

    // Add --env flags if present
    if (config.env && typeof config.env === 'object') {
      for (const [key, value] of Object.entries(
        config.env as Record<string, string>,
      )) {
        args.push('--env', `${key}=${value}`);
      }
    }

    // Add -- separator and command
    args.push('--', config.command);

    // Add command args if present
    if (Array.isArray(config.args)) {
      args.push(...(config.args as string[]));
    }

    return args;
  }

  return null;
}

/**
 * Sync MCP servers from plugins into the Codex CLI via `codex mcp add/remove`.
 *
 * Uses the same ownership model as syncVscodeMcpConfig:
 * - Only tracked servers are updated/removed
 * - Pre-existing user-managed servers are skipped
 */
export async function syncCodexMcpServers(
  validatedPlugins: ValidatedPlugin[],
  options?: {
    dryRun?: boolean;
    trackedServers?: string[];
    _mockExecute?: ExecuteFn;
  },
): Promise<McpMergeResult> {
  const dryRun = options?.dryRun ?? false;
  const previouslyTracked = new Set(options?.trackedServers ?? []);
  const hasTracking = options?.trackedServers !== undefined;
  const exec: ExecuteFn =
    options?._mockExecute ?? ((binary, args) => executeCommand(binary, args));

  // Collect servers from all plugins
  const { servers: pluginServers, warnings } =
    collectMcpServers(validatedPlugins);

  const result: McpMergeResult = {
    added: 0,
    skipped: 0,
    overwritten: 0,
    removed: 0,
    warnings: [...warnings],
    addedServers: [],
    skippedServers: [],
    overwrittenServers: [],
    removedServers: [],
    trackedServers: [],
  };

  // List existing Codex MCP servers
  const listResult = await exec('codex', ['mcp', 'list', '--json']);
  if (!listResult.success) {
    result.warnings.push(
      `Codex CLI not available or 'codex mcp list' failed: ${listResult.error ?? 'unknown error'}`,
    );
    return result;
  }

  let existingNames: Set<string>;
  try {
    const parsed = JSON.parse(listResult.output) as Array<{ name: string }>;
    existingNames = new Set(parsed.map((s) => s.name));
  } catch {
    result.warnings.push('Failed to parse codex mcp list output');
    return result;
  }

  // Process plugin servers: add new, skip existing user-managed
  for (const [name, config] of pluginServers) {
    if (existingNames.has(name)) {
      if (hasTracking && previouslyTracked.has(name)) {
        // We own this server - keep tracking
        result.trackedServers.push(name);
      } else {
        // User-managed server - skip (do not track)
        result.skipped++;
        result.skippedServers.push(name);
      }
    } else {
      // New server - add it
      const addArgs = buildCodexMcpAddArgs(
        name,
        config as Record<string, unknown>,
      );
      if (!addArgs) {
        result.warnings.push(
          `Unsupported MCP server config for '${name}', skipping`,
        );
        continue;
      }

      if (!dryRun) {
        const addResult = await exec('codex', addArgs);
        if (!addResult.success) {
          result.warnings.push(
            `Failed to add MCP server '${name}': ${addResult.error ?? 'unknown error'}`,
          );
          continue;
        }
      }

      result.added++;
      result.addedServers.push(name);
      result.trackedServers.push(name);
    }
  }

  // Remove orphaned tracked servers (previously tracked but no longer in plugins)
  if (hasTracking) {
    const currentServerNames = new Set(pluginServers.keys());
    for (const trackedName of previouslyTracked) {
      if (
        !currentServerNames.has(trackedName) &&
        existingNames.has(trackedName)
      ) {
        if (!dryRun) {
          const removeResult = await exec('codex', [
            'mcp',
            'remove',
            trackedName,
          ]);
          if (!removeResult.success) {
            result.warnings.push(
              `Failed to remove MCP server '${trackedName}': ${removeResult.error ?? 'unknown error'}`,
            );
            continue;
          }
        }
        result.removed++;
        result.removedServers.push(trackedName);
      }
    }
  }

  return result;
}
