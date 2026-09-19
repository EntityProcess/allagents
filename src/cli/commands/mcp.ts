import { isCancel, password } from '@clack/prompts';
import {
  array,
  command,
  flag,
  multioption,
  option,
  optional,
  positional,
  string,
} from 'cmd-ts';
import { dump } from 'js-yaml';
import {
  addWorkspaceMcpServer,
  buildMcpServerConfigFromFlags,
  clearWorkspaceMcpServerProxy,
  getWorkspaceMcpServer,
  listWorkspaceMcpServers,
  parseKeyValuePairs,
  removeWorkspaceMcpServer,
  setWorkspaceMcpServerProxy,
} from '../../core/mcp-servers.js';
import {
  type ConnectHttpMcpServerOptions,
  connectHttpMcpServer,
  runHttpMcpStdioProxy,
  validateOAuthCallbackUrl,
} from '../../core/mcp-http-stdio-proxy.js';
import { syncMcpOnly } from '../../core/mcp-sync.js';
import {
  type ClientType,
  ClientTypeSchema,
  type McpServerConfig,
} from '../../models/workspace-config.js';
import { formatMcpResult } from '../format-sync.js';
import { buildDescription, conciseSubcommands } from '../help.js';
import { isJsonMode, jsonOutput } from '../json-output.js';
import {
  mcpAddMeta,
  mcpGetMeta,
  mcpListMeta,
  mcpReauthMeta,
  mcpRemoveMeta,
  mcpUpdateMeta,
} from '../metadata/mcp.js';
import { terminalSafe } from '../terminal-output.js';

// =============================================================================
// Helpers
// =============================================================================

function parseClientFilter(input: string): ClientType[] {
  const items = input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const result: ClientType[] = [];
  for (const item of items) {
    const parsed = ClientTypeSchema.safeParse(item);
    if (!parsed.success) {
      throw new Error(
        `Invalid client '${item}'. Valid clients: ${ClientTypeSchema.options.join(', ')}`,
      );
    }
    result.push(parsed.data);
  }
  return result;
}

function exitWithError(command: string, error: string): never {
  if (isJsonMode()) {
    jsonOutput({ success: false, command, error });
  } else {
    console.error(`Error: ${terminalSafe(error)}`);
  }
  process.exit(1);
}

/**
 * Shared flag parsing for `mcp add` / `mcp update`. Exits with a user-friendly
 * error if any flag is invalid.
 */
function buildConfigFromAddFlags(
  commandName: string,
  commandOrUrl: string,
  transport: string | undefined,
  args: string[],
  env: string[],
  header: string[],
  client: string | undefined,
): McpServerConfig {
  if (transport && transport !== 'http' && transport !== 'stdio') {
    exitWithError(
      commandName,
      `Invalid transport '${transport}'. Expected 'http' or 'stdio'.`,
    );
  }

  const envResult = parseKeyValuePairs(env, '-e/--env');
  if ('error' in envResult) exitWithError(commandName, envResult.error);

  const headerResult = parseKeyValuePairs(header, '--header');
  if ('error' in headerResult) exitWithError(commandName, headerResult.error);

  let clients: ClientType[] | undefined;
  if (client) {
    try {
      clients = parseClientFilter(client);
    } catch (e) {
      exitWithError(commandName, e instanceof Error ? e.message : String(e));
    }
  }

  const buildOpts: Parameters<typeof buildMcpServerConfigFromFlags>[0] = {
    commandOrUrl,
    args,
    env: envResult.values,
    headers: headerResult.values,
  };
  if (transport) buildOpts.transport = transport as 'http' | 'stdio';
  if (clients) buildOpts.clients = clients;

  const built = buildMcpServerConfigFromFlags(buildOpts);
  if ('error' in built) exitWithError(commandName, built.error);
  return built.config;
}

