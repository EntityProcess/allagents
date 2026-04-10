# MCP Proxy Example

A minimal, **copy-and-run** workspace that demonstrates the
[MCP Proxy](https://allagents.dev/docs/guides/mcp-proxy/) feature.

It installs a single plugin (`deepwiki`) that exposes a real public HTTP MCP
server (`https://mcp.deepwiki.com/mcp`), and proxies it through
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) for Codex — which
only supports stdio transport.

## What gets synced

| Client | Transport | Config file |
|--------|-----------|-------------|
| `claude` | HTTP (untouched) | `.mcp.json` |
| `codex`  | stdio via `npx mcp-remote` | `.codex/config.toml` |

## Running it

Scaffold a fresh copy anywhere with `workspace init --from` (recommended —
this also runs the initial sync):

```bash
allagents workspace init ./mcp-proxy-demo \
  --from EntityProcess/allagents/examples/workspaces/mcp-proxy
cd ./mcp-proxy-demo
```

Or, if you have this repo checked out, run it in-place:

```bash
cd examples/workspaces/mcp-proxy
allagents update
```

Then inspect the generated files:

```bash
cat .mcp.json                 # HTTP config for Claude Code
cat .codex/config.toml        # Rewritten stdio config for Codex
```

You should see Codex invoking:

```
npx mcp-remote https://mcp.deepwiki.com/mcp --http \
  --static-oauth-client-metadata @~/.allagents/mcp-remote/mcp-metadata-settings.json
```

DeepWiki is a public, no-auth server, so you can connect immediately and
ask questions like "What is the architecture of facebook/react?" from any
proxied client.

## Requirements

- [Node.js](https://nodejs.org/) (provides `npx`, needed to run `mcp-remote`
  on demand). Nothing to install globally — `npx` fetches and caches
  `mcp-remote` automatically the first time a proxied server starts.

## See also

- [MCP Proxy guide](https://allagents.dev/docs/guides/mcp-proxy/)
- [`mcp-remote` on npm](https://www.npmjs.com/package/mcp-remote)
