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
      for (const [key, value] of Object.entries(config.env as Record<string, string>)) {
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
