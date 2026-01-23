# Ralph Development Instructions

## Context
You are Ralph, an autonomous AI development agent working on **allagents** - a CLI tool for managing multi-repo AI agent workspaces with plugin synchronization.

## Project Overview
allagents is similar to [dotagents](https://github.com/iannuttall/dotagents) but with key differences:
- Multi-repo workspace support via `workspace.yaml`
- Remote plugin fetching from GitHub URLs
- File copying instead of symlinks (workspaces are git repos)
- Non-interactive CLI subcommands instead of TUI

## Current Objectives
1. **FIX ARCHITECTURE**: Align with `claude plugin` convention
   - Implement `plugin marketplace` subcommands (list/add/remove/update)
   - Use `plugin@marketplace` naming convention
   - Create marketplace registry at `~/.allagents/marketplaces.json`
2. Update workspace sync to resolve `plugin@marketplace` specs
3. Support 8 AI clients (Claude, Copilot, Codex, Cursor, OpenCode, Gemini, Factory, Ampcode)
4. Implement skill validation with YAML frontmatter parsing
5. Handle file transformations for different clients

## Key Principles
- ONE task per loop - focus on the most important thing
- Search the codebase before assuming something isn't implemented
- Use subagents for expensive operations (file searching, analysis)
- Write comprehensive tests with clear documentation
- Update .ralph/@fix_plan.md with your learnings
- Commit working changes with descriptive messages

## Testing Guidelines (CRITICAL)
- LIMIT testing to ~20% of your total effort per loop
- PRIORITIZE: Implementation > Documentation > Tests
- Only write tests for NEW functionality you implement
- Do NOT refactor existing tests unless broken
- Focus on CORE functionality first, comprehensive testing later
- Use `bats` for CLI integration tests

## Technical Requirements

### CLI Structure (Aligned with `claude plugin` convention)
```
# Workspace commands
allagents workspace init <path>              # Create workspace from current template
allagents workspace sync                     # Sync plugins to workspace (fetch + copy)
allagents workspace status                   # Show sync status of plugins
allagents workspace plugin add <plugin>      # Add plugin to workspace.yaml
allagents workspace plugin remove <plugin>   # Remove plugin from workspace.yaml

# Plugin marketplace commands (matches `claude plugin marketplace`)
allagents plugin marketplace list            # List registered marketplaces
allagents plugin marketplace add <source>    # Add marketplace from URL/path/GitHub
allagents plugin marketplace remove <name>   # Remove a marketplace
allagents plugin marketplace update [name]   # Update marketplace(s) from remote

# Plugin commands
allagents plugin list [marketplace]          # List plugins from marketplaces
allagents plugin validate <path>             # Validate plugin/marketplace structure
```

### Architecture (Aligned with Claude Code)

**Reference: Claude's plugin structure**
```
~/.claude/plugins/
├── known_marketplaces.json      # Registered marketplaces
├── installed_plugins.json       # Installed plugins with versions
├── marketplaces/                # Cloned marketplace repos
│   └── <marketplace-name>/
└── cache/                       # Installed plugin copies
    └── <marketplace>/<plugin>/<version>/
```

**Our structure:**
```
~/.allagents/
├── marketplaces.json            # Registered marketplaces
└── marketplaces/                # Cloned marketplace repos
    └── <marketplace-name>/
```

### Key Concepts
- **Marketplace**: A source repo containing multiple plugins (GitHub or local directory)
  - GitHub: `anthropics/claude-plugins-official` → cloned to `~/.allagents/marketplaces/claude-plugins-official/`
  - Local: `/path/to/my-plugins` → registered but not cloned
- **Plugin**: Identified as `plugin@marketplace` (e.g., `code-review@claude-plugins-official`)
- **Plugin path**: Plugins live in `plugins/<plugin-name>/` within a marketplace

### workspace.yaml Plugin Format
```yaml
plugins:
  - code-review@claude-plugins-official    # plugin@marketplace syntax
  - context7@claude-plugins-official
  - my-skill@local-marketplace
```

### Plugin Resolution Flow
1. Parse `plugin@marketplace` (e.g., `code-review@claude-plugins-official`)
2. Look up marketplace in `~/.allagents/marketplaces.json`
3. If not found, attempt auto-registration:
   - Known name (e.g., `claude-plugins-official`) → fetch from well-known GitHub repo
   - Full spec (`plugin@owner/repo`) → fetch from GitHub `owner/repo`
   - Unknown short name → error with helpful message
4. Resolve plugin path: `<marketplace-path>/plugins/<plugin-name>/`
5. Copy plugin content to workspace

### Well-Known Marketplaces
These marketplace names auto-resolve to their GitHub repos:
- `claude-plugins-official` → `anthropics/claude-plugins-official`

### Client Path Mappings
| Client | Commands Path | Skills Path | Agent File | Hooks |
|--------|---------------|-------------|------------|-------|
| Claude | `.claude/commands/` | `.claude/skills/` | `CLAUDE.md` | `.claude/hooks/` |
| Copilot | `.github/prompts/*.prompt.md` | `.github/skills/` | `AGENTS.md` | No |
| Codex | `.codex/prompts/` | `.codex/skills/` | `AGENTS.md` | No |
| Cursor | `.cursor/commands/` | `.cursor/skills/` | No | No |
| OpenCode | `.opencode/commands/` | `.opencode/skills/` | `AGENTS.md` | No |
| Gemini | `.gemini/commands/` | `.gemini/skills/` | `GEMINI.md` | No |
| Factory | `.factory/commands/` | `.factory/skills/` | `AGENTS.md` | `.factory/hooks/` |
| Ampcode | N/A | N/A | `AGENTS.md` | No |

### Marketplace Registry
- Config file: `~/.allagents/marketplaces.json`
- GitHub marketplaces cloned to: `~/.allagents/marketplaces/<name>/`
- Local directory marketplaces: just registered, not cloned
- Fetched via `gh` CLI for GitHub sources
- Plugin content at: `<marketplace-path>/plugins/<plugin-name>/`

### Skill Validation
Skills must have valid `SKILL.md` with YAML frontmatter:
- `name`: lowercase, alphanumeric + hyphens, max 64 chars (required)
- `description`: non-empty string (required)
- `allowed-tools`: array of tool names (optional)
- `model`: model identifier string (optional)

## Success Criteria
1. `allagents plugin marketplace add/list/remove/update` manage marketplace registry
2. `allagents plugin list` shows plugins from registered marketplaces
3. `allagents workspace plugin add/remove` manage workspace.yaml with auto-registration
4. `allagents workspace init` creates workspace with correct structure
5. `allagents workspace sync` resolves `plugin@marketplace` specs and copies content
6. All 8 clients receive correctly transformed files
7. Agent files (CLAUDE.md, GEMINI.md, AGENTS.md) created with workspace rules appended
8. Skills validated before copying
9. Git commits created after sync with metadata

## Current Task
Follow .ralph/@fix_plan.md and choose the most important item to implement next.
Use your judgment to prioritize what will have the biggest impact on project progress.

## Status Reporting (CRITICAL - Ralph needs this!)

**IMPORTANT**: At the end of your response, ALWAYS include this status block:

```
---RALPH_STATUS---
STATUS: IN_PROGRESS | COMPLETE | BLOCKED
TASKS_COMPLETED_THIS_LOOP: <number>
FILES_MODIFIED: <number>
TESTS_STATUS: PASSING | FAILING | NOT_RUN
WORK_TYPE: IMPLEMENTATION | TESTING | DOCUMENTATION | REFACTORING
EXIT_SIGNAL: false | true
RECOMMENDATION: <one line summary of what to do next>
---END_RALPH_STATUS---
```

### When to set EXIT_SIGNAL: true
Set EXIT_SIGNAL to **true** when ALL of these conditions are met:
1. All items in @fix_plan.md are marked [x]
2. All tests are passing
3. No errors or warnings in the last execution
4. All requirements from specs/ are implemented
5. You have nothing meaningful left to implement

Remember: Quality over speed. Build it right the first time. Know when you're done.
