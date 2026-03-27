# AllAgents

[![npm](https://img.shields.io/npm/v/allagents)](https://www.npmjs.com/package/allagents)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docs](https://img.shields.io/badge/docs-allagents.dev-blue)](https://allagents.dev)

Write AI agent skills once. Sync to 23 clients. Manage across multiple repos.

AllAgents keeps your AI tooling (skills, agents, hooks, MCP servers) in one workspace and syncs it to every client your team uses — Claude, Copilot, Cursor, Codex, Gemini, and 18 more.

## Quick Start

```bash
# Create a workspace
npx allagents workspace init my-workspace
cd my-workspace

# Install plugins
npx allagents plugin install code-review@claude-plugins-official

# Sync to all configured clients
npx allagents update
```

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

Tools like `npx skills add` and `npx plugins add` install skills to one project for one or two clients. AllAgents manages your entire AI tooling stack — skills, agents, hooks, commands, and MCP servers — across multiple repos and all your clients, from a single declarative config.

| | `npx skills add` | `npx plugins add` | `allagents` |
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
| `allagents workspace init <path>` | Create a workspace (optionally `--from owner/repo`) |
| `allagents update` | Sync all plugins to workspace |
| `allagents plugin install <spec>` | Install a plugin |
| `allagents plugin uninstall <spec>` | Remove a plugin |
| `allagents plugin list` | List available plugins |
| `allagents skills add <name>` | Add a skill from a repo |
| `allagents skills list` | List skills and status |
| `allagents workspace status` | Show workspace state |
| `allagents self update` | Update AllAgents CLI |

See the [full CLI reference](https://allagents.dev/reference/cli/) for all options.

## Supported Clients

**23 AI coding assistants** across two tiers:

**Universal** (share `.agents/skills/`): Copilot, Codex, OpenCode, Gemini, Amp Code, VSCode, Replit, Kimi

**Provider-specific**: Claude, Cursor, Factory, OpenClaw, Windsurf, Cline, Continue, Roo, Kilo, Trae, Augment, Zencoder, Junie, OpenHands, Kiro

See the [client support matrix](https://allagents.dev/reference/clients/) for paths, hooks, commands, and MCP support per client.

## Plugin Structure

```
my-plugin/
├── skills/          # Reusable prompts (all clients)
│   └── debugging/
│       └── SKILL.md
├── agents/          # Agent definitions
├── commands/        # Slash commands (Claude, OpenCode)
├── hooks/           # Lifecycle hooks (Claude, Factory, Copilot)
├── .github/         # Copilot/VSCode overrides
└── .mcp.json        # MCP server configs
```

## Documentation

Full documentation at [allagents.dev](https://allagents.dev):

- [Getting Started](https://allagents.dev/getting-started/introduction/)
- [Workspaces Guide](https://allagents.dev/guides/workspaces/)
- [Plugins Guide](https://allagents.dev/guides/plugins/)
- [Agent Portability](https://allagents.dev/guides/agent-portability/)
- [Client Support Matrix](https://allagents.dev/reference/clients/)
- [Configuration Reference](https://allagents.dev/reference/configuration/)

## Related Projects

- [skillpm](https://github.com/sbroenne/skillpm) — npm-native package manager for Agent Skills
- [skills-npm](https://github.com/antfu/skills-npm) — Discover agent skills shipped in npm packages
- [dotagents](https://github.com/iannuttall/dotagents) — Unified AI agent configuration management

## License

MIT
