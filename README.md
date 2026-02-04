# AllAgents

CLI tool for managing multi-repo AI agent workspaces with plugin synchronization across multiple AI clients.

> **Attribution:** AllAgents is inspired by [dotagents](https://github.com/iannuttall/dotagents) by Ian Nuttall. While rewritten from scratch, we share the vision of unified AI agent configuration management. Thank you Ian for the inspiration!

## Why AllAgents?

**The Problem:** AI coding assistants (Claude, Copilot, Cursor, Codex, etc.) each have their own configuration formats and directory structures. If you want to share skills across multiple projects or use multiple AI clients, you need to manually copy and transform files.

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

# Or initialize from a remote GitHub template
allagents workspace init my-workspace --from owner/repo/path/to/template

# Add a marketplace (or let auto-registration handle it)
allagents plugin marketplace add anthropics/claude-plugins-official

# Install plugins to workspace
allagents plugin install code-review@claude-plugins-official
allagents plugin install my-plugin@someuser/their-repo

# Sync plugins to workspace
allagents workspace sync
```

### Initialize from Remote Template

Start a new workspace instantly from any GitHub repository containing a `workspace.yaml`:

```bash
# From GitHub URL
allagents workspace init ~/my-project --from https://github.com/myorg/templates/tree/main/nodejs

# From shorthand
allagents workspace init ~/my-project --from myorg/templates/nodejs

# From repo root (looks for .allagents/workspace.yaml or workspace.yaml)
allagents workspace init ~/my-project --from myorg/templates
```

This fetches the workspace configuration directly from GitHub - no cloning required.

## Commands

### Workspace Commands

```bash
# Initialize a new workspace from template
allagents workspace init <path>
allagents workspace init <path> --from <source>  # From local path or GitHub URL

# Sync all plugins to workspace (non-destructive)
allagents workspace sync [options]
  --force    Force re-fetch of remote plugins even if cached
  --dry-run  Preview changes without applying

# Non-destructive sync: your files are safe
# - First sync overlays without deleting existing files
# - Subsequent syncs only remove files AllAgents previously synced
# - Tracked in .allagents/sync-state.json

# Show status of workspace and plugins
allagents workspace status

# Add a repository to the workspace (auto-detects git remote source)
allagents workspace repo add <path>
allagents workspace repo add <path> --description "My project"

# Remove a repository from the workspace
allagents workspace repo remove <path>

# List all repositories in the workspace
allagents workspace repo list
```

### `workspace setup`

Generate a VSCode `.code-workspace` file from your workspace.yaml configuration. Repository paths are resolved to absolute paths. Plugin folders are included with prompt/instruction file location settings for Copilot.

```bash
allagents workspace setup
allagents workspace setup --output my-workspace
```

#### Output filename

Priority: `--output` flag > `vscode.output` in workspace.yaml > `<dirname>.code-workspace`

```yaml
# workspace.yaml
vscode:
  output: my-project.code-workspace
```

#### Template file

Create `.allagents/vscode-template.json` for VSCode-specific settings, launch configurations, extensions, and extra folders. The template supports `{repo:../path}` placeholders that resolve to absolute paths using repository paths from workspace.yaml.

```json
{
  "folders": [
    { "path": "{repo:../Shared}", "name": "SharedLib" }
  ],
  "settings": {
    "cSpell.words": ["myterm"],
    "chat.agent.maxRequests": 999,
    "chat.useClaudeSkills": true
  },
  "launch": {
    "configurations": [
      {
        "type": "node",
        "name": "dev",
        "cwd": "{repo:../myapp}/src",
        "runtimeExecutable": "npm",
        "runtimeArgs": ["run", "dev"]
      }
    ]
  },
  "extensions": {
    "recommendations": ["dbaeumer.vscode-eslint"]
  }
}
```

The generated workspace includes:
- Repository folders from workspace.yaml (resolved to absolute paths, listed first)
- Template folders (deduplicated against repository folders)
- Plugin folders with Copilot prompt/instruction file location settings
- All other template content (settings, launch, extensions) with `{repo:..}` placeholders resolved

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
# Install a plugin to .allagents/workspace.yaml (auto-registers marketplace if needed)
allagents plugin install <plugin@marketplace>

# Remove a plugin from .allagents/workspace.yaml
allagents plugin uninstall <plugin>

# List available plugins from marketplaces
allagents plugin list [marketplace]

# Validate a plugin or marketplace structure
allagents plugin validate <path>
```

## .allagents/workspace.yaml

The workspace configuration file lives in `.allagents/workspace.yaml` and defines repositories, plugins, workspace files, and target clients:

```yaml
# Workspace file sync (optional) - copy files from a shared source
workspace:
  source: ../shared-config              # Default base for relative paths
  files:
    - AGENTS.md                         # String shorthand: same source and dest
    - source: docs/guide.md             # Object form: explicit source
      dest: GUIDE.md                    # Optional dest (defaults to basename)
    - dest: CUSTOM.md                   # File-level source override
      source: ../other-config/CUSTOM.md
    - dest: AGENTS.md                   # GitHub source
      source: owner/repo/path/AGENTS.md

repositories:
  - path: ../my-project
    source: github
    repo: myorg/my-project
    description: Main project repository
  - path: ../my-api
    source: github
    repo: myorg/my-api
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

### Workspace File Sync

The `workspace:` section enables syncing files from external sources to your workspace root. This is useful for sharing agent configurations (AGENTS.md, CLAUDE.md) across multiple projects.

**Key behaviors:**
- **Source of truth is remote** - Local copies are overwritten on every sync
- **Deleted files are restored** - If you delete AGENTS.md locally, sync restores it
- **WORKSPACE-RULES injection** - AGENTS.md and CLAUDE.md automatically get workspace discovery rules injected

**Source resolution:**
| Format | Example | Resolves to |
|--------|---------|-------------|
| String shorthand | `AGENTS.md` | `{workspace.source}/AGENTS.md` |
| Relative source | `source: docs/guide.md` | `{workspace.source}/docs/guide.md` |
| File-level override | `source: ../other/file.md` | `../other/file.md` (relative to workspace) |
| GitHub source | `source: owner/repo/path/file.md` | Fetched from GitHub cache |

**GitHub sources** are fetched fresh on every sync (always pulls latest).

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

| Client | Skills | Agent File | Hooks | Commands |
|--------|--------|------------|-------|----------|
| claude | `.claude/skills/` | `CLAUDE.md` | `.claude/hooks/` | `.claude/commands/` |
| copilot | `.github/skills/` | `AGENTS.md` | No | No |
| codex | `.codex/skills/` | `AGENTS.md` | No | No |
| cursor | `.cursor/skills/` | `AGENTS.md` | No | No |
| opencode | `.opencode/skills/` | `AGENTS.md` | No | No |
| gemini | `.gemini/skills/` | `GEMINI.md` | No | No |
| factory | `.factory/skills/` | `AGENTS.md` | `.factory/hooks/` | No |
| ampcode | No | `AGENTS.md` | No | No |

> **Note:** Commands are a Claude-specific feature. Skills are the cross-client way to share reusable prompts.

## Marketplace Structure

Marketplaces contain multiple plugins:

```
my-marketplace/
├── plugins/
│   ├── code-review/
│   │   ├── plugin.json
│   │   └── skills/
│   └── debugging/
│       ├── plugin.json
│       └── skills/
└── README.md
```

## Plugin Structure

Each plugin follows this structure:

```
my-plugin/
├── plugin.json         # Plugin metadata
├── skills/             # Skill directories with SKILL.md (all clients)
│   └── debugging/
│       └── SKILL.md
├── commands/           # Command files (.md) - Claude only
│   ├── build.md
│   └── deploy.md
├── hooks/              # Hook files (Claude/Factory only)
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

### Self Commands

```bash
# Update to latest version (auto-detects package manager)
allagents self update

# Force a specific package manager
allagents self update --npm
allagents self update --bun
```

When using the interactive TUI, AllAgents automatically checks for newer versions in the background and shows a notice on startup when an update is available.

## Storage Locations

```
~/.allagents/
├── marketplaces.json              # Registry of marketplaces
├── version-check.json             # Cached update check (auto-managed)
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
