# MCP Proxy Example

A minimal, **copy-and-run** workspace that demonstrates the
[MCP Proxy](https://allagents.dev/docs/guides/mcp-proxy/) feature.

It installs a single plugin (`deepwiki`) that exposes a real public HTTP MCP
server (`https://mcp.deepwiki.com/mcp`), and proxies it through AllAgents'
own built-in stdio bridge for Codex — which only supports stdio transport.

## What gets synced

| Client | Transport | Config file |
|--------|-----------|-------------|
| `claude` | HTTP (untouched) | `.mcp.json` |
| `codex`  | stdio via `allagents mcp proxy` | `.codex/config.toml` |

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
[mcp_servers.deepwiki]
command = "allagents"
args = ["mcp", "proxy", "https://mcp.deepwiki.com/mcp"]
```

DeepWiki is a public, no-auth server, so you can connect immediately and
ask questions like "What is the architecture of facebook/react?" from any
proxied client.

## Requirements

None beyond `allagents` itself — the proxy is built into the binary, with
no separate package to fetch or cache on first use.

## See also

- [MCP Proxy guide](https://allagents.dev/docs/guides/mcp-proxy/)
