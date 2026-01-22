# Workspace Setup Plan

> Source: [GitHub Issue #2](https://github.com/EntityProcess/allagents/issues/2)

## Proposal

Create CLI tool similar to https://github.com/iannuttall/dotagents except:
1. We support multi-repo workspaces
2. Can sync to plugin directory
3. Copy files instead of symlinks

It will only support commands and skills initially.

## Workspace Template

file: `templates/workspace-1/AGENTS.md`
```markdown
<!-- WORKSPACE-RULES:START -->
# Workspace Rules

## Rule: Workspace Discovery
TRIGGER: Any task
ACTION: Read `workspace.yaml` to get repository paths and project domains

## Rule: Correct Repository Paths
TRIGGER: File operations (read, search, modify)
ACTION: Use repository paths from `workspace.yaml`, not assumptions
<!-- WORKSPACE-RULES:END -->
```

file: `templates/workspace-1/workspace.yaml`
```yaml
repositories:
  - path: ../allagents
    owner: EntityProcess
    repo: allagents
    description: primary project

  - path: ../dotagents
    owner: iannuttall
    repo: dotagents
    description: related project that inspired the primary project

  - path: ../openskills
    owner: numman-ali
    repo: openskills
    description: Universal skills loader for AI coding agents

  - path: ../mcporter
    owner: steipete
    repo: mcporter
    description: related project used for inspiration to copy mcp tokens

plugins:
  - .claude/allagents
  - https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-review

clients:
  - copilot
  - copilot-cli
  - claude
  - opencode
  - codex
```

## New Workspace Directory

Initialize git repository and make initial commit.

The plugin relative path is converted to absolute path that points to the original repo.
```yaml
plugins:
  - ~/projects/allagents/.claude
  - https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-review
```

### Copilot

- .github/prompts
- .github/skills
- .github/instructions/skills.instructions
- AGENTS.md

### Claude

- .claude/commands
- .claude/skills
- CLAUDE.md

## Example Usage

Create new workspace from template:
```bash
cd templates/workspace-1
allagents workspace init path/to/new/workspace
```

Sync workspace (creates commit with timestamp of synced plugins):
```bash
cd projects/workspace-1
allagents workspace sync
```

---

## Clarifications

### Plugin Sync Behavior

- **Remote plugins (GitHub URLs)**: Fetched via `gh` CLI and cached at `~/.allagents/plugins/marketplaces/<repo-name>/`
  - The entire repo is fetched even if only one plugin is needed (repos contain a `plugins/` folder)
  - Similar pattern to Claude's `~/.claude/plugins/marketplaces/<repo-name>/`
- **Conflicts**: Overwrite local changes with remote changes (no merge). This is a private copy, conflicts are unlikely.
- **Local plugins**: Use absolute path pointing directly to the source. User manually pulls updates and runs sync.

### Sync Scope

- Full plugin directory is copied
- Plugins are specified in `workspace.yaml`
- Structure mirrors Claude plugin format: `commands/`, `skills/`, `agents/`, `hooks/`

### AGENTS.md Rules

- For AI agents working in the workspace (not consumed by CLI)
- Workspace rules are appended to `AGENTS.md` and `CLAUDE.md`

---

## CLI Command Structure

```
allagents workspace init <path>     # Create workspace from current template
allagents workspace sync            # Sync plugins to workspace (fetch + copy)
allagents workspace status          # Show sync status of plugins
allagents workspace add <plugin>    # Add plugin to workspace.yaml
allagents workspace remove <plugin> # Remove plugin from workspace.yaml

allagents plugin fetch <url>        # Fetch remote plugin to cache
allagents plugin list               # List cached plugins
allagents plugin update [name]      # Update cached plugin(s) from remote
```

---

## Client Path Mappings

Based on [dotagents](https://github.com/iannuttall/dotagents) research, here are the supported clients and their directory conventions:

### Supported Clients

| Client | Commands Path | Skills Path | Agent File | Hooks |
|--------|---------------|-------------|------------|-------|
| Claude | `.claude/commands/` | `.claude/skills/` | `CLAUDE.md` | `.claude/hooks/` |
| Copilot (GitHub) | `.github/prompts/*.prompt.md` | `.github/skills/` | `AGENTS.md` | No |
| Codex | `.codex/prompts/` | `.codex/skills/` | `AGENTS.md` | No |
| Cursor | `.cursor/commands/` | `.cursor/skills/` | No | No |
| OpenCode | `.opencode/commands/` | `.opencode/skills/` | `AGENTS.md` | No |
| Gemini | `.gemini/commands/` | `.gemini/skills/` | `GEMINI.md` | No |
| Factory | `.factory/commands/` | `.factory/skills/` | `AGENTS.md` | `.factory/hooks/` |
| Ampcode | N/A | N/A | `AGENTS.md` | No |

### Agent File Handling

Each client reads its own agent file. When multiple clients are selected, **all** their agent files are created in the workspace:

```
workspace/
├── CLAUDE.md    ← Claude reads this
├── GEMINI.md    ← Gemini reads this
├── AGENTS.md    ← Codex, Copilot, OpenCode, etc. read this
```

**Source precedence** determines which source file populates each destination:

| Destination | Source (in order of preference) |
|-------------|--------------------------------|
| `CLAUDE.md` | `CLAUDE.md` → `AGENTS.md` |
| `GEMINI.md` | `GEMINI.md` → `AGENTS.md` |
| `AGENTS.md` | `AGENTS.md` |

This allows multiple clients to work in the same workspace folder, each reading their own agent file.

**Example**: Source plugin has both `CLAUDE.md` and `AGENTS.md`, workspace has `clients: [claude, codex]`:

| Source | Destination | Reason |
|--------|-------------|--------|
| `CLAUDE.md` | `CLAUDE.md` | Claude selected, client-specific file exists |
| `AGENTS.md` | `AGENTS.md` | Codex selected, uses AGENTS.md |

Both files are copied to the workspace.

### File Extension Transforms

| Client | Commands Extension | Notes |
|--------|-------------------|-------|
| Claude | `*.md` | Standard markdown |
| Copilot | `*.prompt.md` | Must have `.prompt.md` suffix |
| Codex | `*.md` | Uses `prompts/` folder name |
| Others | `*.md` | Standard markdown |

---

## Skill Validation

Skills must have a valid `SKILL.md` file with YAML frontmatter:

```markdown
---
name: my-skill
description: "A brief description of what this skill does"
---

# Skill content here...
```

### Required Fields

| Field | Rules |
|-------|-------|
| `name` | Lowercase, alphanumeric + hyphens, max 64 chars |
| `description` | Required, non-empty string |

### Optional Fields

| Field | Description |
|-------|-------------|
| `allowed-tools` | Array of tool names |
| `model` | Model identifier string |

### Skill Directory Structure

```
skills/
├── my-skill/
│   ├── SKILL.md           # Required: metadata + instructions
│   ├── references/        # Optional: documentation
│   ├── scripts/           # Optional: executable code
│   └── assets/            # Optional: templates/resources
└── another-skill/
    └── SKILL.md
```

---

## Sync Flow

```
1. Read workspace.yaml
2. For each plugin in plugins list:
   a. If GitHub URL → check cache at ~/.allagents/plugins/marketplaces/<repo>/
      - If not cached or --force → gh repo clone to cache
   b. If local path → resolve to absolute path
3. For each client in clients list:
   a. Determine target paths from client mapping table
   b. Copy commands:
      - Source: plugin/commands/*.md
      - Target: client-specific commands path
      - Transform: rename extension if needed (e.g., *.prompt.md for Copilot)
   c. Copy skills:
      - Source: plugin/skills/<name>/
      - Target: client-specific skills path
      - Validate: each skill must have valid SKILL.md
   d. Copy hooks (if client supports):
      - Source: plugin/hooks/
      - Target: client-specific hooks path
4. Handle agent files for each client:
   - Create client's agent file (CLAUDE.md, GEMINI.md, or AGENTS.md)
   - Use source precedence: prefer client-specific file, fall back to AGENTS.md
   - Append workspace rules section to each agent file
5. Create git commit with sync metadata
```

---

## File Transformation Rules

### Source → Client Mapping

| Source | Claude | Copilot | Codex | Cursor |
|--------|--------|---------|-------|--------|
| `commands/*.md` | `.claude/commands/*.md` | `.github/prompts/*.prompt.md` | `.codex/prompts/*.md` | `.cursor/commands/*.md` |
| `skills/<name>/` | `.claude/skills/<name>/` | `.github/skills/<name>/` | `.codex/skills/<name>/` | `.cursor/skills/<name>/` |
| `hooks/*.md` | `.claude/hooks/*.md` | N/A | N/A | N/A |
| Agent file | `CLAUDE.md` ¹ | `AGENTS.md` | `AGENTS.md` | N/A |

¹ Source precedence: `CLAUDE.md` → `AGENTS.md`

### Plugin Directory Structure (Source)

```
plugin-name/
├── commands/           # Slash commands (*.md)
├── skills/             # Skill directories with SKILL.md
│   └── skill-name/
│       └── SKILL.md
├── hooks/              # Event hooks (Claude/Factory only)
├── agents/             # (future)
└── plugin.json         # Plugin manifest
```

---

## Comparison: allagents vs dotagents

| Aspect | dotagents | allagents |
|--------|-----------|-----------|
| **Approach** | Symlinks to canonical `.agents/` | Copy files to workspace |
| **CLI style** | Interactive TUI prompts | Command-line subcommands |
| **Multi-repo** | No | Yes (workspace.yaml) |
| **Scope** | Global or project | Workspace-based |
| **Backup/Undo** | Yes (timestamped) | Not needed (git history) |
| **Plugin sources** | Local only | Local + GitHub URLs |
| **Clients** | 8 supported (TUI selection) | 8 supported (yaml config) |
| **Selective sync** | TUI checkboxes | yaml clients list |

### Key Differences

1. **File copying vs symlinks**: allagents copies files so workspaces are self-contained and can be committed to git
2. **Multi-repo support**: allagents manages plugins from multiple repositories via workspace.yaml
3. **Remote plugins**: allagents can fetch plugins from GitHub URLs and cache them locally
4. **Non-interactive**: allagents uses standard CLI subcommands instead of interactive TUI
5. **Git-based history**: No backup/undo system needed - workspaces are git repos with full history

---

## Future Enhancements

- **Frontmatter transformation**: Tool-specific field mapping for metadata
- **Dry-run mode**: Preview changes before applying
