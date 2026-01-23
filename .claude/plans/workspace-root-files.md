# Implementation Plan: Workspace Root Files

## Summary

Add explicit `workspace.files` configuration to copy arbitrary files to workspace root. Remove implicit agent file copying from plugins.

## Problem

1. Users want to copy root-level files (CLAUDE.md, AGENTS.md, .cursorrules) from a source folder to workspace root
2. Currently, agent files are implicitly copied from plugins - but if multiple plugins have AGENTS.md, last-write-wins (undefined behavior)
3. No way to copy arbitrary files, only agent files

## Solution

- Add `workspace` block to workspace.yaml with explicit file mappings
- Remove implicit agent file copying from plugins entirely
- Plugins only provide: commands, skills, hooks

---

## Schema Change

**File:** `src/models/workspace-config.ts`

```typescript
const WorkspaceFileSchema = z.union([
  z.string(), // shorthand: "CLAUDE.md"
  z.object({
    source: z.string(),
    dest: z.string().optional(), // defaults to basename
  }),
]);

const WorkspaceSchema = z.object({
  source: z.string(), // local path, GitHub URL, or plugin@marketplace
  files: z.array(WorkspaceFileSchema),
});

const WorkspaceConfigSchema = z.object({
  workspace: WorkspaceSchema.optional(),
  repositories: z.array(RepositorySchema),
  plugins: z.array(PluginSourceSchema),
  clients: z.array(ClientTypeSchema),
});
```

---

## YAML Examples

```yaml
# Shorthand - source and dest are the same
workspace:
  source: ../my-config
  files:
    - CLAUDE.md
    - AGENTS.md
    - .cursorrules

# Explicit mapping - when source path differs from dest
workspace:
  source: ../my-config
  files:
    - source: docs/CLAUDE.md
      dest: CLAUDE.md
    - source: config/.cursorrules
      dest: .cursorrules
    - AGENTS.md  # shorthand mixed with explicit
```

### Source Types

`workspace.source` supports same formats as plugins:

```yaml
# Local path
workspace:
  source: ../my-config-folder

# GitHub URL
workspace:
  source: https://github.com/owner/repo/tree/main/config

# Plugin marketplace spec
workspace:
  source: workspace-config@owner/repo
```

---

## Code Changes

### 1. Update schema

**File:** `src/models/workspace-config.ts`

Add `WorkspaceFileSchema` and `WorkspaceSchema` as shown above. Make `workspace` optional in `WorkspaceConfigSchema` for backward compatibility.

### 2. Remove agent file copying from plugins

**File:** `src/core/transform.ts`

Remove `copyAgentFile` call from `copyPluginToWorkspace`:

```typescript
export async function copyPluginToWorkspace(
  pluginPath: string,
  workspacePath: string,
  client: ClientType,
  options: CopyOptions = {},
): Promise<CopyResult[]> {
  const [commandResults, skillResults, hookResults] = await Promise.all([
    copyCommands(pluginPath, workspacePath, client, options),
    copySkills(pluginPath, workspacePath, client, options),
    copyHooks(pluginPath, workspacePath, client, options),
    // REMOVED: copyAgentFile(pluginPath, workspacePath, client, options),
  ]);

  return [...commandResults, ...skillResults, ...hookResults];
}
```

Delete or keep `copyAgentFile` and `getSourceAgentFile` functions (can delete if not used elsewhere).

### 3. Add workspace files copying

**File:** `src/core/transform.ts`

