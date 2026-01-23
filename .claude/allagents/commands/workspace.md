---
name: workspace
description: Manage allagents workspaces - init, sync, status, and modify
allowed-tools:
  - Bash
  - Read
  - Write
---

# Allagents Workspace Command

You are helping the user manage their allagents workspace.

## Available Commands

Run these via `allagents` CLI:

- `allagents workspace init <path>` - Create a new workspace from template
- `allagents workspace sync` - Sync plugins to all repositories (use `--force` to overwrite, `--dry-run` to preview)
- `allagents workspace status` - Show current plugin and client status
- `allagents workspace add <plugin>` - Add a plugin (local path or GitHub URL)
- `allagents workspace remove <plugin>` - Remove a plugin from workspace

## Workflow

1. Initialize: `allagents workspace init my-workspace`
2. Configure: Edit `workspace.yaml` to add repositories, plugins, and clients
3. Sync: `allagents workspace sync` to copy plugin content to all repos

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

- Use `--dry-run` to preview sync changes before applying
- Use `--force` to overwrite existing files during sync
- Check `allagents workspace status` to verify plugin resolution
