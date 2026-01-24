# Plan: Non-Destructive Sync with State Tracking

## Problem

Currently `allagents sync` uses a destructive approach:
1. Purges ALL managed directories (`rm -rf .claude/commands/`, etc.)
2. Copies fresh from plugins

This breaks existing workspaces with user-created files alongside plugin content.

## Solution

Track which files allagents syncs in a state file. Only purge files we previously created.

**Model:**
| File type | Behavior |
|-----------|----------|
| Files in sync-state | Purge and recreate |
| User files (not in state) | Leave alone |
| Agent files (CLAUDE.md, AGENTS.md) | Merge: preserve user content, update WORKSPACE-RULES section |

## Implementation

### 1. Create State Model (`src/models/sync-state.ts`) - NEW

```typescript
export interface SyncState {
  version: 1;
  lastSync: string;  // ISO timestamp
  files: Record<ClientType, string[]>;  // per-client file list
}
```

### 2. Create State Utilities (`src/core/sync-state.ts`) - NEW

- `getSyncStatePath(workspacePath)` → `.allagents/sync-state.json`
- `loadSyncState(workspacePath)` → `SyncState | null`
- `saveSyncState(workspacePath, files)` → writes state file
- `getPreviouslySyncedFiles(state, client)` → `string[]`

### 3. Add Selective Purge (`src/core/sync.ts`) - MODIFY

Add `selectivePurgeWorkspace()` function:
- Takes previous state
- If no state (first sync), skip purge entirely
- Otherwise, only delete files listed in state
- Use `unlink()` for files, `rmdir()` for empty directories
- Clean up empty parent directories after deletion

### 4. Fix WORKSPACE-RULES Injection (`src/core/transform.ts`) - MODIFY

Current code (line 463): `appendFile(targetPath, WORKSPACE_RULES)` - NOT idempotent

Fix: Add `injectWorkspaceRules(filePath)` function:
- Read file content
- If markers exist (`<!-- WORKSPACE-RULES:START -->...END -->`): replace between markers
- If no markers: append with markers
- Idempotent - safe to run multiple times

Update `copyWorkspaceFiles()` to use new function instead of `appendFile()`.

### 5. Track Files During Copy (`src/core/sync.ts`) - MODIFY

Add `collectSyncedPaths()` function:
- Extract destination paths from `CopyResult[]`
- Group by client based on path prefix (`.claude/` → claude, `.github/` → copilot)
- Handle skill directories (track with trailing `/`)

### 6. Update Main Sync Flow (`src/core/sync.ts:syncWorkspace`) - MODIFY

```
Before:
  validate → purge ALL → copy → commit

After:
  validate → load state → selective purge → copy → save state → commit
```

Key changes at lines 419-424:
- Load previous state before purge
- Replace `purgeWorkspace()` with `selectivePurgeWorkspace()`
- After successful copy, call `saveSyncState()`

### 7. Add Constant (`src/constants.ts`) - MODIFY

```typescript
export const SYNC_STATE_FILE = 'sync-state.json';
```

## Files to Modify

| File | Change |
|------|--------|
| `src/models/sync-state.ts` | NEW - State schema with Zod |
| `src/core/sync-state.ts` | NEW - Load/save state utilities |
| `src/core/sync.ts` | Add selective purge, update sync flow |
| `src/core/transform.ts` | Fix idempotent WORKSPACE-RULES injection |
| `src/constants.ts` | Add SYNC_STATE_FILE constant |
| `tests/unit/core/sync-state.test.ts` | NEW - State utilities tests |
| `tests/unit/core/sync.test.ts` | Add non-destructive sync tests |

## Edge Cases

1. **First sync on existing workspace**: No state file → skip purge → overlay only
2. **Corrupted state file**: Treat as no state → safe behavior
3. **Skill directories**: Track with trailing `/` to distinguish from files
4. **Plugin removed from config**: Its files purged on next sync (in state)
5. **User adds file after sync**: Not in state → preserved

## Verification

1. **Unit tests**: Run `bun test tests/unit/core/sync-state.test.ts`
2. **Integration test**:
   ```bash
   # Create workspace with user file
   mkdir -p test-ws/.claude/commands
   echo "# User" > test-ws/.claude/commands/user.md
   echo "# Plugin" > test-ws/.claude/commands/plugin.md

   # Create workspace.yaml with empty plugins
   mkdir test-ws/.allagents
   echo "repositories: []\nplugins: []\nclients: [claude]" > test-ws/.allagents/workspace.yaml

   # First sync - should preserve user.md
   allagents workspace sync test-ws
   ls test-ws/.claude/commands/  # user.md should exist

   # Check state file created
   cat test-ws/.allagents/sync-state.json
   ```
3. **WORKSPACE-RULES idempotency**:
   ```bash
   # Run sync twice on same workspace
   allagents workspace sync test-ws
   allagents workspace sync test-ws

   # Check CLAUDE.md has exactly ONE WORKSPACE-RULES section
   grep -c "WORKSPACE-RULES:START" test-ws/CLAUDE.md  # Should be 1
   ```
