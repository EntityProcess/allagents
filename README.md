# AllAgents

CLI tool for managing multi-repo AI agent workspaces with plugin synchronization across multiple AI clients.

> **Attribution:** AllAgents is inspired by [dotagents](https://github.com/iannuttall/dotagents) by Ian Nuttall. While rewritten from scratch, we share the vision of unified AI agent configuration management. Thank you Ian for the inspiration!

## Why AllAgents?

**The Problem:** AI coding assistants (Claude, Copilot, Cursor, Codex, etc.) each have their own configuration formats and directory structures. If you want to share skills, commands, or prompts across multiple projects or use multiple AI clients, you need to manually copy and transform files.

**AllAgents solves this by:**

| Feature | Claude Code Plugins | AllAgents |
|---------|--------------------|-----------|
| Scope | Single project | Multi-repo workspace |
| Client support | Claude only | 8 AI clients |
| File location | Runtime lookup from cache | Copied to workspace (git-versioned) |
| Project structure | AI config mixed with code | Separate workspace repo |

### Key Differentiators

1. **Multi-repo workspaces** - One workspace references multiple project repositories. Your AI tooling lives separately from your application code.

2. **Multi-client distribution** - Write plugins once, sync to all clients. AllAgents transforms and copies files to each client's expected paths.

3. **Workspace is a git repo** - Unlike Claude's runtime plugin system, AllAgents copies files into your workspace. Team members get the same AI tooling via git.

4. **Clean separation** - Project repos stay clean. AI configuration lives in the workspace.

```
┌─────────────────┐
│   Marketplace   │  (plugin source - GitHub repos)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    AllAgents    │  (sync & transform)
│  workspace sync │
└────────┬────────┘
         │
    ┌────┴────┬────────┬─────────┐
    ▼         ▼        ▼         ▼
.claude/  .github/  .cursor/  .codex/   (client-specific paths)
```

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

# Add a marketplace (or let auto-registration handle it)
allagents plugin marketplace add anthropics/claude-plugins-official

# Add plugins to workspace
allagents workspace plugin add code-review@claude-plugins-official
allagents workspace plugin add my-plugin@someuser/their-repo

# Sync plugins to workspace
allagents workspace sync
```

## Commands

### Workspace Commands

```bash
# Initialize a new workspace from template
allagents workspace init <path>

# Sync all plugins to workspace
allagents workspace sync [options]
  --force    Force overwrite of local changes
  --dry-run  Preview changes without applying

# Show status of workspace and plugins
allagents workspace status

# Add a plugin to .allagents/workspace.yaml (auto-registers marketplace if needed)
allagents workspace plugin add <plugin@marketplace>

# Remove a plugin from .allagents/workspace.yaml
allagents workspace plugin remove <plugin>
```

### Plugin Marketplace Commands

```bash
# List registered marketplaces
allagents plugin marketplace list

# Add a marketplace from GitHub or local path
allagents plugin marketplace add <source>
  # Examples:
  #   allagents plugin marketplace add anthropics/claude-plugins-official
  #   allagents plugin marketplace add /path/to/local/marketplace

# Remove a marketplace
allagents plugin marketplace remove <name>

# Update marketplace(s) from remote
allagents plugin marketplace update [name]
```

### Plugin Commands

```bash
# List available plugins from marketplaces
allagents plugin list [marketplace]

# Validate a plugin or marketplace structure
allagents plugin validate <path>
```

## .allagents/workspace.yaml

The workspace configuration file lives in `.allagents/workspace.yaml` and defines repositories, plugins, and target clients:

```yaml
repositories:
  - path: ../my-project
    owner: myorg
    repo: my-project
    description: Main project repository
  - path: ../my-api
    owner: myorg
    repo: my-api
    description: API service

plugins:
  - code-review@claude-plugins-official     # plugin@marketplace format
  - context7@claude-plugins-official
  - my-plugin@someuser/their-repo           # fully qualified for custom marketplaces

clients:
  - claude
  - copilot
  - cursor
```

### Plugin Spec Format

Plugins use the `plugin@marketplace` format:

| Format | Example | Description |
|--------|---------|-------------|
| Well-known | `code-review@claude-plugins-official` | Uses known marketplace mapping |
| owner/repo | `my-plugin@owner/repo` | Auto-registers GitHub repo, looks in `plugins/` |
| owner/repo/subpath | `my-plugin@owner/repo/extensions` | Looks in custom subdirectory |

The subpath format is useful when plugins aren't in the standard `plugins/` directory:

```yaml
plugins:
  - feature-dev@anthropics/claude-plugins-official/plugins  # explicit plugins/ dir
  - my-addon@someuser/repo/addons                           # custom addons/ dir
  - tool@org/monorepo/packages/tools                        # nested path
```

### Well-Known Marketplaces

These marketplace names auto-resolve to their GitHub repos:

- `claude-plugins-official` → `anthropics/claude-plugins-official`

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

## Marketplace Structure

Marketplaces contain multiple plugins:

```
my-marketplace/
├── plugins/
│   ├── code-review/
│   │   ├── plugin.json
│   │   ├── commands/
│   │   └── skills/
│   └── debugging/
│       ├── plugin.json
│       ├── commands/
│       └── skills/
└── README.md
```

## Plugin Structure

Each plugin follows this structure:

```
my-plugin/
├── plugin.json         # Plugin metadata
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

## Storage Locations

```
~/.allagents/
├── marketplaces.json              # Registry of marketplaces
└── marketplaces/                  # Cloned marketplace repos
    ├── claude-plugins-official/
    └── someuser-their-repo/
```

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
