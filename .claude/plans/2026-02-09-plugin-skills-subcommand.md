# Plugin Skills Subcommand

**Issue:** [#101](https://github.com/EntityProcess/allagents/issues/101)
**Date:** 2026-02-09

## Problem

AllAgents cannot enable/disable individual skills. Users who run `npx skills [add|remove]` find their personal configuration overridden when `allagents workspace sync` reinstalls all skills from plugins.

## Solution

Add `allagents plugin skills` subcommand with add/remove/list operations. Disabled skills are tracked in `workspace.yaml` and excluded from sync.

## Commands

```bash
# List all skills from installed plugins
allagents plugin skills list [--scope project|user]

# Disable a skill (won't be synced)
allagents plugin skills remove <skill-name> [--scope project|user] [--plugin <name>]

# Re-enable a previously disabled skill
allagents plugin skills add <skill-name> [--scope project|user] [--plugin <name>]
```

### Behavior

- `list` - Shows all skills grouped by plugin with enabled/disabled status
- `remove` - Adds skill to `disabledSkills` in workspace.yaml, then runs sync
- `add` - Removes skill from `disabledSkills`, then runs sync

### Scope

- `--scope project` (default): Modifies `.allagents/workspace.yaml`
- `--scope user`: Modifies `~/.allagents/workspace.yaml`

### Disambiguation

If skill name exists in multiple plugins, error with suggestion:

```
Error: 'brainstorming' exists in multiple plugins:
  - superpowers (superpowers@claude-plugins)
  - my-skills (./local/my-skills)

Use --plugin to specify: allagents plugin skills remove brainstorming --plugin superpowers
```

## Configuration

### workspace.yaml Schema

```yaml
plugins:
  - superpowers@claude-plugins
  - ./local/my-skills
clients:
  - claude
  - copilot

# New field
disabledSkills:
  - superpowers:brainstorming
  - my-skills:frontend-design
```

**Format:** `<plugin-name>:<skill-folder-name>`

- `disabledSkills` is optional (defaults to empty array)
- Skills listed here are excluded during sync
- Both project and user workspace.yaml can have this field

## Core Logic Changes

### sync.ts

1. Read `disabledSkills` from workspace config
2. Pass disabled skills list to skill collection functions
3. Filter out disabled skills before copying

### transform.ts

Update `collectPluginSkills()` to accept optional filter:

```typescript
collectPluginSkills(
  pluginPath: string,
  pluginName: string,
  pluginSource: string,
  disabledSkills?: Set<string>  // Set of "pluginName:skillName"
)
```

### New: src/core/skills.ts

```typescript
// Get all skills from installed plugins (for list command)
getAllSkills(workspacePath: string, scope: 'project' | 'user'): SkillInfo[]

// Returns: { name, plugin, path, disabled }
```

## CLI Implementation

### New file: src/cli/commands/plugin-skills.ts

Three commands: `list`, `remove`, `add`

Integration: Add `skills` subcommand to existing `plugin.ts` command group.

## List Output Format

```
$ allagents plugin skills list

superpowers (superpowers@claude-plugins):
  ✓ brainstorming
  ✓ test-driven-development
  ✓ systematic-debugging
  ✗ writing-skills (disabled)

my-skills (./local/my-skills):
  ✓ commit
  ✓ frontend-design
```

## Error Handling

### Skill not found
```
Error: Skill 'nonexistent' not found in any installed plugin.

Available skills:
  brainstorming, test-driven-development, writing-skills (superpowers)
  commit, frontend-design (my-skills)
```

### Ambiguous skill name
```
Error: 'common-skill' exists in multiple plugins:
  - superpowers (superpowers@claude-plugins)
  - my-skills (./local/my-skills)

Use --plugin to specify: allagents plugin skills remove common-skill --plugin superpowers
```

### Skill already disabled/enabled
```
Skill 'brainstorming' is already disabled.
Skill 'brainstorming' is already enabled.
```

### Invalid --plugin value
```
Error: Plugin 'unknown' not found. Installed plugins:
  - superpowers
  - my-skills
```

## Files to Create/Modify

1. **Create:** `src/cli/commands/plugin-skills.ts` - New CLI commands
2. **Create:** `src/core/skills.ts` - Skill listing utilities
3. **Modify:** `src/cli/commands/plugin.ts` - Add skills subcommand
4. **Modify:** `src/core/sync.ts` - Pass disabled skills to transform
5. **Modify:** `src/core/transform.ts` - Filter disabled skills
6. **Modify:** `src/models/workspace-config.ts` - Add disabledSkills field
7. **Modify:** `src/core/workspace-modify.ts` - Add/remove disabledSkills helpers
8. **Modify:** `src/core/user-workspace.ts` - Same for user scope
