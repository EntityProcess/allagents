# User Scope Plugin Installation - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `--scope user` option to `allagents plugin install` that syncs plugins to user-level directories (`~/.claude/skills/`, `~/.codex/skills/`, etc.) instead of project-level directories.

**Architecture:** Create a user-level workspace config at `~/.allagents/workspace.yaml` that mirrors the project-level one. When `--scope user` is passed to install/uninstall, plugins are added to this user config. A new `syncUserWorkspace()` function syncs user-scoped plugins to user home directories using a `USER_CLIENT_MAPPINGS` that maps client types to their user-level paths (e.g., `~/.claude/skills/`). Sync state for user scope is stored at `~/.allagents/sync-state.json`.

**Tech Stack:** TypeScript, cmd-ts (CLI parsing), js-yaml, zod (validation), bun test

---

## Background

### Current Architecture

- Plugins are tracked in `.allagents/workspace.yaml` (project-level)
- `syncWorkspace()` copies skills to project-relative paths like `.claude/skills/`
- `CLIENT_MAPPINGS` in `src/models/client-mapping.ts` defines project-relative paths per client
- User-level `~/.allagents/` directory already exists for marketplace/plugin caches
- `getAllagentsDir()` in `src/core/marketplace.ts` returns `~/.allagents/`

### User-Level Client Paths (from dotagents reference)

| Client    | User Path                    |
|-----------|------------------------------|
| claude    | `~/.claude/`                 |
| copilot   | `~/.copilot/`                |
| codex     | `~/.codex/`                  |
| cursor    | `~/.cursor/`                 |
| opencode  | `~/.config/opencode/`        |
| gemini    | `~/.gemini/`                 |
| factory   | `~/.factory/`                |
| ampcode   | `~/.config/amp/`             |

### Key Files

- `src/models/client-mapping.ts` — Client path mappings
- `src/models/workspace-config.ts` — WorkspaceConfig zod schema
- `src/core/workspace-modify.ts` — `addPlugin()` / `removePlugin()`
- `src/core/sync.ts` — `syncWorkspace()` orchestration
- `src/core/sync-state.ts` — Sync state load/save
- `src/core/transform.ts` — `copyPluginToWorkspace()`, `copySkills()`
- `src/cli/commands/plugin.ts` — `plugin install` / `plugin uninstall` CLI commands
- `src/constants.ts` — `CONFIG_DIR`, `WORKSPACE_CONFIG_FILE`

---

### Task 1: Add User-Level Client Mappings

**Files:**
- Modify: `src/models/client-mapping.ts`
- Test: `tests/models/client-mapping.test.ts`

**Step 1: Write the failing test**

Create test file `tests/models/client-mapping.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { CLIENT_MAPPINGS, USER_CLIENT_MAPPINGS } from '../../src/models/client-mapping.js';

describe('USER_CLIENT_MAPPINGS', () => {
  test('defines user-level paths for all clients in CLIENT_MAPPINGS', () => {
    for (const client of Object.keys(CLIENT_MAPPINGS)) {
      expect(USER_CLIENT_MAPPINGS).toHaveProperty(client);
    }
  });

  test('claude uses ~/.claude/ paths', () => {
    expect(USER_CLIENT_MAPPINGS.claude.skillsPath).toBe('.claude/skills/');
    expect(USER_CLIENT_MAPPINGS.claude.commandsPath).toBe('.claude/commands/');
    expect(USER_CLIENT_MAPPINGS.claude.hooksPath).toBe('.claude/hooks/');
    expect(USER_CLIENT_MAPPINGS.claude.agentsPath).toBe('.claude/agents/');
  });

  test('copilot uses ~/.copilot/ paths', () => {
    expect(USER_CLIENT_MAPPINGS.copilot.skillsPath).toBe('.copilot/skills/');
  });

  test('codex uses ~/.codex/ paths', () => {
    expect(USER_CLIENT_MAPPINGS.codex.skillsPath).toBe('.codex/skills/');
  });

  test('opencode uses .config/opencode/ paths', () => {
    expect(USER_CLIENT_MAPPINGS.opencode.skillsPath).toBe('.config/opencode/skills/');
  });

  test('ampcode uses .config/amp/ paths', () => {
    expect(USER_CLIENT_MAPPINGS.ampcode.skillsPath).toBe('.config/amp/skills/');
  });

  test('user paths are relative to home directory (no leading /)', () => {
    for (const [, mapping] of Object.entries(USER_CLIENT_MAPPINGS)) {
      expect(mapping.skillsPath).not.toMatch(/^\//);
      if (mapping.commandsPath) expect(mapping.commandsPath).not.toMatch(/^\//);
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /home/christso/projects/allagents_feat-47-user-scope && bun test tests/models/client-mapping.test.ts`
Expected: FAIL — `USER_CLIENT_MAPPINGS` not exported

**Step 3: Write minimal implementation**

In `src/models/client-mapping.ts`, add below the existing `CLIENT_MAPPINGS`:

```typescript
/**
 * User-level client path mappings for all supported AI clients.
 * Paths are relative to the user's home directory (~/).
 * Used when plugins are installed with --scope user.
 */
export const USER_CLIENT_MAPPINGS: Record<ClientType, ClientMapping> = {
  claude: {
    commandsPath: '.claude/commands/',
    skillsPath: '.claude/skills/',
    agentsPath: '.claude/agents/',
    agentFile: 'CLAUDE.md',
    agentFileFallback: 'AGENTS.md',
    hooksPath: '.claude/hooks/',
  },
  copilot: {
    skillsPath: '.copilot/skills/',
    agentFile: 'AGENTS.md',
  },
  codex: {
    skillsPath: '.codex/skills/',
    agentFile: 'AGENTS.md',
  },
  cursor: {
    skillsPath: '.cursor/skills/',
    agentFile: 'AGENTS.md',
  },
  opencode: {
    skillsPath: '.config/opencode/skills/',
    agentFile: 'AGENTS.md',
  },
  gemini: {
    skillsPath: '.gemini/skills/',
    agentFile: 'GEMINI.md',
    agentFileFallback: 'AGENTS.md',
  },
  factory: {
    skillsPath: '.factory/skills/',
    agentFile: 'AGENTS.md',
    hooksPath: '.factory/hooks/',
  },
  ampcode: {
    skillsPath: '.config/amp/skills/',
    agentFile: 'AGENTS.md',
  },
};
```

**Step 4: Run test to verify it passes**

Run: `cd /home/christso/projects/allagents_feat-47-user-scope && bun test tests/models/client-mapping.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/models/client-mapping.ts tests/models/client-mapping.test.ts
git commit -m "feat(models): add user-level client path mappings"
```

---

### Task 2: Add User Workspace Config Management

**Files:**
- Create: `src/core/user-workspace.ts`
- Test: `tests/core/user-workspace.test.ts`

This module manages the user-level `~/.allagents/workspace.yaml` — creating it if it doesn't exist, adding/removing plugins, and reading the config.

**Step 1: Write the failing test**

Create `tests/core/user-workspace.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  addUserPlugin,
  removeUserPlugin,
  getUserWorkspaceConfig,
  ensureUserWorkspace,
} from '../../src/core/user-workspace.js';

describe('user-workspace', () => {
  let tempHome: string;
  let originalHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'allagents-test-'));
    originalHome = process.env.HOME || '';
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  describe('ensureUserWorkspace', () => {
    test('creates ~/.allagents/workspace.yaml if missing', async () => {
      await ensureUserWorkspace();
      const config = await getUserWorkspaceConfig();
      expect(config).toBeTruthy();
      expect(config!.plugins).toEqual([]);
      expect(config!.clients).toContain('claude');
    });

    test('does not overwrite existing config', async () => {
      await ensureUserWorkspace();
      await addUserPlugin('test-plugin@marketplace');
      await ensureUserWorkspace(); // call again
      const config = await getUserWorkspaceConfig();
      expect(config!.plugins).toContain('test-plugin@marketplace');
    });
  });

  describe('addUserPlugin', () => {
    test('adds plugin to user workspace.yaml', async () => {
      const result = await addUserPlugin('superpowers@obra/superpowers');
      expect(result.success).toBe(true);
      const config = await getUserWorkspaceConfig();
      expect(config!.plugins).toContain('superpowers@obra/superpowers');
    });

    test('rejects duplicate plugin', async () => {
      await addUserPlugin('superpowers@obra/superpowers');
      const result = await addUserPlugin('superpowers@obra/superpowers');
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });
  });

  describe('removeUserPlugin', () => {
    test('removes plugin from user workspace.yaml', async () => {
      await addUserPlugin('superpowers@obra/superpowers');
      const result = await removeUserPlugin('superpowers@obra/superpowers');
      expect(result.success).toBe(true);
      const config = await getUserWorkspaceConfig();
      expect(config!.plugins).not.toContain('superpowers@obra/superpowers');
    });

    test('returns error for non-existent plugin', async () => {
      const result = await removeUserPlugin('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /home/christso/projects/allagents_feat-47-user-scope && bun test tests/core/user-workspace.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `src/core/user-workspace.ts`:

```typescript
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { load, dump } from 'js-yaml';
import { WORKSPACE_CONFIG_FILE } from '../constants.js';
import type { WorkspaceConfig, ClientType } from '../models/workspace-config.js';
import { getAllagentsDir } from './marketplace.js';
import {
  isPluginSpec,
  resolvePluginSpecWithAutoRegister,
} from './marketplace.js';
import {
  validatePluginSource,
  isGitHubUrl,
  verifyGitHubUrlExists,
} from '../utils/plugin-path.js';
import type { ModifyResult } from './workspace-modify.js';

/**
 * All supported client types for user-scope installations.
 */
const ALL_CLIENTS: ClientType[] = [
  'claude', 'copilot', 'codex', 'cursor', 'opencode', 'gemini', 'factory', 'ampcode',
];

