# Declarative Workspace Sync

## Problem

When a plugin is removed from `workspace.yaml`, its files remain in `.claude/` and other managed directories. Users must manually delete orphaned files.

## Solution

Make `workspace.yaml` the single source of truth. On every sync:

1. **Validate** - Fetch/verify all plugins are available
2. **Purge** - Delete all managed directories
3. **Copy** - Re-sync fresh from declared plugins

## Sync Behavior

```
allagents workspace sync
```

### Step 1: Validate All Plugins

Before any destructive action, verify all plugins in `workspace.yaml` are accessible:
- Local paths exist
- GitHub repos can be fetched/are cached
- Marketplace plugins resolve

If any plugin fails validation, abort sync with error. Workspace remains unchanged.

### Step 2: Purge Managed Directories

For each client in `workspace.yaml`, delete:

| Client | Purged |
|--------|--------|
| claude | `.claude/commands/`, `.claude/skills/`, `.claude/hooks/`, `CLAUDE.md` |
| copilot | `.github/copilot-instructions.md` |
| opencode | `AGENTS.md` |
| codex | `AGENTS.md` |

### Step 3: Copy Fresh

Copy content from all plugins as normal.

## User Expectations

- `workspace.yaml` is the only source of truth
- Custom commands/skills must be in a plugin (local or remote) listed in `workspace.yaml`
- Every sync produces identical results given the same `workspace.yaml`

## Example: Local Customizations

Users wanting custom commands create a local plugin:

```
my-workspace/
  workspace.yaml
  local-plugin/
    commands/
      my-custom-command.md
```

```yaml
# workspace.yaml
plugins:
  - superpowers@obra/superpowers
  - ./local-plugin  # Custom commands here
```

## Implementation

### Changes to `sync.ts`

1. Add `purgeWorkspace(workspacePath, clients)` function
2. Call purge after successful plugin validation, before copying
3. Purge only directories for configured clients

### Purge Function

```typescript
async function purgeWorkspace(
  workspacePath: string,
  clients: ClientType[]
): Promise<void> {
  for (const client of clients) {
    const mapping = CLIENT_MAPPINGS[client];

    // Purge commands directory
    if (mapping.commandsPath) {
      await rm(join(workspacePath, mapping.commandsPath), { recursive: true, force: true });
    }

    // Purge skills directory
    if (mapping.skillsPath) {
      await rm(join(workspacePath, mapping.skillsPath), { recursive: true, force: true });
    }

    // Purge hooks directory
    if (mapping.hooksPath) {
      await rm(join(workspacePath, mapping.hooksPath), { recursive: true, force: true });
    }

    // Purge agent file
    const agentPath = join(workspacePath, mapping.agentFile);
    if (existsSync(agentPath)) {
      await rm(agentPath);
    }
  }
}
```

### Updated Sync Flow

```typescript
export async function syncWorkspace(...) {
  // 1. Parse config
  const config = await parseWorkspaceConfig(configPath);

  // 2. Validate all plugins (fetch if needed, verify paths)
  const validationResults = await validateAllPlugins(config.plugins, options);
  if (validationResults.some(r => !r.success)) {
    return { success: false, error: 'Plugin validation failed', ... };
  }

  // 3. Purge managed directories (only after validation succeeds)
  if (!dryRun) {
    await purgeWorkspace(workspacePath, config.clients);
  }

  // 4. Copy fresh from all plugins
  const pluginResults = await Promise.all(...);

  // 5. Git commit if successful
  ...
}
```

## Future Considerations (Not in scope)

- `.claude/local/` convention for sync-immune files (add only if users request)
- Manifest tracking for granular control (add only if needed)
- `--no-purge` flag for additive sync (add only if needed)

## Decision Log

- **No manifest**: YAGNI. Purge-and-rebuild is simpler and achieves same result.
- **Purge after validation**: Avoids leaving workspace broken if plugin fetch fails.
- **No local file preservation**: Users can create local plugins for customizations.