async function connectConfiguredHttpServer(
  commandName: string,
  serverUrl: string,
  headers: Record<string, string> | undefined,
  mode: {
    resetCredentials: boolean;
    allowAuthorization: boolean;
  },
): Promise<void> {
  try {
    const options: ConnectHttpMcpServerOptions = {
      headers: headers ?? {},
      resetCredentials: mode.resetCredentials,
      allowAuthorization: mode.allowAuthorization,
    };
    if (mode.allowAuthorization) {
      options.callbackUrlReader = async ({ redirectUrl, state, signal }) => {
        const callbackUrl = await password({
          message: 'Paste the OAuth callback URL if using another browser',
          signal,
          validate: (value) => {
            if (!value) {
              return 'OAuth callback URL is required';
            }
            try {
              validateOAuthCallbackUrl(value, redirectUrl, state);
              return undefined;
            } catch (error) {
              return error instanceof Error
                ? error.message
                : 'Invalid OAuth callback URL';
            }
          },
        });
        if (isCancel(callbackUrl)) {
          throw new Error('OAuth authorization cancelled');
        }
        return callbackUrl;
      };
    }
    await connectHttpMcpServer(serverUrl, options);
  } catch (error) {
    exitWithError(
      commandName,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function getConfiguredMcpServer(
  commandName: string,
  name: string,
): Promise<McpServerConfig | null> {
  try {
    return await getWorkspaceMcpServer(name, process.cwd());
  } catch (error) {
    exitWithError(
      commandName,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Run MCP-only sync after a mutation and print per-scope results. Always runs
 * offline because the mutation only affects local workspace.yaml and does not
 * require refreshing plugins from remote marketplaces.
 */
async function runPostMutationSync(
  commandName: string,
  successMessage: string,
  jsonExtra: Record<string, unknown>,
): Promise<void> {
  const syncResult = await syncMcpOnly(process.cwd(), { offline: true });
  if (!syncResult.success) {
    exitWithError(commandName, syncResult.error ?? 'MCP sync failed');
  }

  if (isJsonMode()) {
    jsonOutput({
      success: true,
      command: commandName,
      data: { ...jsonExtra, mcpResults: syncResult.mcpResults },
    });
    return;
  }

  console.log(successMessage);
  for (const [scope, result] of Object.entries(syncResult.mcpResults)) {
    if (!result) continue;
    const lines = formatMcpResult(result, scope);
    if (lines.length > 0) {
      console.log('');
      for (const line of lines) console.log(line);
    }
  }
  for (const warning of syncResult.warnings) {
    console.log(`  \u26A0 ${warning}`);
  }
}

function serverToDisplay(name: string, config: McpServerConfig): string[] {
  const lines: string[] = [`${name}:`];
  const isHttp = 'url' in config;
  lines.push(`  transport: ${isHttp ? 'http' : 'stdio'}`);
  if (isHttp) {
    lines.push(`  url: ${config.url}`);
    if (config.headers && Object.keys(config.headers).length > 0) {
      lines.push('  headers:');
      for (const [k, v] of Object.entries(config.headers)) {
        lines.push(`    ${k}: ${v}`);
      }
    }
  } else {
    lines.push(`  command: ${config.command}`);
    if (config.args && config.args.length > 0) {
      lines.push(`  args: ${JSON.stringify(config.args)}`);
    }
    if (config.env && Object.keys(config.env).length > 0) {
      lines.push('  env:');
      for (const [k, v] of Object.entries(config.env)) {
        lines.push(`    ${k}: ${v}`);
      }
    }
  }
  if (config.clients && config.clients.length > 0) {
    lines.push(`  clients: [${config.clients.join(', ')}]`);
  }
  return lines;
}

// =============================================================================
// mcp add
// =============================================================================

const addArgs = {
  name: positional({ type: string, displayName: 'name' }),
  commandOrUrl: positional({ type: string, displayName: 'commandOrUrl' }),
  transport: option({
    type: optional(string),
    long: 'transport',
    description:
      "Transport: 'http' or 'stdio' (auto-detected from URL if omitted)",
  }),
  args: multioption({
    type: array(string),
    long: 'arg',
    description: 'Argument for stdio command (repeatable)',
  }),
  env: multioption({
    type: array(string),
    long: 'env',
    short: 'e',
    description: 'Environment variable KEY=VALUE (repeatable)',
  }),
  header: multioption({
    type: array(string),
    long: 'header',
    description: 'HTTP header KEY=VALUE (repeatable)',
  }),
  client: option({
    type: optional(string),
    long: 'client',
    description: 'Comma-separated list of client filters',
  }),
};

const mcpAddCmd = command({
  name: 'add',
  description: buildDescription(mcpAddMeta),
  args: {
    ...addArgs,
    force: flag({
      long: 'force',
      short: 'f',
      description: 'Replace an existing server with the same name',
    }),
  },
  handler: async ({
    name,
    commandOrUrl,
    transport,
    args,
    env,
    header,
    client,
    force,
  }) => {
    const config = buildConfigFromAddFlags(
      'mcp add',
      commandOrUrl,
      transport,
      args,
      env,
      header,
      client,
    );
    const existing = await getConfiguredMcpServer('mcp add', name);
    if (existing && !force) {
      exitWithError(
        'mcp add',
        `MCP server '${name}' already exists in workspace.yaml. Use --force to replace it.`,
      );
    }

    if ('url' in config) {
      const allowAuthorization = !isJsonMode() && Boolean(process.stdin.isTTY);
      await connectConfiguredHttpServer(
        'mcp add',
        config.url,
        config.headers,
        { resetCredentials: false, allowAuthorization },
      );
    }

    const addResult = await addWorkspaceMcpServer(
      name,
      config,
      process.cwd(),
      force,
    );
    if (!addResult.success)
      exitWithError('mcp add', addResult.error ?? 'Unknown error');

    if ('url' in config) {
      const proxyResult = await setWorkspaceMcpServerProxy(
        name,
        process.cwd(),
        config.clients,
      );
      if (!proxyResult.success) {
        exitWithError(
          'mcp add',
          proxyResult.error ?? 'Failed to configure AllAgents MCP routing',
        );
      }
    } else if (force) {
      const clearResult = await clearWorkspaceMcpServerProxy(
        name,
        process.cwd(),
      );
      if (!clearResult.success) {
        exitWithError(
          'mcp add',
          clearResult.error ?? 'Failed to clear AllAgents MCP routing',
        );
      }
    }

    await runPostMutationSync(
      'mcp add',
      `\u2713 Added MCP server '${name}' to workspace.yaml`,
      {
        name,
        config: addResult.config,
      },
    );
  },
});

// =============================================================================
// mcp remove
// =============================================================================

const mcpRemoveCmd = command({
  name: 'remove',
  description: buildDescription(mcpRemoveMeta),
  args: {
    name: positional({ type: string, displayName: 'name' }),
  },
  handler: async ({ name }) => {
    const removeResult = await removeWorkspaceMcpServer(name, process.cwd());
    if (!removeResult.success)
      exitWithError('mcp remove', removeResult.error ?? 'Unknown error');
    await runPostMutationSync(
      'mcp remove',
      `\u2713 Removed MCP server '${name}' from workspace.yaml`,
      { name },
    );
  },
});

// =============================================================================
// mcp reauth
// =============================================================================

const mcpReauthCmd = command({
  name: 'reauth',
  description: buildDescription(mcpReauthMeta),
  args: {
    name: positional({ type: string, displayName: 'name' }),
  },
  handler: async ({ name }) => {
    if (isJsonMode() || !process.stdin.isTTY) {
      exitWithError(
        'mcp reauth',
        'OAuth login requires an interactive terminal',
      );
    }

    const config = await getConfiguredMcpServer('mcp reauth', name);
    if (!config) {
      exitWithError(
        'mcp reauth',
        `MCP server '${name}' is not defined in workspace.yaml`,
      );
    }
    if (!('url' in config)) {
      exitWithError(
        'mcp reauth',
        `MCP server '${name}' uses stdio and cannot be reauthenticated`,
      );
    }

    await connectConfiguredHttpServer(
      'mcp reauth',
      config.url,
      config.headers,
      { resetCredentials: true, allowAuthorization: true },
    );
    console.log(
      `\u2713 Reauthenticated MCP server '${terminalSafe(name)}'`,
    );
  },
});

// =============================================================================
// mcp proxy
// =============================================================================

const mcpProxyCmd = command({
  name: 'proxy',
  description: 'Expose a remote HTTP MCP server locally over stdio',
  args: {
    serverUrl: positional({ type: string, displayName: 'serverUrl' }),
    header: multioption({
      type: array(string),
      long: 'header',
      description: 'HTTP header KEY=VALUE (repeatable)',
    }),
  },
  handler: async ({ serverUrl, header }) => {
    const headerResult = parseKeyValuePairs(header, '--header');
    if ('error' in headerResult) {
      exitWithError('mcp proxy', headerResult.error);
    }
    await runHttpMcpStdioProxy(serverUrl, headerResult.values);
  },
});

// =============================================================================
// mcp list
// =============================================================================

const mcpListCmd = command({
  name: 'list',
  description: buildDescription(mcpListMeta),
  args: {},
  handler: async () => {
    let servers: Record<string, McpServerConfig>;
    try {
      servers = await listWorkspaceMcpServers(process.cwd());
    } catch (e) {
      exitWithError('mcp list', e instanceof Error ? e.message : String(e));
    }
    const names = Object.keys(servers);

    if (isJsonMode()) {
      jsonOutput({
        success: true,
        command: 'mcp list',
        data: { servers, total: names.length },
      });
      return;
    }

    if (names.length === 0) {
      console.log('No MCP servers defined in workspace.yaml.');
      console.log('');
      console.log('Add one with:');
      console.log('  allagents mcp add <name> <commandOrUrl>');
      return;
    }

    console.log(`MCP servers (${names.length}):`);
    console.log('');
    for (const name of names) {
      const config = servers[name];
      if (!config) continue;
      for (const line of serverToDisplay(name, config)) {
        console.log(`  ${line}`);
      }
      console.log('');
    }
  },
});

// =============================================================================
// mcp get
// =============================================================================

const mcpGetCmd = command({
  name: 'get',
  description: buildDescription(mcpGetMeta),
  args: {
    name: positional({ type: string, displayName: 'name' }),
  },
  handler: async ({ name }) => {
    let config: McpServerConfig | null;
    try {
      config = await getWorkspaceMcpServer(name, process.cwd());
    } catch (e) {
      exitWithError('mcp get', e instanceof Error ? e.message : String(e));
    }
    if (!config) {
      exitWithError(
        'mcp get',
        `MCP server '${name}' not found in workspace.yaml`,
      );
    }

    if (isJsonMode()) {
      jsonOutput({
        success: true,
        command: 'mcp get',
        data: { name, config },
      });
      return;
    }

    console.log(dump({ [name]: config }, { lineWidth: -1 }).trimEnd());
  },
});

// =============================================================================
// mcp update
// =============================================================================

const mcpUpdateCmd = command({
  name: 'update',
  description: buildDescription(mcpUpdateMeta),
  args: {
    offline: flag({
      long: 'offline',
      description: 'Use cached plugins without fetching from remote',
    }),
  },
  handler: async ({ offline }) => {
    const result = await syncMcpOnly(process.cwd(), { offline });
    if (!result.success) {
      exitWithError('mcp update', result.error ?? 'MCP sync failed');
    }

    if (isJsonMode()) {
      jsonOutput({
        success: true,
        command: 'mcp update',
        data: { mcpResults: result.mcpResults, warnings: result.warnings },
      });
      return;
    }

    const hasAnyChanges = Object.values(result.mcpResults).some(
      (r) =>
        r &&
        (r.added > 0 || r.overwritten > 0 || r.removed > 0 || r.skipped > 0),
    );

    if (!hasAnyChanges) {
      console.log('No MCP server changes.');
    } else {
      for (const [scope, mcpResult] of Object.entries(result.mcpResults)) {
        if (!mcpResult) continue;
        const lines = formatMcpResult(mcpResult, scope);
        if (lines.length > 0) {
          for (const line of lines) console.log(line);
          console.log('');
        }
      }
    }

    if (result.warnings.length > 0) {
      console.log('Warnings:');
      for (const warning of result.warnings) {
        console.log(`  \u26A0 ${warning}`);
      }
    }
  },
});

// =============================================================================
// mcp group
// =============================================================================

export const mcpCmd = conciseSubcommands(
  {
    name: 'mcp',
    description: 'Manage MCP servers for AI clients',
    cmds: {
      add: mcpAddCmd,
      reauth: mcpReauthCmd,
      proxy: mcpProxyCmd,
      remove: mcpRemoveCmd,
      list: mcpListCmd,
      get: mcpGetCmd,
      update: mcpUpdateCmd,
    },
  },
  ['proxy'],
);
