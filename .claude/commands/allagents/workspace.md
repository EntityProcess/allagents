---
name: AllAgents: Workspace
description: Manage allagents workspaces - init, sync, status, and modify
tags: "[allagents, workspace]"
---

# Allagents Workspace Command

Help the user manage their allagents workspace by running CLI commands and editing configuration.

## Subcommands

| Subcommand | Usage | Description |
|------------|-------|-------------|
| `init` | `allagents workspace init <path>` | Create new workspace from template |
| `sync` | `allagents workspace sync [--force] [--dry-run]` | Sync plugins to all repositories |
| `status` | `allagents workspace status` | Show plugin and client status |
| `add` | `allagents workspace add <plugin>` | Add a plugin (local path or GitHub URL) |
| `remove` | `allagents workspace remove <plugin>` | Remove a plugin from workspace |

## Sync Options

- `--force, -f` - Force re-fetch of remote plugins even if cached
- `--dry-run, -n` - Preview changes without making them

## What to Do

Based on user's request or provided arguments:

1. **No subcommand given**: Run `allagents workspace status` to show current state
2. **"init" subcommand**: Run `allagents workspace init <path>` with provided path
3. **"sync" subcommand**: Run `allagents workspace sync` with any flags
4. **"status" subcommand**: Run `allagents workspace status`
5. **"add" subcommand**: Run `allagents workspace add <plugin>` with provided plugin
6. **"remove" subcommand**: Run `allagents workspace remove <plugin>` with provided plugin

## workspace.yaml Structure

```yaml
repositories:
  - path: ../my-repo
    owner: github-owner
    repo: repo-name
    description: optional description

plugins:
  - ./local/plugin/path
  - https://github.com/owner/repo/tree/main/plugins/name

clients:
  - claude
  - copilot
  - opencode
```

## Tips

- Run `--dry-run` first to preview sync changes before applying
- Use `--force` to re-fetch cached GitHub plugins
- Always run `status` after configuration changes to verify resolution
