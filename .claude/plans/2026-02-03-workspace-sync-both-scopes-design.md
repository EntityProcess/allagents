# Workspace Sync Both Scopes

## Problem

Users must run `workspace sync --scope user` separately to sync user-level plugins, creating friction. New users don't understand scopes and expect the command to "just work."

## Design

`workspace sync` syncs both user and project workspaces automatically with no `--scope` flag.

### Behavior

1. If `~/.allagents/workspace.yaml` exists, sync user workspace
2. If `.allagents/workspace.yaml` exists in cwd, sync project workspace
3. If both exist, sync both (user first, then project)
4. If neither exists, auto-create user config via `ensureUserWorkspace()` and print:
   "No plugins configured. Run `allagents plugin install <plugin>` to get started."

### CLI Changes

- Remove `--scope` / `-s` option from `workspace sync` command
- No changes to other commands (`plugin install --scope user` etc. remain)

### Output

Label each sync phase. Only show phases that actually run.

```
Syncing user workspace...
  ✓ synced 3 plugins
Syncing project workspace...
  ✓ synced 2 plugins
```

## Key Files

- `src/cli/commands/workspace.ts` — remove `--scope` from sync command, call both sync functions
- `src/core/sync.ts` — `syncWorkspace()` (project) and `syncUserWorkspace()` (user)
- `src/core/user-workspace.ts` — `ensureUserWorkspace()` for auto-creation
