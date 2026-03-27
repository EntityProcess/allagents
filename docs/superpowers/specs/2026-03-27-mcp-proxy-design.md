# MCP Proxy Design

## Problem

MCP servers that use HTTP transport require each client to handle OAuth independently. Some clients do this poorly or not at all. Users need a way to route HTTP MCP servers through a local stdio proxy (`mcp-remote`) so that:

- OAuth is handled once and tokens are cached in `~/.mcp-auth/`
- All clients connect via stdio to an already-authenticated proxy
- The setup is transparent — users configure which clients need proxying and AllAgents handles the rest

## Solution

During MCP sync, AllAgents rewrites HTTP server configs to stdio configs using `npx mcp-remote` for clients configured to use the proxy. This applies to both file-based sync (project-scoped) and CLI-based sync (user-scoped).

## Configuration

### Workspace config (`workspace.yaml`)

```yaml
mcpProxy:
  clients: [claude, copilot]  # proxy all HTTP servers for these clients
  servers:                     # optional: per-server overrides
    my-internal-api:
      proxy: [codex]           # additionally proxy this server for codex
```

**Rules:**

- `mcpProxy.clients` — default client list. All HTTP MCP servers are proxied for these clients.
- `mcpProxy.servers.<name>.proxy` — additional client list for a specific server. Merged with (not replacing) the client defaults.
- Only HTTP servers (those with a `url` field) are proxied. stdio servers pass through unchanged.

### OAuth metadata file

AllAgents auto-generates `~/.allagents/mcp-remote/mcp-metadata-settings.json` on first sync if it does not exist:

```json
{
  "client_uri": "http://localhost"
}
```

This file is shared across all workspaces and servers.

## Transform

### Input (HTTP server config from plugin `.mcp.json`)

```json
{
  "url": "https://knowledge.mcp.wtg.zone"
}
```

### Output (rewritten stdio config for proxied clients)

```json
{
  "command": "npx",
  "args": [
    "mcp-remote",
    "https://knowledge.mcp.wtg.zone",
    "--http",
    "--static-oauth-client-metadata",
    "@/home/user/.allagents/mcp-remote/mcp-metadata-settings.json"
  ]
}
```

The `~` is expanded to the actual home directory. The `@` prefix is required by `mcp-remote` to read from file.

### Non-proxied clients

Clients not in the proxy config receive the original HTTP config unchanged.

## Sync integration

The proxy transform inserts into the existing sync flow at two points:

### 1. File-based sync (project-scoped)

Used for writing to `.mcp.json`, `.vscode/mcp.json`, `.copilot/mcp-config.json`, `.codex/config.toml`.

```
collectMcpServers() → applyMcpProxy(servers, client) → write config
```

A new `applyMcpProxy()` function takes the collected servers and the target client, and returns transformed configs where applicable.

### 2. CLI-based sync (user-scoped)

Used when calling `claude mcp add` or `codex mcp add` commands.

Instead of:
```
claude mcp add --transport http --scope user my-server https://example.com
```

The proxy transform produces:
```
claude mcp add --scope user my-server -- npx mcp-remote https://example.com --http --static-oauth-client-metadata @~/.allagents/mcp-remote/mcp-metadata-settings.json
```

The transform applies inside `buildClaudeMcpAddArgs()` and `buildCodexMcpAddArgs()` (or a wrapper around them), before the CLI command is executed.

## Ownership and tracking

Existing `trackedServers` behavior is unchanged. The server is tracked by name regardless of whether its config was rewritten. If a server was proxied and later the proxy config is removed, the next sync updates the config to the original HTTP version (or vice versa).

## Implementation scope

### New files

- `src/core/mcp-proxy.ts` — proxy transform logic:
  - `applyMcpProxy(servers, client, proxyConfig)` — rewrites HTTP configs to stdio for proxied clients
  - `ensureProxyMetadata()` — creates `~/.allagents/mcp-remote/mcp-metadata-settings.json` if missing
  - `shouldProxy(serverName, client, proxyConfig)` — determines if a server+client pair needs proxying

### Modified files

- `src/core/sync.ts` — call `applyMcpProxy()` before each client's MCP sync step, call `ensureProxyMetadata()` at sync start
- `src/models/workspace.ts` (or equivalent) — parse `mcpProxy` section from `workspace.yaml`
- `buildClaudeMcpAddArgs()` in `src/core/claude-mcp.ts` — handle proxied configs (or apply transform before calling)
- `buildCodexMcpAddArgs()` in `src/core/codex-mcp.ts` — same

### CLI: `allagents mcp add` with proxy support

The `allagents mcp add` command (from issue #346) supports both `--scope user` and `--scope project`, and integrates with the proxy config:

```
allagents mcp add <name> <url> [--scope user|project] [--client claude,copilot,codex]
```

When adding a server, the proxy transform is applied per-client based on `workspace.yaml` proxy config:

- If the target client is in `mcpProxy.clients`, the server is written as a proxied stdio config
- If not, the server is written as a native HTTP config
- `--scope user` writes to user-scoped config (CLI-based for Claude/Codex, file-based for VS Code/Copilot)
- `--scope project` writes to project-scoped config files

The proxy transform is the same regardless of whether the server was added via `allagents mcp add` or synced from a plugin.

## Edge cases

- **Server not HTTP** — stdio servers are never proxied, even if the client is in `mcpProxy.clients`.
- **`mcp-remote` not installed** — `npx mcp-remote` auto-installs on first run. No pre-install step needed.
- **Metadata file deleted** — `ensureProxyMetadata()` recreates it on next sync.
- **Proxy config removed** — next sync writes the original HTTP config, replacing the proxied version. Tracked server name is unchanged so ownership is preserved.
- **Multiple workspaces** — each workspace can have its own `mcpProxy` config. The metadata file is shared since it's workspace-independent.

## Out of scope

- Managing `mcp-remote` processes (each client spawns its own via `npx`)
- Custom `mcp-remote` flags beyond `--http` and `--static-oauth-client-metadata`
- Wrapper scripts for platforms that can't run `npx` (all current clients support it)
- Full `allagents mcp` subcommand surface beyond `add` (list, remove, get, update — covered by issue #346 separately)
