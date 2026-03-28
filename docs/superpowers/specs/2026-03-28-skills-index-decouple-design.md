# Skills Index: Decouple Repo Skills from AGENTS.md

## Problem

PRs #337 and #339 introduced repository skill discovery that embeds an `<available_skills>` XML block directly into AGENTS.md via WORKSPACE-RULES. However, VS Code already auto-discovers skills from repos in the workspace and loads them into context natively. This causes skills to appear twice in the AI's context window.

No other client (Claude Code, Cursor, Codex, etc.) has native cross-repo skill discovery. They still need access to the skill index, but not inline in AGENTS.md.

## Design

### Skills-index files

During sync, for each repo that has discovered skills, generate a file at:

```
.allagents/skills-index/<repo-name>.md
```

The file contains the `<available_skills>` XML block (skill name, description, location) that was previously embedded inline in AGENTS.md.

`<repo-name>` is derived from `repository.name` in workspace.yaml, falling back to the directory basename of `repository.path`.

### AGENTS.md conditional link

Replace the inline `## Repository Skills` + `<available_skills>` block in WORKSPACE-RULES with a conditional instruction:

```markdown
## Repository Skills
If the skills from the following repositories are not already available in your context, read the corresponding index file:
- <repo-name>: .allagents/skills-index/<repo-name>.md
```

This way:
- VS Code (which already loaded skills natively) ignores it
- Other clients follow the link and read the index file on demand
- Skills are never double-loaded into context

### Opt-in behavior

Repository skill discovery is opt-in. To enable it, set `skills: true` (or provide custom paths) on individual repositories in workspace.yaml. When omitted, skill discovery is skipped for that repo — no skills-index file is generated and no link appears in AGENTS.md.

This guards against performance issues from scanning large repos with many skill directories.

### Sync state and cleanup

- Track generated skills-index files in `sync-state.json`
- When a repo is removed from workspace.yaml or has `skills: false`, delete its corresponding index file
- When the `skills-index/` directory becomes empty, remove it
- Deduplication logic in `discoverWorkspaceSkills()` still applies and determines which skills go into each repo's index file

## What changes

### Stays the same
- `discoverRepoSkills()` and `discoverWorkspaceSkills()` — discovery and dedup logic unchanged (except default flip below)
- `ensureWorkspaceRules()` — still injects WORKSPACE-RULES between markers
- `parseSkillMetadata()` — still parses SKILL.md frontmatter

### Changes
- `generateWorkspaceRules()` — takes skill entries grouped by repo, emits conditional link text instead of inline `<available_skills>` XML
- New function to write per-repo skills-index files to `.allagents/skills-index/`
- Sync pipeline (`sync.ts`, `workspace-repo.ts`) — writes skills-index files before generating WORKSPACE-RULES
- Sync state — tracks skills-index files for cleanup
- `discoverWorkspaceSkills()` — flip default from opt-out to opt-in (skip when `skills` is omitted, only discover when `skills: true` or custom paths)
- Tests — update to reflect new output format and opt-in default

### Removed
- Inline `<available_skills>` XML block from AGENTS.md