```typescript
import type { WorkspaceFile } from '../models/workspace-config.js';

/**
 * Normalize workspace file entry to explicit form
 */
function normalizeWorkspaceFile(file: string | { source: string; dest?: string }): { source: string; dest: string } {
  if (typeof file === 'string') {
    return { source: file, dest: file };
  }
  return {
    source: file.source,
    dest: file.dest ?? file.source.split('/').pop()!, // basename
  };
}

/**
 * Copy workspace files from source to workspace root
 */
export async function copyWorkspaceFiles(
  sourcePath: string,
  workspacePath: string,
  files: WorkspaceFile[],
  options: CopyOptions = {},
): Promise<CopyResult[]> {
  const { dryRun = false } = options;
  const results: CopyResult[] = [];

  for (const file of files) {
    const normalized = normalizeWorkspaceFile(file);
    const srcPath = join(sourcePath, normalized.source);
    const destPath = join(workspacePath, normalized.dest);

    if (!existsSync(srcPath)) {
      results.push({
        source: srcPath,
        destination: destPath,
        action: 'failed',
        error: `Source file not found: ${srcPath}`,
      });
      continue;
    }

    if (dryRun) {
      results.push({ source: srcPath, destination: destPath, action: 'copied' });
      continue;
    }

    try {
      const content = await readFile(srcPath, 'utf-8');
      await writeFile(destPath, content, 'utf-8');
      results.push({ source: srcPath, destination: destPath, action: 'copied' });
    } catch (error) {
      results.push({
        source: srcPath,
        destination: destPath,
        action: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return results;
}
```

### 4. Update sync flow

**File:** `src/core/sync.ts`

Add workspace source validation and file copying:

```typescript
export async function syncWorkspace(
  workspacePath: string = process.cwd(),
  options: SyncOptions = {},
): Promise<SyncResult> {
  // ... existing config parsing ...

  // Step 1: Validate all plugins (existing)
  const validatedPlugins = await validateAllPlugins(config.plugins, workspacePath, force);

  // Step 1b: Validate workspace.source if defined (NEW)
  let validatedWorkspaceSource: ValidatedPlugin | null = null;
  if (config.workspace?.source) {
    validatedWorkspaceSource = await validatePlugin(config.workspace.source, workspacePath, force);
    if (!validatedWorkspaceSource.success) {
      return {
        success: false,
        pluginResults: [],
        totalCopied: 0,
        totalFailed: 1,
        totalSkipped: 0,
        totalGenerated: 0,
        error: `Workspace source validation failed: ${validatedWorkspaceSource.error}`,
      };
    }
  }

  // Step 2: Check plugin validation failures (existing)
  // ...

  // Step 3: Purge (existing)
  // ...

  // Step 4: Copy plugin content (existing)
  // ...

  // Step 5: Copy workspace files (NEW)
  let workspaceFileResults: CopyResult[] = [];
  if (config.workspace && validatedWorkspaceSource) {
    workspaceFileResults = await copyWorkspaceFiles(
      validatedWorkspaceSource.resolved,
      workspacePath,
      config.workspace.files,
      { dryRun },
    );
  }

  // Update totals to include workspace file results
  for (const result of workspaceFileResults) {
    switch (result.action) {
      case 'copied': totalCopied++; break;
      case 'failed': totalFailed++; break;
      case 'skipped': totalSkipped++; break;
    }
  }

  // ... rest of existing logic ...
}
```

### 5. Update purge logic

**File:** `src/core/sync.ts`

Keep existing agent file purging in `purgeWorkspace`. Files get repopulated from `workspace.files` if defined.

### 6. Update default template

**File:** `src/templates/default/workspace.yaml`

```yaml
# Workspace root files (optional)
# workspace:
#   source: ./path/to/config  # local path, GitHub URL, or plugin@marketplace
#   files:
#     - CLAUDE.md
#     - AGENTS.md

repositories: []

plugins: []

clients:
  - claude
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/models/workspace-config.ts` | Add `WorkspaceSchema`, `WorkspaceFileSchema` |
| `src/core/transform.ts` | Remove agent copy from `copyPluginToWorkspace`, add `copyWorkspaceFiles` |
| `src/core/sync.ts` | Validate & copy workspace.files, update result totals |
| `src/templates/default/workspace.yaml` | Add commented workspace example |

---

## Breaking Changes

- Plugins' `AGENTS.md`/`CLAUDE.md` no longer auto-copied to workspace root
- Users must add `workspace:` block to copy root files
- No deprecation warning - clean break

---

## Not in Scope

- Merging files from multiple sources
- Default files list (must be explicit)
- Complex destination transforms (only basename extraction)
