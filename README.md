# AllAgents

[![npm](https://img.shields.io/npm/v/allagents)](https://www.npmjs.com/package/allagents)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docs](https://img.shields.io/badge/docs-allagents.dev-blue)](https://allagents.dev)

Write AI agent skills once. Sync to 23 clients. Manage across multiple repos.

AllAgents keeps your AI tooling (skills, agents, hooks, MCP servers) in one workspace and syncs it to every client your team uses — Claude, Copilot, Cursor, Codex, Gemini, and 18 more.

## Quick Start

```bash
# Create a workspace from a shared template
npx allagents init my-workspace --from myorg/templates/nodejs
cd my-workspace

# Install plugins
npx allagents plugin install code-review@claude-plugins-official

# Sync to all configured clients
npx allagents update
```

No cloning required — AllAgents fetches the `workspace.yaml` directly from GitHub and sets up everything.

## How It Works

1. **Configure** your workspace with repos, plugins, and target clients in `workspace.yaml`
2. **Sync** — AllAgents copies skills, agents, hooks, and MCP servers to each client's expected paths
3. **Work** — every team member gets identical AI tooling via git, across any client they choose

```
┌─────────────────┐
│   Marketplace   │  GitHub repos containing plugins
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    AllAgents     │  sync & transform
│      sync       │
└────────┬────────┘
         │
    ┌────┴────┬────────┬─────────┐
    ▼         ▼        ▼         ▼
.claude/  .github/  .cursor/  .agents/   client paths
```

## Why AllAgents?

Tools like `npx skills` and `npx plugins` install skills to one project for one or two clients. AllAgents manages your entire AI tooling stack — skills, agents, hooks, commands, and MCP servers — across multiple repos and all your clients, from a single declarative config.

| | `npx skills` | `npx plugins` | `npx allagents` |
|---|---|---|---|
| **Config** | Imperative | Imperative | Declarative (`workspace.yaml`) |
| **Scope** | Single project | Single project | Multi-repo workspace |
| **Artifacts** | Skills | Skills, agents, hooks, commands, MCP | Skills, agents, hooks, commands, MCP |
| **Clients** | 43 agents | 2 (Claude, Cursor) | 23 clients simultaneously |
| **Team sharing** | Each dev runs install | Each dev runs install | Git-versioned — clone and go |
| **Ongoing sync** | One-shot install | One-shot install | `allagents update` keeps everything current |
| **Workspace awareness** | None | None | WORKSPACE-RULES injected so AI knows all repos and skills |
| **Provider resilience** | Per-client | Per-client | Switch clients instantly — same tooling everywhere |

## workspace.yaml

```yaml
workspace:
  source: ../shared-config
  files:
    - AGENTS.md

repositories:
  - path: ../my-project
    description: Main project
  - path: ../my-api
    description: API service

plugins:
  - code-review@claude-plugins-official
  - my-plugin@someuser/their-repo

clients:
  - claude
  - copilot
  - cursor
```

## Commands

| Command | Description |
|---|---|
| `allagents init <path>` | Create a workspace (optionally `--from owner/repo`) |
| `allagents update` | Sync all plugins to workspace |
| `allagents plugin install <spec>` | Install a plugin |
| `allagents plugin uninstall <spec>` | Remove a plugin |
| `allagents plugin list` | List available plugins |
| `allagents skill add <name>` | Add a skill from a repo (plural `skills` alias supported) |
| `allagents skill search <query> [--catalog recommended]` | Search globally or within the built-in Recommended catalog |
| `allagents skill list` | List skills and status |
| `allagents mcp add <name> <commandOrUrl>` | Add an MCP server and sync to clients |
| `allagents mcp proxy <serverUrl>` | Bridge a remote HTTP MCP server to local stdio |
| `allagents mcp list` | List workspace MCP servers |
| `allagents workspace status` | Show workspace state |
| `allagents self update` | Update AllAgents CLI |

See the [full CLI reference](https://allagents.dev/docs/reference/cli/) for all options.

## Recommended Skill Catalog

`allagents skill search <query>` keeps the existing global GitHub search. Add
`--catalog recommended` to search only the built-in, versioned Recommended
catalog:

```bash
allagents skill search testing --catalog recommended
```

The catalog is a hard discovery boundary: catalog failures and empty results do
not fall back to global search. **Recommended** is a discovery label, not a
security, trust, quality, or license guarantee; review each result's source,
classification, policy, warnings, and upstream content. In an interactive
terminal, installable results can be selected for project scope (including a
new disposable workspace) or user scope. Exact repository, ref, catalog root,
selected skill subset, and provenance are retained for later syncs.

## Supported Clients

**23 AI coding assistants** across two tiers:

**Universal** (share `.agents/skills/`): Copilot, Codex, OpenCode, Gemini, Amp Code, VSCode, Replit, Kimi

**Provider-specific**: Claude, Cursor, Factory, OpenClaw, Windsurf, Cline, Continue, Roo, Kilo, Trae, Augment, Zencoder, Junie, OpenHands, Kiro

See the [client support matrix](https://allagents.dev/docs/reference/clients/) for paths, hooks, commands, and MCP support per client.

## Plugin Structure

```
my-plugin/
├── skills/          # Reusable prompts (all clients)
│   └── debugging/
│       └── SKILL.md
├── agents/          # Agent definitions
├── commands/        # Slash commands (Claude, OpenCode)
├── hooks/           # Lifecycle hooks (Claude, Factory, Copilot, Codex)
├── .codex-plugin/   # Codex plugin manifest and explicit hook paths
├── .github/         # Copilot/VSCode project overrides
└── .mcp.json        # MCP server configs
```

For Codex project sync, AllAgents copies skills into `.codex/skills/`, merges
plugin hooks into `.codex/hooks.json`, and preserves user-owned hooks already in
that file. Codex plugins can declare hooks in `.codex-plugin/plugin.json` with a
`hooks` path, path array, inline object, or inline object array; otherwise
AllAgents falls back to `hooks/hooks.json`.

For Copilot project sync, AllAgents combines plugin hook declarations from
`hooks.json` or `hooks/hooks.json` in `.github/hooks/allagents.json` and binds
`COPILOT_PLUGIN_ROOT` for each plugin. Other repository hooks under
`.github/hooks/` remain project-scoped and are never promoted into the
user-global `~/.copilot/hooks/` directory. Copilot package metadata under
`.github/plugin/` is not copied into the project overlay. Potential user-scope
copies from older versions are left untouched and reported for manual review
because their ownership was not tracked.

Marketplace registration and `plugin.json` are not required for direct plugin
sources. A plugin without a supported hook declaration continues syncing its
other artifacts. AllAgents warns and omits a declaration that cannot be read or
parsed as JSON or lacks the version-1 `hooks` object envelope. A declaration
with `disableAllHooks: true` adds no entries; otherwise, a non-array event value
also omits the declaration. Skipping a declaration does not reject the plugin
or itself suppress other eligible artifacts, including repository hook files.

## Documentation

Full documentation at [allagents.dev](https://allagents.dev):

- [Getting Started](https://allagents.dev/docs/getting-started/introduction/)
- [Workspaces Guide](https://allagents.dev/docs/guides/workspaces/)
- [Plugins Guide](https://allagents.dev/docs/guides/plugins/)
- [Agent Portability](https://allagents.dev/docs/guides/agent-portability/)
- [Client Support Matrix](https://allagents.dev/docs/reference/clients/)
- [Configuration Reference](https://allagents.dev/docs/reference/configuration/)

## Related Projects

- [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) — Universal skills for AI coding assistants
- [skillpm](https://github.com/sbroenne/skillpm) — npm-native package manager for Agent Skills
- [skills-npm](https://github.com/antfu/skills-npm) — Discover agent skills shipped in npm packages
- [dotagents](https://github.com/iannuttall/dotagents) — Unified AI agent configuration management

## License

MIT