/**
 * Get path to user-level workspace config: ~/.allagents/workspace.yaml
 */
export function getUserWorkspaceConfigPath(): string {
  return join(getAllagentsDir(), WORKSPACE_CONFIG_FILE);
}

/**
 * Ensure user-level workspace.yaml exists with default config.
 * Creates it if missing, does not overwrite existing.
 */
export async function ensureUserWorkspace(): Promise<void> {
  const configPath = getUserWorkspaceConfigPath();
  if (existsSync(configPath)) return;

  const defaultConfig: WorkspaceConfig = {
    repositories: [],
    plugins: [],
    clients: [...ALL_CLIENTS],
  };

  await mkdir(getAllagentsDir(), { recursive: true });
  await writeFile(configPath, dump(defaultConfig, { lineWidth: -1 }), 'utf-8');
}

/**
 * Read user-level workspace config. Returns null if not found.
 */
export async function getUserWorkspaceConfig(): Promise<WorkspaceConfig | null> {
  const configPath = getUserWorkspaceConfigPath();
  if (!existsSync(configPath)) return null;

  try {
    const content = await readFile(configPath, 'utf-8');
    return load(content) as WorkspaceConfig;
  } catch {
    return null;
  }
}

/**
 * Add a plugin to the user-level workspace config.
 * Creates the config file if it doesn't exist.
 */
export async function addUserPlugin(plugin: string): Promise<ModifyResult> {
  await ensureUserWorkspace();
  const configPath = getUserWorkspaceConfigPath();

  // Handle plugin@marketplace format
  if (isPluginSpec(plugin)) {
    const resolved = await resolvePluginSpecWithAutoRegister(plugin);
    if (!resolved.success) {
      return { success: false, error: resolved.error || 'Unknown error' };
    }
    const normalizedPlugin = resolved.registeredAs
      ? plugin.replace(/@[^@]+$/, `@${resolved.registeredAs}`)
      : plugin;
    return addPluginToUserConfig(normalizedPlugin, configPath, resolved.registeredAs);
  }

  // Handle GitHub URL
  if (isGitHubUrl(plugin)) {
    const validation = validatePluginSource(plugin);
    if (!validation.valid) {
      return { success: false, error: validation.error || 'Invalid GitHub URL' };
    }
    const verifyResult = await verifyGitHubUrlExists(plugin);
    if (!verifyResult.exists) {
      return { success: false, error: verifyResult.error || `GitHub URL not found: ${plugin}` };
    }
  }

  return addPluginToUserConfig(plugin, configPath);
}

/**
 * Remove a plugin from the user-level workspace config.
 */
