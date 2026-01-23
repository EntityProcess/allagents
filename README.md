# allagents

CLI tool for managing multi-repo AI agent workspaces with plugin synchronization.

## Overview

allagents helps you manage AI agent configurations (prompts, skills, hooks) across multiple repositories and AI clients. It:

- Creates workspace configurations via `workspace.yaml`
- Fetches plugins from GitHub or local paths
- Syncs plugin content to target repositories
- Supports 8 AI clients: Claude, Copilot, Codex, Cursor, OpenCode, Gemini, Factory, Ampcode

## Installation

```bash
# Using bun
bun install -g allagents

# Or run directly
bunx allagents
```

## Quick Start

```bash
# Create a new workspace
allagents workspace init my-workspace
cd my-workspace

# Add plugins
allagents workspace add https://github.com/owner/my-plugin
allagents workspace add ../local-plugin

# Sync plugins to workspace
allagents workspace sync
```

## Commands

### Workspace Commands

```bash
# Initialize a new workspace from template
allagents workspace init <path>

# Sync all plugins to workspace (fetch + copy)
allagents workspace sync [options]
  --force    Force re-fetch of remote plugins
  --dry-run  Simulate sync without making changes

# Show status of workspace and plugins
allagents workspace status

# Add a plugin to workspace.yaml
allagents workspace add <plugin>

# Remove a plugin from workspace.yaml
allagents workspace remove <plugin>
```

### Plugin Commands

```bash
# Fetch a remote plugin to local cache
allagents plugin fetch <url>
  --force    Force re-clone even if cached

# List all cached plugins
allagents plugin list

# Update cached plugins from remote
allagents plugin update [name]
```

## workspace.yaml

The workspace configuration file defines repositories, plugins, and target clients:

```yaml
repositories:
  - path: ../my-project
    owner: myorg
    repo: my-project
    description: Main project repository

plugins:
  - https://github.com/owner/plugin-repo  # GitHub URL
  - ../local-plugins/my-plugin            # Local path
  - /absolute/path/to/plugin              # Absolute path

clients:
  - claude
  - copilot
  - cursor
```

### Supported Clients

| Client | Commands | Skills | Agent File | Hooks |
|--------|----------|--------|------------|-------|
| claude | `.claude/commands/` | `.claude/skills/` | `CLAUDE.md` | `.claude/hooks/` |
| copilot | `.github/prompts/*.prompt.md` | `.github/skills/` | `AGENTS.md` | No |
| codex | `.codex/prompts/` | `.codex/skills/` | `AGENTS.md` | No |
| cursor | `.cursor/commands/` | `.cursor/skills/` | No | No |
| opencode | `.opencode/commands/` | `.opencode/skills/` | `AGENTS.md` | No |
| gemini | `.gemini/commands/` | `.gemini/skills/` | `GEMINI.md` | No |
| factory | `.factory/commands/` | `.factory/skills/` | `AGENTS.md` | `.factory/hooks/` |
| ampcode | N/A | N/A | `AGENTS.md` | No |

## Plugin Structure

Plugins should follow this directory structure:

```
my-plugin/
├── commands/           # Command files (.md)
│   ├── build.md
│   └── deploy.md
├── skills/             # Skill directories with SKILL.md
│   └── debugging/
│       └── SKILL.md
├── hooks/              # Hook files (for Claude/Factory)
│   └── pre-commit.md
└── AGENTS.md           # Agent configuration (optional)
```

### Skill Validation

Skills must have a valid `SKILL.md` file with YAML frontmatter:

```yaml
---
name: my-skill          # Required: lowercase, alphanumeric + hyphens, max 64 chars
description: Description of the skill  # Required
allowed-tools:          # Optional
  - Read
  - Write
model: claude-3-opus    # Optional
---

# Skill Content

Skill instructions go here...
```

## Plugin Cache

Remote plugins are cached at:
```
~/.allagents/plugins/marketplaces/<repo-name>/
```

Use `allagents plugin list` to see cached plugins and `allagents plugin update` to refresh them.

## Development

```bash
# Install dependencies
bun install

# Run in development
bun run dev workspace init test-ws

# Run tests
bun run test

# Type check
bun run typecheck

# Build
bun run build
```

## License

MIT
