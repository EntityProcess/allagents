# Lifecycle Hooks Example

This workspace demonstrates the `lifecycleHooks.preSync` escape hatch for
installing runtime prerequisites that AllAgents cannot sync as agent artifacts.

## What it does

Before syncing plugin artifacts, AllAgents runs each `preSync` script in order:

1. `install-agent-tui` - installs the `agent-tui` binary (if not already present)
2. `install-bd` - installs the `bd` (Beads) CLI (if not already present)

Both scripts use an idempotency marker stored under `.allagents/` to avoid
re-downloading on every sync.

## Security

Lifecycle scripts are arbitrary local commands. **Review any script from a
plugin or template before enabling it in your workspace.** Only the workspace
owner can opt into running these scripts -- they are never silently executed.

## Environment

Scripts run in the workspace root and receive:

| Variable | Value |
|---|---|
| `ALLAGENTS_WORKSPACE` | Absolute path to the workspace root |
| `ALLAGENTS_CONFIG_DIR` | Absolute path to `.allagents/` |

## Usage

```bash
# Copy this example to a new workspace
allagents workspace init my-workspace --from examples/workspaces/lifecycle-hooks

# Run sync (lifecycle hooks execute before plugin copy)
cd my-workspace && allagents update

# Dry-run (shows what scripts would run, does not execute)
allagents update --dry-run
```

## Optional scripts

Mark a script as `optional: true` to continue sync even if it fails:

```yaml
lifecycleHooks:
  preSync:
    - name: nice-to-have
      script: ./optional-setup.sh
      optional: true
```

A required (default) script failure aborts the sync before any filesystem mutation.
