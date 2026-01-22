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

### Clients List

The `clients` list controls which output formats are generated. Each client has different folder conventions:

| Client | Commands/Prompts | Skills | Agent File |
|--------|------------------|--------|------------|
| Claude | `.claude/commands/*.md` | `.claude/skills/<name>/SKILL.md` | `CLAUDE.md` |
| Copilot | `.github/prompts/*.prompt.md` | `.github/skills/<name>/SKILL.md` | `AGENTS.md` |
| Others | TBD (follow openskills patterns) | TBD | `AGENTS.md` |

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

## Sync Flow

```
1. Read workspace.yaml
2. For each plugin in plugins list:
   a. If GitHub URL → check cache at ~/.allagents/plugins/marketplaces/<repo>/
      - If not cached or --force → gh repo clone to cache
   b. If local path → resolve to absolute path
3. For each client in clients list:
   a. Map plugin folders to client-specific paths:
      - commands/ → .claude/commands/ (Claude) or .github/prompts/ (Copilot)
      - skills/ → .claude/skills/ (Claude) or .github/skills/ (Copilot)
   b. Copy files (overwrite existing)
   c. Rename files if needed (e.g., *.md → *.prompt.md for Copilot)
4. Append workspace rules to CLAUDE.md / AGENTS.md
5. Create git commit with sync metadata
```

---

## File Transformation Rules

### Claude → Copilot

| Source | Destination | Transform |
|--------|-------------|-----------|
| `commands/*.md` | `.github/prompts/*.prompt.md` | Rename extension |
| `skills/<name>/SKILL.md` | `.github/skills/<name>/SKILL.md` | None |
| Append to `CLAUDE.md` | Append to `AGENTS.md` | None |

### Plugin Directory Structure (Source)

```
plugin-name/
├── commands/           # Slash commands
├── skills/             # Skill directories with SKILL.md
├── agents/             # (future)
├── hooks/              # (future)
└── plugin.json         # Plugin manifest
```