export async function removeUserPlugin(plugin: string): Promise<ModifyResult> {
  await ensureUserWorkspace();
  const configPath = getUserWorkspaceConfigPath();

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;

    let index = config.plugins.indexOf(plugin);
    if (index === -1) {
      index = config.plugins.findIndex(
        (p) => p.startsWith(`${plugin}@`) || p === plugin,
      );
    }

    if (index === -1) {
      return { success: false, error: `Plugin not found in user config: ${plugin}` };
    }

    config.plugins.splice(index, 1);
    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function addPluginToUserConfig(
  plugin: string,
  configPath: string,
  autoRegistered?: string,
): Promise<ModifyResult> {
  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;

    if (config.plugins.includes(plugin)) {
      return { success: false, error: `Plugin already exists in user config: ${plugin}` };
    }

    config.plugins.push(plugin);
    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
    return { success: true, ...(autoRegistered && { autoRegistered }) };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /home/christso/projects/allagents_feat-47-user-scope && bun test tests/core/user-workspace.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/user-workspace.ts tests/core/user-workspace.test.ts
git commit -m "feat(core): add user-level workspace config management"
```

---

### Task 3: Add User-Scope Sync Function

**Files:**
- Modify: `src/core/sync.ts`
- Test: `tests/core/sync-user.test.ts`

Add `syncUserWorkspace()` that syncs user-scoped plugins to `~/` using `USER_CLIENT_MAPPINGS`. This reuses the existing `validateAllPlugins`, `collectAllSkills`, `buildPluginSkillNameMaps`, and `copyValidatedPlugin` logic but targets user home as the workspace path and uses user client mappings.

**Step 1: Write the failing test**

Create `tests/core/sync-user.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dump } from 'js-yaml';
import { syncUserWorkspace } from '../../src/core/sync.js';
import type { WorkspaceConfig } from '../../src/models/workspace-config.js';

describe('syncUserWorkspace', () => {
  let tempHome: string;
  let originalHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'allagents-user-sync-'));
    originalHome = process.env.HOME || '';
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  test('returns early when no user workspace exists', async () => {
    const result = await syncUserWorkspace();
    expect(result.success).toBe(true);
    expect(result.pluginResults).toHaveLength(0);
  });

  test('syncs local plugin to user home directories', async () => {
    // Create a local plugin with a skill
    const pluginDir = join(tempHome, 'test-plugin');
    const skillDir = join(pluginDir, 'skills', 'my-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: my-skill\ndescription: Test\n---\nTest skill');

    // Create user workspace config pointing to the local plugin
    const config: WorkspaceConfig = {
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
    };
    const allagentsDir = join(tempHome, '.allagents');
    await mkdir(allagentsDir, { recursive: true });
    await writeFile(join(allagentsDir, 'workspace.yaml'), dump(config, { lineWidth: -1 }));

    const result = await syncUserWorkspace();
    expect(result.success).toBe(true);

    // Verify skill was synced to ~/.claude/skills/
    const skillPath = join(tempHome, '.claude', 'skills', 'my-skill');
    expect(existsSync(skillPath)).toBe(true);
  });

  test('syncs to multiple clients', async () => {
    // Create a local plugin with a skill
    const pluginDir = join(tempHome, 'test-plugin');
    const skillDir = join(pluginDir, 'skills', 'my-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: my-skill\ndescription: Test\n---\nTest skill');

    const config: WorkspaceConfig = {
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude', 'codex'],
    };
    const allagentsDir = join(tempHome, '.allagents');
    await mkdir(allagentsDir, { recursive: true });
    await writeFile(join(allagentsDir, 'workspace.yaml'), dump(config, { lineWidth: -1 }));

    const result = await syncUserWorkspace();
    expect(result.success).toBe(true);

    expect(existsSync(join(tempHome, '.claude', 'skills', 'my-skill'))).toBe(true);
    expect(existsSync(join(tempHome, '.codex', 'skills', 'my-skill'))).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /home/christso/projects/allagents_feat-47-user-scope && bun test tests/core/sync-user.test.ts`
Expected: FAIL — `syncUserWorkspace` not exported

**Step 3: Write minimal implementation**

Add to `src/core/sync.ts`. The key insight is that `syncUserWorkspace()` reuses the existing sync pipeline but:
1. Reads from `~/.allagents/workspace.yaml` instead of `.allagents/workspace.yaml`
2. Uses `USER_CLIENT_MAPPINGS` to determine target paths
3. Uses the user's home directory as the "workspace path" for file operations
4. Stores sync state at `~/.allagents/sync-state.json`

At the top of `src/core/sync.ts`, add the import:

```typescript
import { USER_CLIENT_MAPPINGS } from '../models/client-mapping.js';
import { getUserWorkspaceConfig, getUserWorkspaceConfigPath } from './user-workspace.js';
```

Add the `syncUserWorkspace` function. The approach is to temporarily override `CLIENT_MAPPINGS` lookup by passing a `clientMappings` option through to `copyPluginToWorkspace`, OR (simpler) to call `syncWorkspace` with the home directory as workspace path after swapping in user client mappings.

The cleanest approach: add a `clientMappings` option to `copyPluginToWorkspace` and `copyValidatedPlugin`. But to keep changes minimal, we can implement `syncUserWorkspace` as a wrapper that:
1. Reads user config
2. Calls the existing validation/collect/copy pipeline with `homedir` as workspace

However, `copyPluginToWorkspace` in `transform.ts` uses `CLIENT_MAPPINGS[client]` directly. To redirect paths, we either need to:
- (a) Add a parameter to pass custom mappings through, or
- (b) Copy plugin content using `USER_CLIENT_MAPPINGS` paths resolved against `homedir`

Option (b) is simpler — the user-scope sync function can call `copyPluginToWorkspace` with `homedir` as `workspacePath`, but it would use the project-level `CLIENT_MAPPINGS`. We need the user-level paths instead.

**The cleanest approach:** Add an optional `clientMappings` parameter to `copyPluginToWorkspace` in `transform.ts` that defaults to `CLIENT_MAPPINGS`. Then `syncUserWorkspace` passes `USER_CLIENT_MAPPINGS`.

In `src/core/transform.ts`, modify `copyPluginToWorkspace` signature:

```typescript
export async function copyPluginToWorkspace(
  pluginPath: string,
  workspacePath: string,
  client: ClientType,
  options: PluginCopyOptions & { clientMappings?: Record<ClientType, ClientMapping> } = {},
): Promise<CopyResult[]> {
  const { skillNameMap, clientMappings, ...baseOptions } = options;
  // Use provided mappings or fall back to default
  const mappings = clientMappings ?? CLIENT_MAPPINGS_DEFAULT;
  // ... rest of function uses mappings[client] instead of CLIENT_MAPPINGS[client]
```

Wait — looking more carefully at `transform.ts`, the individual `copySkills`, `copyCommands`, etc. functions each reference `CLIENT_MAPPINGS[client]` directly. To avoid modifying many internal functions, a simpler approach:

**Simplest approach:** `syncUserWorkspace` computes the absolute target paths itself and calls `copyPluginToWorkspace` with a synthetic workspace path that, combined with the existing relative `CLIENT_MAPPINGS` paths, lands in the right place.

Actually, the simplest correct approach is: **pass `clientMappings` through to `copyPluginToWorkspace` which passes it to each copy sub-function.** This is a small change.

Let me look at the copy functions to count how many need the change.

Looking at `transform.ts`: `copyCommands`, `copySkills`, `copyHooks`, `copyAgents` all take `(pluginPath, workspacePath, client, options)` and internally do `CLIENT_MAPPINGS[client].skillsPath` etc. Each needs an optional override.

**Revised approach — pass mappings through options:**

Modify `CopyOptions` interface in `transform.ts` to include optional `clientMappings`:

```typescript
export interface CopyOptions {
  dryRun?: boolean;
  clientMappings?: Record<ClientType, ClientMapping>;
}
```

Then in each function, use `options.clientMappings?.[client] ?? CLIENT_MAPPINGS[client]` to get the mapping. This is ~4 one-line changes in the copy functions.

Then `syncUserWorkspace`:

```typescript
export async function syncUserWorkspace(
  options: { offline?: boolean; dryRun?: boolean } = {},
): Promise<SyncResult> {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '~';
  const config = await getUserWorkspaceConfig();

  if (!config) {
    return {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
    };
  }

  const clients = config.clients;
  const { offline = false, dryRun = false } = options;

  // Validate plugins
  const validatedPlugins = await validateAllPlugins(config.plugins, homeDir, offline);
  const failedValidations = validatedPlugins.filter((v) => !v.success);
  if (failedValidations.length > 0) {
    const errors = failedValidations.map((v) => `  - ${v.plugin}: ${v.error}`).join('\n');
    return {
      success: false,
      pluginResults: failedValidations.map((v) => ({
        plugin: v.plugin, resolved: v.resolved, success: false, copyResults: [],
        ...(v.error && { error: v.error }),
      })),
      totalCopied: 0, totalFailed: failedValidations.length,
      totalSkipped: 0, totalGenerated: 0,
      error: `Plugin validation failed:\n${errors}`,
    };
  }

  // Load previous sync state from ~/.allagents/sync-state.json
  const previousState = await loadSyncState(resolve(homeDir, '.allagents', '..'));
  // (This needs adjustment — sync state is stored at ~/.allagents/sync-state.json
  //  but loadSyncState expects workspacePath and appends .allagents/sync-state.json)
  // So we pass homeDir as workspacePath — it will look for ~/.allagents/sync-state.json ✓

  const prevState = await loadSyncState(homeDir);

  if (!dryRun) {
    await selectivePurgeWorkspace(homeDir, prevState, clients, {
      partialSync: false,
      clientMappings: USER_CLIENT_MAPPINGS,
    });
  }

  // Two-pass skill name resolution
  const allSkills = await collectAllSkills(validatedPlugins);
  const pluginSkillMaps = buildPluginSkillNameMaps(allSkills);

  // Copy plugins using USER_CLIENT_MAPPINGS
  const pluginResults = await Promise.all(
    validatedPlugins.map((vp) => {
      const skillNameMap = pluginSkillMaps.get(vp.resolved);
      return copyValidatedPlugin(vp, homeDir, clients, dryRun, skillNameMap, USER_CLIENT_MAPPINGS);
    }),
  );

  // Save sync state
  // ... (aggregate files per client, save to homeDir)
}
```

This is getting complex. Let me structure the tasks more carefully.

---

**Revised plan structure for Task 3:**

Modify `src/core/transform.ts` to accept optional `clientMappings` in `CopyOptions`, then add `syncUserWorkspace` to `src/core/sync.ts`.

**Step 1: Write the failing test** (as above)

**Step 2: Run test to verify it fails**

**Step 3: Modify `src/core/transform.ts` — add `clientMappings` to `CopyOptions`**

In `src/core/transform.ts`, modify the `CopyOptions` interface:

```typescript
import type { ClientMapping } from '../models/client-mapping.js';

export interface CopyOptions {
  dryRun?: boolean;
  clientMappings?: Record<string, ClientMapping>;
}
```

Then in each of these functions, replace direct `CLIENT_MAPPINGS[client]` access with a helper:

```typescript
function getMapping(client: ClientType, options: CopyOptions = {}): ClientMapping {
  return (options.clientMappings as Record<ClientType, ClientMapping>)?.[client] ?? CLIENT_MAPPINGS[client];
}
```

Update `copyCommands`, `copySkills`, `copyHooks`, `copyAgents` to use `getMapping(client, options)` instead of `CLIENT_MAPPINGS[client]`.

Update `PluginCopyOptions` to inherit the new field.

**Step 4: Add `syncUserWorkspace` to `src/core/sync.ts`**

Add the function (see code above, with the `selectivePurgeWorkspace` also accepting `clientMappings`).

**Step 5: Run test to verify it passes**

**Step 6: Commit**

```bash
git add src/core/transform.ts src/core/sync.ts tests/core/sync-user.test.ts
git commit -m "feat(core): add user-scope sync with USER_CLIENT_MAPPINGS passthrough"
```

---

### Task 4: Add `--scope` CLI Option to `plugin install` and `plugin uninstall`

**Files:**
- Modify: `src/cli/commands/plugin.ts`
- Modify: `src/cli/metadata/plugin.ts`
- Test: `tests/cli/plugin-scope.test.ts`

**Step 1: Write the failing test**

Create `tests/cli/plugin-scope.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dump, load } from 'js-yaml';
import { execSync } from 'node:child_process';

describe('plugin install --scope', () => {
  let tempHome: string;
  let originalHome: string;
  let pluginDir: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'allagents-scope-'));
    originalHome = process.env.HOME || '';
    process.env.HOME = tempHome;

    // Create a local plugin with a skill
    pluginDir = join(tempHome, 'test-plugin');
    const skillDir = join(pluginDir, 'skills', 'test-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: test-skill\ndescription: A test skill\n---\nTest skill content',
    );
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  test('--scope user adds plugin to user config and syncs to home', async () => {
    // Note: This is an integration-level test. The exact invocation
    // depends on how the CLI is wired. We test the core functions directly.
    const { addUserPlugin } = await import('../../src/core/user-workspace.js');
    const { syncUserWorkspace } = await import('../../src/core/sync.js');

    const result = await addUserPlugin(pluginDir);
    expect(result.success).toBe(true);

    const syncResult = await syncUserWorkspace();
    expect(syncResult.success).toBe(true);
    expect(existsSync(join(tempHome, '.claude', 'skills', 'test-skill'))).toBe(true);
  });

  test('default scope (project) requires workspace.yaml', async () => {
    // Without --scope, install requires .allagents/workspace.yaml
    const { addPlugin } = await import('../../src/core/workspace-modify.js');
    const result = await addPlugin(pluginDir, tempHome);
    expect(result.success).toBe(false);
    expect(result.error).toContain('workspace.yaml not found');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /home/christso/projects/allagents_feat-47-user-scope && bun test tests/cli/plugin-scope.test.ts`
Expected: FAIL (syncUserWorkspace not exported yet — may pass if Task 3 done first)

**Step 3: Modify CLI commands**

In `src/cli/commands/plugin.ts`, modify `pluginInstallCmd` to accept `--scope`:

```typescript
import { addUserPlugin } from '../../core/user-workspace.js';
import { syncUserWorkspace } from '../../core/sync.js';

const pluginInstallCmd = command({
  name: 'install',
  description: buildDescription(pluginInstallMeta),
  args: {
    plugin: positional({ type: string, displayName: 'plugin' }),
    scope: option({
      type: optional(string),
      long: 'scope',
      short: 's',
      description: 'Installation scope: "project" (default) or "user"',
    }),
  },
  handler: async ({ plugin, scope }) => {
    try {
      const isUserScope = scope === 'user';

      const result = isUserScope
        ? await addUserPlugin(plugin)
        : await addPlugin(plugin);

      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin install', error: result.error ?? 'Unknown error' });
          process.exit(1);
        }
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      if (isJsonMode()) {
        const { ok, syncData } = isUserScope
          ? await runUserSyncAndPrint()
          : await runSyncAndPrint();
        jsonOutput({
          success: ok,
          command: 'plugin install',
          data: {
            plugin,
            scope: isUserScope ? 'user' : 'project',
            autoRegistered: result.autoRegistered ?? null,
            syncResult: syncData,
          },
          ...(!ok && { error: 'Sync completed with failures' }),
        });
        if (!ok) process.exit(1);
        return;
      }

      if (result.autoRegistered) {
        console.log(`✓ Auto-registered marketplace: ${result.autoRegistered}`);
      }
      console.log(`✓ Installed plugin (${isUserScope ? 'user' : 'project'} scope): ${plugin}`);

      const { ok: syncOk } = isUserScope
        ? await runUserSyncAndPrint()
        : await runSyncAndPrint();
      if (!syncOk) process.exit(1);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin install', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});
```

Add `runUserSyncAndPrint` helper (similar to `runSyncAndPrint` but calls `syncUserWorkspace`):

```typescript
async function runUserSyncAndPrint(): Promise<{ ok: boolean; syncData: ReturnType<typeof buildSyncData> | null }> {
  if (!isJsonMode()) {
    console.log('\nSyncing user workspace...\n');
  }
  const result = await syncUserWorkspace();

  if (!result.success && result.error) {
    if (!isJsonMode()) {
      console.error(`Sync error: ${result.error}`);
    }
    return { ok: false, syncData: null };
  }

  const syncData = buildSyncData(result);

  if (!isJsonMode()) {
    for (const pluginResult of result.pluginResults) {
      const status = pluginResult.success ? '✓' : '✗';
      console.log(`${status} Plugin: ${pluginResult.plugin}`);
      // ... same output logic as runSyncAndPrint
    }
    console.log('\nUser sync complete:');
    console.log(`  Total copied: ${result.totalCopied}`);
    if (result.totalFailed > 0) console.log(`  Total failed: ${result.totalFailed}`);
  }

  return { ok: result.success && result.totalFailed === 0, syncData };
}
```

Similarly modify `pluginUninstallCmd` to accept `--scope` and call `removeUserPlugin` + `syncUserWorkspace` when scope is "user".

**Step 4: Run tests to verify they pass**

Run: `cd /home/christso/projects/allagents_feat-47-user-scope && bun test`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/cli/commands/plugin.ts src/cli/metadata/plugin.ts tests/cli/plugin-scope.test.ts
git commit -m "feat(cli): add --scope user option to plugin install/uninstall"
```

---

### Task 5: Add `workspace sync --scope user` Support

**Files:**
- Modify: `src/cli/commands/workspace.ts`
- Test: `tests/cli/workspace-sync-scope.test.ts`

**Step 1: Write the failing test**

Create `tests/cli/workspace-sync-scope.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dump } from 'js-yaml';
import { syncUserWorkspace } from '../../src/core/sync.js';
import type { WorkspaceConfig } from '../../src/models/workspace-config.js';

describe('workspace sync --scope user', () => {
  let tempHome: string;
  let originalHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'allagents-ws-sync-'));
    originalHome = process.env.HOME || '';
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  test('syncs user plugins to home directories', async () => {
    const pluginDir = join(tempHome, 'test-plugin');
    const skillDir = join(pluginDir, 'skills', 'my-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: my-skill\ndescription: Test\n---\nContent');

    const config: WorkspaceConfig = {
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude', 'cursor'],
    };
    const allagentsDir = join(tempHome, '.allagents');
    await mkdir(allagentsDir, { recursive: true });
    await writeFile(join(allagentsDir, 'workspace.yaml'), dump(config, { lineWidth: -1 }));

    const result = await syncUserWorkspace();
    expect(result.success).toBe(true);

    expect(existsSync(join(tempHome, '.claude', 'skills', 'my-skill'))).toBe(true);
    expect(existsSync(join(tempHome, '.cursor', 'skills', 'my-skill'))).toBe(true);
  });

  test('purges previously synced user files on re-sync', async () => {
    const pluginDir = join(tempHome, 'test-plugin');
    const skillDir = join(pluginDir, 'skills', 'old-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: old-skill\ndescription: Test\n---\nContent');

    const config: WorkspaceConfig = {
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
    };
    const allagentsDir = join(tempHome, '.allagents');
    await mkdir(allagentsDir, { recursive: true });
    await writeFile(join(allagentsDir, 'workspace.yaml'), dump(config, { lineWidth: -1 }));

    // First sync
    await syncUserWorkspace();
    expect(existsSync(join(tempHome, '.claude', 'skills', 'old-skill'))).toBe(true);

    // Remove the plugin and re-sync
    config.plugins = [];
    await writeFile(join(allagentsDir, 'workspace.yaml'), dump(config, { lineWidth: -1 }));
    await syncUserWorkspace();

    // Old skill should be purged
    expect(existsSync(join(tempHome, '.claude', 'skills', 'old-skill'))).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /home/christso/projects/allagents_feat-47-user-scope && bun test tests/cli/workspace-sync-scope.test.ts`

**Step 3: Add `--scope` option to workspace sync command**

In `src/cli/commands/workspace.ts`, add `--scope` option to the sync command:

```typescript
scope: option({
  type: optional(string),
  long: 'scope',
  short: 's',
  description: 'Sync scope: "project" (default) or "user"',
}),
```

In the handler, when `scope === 'user'`, call `syncUserWorkspace()` instead of `syncWorkspace()`.

**Step 4: Run tests to verify they pass**

Run: `cd /home/christso/projects/allagents_feat-47-user-scope && bun test`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/cli/commands/workspace.ts tests/cli/workspace-sync-scope.test.ts
git commit -m "feat(cli): add --scope user option to workspace sync"
```

---

### Task 6: Add `selectivePurgeWorkspace` Support for User Mappings

**Files:**
- Modify: `src/core/sync.ts` (the `selectivePurgeWorkspace` function)
- Already tested by Task 5's purge test

The existing `selectivePurgeWorkspace` uses `CLIENT_MAPPINGS` to determine which directories to clean. For user scope, it needs to use `USER_CLIENT_MAPPINGS` and target `~/` as root.

**Step 1: Verify purge test from Task 5 fails**

The purge test in Task 5 should drive this change.

**Step 2: Add `clientMappings` option to `selectivePurgeWorkspace`**

In `src/core/sync.ts`, modify `selectivePurgeWorkspace` to accept optional `clientMappings`:

```typescript
interface PurgeOptions {
  partialSync?: boolean;
  clientMappings?: Record<string, ClientMapping>;
}

async function selectivePurgeWorkspace(
  workspacePath: string,
  previousState: SyncState | null,
  clients: ClientType[],
  options: PurgeOptions = {},
): Promise<void> {
  // Use provided mappings or default
  const mappings = options.clientMappings ?? CLIENT_MAPPINGS;
  // ... rest uses mappings[client] instead of CLIENT_MAPPINGS[client]
}
```

**Step 3: Run tests**

Run: `cd /home/christso/projects/allagents_feat-47-user-scope && bun test`
Expected: All tests PASS (including purge test from Task 5)

**Step 4: Commit**

```bash
git add src/core/sync.ts
git commit -m "feat(core): support custom client mappings in selectivePurgeWorkspace"
```

---

### Task 7: E2E Testing with Real Plugin Repos

**Files:**
- Test: `tests/e2e/user-scope.test.ts`

**Step 1: Write E2E test**

Create `tests/e2e/user-scope.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addUserPlugin } from '../../src/core/user-workspace.js';
import { addPlugin } from '../../src/core/workspace-modify.js';
import { syncUserWorkspace, syncWorkspace } from '../../src/core/sync.js';
import { initWorkspace } from '../../src/core/workspace.js';

describe('E2E: user scope vs project scope', () => {
  let tempHome: string;
  let tempProject: string;
  let originalHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'allagents-e2e-home-'));
    tempProject = await mkdtemp(join(tmpdir(), 'allagents-e2e-proj-'));
    originalHome = process.env.HOME || '';
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
    await rm(tempProject, { recursive: true, force: true });
  });

  test('user scope installs plugin from obra/superpowers', async () => {
    const result = await addUserPlugin('superpowers@obra/superpowers');
    expect(result.success).toBe(true);

    const syncResult = await syncUserWorkspace();
    expect(syncResult.success).toBe(true);
    expect(syncResult.totalCopied).toBeGreaterThan(0);

    // Verify skills exist in user home
    expect(existsSync(join(tempHome, '.claude', 'skills'))).toBe(true);
    const skills = await readdir(join(tempHome, '.claude', 'skills'));
    expect(skills.length).toBeGreaterThan(0);
  });

  test('project scope installs plugin from claude-plugins-official', async () => {
    // Init a workspace first
    await initWorkspace(tempProject);

    const result = await addPlugin('code-review@claude-plugins-official', tempProject);
    expect(result.success).toBe(true);

    const syncResult = await syncWorkspace(tempProject);
    expect(syncResult.success).toBe(true);

    // Verify skills exist in project directory
    expect(existsSync(join(tempProject, '.claude', 'skills'))).toBe(true);
  });

  test('user and project scope do not interfere', async () => {
    // Install user-scoped plugin
    await addUserPlugin('superpowers@obra/superpowers');
    await syncUserWorkspace();

    // Init project and install project-scoped plugin
    await initWorkspace(tempProject);
    await addPlugin('code-review@claude-plugins-official', tempProject);
    await syncWorkspace(tempProject);

    // User skills in home dir
    expect(existsSync(join(tempHome, '.claude', 'skills'))).toBe(true);

    // Project skills in project dir
    expect(existsSync(join(tempProject, '.claude', 'skills'))).toBe(true);
  });
});
```

**Step 2: Run E2E tests**

Run: `cd /home/christso/projects/allagents_feat-47-user-scope && bun test tests/e2e/user-scope.test.ts`

Note: These tests require network access (GitHub). They may need `--timeout 30000` or similar.

**Step 3: Fix any issues discovered**

**Step 4: Commit**

```bash
git add tests/e2e/user-scope.test.ts
git commit -m "test(e2e): add user scope vs project scope integration tests"
```

---

### Task 8: Run Full Test Suite and Verify No Regressions

**Step 1: Run all tests**

Run: `cd /home/christso/projects/allagents_feat-47-user-scope && bun test`
Expected: All 399+ tests PASS

**Step 2: Fix any regressions**

The `clientMappings` passthrough in `transform.ts` should be backward-compatible since it defaults to `CLIENT_MAPPINGS`.

**Step 3: Final commit if any fixes needed**

---

### Task 9: Push Branch and Create PR

**Step 1: Push the branch**

```bash
cd /home/christso/projects/allagents_feat-47-user-scope
git push -u origin feat/47-user-scope-install
```

**Step 2: Create PR**

```bash
gh pr create --title "feat: support user scope plugin installation" --body "$(cat <<'EOF'
## Summary
- Add `--scope user` option to `allagents plugin install` and `allagents plugin uninstall`
- Add `--scope user` option to `allagents workspace sync`
- User-scoped plugins are stored in `~/.allagents/workspace.yaml`
- User-scoped skills sync to user home directories (`~/.claude/skills/`, `~/.codex/skills/`, etc.)
- Default behavior (`--scope project`) is unchanged

Closes #47

## Test plan
- [ ] Unit tests for `USER_CLIENT_MAPPINGS`
- [ ] Unit tests for user workspace config management (add/remove/ensure)
- [ ] Unit tests for `syncUserWorkspace()` (sync to home, multi-client, purge)
- [ ] Integration tests for `--scope user` install/uninstall flow
- [ ] E2E tests with real plugin repos (obra/superpowers, claude-plugins-official)
- [ ] Verify no regressions in existing 399 tests

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
