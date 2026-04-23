import type { AgentCommandMeta } from '../help.js';

export const mcpAddMeta: AgentCommandMeta = {
  command: 'mcp add',
  description: 'Add an MCP server to workspace.yaml and sync to clients',
  whenToUse:
    'When adding a new MCP server that you want AllAgents to manage and sync to all configured clients',
  examples: [
    'allagents mcp add deepwiki https://mcp.deepwiki.com/mcp',
    'allagents mcp add my-server npx --arg=-y --arg=@my/mcp-server',
    'allagents mcp add gh-api npx -e GH_TOKEN=abc123 --arg=-y --arg=@modelcontextprotocol/server-github',
    'allagents mcp add deepwiki https://mcp.deepwiki.com/mcp --client claude,copilot',
    'allagents mcp add secure-api https://api.example.com/mcp --proxy',
  ],
  expectedOutput:
    'Adds the server to workspace.yaml and syncs it to all configured clients. With --proxy, HTTP servers are rewritten through the built-in AllAgents HTTP-to-stdio proxy path for the targeted clients. Exit 0 on success, 1 on failure.',
  positionals: [
    {
      name: 'name',
      type: 'string',
      required: true,
      description: 'Server name (unique within workspace.yaml)',
    },
    {
      name: 'commandOrUrl',
      type: 'string',
      required: true,
      description:
        'HTTP URL (http://, https://) for http transport, or a command for stdio transport',
    },
  ],
  options: [
    {
      flag: '--transport',
      type: 'string',
      description:
        "Transport type: 'http' or 'stdio' (auto-detected from URL by default)",
    },
    {
      flag: '--arg',
      type: 'string',
      description: 'Argument to pass to the stdio command (repeatable)',
    },
    {
      flag: '--env',
      short: '-e',
      type: 'string',
      description:
        'Environment variable KEY=VALUE for stdio transport (repeatable)',
    },
    {
      flag: '--header',
      type: 'string',
      description: 'HTTP header KEY=VALUE for http transport (repeatable)',
    },
    {
      flag: '--client',
      type: 'string',
      description:
        'Comma-separated list of clients that should receive this server (default: all project-scoped clients)',
    },
    {
      flag: '--proxy',
      type: 'boolean',
      description:
        'For HTTP servers, persist server-scoped proxy intent and sync targeted clients via the built-in AllAgents HTTP proxy helper',
    },
    {
      flag: '--force',
      short: '-f',
      type: 'boolean',
      description: 'Replace an existing server with the same name',
    },
  ],
};

export const mcpRemoveMeta: AgentCommandMeta = {
  command: 'mcp remove',
  description: 'Remove an MCP server from workspace.yaml and all clients',
  whenToUse: 'When you no longer need an MCP server that AllAgents added',
  examples: ['allagents mcp remove deepwiki'],
  expectedOutput:
    'Removes the server from workspace.yaml and unsyncs it from all configured clients. Exit 0 on success, 1 if the server is not defined in workspace.yaml.',
  positionals: [
    {
      name: 'name',
      type: 'string',
      required: true,
      description: 'Server name to remove',
    },
  ],
};

export const mcpListMeta: AgentCommandMeta = {
  command: 'mcp list',
  description: 'List MCP servers defined in workspace.yaml',
  whenToUse:
    'To inspect MCP servers AllAgents is managing at the workspace level',
  examples: ['allagents mcp list'],
  expectedOutput:
    'Prints a table of workspace-defined MCP servers with transport, target, and client filter. Exit 0 on success.',
};

export const mcpGetMeta: AgentCommandMeta = {
  command: 'mcp get',
  description: 'Show the workspace definition for an MCP server',
  whenToUse: 'To see how an MCP server is configured in workspace.yaml',
  examples: ['allagents mcp get deepwiki'],
  expectedOutput:
    'Prints the server config (YAML). Exit 0 on success, 1 if not found.',
  positionals: [
    {
      name: 'name',
      type: 'string',
      required: true,
      description: 'Server name',
    },
  ],
};

export const mcpUpdateMeta: AgentCommandMeta = {
  command: 'mcp update',
  description: 'Sync MCP servers only, without touching other artifacts',
  whenToUse:
    "When you've edited workspace.yaml's mcpServers block or plugin .mcp.json files and want to re-sync only MCP servers without re-running the full workspace sync. To modify a server definition use 'mcp add --force'.",
  examples: ['allagents mcp update', 'allagents mcp update --offline'],
  expectedOutput:
    'Runs the MCP portion of sync for all project-scoped clients. Prints per-scope added/updated/removed counts. Exit 0 on success, 1 on failure.',
  options: [
    {
      flag: '--offline',
      type: 'boolean',
      description: 'Use cached plugins without fetching from remote',
    },
  ],
};
