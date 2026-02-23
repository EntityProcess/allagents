# Install Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `claude-native` client type with `install: native` on client entries, cleanly separating client identity from installation mechanism.

**Architecture:** Add `InstallMode` and `ClientEntry` types to workspace config schema. Thread normalized client entries through the sync pipeline, splitting plugins into file-based and native lists. Native sync reuses the CLI module from PR #156. Sync state tracks native plugins per-client.

**Tech Stack:** TypeScript, Zod schemas, bun:test

---

### Task 1: Schema — Add InstallMode, ClientEntry, and update PluginEntry

**Files:**
- Modify: `src/models/workspace-config.ts`

**Step 1: Write the failing test**

Create `tests/unit/models/workspace-config-install-mode.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import {
  InstallModeSchema,
  ClientEntrySchema,
  WorkspaceConfigSchema,
  normalizeClientEntry,
  getClientTypes,
  getClientInstallMode,
  getPluginInstallMode,
  resolveInstallMode,
} from '../../../src/models/workspace-config.js';

describe('InstallModeSchema', () => {
  it('accepts file and native', () => {
    expect(InstallModeSchema.parse('file')).toBe('file');
    expect(InstallModeSchema.parse('native')).toBe('native');
  });

  it('rejects invalid values', () => {
    expect(() => InstallModeSchema.parse('other')).toThrow();
  });
});

describe('ClientEntrySchema', () => {
  it('accepts string shorthand', () => {
    expect(ClientEntrySchema.parse('claude')).toBe('claude');
  });

  it('accepts object form with install mode', () => {
    const result = ClientEntrySchema.parse({ name: 'claude', install: 'native' });
    expect(result).toEqual({ name: 'claude', install: 'native' });
  });

  it('defaults install to file when omitted', () => {
    const result = ClientEntrySchema.parse({ name: 'claude' });
    expect(result).toEqual({ name: 'claude', install: 'file' });
  });
});

describe('normalizeClientEntry', () => {
  it('normalizes string shorthand to object with file mode', () => {
    expect(normalizeClientEntry('claude')).toEqual({ name: 'claude', install: 'file' });
  });

  it('normalizes object entry preserving install mode', () => {
    expect(normalizeClientEntry({ name: 'claude', install: 'native' }))
      .toEqual({ name: 'claude', install: 'native' });
  });
});

describe('getClientTypes', () => {
  it('extracts unique client types from mixed entries', () => {
    const entries = ['copilot', { name: 'claude' as const, install: 'native' as const }, 'universal'];
    expect(getClientTypes(entries)).toEqual(['copilot', 'claude', 'universal']);
  });
});

describe('getClientInstallMode', () => {
  it('returns native for native client entry', () => {
    const entries = ['copilot', { name: 'claude' as const, install: 'native' as const }];
    expect(getClientInstallMode(entries, 'claude')).toBe('native');
  });

  it('returns file for string shorthand client', () => {
    const entries = ['copilot', { name: 'claude' as const, install: 'native' as const }];
    expect(getClientInstallMode(entries, 'copilot')).toBe('file');
  });

  it('returns file for unknown client', () => {
    expect(getClientInstallMode([], 'claude')).toBe('file');
  });
});

describe('getPluginInstallMode', () => {
  it('returns undefined for string shorthand plugin', () => {
    expect(getPluginInstallMode('my-plugin')).toBeUndefined();
  });

  it('returns undefined when install not set on object plugin', () => {
    expect(getPluginInstallMode({ source: 'my-plugin' })).toBeUndefined();
  });

  it('returns native when set on plugin', () => {
    expect(getPluginInstallMode({ source: 'my-plugin', install: 'native' })).toBe('native');
  });

  it('returns file when set on plugin', () => {
    expect(getPluginInstallMode({ source: 'my-plugin', install: 'file' })).toBe('file');
  });
});

describe('resolveInstallMode', () => {
  it('plugin-level overrides client-level', () => {
    expect(resolveInstallMode(
      { source: 'x', install: 'file' },
      { name: 'claude', install: 'native' },
    )).toBe('file');
  });

  it('falls back to client install mode', () => {
    expect(resolveInstallMode(
      { source: 'x' },
      { name: 'claude', install: 'native' },
    )).toBe('native');
  });

  it('defaults to file', () => {
    expect(resolveInstallMode('x', { name: 'claude', install: 'file' })).toBe('file');
  });
});

describe('WorkspaceConfigSchema with client entries', () => {
  it('parses mixed string and object clients', () => {
    const config = WorkspaceConfigSchema.parse({
      repositories: [],
      plugins: [],
      clients: ['copilot', { name: 'claude', install: 'native' }],
    });
    expect(config.clients).toEqual(['copilot', { name: 'claude', install: 'native' }]);
  });

  it('parses plugin entry with install override', () => {
    const config = WorkspaceConfigSchema.parse({
      repositories: [],
      plugins: [{ source: 'my-plugin', install: 'file' }],
      clients: ['claude'],
    });
    expect(config.plugins[0]).toEqual({ source: 'my-plugin', install: 'file' });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/unit/models/workspace-config-install-mode.test.ts`
Expected: FAIL — imports don't exist yet

**Step 3: Write minimal implementation**

In `src/models/workspace-config.ts`, add after the `ClientTypeSchema` definition (after line 93):

```typescript
/**
 * Installation mode for plugins
 * - 'file': Copy plugin files to client directories (default)
 * - 'native': Use client's native CLI to install (e.g., `claude plugin install`)
 */
export const InstallModeSchema = z.enum(['file', 'native']);
export type InstallMode = z.infer<typeof InstallModeSchema>;

/**
 * Client entry — string shorthand or object with install mode.
 * String "claude" is equivalent to { name: "claude", install: "file" }.
 */
export const ClientEntrySchema = z.union([
  ClientTypeSchema,
  z.object({
    name: ClientTypeSchema,
    install: InstallModeSchema.default('file'),
  }),
]);
export type ClientEntry = z.infer<typeof ClientEntrySchema>;
```

Update `PluginEntrySchema` to add `install`:

```typescript
export const PluginEntrySchema = z.union([
  PluginSourceSchema,
  z.object({
    source: PluginSourceSchema,
    clients: z.array(ClientTypeSchema).optional(),
    install: InstallModeSchema.optional(),
  }),
]);
```

Update `WorkspaceConfigSchema.clients`:

```typescript
clients: z.array(ClientEntrySchema),  // was z.array(ClientTypeSchema)
```

Add helper functions (after `getPluginClients`):

```typescript
/**
 * Get plugin-level install mode override (if any)
 */
export function getPluginInstallMode(plugin: PluginEntry): InstallMode | undefined {
  return typeof plugin === 'string' ? undefined : plugin.install;
}

/**
 * Normalize a client entry to { name, install } form.
 */
export function normalizeClientEntry(entry: ClientEntry): { name: ClientType; install: InstallMode } {
  if (typeof entry === 'string') {
    return { name: entry, install: 'file' };
  }
  return { name: entry.name, install: entry.install ?? 'file' };
}

/**
 * Extract unique ClientType values from client entries.
 */
export function getClientTypes(entries: ClientEntry[]): ClientType[] {
  return entries.map((e) => (typeof e === 'string' ? e : e.name));
}

/**
 * Get install mode for a specific client from entries.
 * Returns 'file' if client not found.
 */
export function getClientInstallMode(entries: ClientEntry[], client: ClientType): InstallMode {
  for (const entry of entries) {
    const normalized = normalizeClientEntry(entry);
    if (normalized.name === client) return normalized.install;
  }
  return 'file';
}

/**
 * Resolve effective install mode for a (plugin, client) pair.
 * Priority: plugin-level > client-level > 'file' default.
 */
export function resolveInstallMode(
  pluginEntry: PluginEntry,
  clientEntry: { name: ClientType; install: InstallMode },
): InstallMode {
  const pluginMode = getPluginInstallMode(pluginEntry);
  if (pluginMode) return pluginMode;
  return clientEntry.install;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/unit/models/workspace-config-install-mode.test.ts`
Expected: PASS

**Step 5: Run existing tests to verify no regressions**

Run: `bun test`
Expected: Some tests may fail because `config.clients` is now `ClientEntry[]` instead of `ClientType[]`. That's expected and will be fixed in subsequent tasks.

**Step 6: Commit**

```bash
git add src/models/workspace-config.ts tests/unit/models/workspace-config-install-mode.test.ts
git commit -m "feat(schema): add InstallMode, ClientEntry types and helpers"
```

---

### Task 2: Schema — Update sync state for per-client native tracking

**Files:**
- Modify: `src/models/sync-state.ts`
- Modify: `src/core/sync-state.ts`

**Step 1: Write the failing test**

Create `tests/unit/core/sync-state-native.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  saveSyncState,
  loadSyncState,
  getPreviouslySyncedNativePlugins,
} from '../../../src/core/sync-state.js';

describe('sync state — native plugins', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-state-native-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('saves and loads native plugins per-client', async () => {
    await saveSyncState(testDir, {
      files: {},
      nativePlugins: { claude: ['superpowers@superpowers-marketplace'] },
    });

    const state = await loadSyncState(testDir);
    expect(state).not.toBeNull();
    expect(state!.nativePlugins).toEqual({ claude: ['superpowers@superpowers-marketplace'] });
  });

  it('omits nativePlugins from state when empty', async () => {
    await saveSyncState(testDir, { files: {} });

    const raw = await readFile(join(testDir, '.allagents', 'sync-state.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.nativePlugins).toBeUndefined();
  });

  it('getPreviouslySyncedNativePlugins returns empty for no state', () => {
    expect(getPreviouslySyncedNativePlugins(null, 'claude')).toEqual([]);
  });

  it('getPreviouslySyncedNativePlugins returns plugins for given client', async () => {
    await saveSyncState(testDir, {
      files: {},
      nativePlugins: { claude: ['a@b', 'c@d'] },
    });
    const state = await loadSyncState(testDir);
    expect(getPreviouslySyncedNativePlugins(state, 'claude')).toEqual(['a@b', 'c@d']);
  });

  it('getPreviouslySyncedNativePlugins returns empty for other client', async () => {
    await saveSyncState(testDir, {
      files: {},
      nativePlugins: { claude: ['a@b'] },
    });
    const state = await loadSyncState(testDir);
    expect(getPreviouslySyncedNativePlugins(state, 'copilot')).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/unit/core/sync-state-native.test.ts`
Expected: FAIL — `getPreviouslySyncedNativePlugins` doesn't exist, `nativePlugins` not in schema

**Step 3: Write minimal implementation**

In `src/models/sync-state.ts`, add `nativePlugins` field:

```typescript
export const SyncStateSchema = z.object({
  version: z.literal(1),
  lastSync: z.string(),
  files: z.record(ClientTypeSchema, z.array(z.string())),
  mcpServers: z.record(z.string(), z.array(z.string())).optional(),
  nativePlugins: z.record(ClientTypeSchema, z.array(z.string())).optional(),
});
```

In `src/core/sync-state.ts`, update `SyncStateData` and add helper:

```typescript
export interface SyncStateData {
  files: Partial<Record<ClientType, string[]>>;
  mcpServers?: Partial<Record<McpScope, string[]>>;
  nativePlugins?: Partial<Record<ClientType, string[]>>;
}
```

Update `saveSyncState` to include `nativePlugins`:

```typescript
const state: SyncState = {
  version: 1,
  lastSync: new Date().toISOString(),
  files: normalizedData.files as Record<ClientType, string[]>,
  ...(normalizedData.mcpServers && { mcpServers: normalizedData.mcpServers }),
  ...(normalizedData.nativePlugins && { nativePlugins: normalizedData.nativePlugins }),
};
```

Add helper function:

```typescript
/**
 * Get native plugins previously installed for a specific client
 */
export function getPreviouslySyncedNativePlugins(
  state: SyncState | null,
  client: ClientType,
): string[] {
  if (!state?.nativePlugins) return [];
  return state.nativePlugins[client] ?? [];
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/unit/core/sync-state-native.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/models/sync-state.ts src/core/sync-state.ts tests/unit/core/sync-state-native.test.ts
git commit -m "feat(sync-state): add per-client native plugin tracking"
```

---

### Task 3: Add claude-native.ts core module (from PR #156)

**Files:**
- Create: `src/core/claude-native.ts`
- Create: `tests/unit/core/claude-native.test.ts`

**Step 1: Write the test**

Create `tests/unit/core/claude-native.test.ts` (taken from PR #156):

```typescript
import { describe, expect, test } from 'bun:test';
import {
  toClaudePluginSpec,
  extractMarketplaceSource,
} from '../../../src/core/claude-native.js';

describe('claude-native', () => {
  describe('toClaudePluginSpec', () => {
    test('converts marketplace spec with owner/repo to plugin@repo', () => {
      expect(toClaudePluginSpec('superpowers@obra/superpowers-marketplace')).toBe(
        'superpowers@superpowers-marketplace',
      );
    });

    test('preserves plugin@marketplace format', () => {
      expect(toClaudePluginSpec('superpowers@superpowers-marketplace')).toBe(
        'superpowers@superpowers-marketplace',
      );
    });

    test('returns null for direct GitHub paths', () => {
      expect(
        toClaudePluginSpec('vercel-labs/agent-browser/skills/agent-browser'),
      ).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(toClaudePluginSpec('')).toBeNull();
    });

    test('returns null for trailing slash in marketplace', () => {
      expect(toClaudePluginSpec('plugin@owner/')).toBeNull();
    });
  });

  describe('extractMarketplaceSource', () => {
    test('extracts owner/repo from marketplace spec', () => {
      expect(
        extractMarketplaceSource('superpowers@obra/superpowers-marketplace'),
      ).toBe('obra/superpowers-marketplace');
    });

    test('returns null for non-marketplace specs', () => {
      expect(
        extractMarketplaceSource('vercel-labs/agent-browser/skills/agent-browser'),
      ).toBeNull();
    });

    test('returns null for plain marketplace name', () => {
      expect(
        extractMarketplaceSource('superpowers@superpowers-marketplace'),
      ).toBeNull();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/unit/core/claude-native.test.ts`
Expected: FAIL — module doesn't exist

**Step 3: Create the module**

Create `src/core/claude-native.ts` — the full content from PR #156 (see the diff above for complete code). This includes:
- `executeClaudeCommand()` — shell out to `claude` CLI
- `isClaudeCliAvailable()` — check if CLI exists
- `addMarketplace()`, `installPlugin()`, `uninstallPlugin()`, `listInstalledPlugins()`
- `extractMarketplaceSource()`, `toClaudePluginSpec()` — spec conversion
- `syncNativePlugins()` — orchestrate marketplace registration + install
- `NativeSyncResult` type

**Step 4: Run test to verify it passes**

Run: `bun test tests/unit/core/claude-native.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/claude-native.ts tests/unit/core/claude-native.test.ts
git commit -m "feat(native): add claude CLI integration module"
```

---

### Task 4: Update sync pipeline — thread install mode through buildPluginSyncPlans

**Files:**
- Modify: `src/core/sync.ts` (lines 192-202, 789-805)

**Step 1: Write the failing test**

Create `tests/unit/core/sync-install-mode.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncWorkspace } from '../../../src/core/sync.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';

async function createPlugin(baseDir: string, name: string, skillName: string): Promise<string> {
  const pluginDir = join(baseDir, name);
  const skillDir = join(pluginDir, 'skills', skillName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${skillName}\ndescription: test\n---\n`);
  return pluginDir;
}

describe('syncWorkspace — install mode', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-install-mode-'));
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('file-only clients work as before with string shorthand', async () => {
    await createPlugin(testDir, 'test-plugin', 'test-skill');
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `repositories: []\nplugins:\n  - ./test-plugin\nclients:\n  - claude\n  - copilot\n`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    expect(existsSync(join(testDir, '.claude', 'skills', 'test-skill'))).toBe(true);
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill'))).toBe(true);
  });

  it('native-only client skips file copy for that client', async () => {
    await createPlugin(testDir, 'test-plugin', 'test-skill');
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `repositories: []\nplugins:\n  - ./test-plugin\nclients:\n  - name: claude\n    install: native\n  - copilot\n`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    // Claude native: no files copied to .claude/
    expect(existsSync(join(testDir, '.claude', 'skills', 'test-skill'))).toBe(false);
    // Copilot file: files copied to .github/
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill'))).toBe(true);
  });

  it('plugin-level install:file overrides client native', async () => {
    await createPlugin(testDir, 'test-plugin', 'test-skill');
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `repositories: []\nplugins:\n  - source: ./test-plugin\n    install: file\nclients:\n  - name: claude\n    install: native\n`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    // Plugin forces file mode, so files are copied to .claude/ despite native client
    expect(existsSync(join(testDir, '.claude', 'skills', 'test-skill'))).toBe(true);
  });

  it('non-marketplace plugin with native client falls back to file copy', async () => {
    await createPlugin(testDir, 'local-plugin', 'local-skill');
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `repositories: []\nplugins:\n  - ./local-plugin\nclients:\n  - name: claude\n    install: native\n`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    // Non-marketplace plugin can't install natively, falls back to file
    expect(existsSync(join(testDir, '.claude', 'skills', 'local-skill'))).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/unit/core/sync-install-mode.test.ts`
Expected: FAIL — workspace config parsing fails because `clients` with object entries isn't handled in sync yet, or native-only test fails because files still get copied

**Step 3: Update sync.ts**

This is the core change. Several functions need updating:

**3a. Update `PluginSyncPlan` interface** (line ~192):

```typescript
interface PluginSyncPlan {
  source: string;
  clients: ClientType[];
  /** Clients that should use native install for this plugin */
  nativeClients: ClientType[];
}
```

**3b. Update `collectSyncClients`** (line ~197):

```typescript
function collectSyncClients(
  clientEntries: ClientEntry[],
  plans: PluginSyncPlan[],
): ClientType[] {
  const workspaceClientTypes = getClientTypes(clientEntries);
  return [...new Set([...workspaceClientTypes, ...plans.flatMap((plan) => [...plan.clients, ...plan.nativeClients])])];
}
```

**3c. Update `buildPluginSyncPlans`** (line ~789):

```typescript
function buildPluginSyncPlans(
  plugins: PluginEntry[],
  clientEntries: ClientEntry[],
  selectedClients?: ClientType[],
): PluginSyncPlan[] {
  const selected = selectedClients ? new Set(selectedClients) : null;
  const workspaceClientTypes = getClientTypes(clientEntries);

  return plugins.map((plugin) => {
    const source = getPluginSource(plugin);
    const pluginClientTypes = getPluginClients(plugin) ?? workspaceClientTypes;
    const effectiveClients = selected
      ? pluginClientTypes.filter((c) => selected.has(c))
      : pluginClientTypes;

    // Check if plugin source is marketplace-based (can be installed natively)
    const isMarketplace = toClaudePluginSpec(source) !== null;

    // Split into file and native clients based on resolved install mode
    const fileClients: ClientType[] = [];
    const nativeClients: ClientType[] = [];

    for (const client of effectiveClients) {
      const clientEntry = normalizeClientEntry(
        clientEntries.find((e) =>
          (typeof e === 'string' ? e : e.name) === client
        ) ?? client
      );
      const mode = resolveInstallMode(plugin, clientEntry);

      if (mode === 'native' && isMarketplace) {
        nativeClients.push(client);
      } else {
        // Non-marketplace plugins always fall back to file, even if mode is native
        fileClients.push(client);
      }
    }

    return { source, clients: fileClients, nativeClients };
  });
}
```

**3d. Update `syncWorkspace`** — client extraction and native sync step.

At line ~1114, update client filtering to work with `ClientEntry[]`:

```typescript
const workspaceClients = options.clients
  ? config.clients.filter((c) => {
      const name = typeof c === 'string' ? c : c.name;
      return options.clients?.includes(name);
    })
  : config.clients;
```

At line ~1120, update availableClients to extract ClientType from entries:

```typescript
const availableClients = new Set<ClientType>(getClientTypes(config.clients));
```

At line ~1142-1148, update buildPluginSyncPlans call:

```typescript
const selectedClients = options.clients as ClientType[] | undefined;
const pluginPlans = buildPluginSyncPlans(
  config.plugins,
  config.clients,      // now ClientEntry[]
  selectedClients,
).filter((plan) => plan.clients.length > 0 || plan.nativeClients.length > 0);
const syncClients = collectSyncClients(workspaceClients, pluginPlans);
```

Update `validateAllPlugins` to carry `nativeClients` through `ValidatedPlugin`:

```typescript
// In ValidatedPlugin interface, add:
nativeClients: ClientType[];
```

Update the call at line ~1154:

```typescript
const validatedPlugins = await validateAllPlugins(pluginPlans, workspacePath, offline);
```

And update `validateAllPlugins` (line ~814):

```typescript
async function validateAllPlugins(
  plans: PluginSyncPlan[],
  workspacePath: string,
  offline: boolean,
): Promise<ValidatedPlugin[]> {
  return Promise.all(
    plans.map(async ({ source, clients, nativeClients }) => {
      const validated = await validatePlugin(source, workspacePath, offline);
      return { ...validated, clients, nativeClients };
    }),
  );
}
```

After the file-based copy step (after line ~1251), before step 5 (workspace files), add native sync:

```typescript
// Step 4b: Native CLI installations
let nativeResult: NativeSyncResult | undefined;
const nativePluginsByClient = new Map<ClientType, string[]>();

for (const vp of validPlugins) {
  for (const client of vp.nativeClients) {
    const existing = nativePluginsByClient.get(client) ?? [];
    existing.push(vp.plugin);
    nativePluginsByClient.set(client, existing);
  }
}

if (nativePluginsByClient.size > 0) {
  if (!dryRun) {
    const cliAvailable = await isClaudeCliAvailable();
    if (cliAvailable) {
      // Uninstall previously-synced native plugins that are no longer configured
      for (const [client, sources] of nativePluginsByClient) {
        const currentSpecs = sources
          .map((s) => toClaudePluginSpec(s))
          .filter((s): s is string => s !== null);
        const previousPlugins = getPreviouslySyncedNativePlugins(previousState, client);
        const removed = previousPlugins.filter((p) => !currentSpecs.includes(p));
        for (const plugin of removed) {
          await uninstallPlugin(plugin, 'project', { cwd: workspacePath });
        }
      }

      // Install native plugins (currently only claude supported)
      const allNativeSources = [...new Set(
        Array.from(nativePluginsByClient.values()).flat()
      )];
      nativeResult = await syncNativePlugins(allNativeSources, 'project', {
        cwd: workspacePath,
      });
    } else {
      warnings.push('Native install: claude CLI not found, skipping native plugin installation');
    }
  } else {
    const allNativeSources = [...new Set(
      Array.from(nativePluginsByClient.values()).flat()
    )];
    nativeResult = await syncNativePlugins(allNativeSources, 'project', {
      cwd: workspacePath,
      dryRun: true,
    });
  }
}
```

Update save state (line ~1387) to include native plugins:

```typescript
// Build native plugin tracking per-client
const nativePluginsState: Partial<Record<ClientType, string[]>> = {};
if (nativeResult) {
  for (const [client] of nativePluginsByClient) {
    nativePluginsState[client] = nativeResult.pluginsInstalled;
  }
}

// When syncing a subset of clients that excludes native clients, preserve previous state
if (options.clients && previousState?.nativePlugins) {
  for (const [client, plugins] of Object.entries(previousState.nativePlugins)) {
    if (!syncClients.includes(client as ClientType)) {
      nativePluginsState[client as ClientType] = plugins;
    }
  }
}

await saveSyncState(workspacePath, {
  files: syncedFiles,
  ...(Object.keys(nativePluginsState).length > 0 && { nativePlugins: nativePluginsState }),
});
```

Update return value to include `nativeResult`:

```typescript
return {
  success: !hasFailures,
  pluginResults,
  totalCopied,
  totalFailed,
  totalSkipped,
  totalGenerated,
  purgedPaths,
  ...(warnings.length > 0 && { warnings }),
  ...(nativeResult && { nativeResult }),
};
```

Update `SyncResult` interface to include `nativeResult`:

```typescript
export interface SyncResult {
  // ...existing fields...
  nativeResult?: NativeSyncResult;
}
```

Update `mergeSyncResults` to merge `nativeResult`:

```typescript
const nativeResult = a.nativeResult ?? b.nativeResult;
// ...include in return
...(nativeResult && { nativeResult }),
```

Add imports at the top of sync.ts:

```typescript
import { syncNativePlugins, isClaudeCliAvailable, uninstallPlugin, toClaudePluginSpec, type NativeSyncResult } from './claude-native.js';
import {
  type ClientEntry,
  getClientTypes,
  normalizeClientEntry,
  resolveInstallMode,
  getPluginInstallMode,
} from '../models/workspace-config.js';
```

Also import `getPreviouslySyncedNativePlugins` from sync-state.

**Step 4: Run test to verify it passes**

Run: `bun test tests/unit/core/sync-install-mode.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `bun test`
Expected: Fix any regressions from the `config.clients` type change.

**Step 6: Commit**

```bash
git add src/core/sync.ts tests/unit/core/sync-install-mode.test.ts
git commit -m "feat(sync): thread install mode through sync pipeline"
```

---

### Task 5: Update syncUserWorkspace for install mode

**Files:**
- Modify: `src/core/sync.ts` (lines 1428-1556)

**Step 1: Apply same pattern as syncWorkspace**

The changes mirror Task 4 but for `syncUserWorkspace`:
- Extract client types from `config.clients` (now `ClientEntry[]`)
- Pass `config.clients` to `buildPluginSyncPlans`
- Add native sync step after file copy
- Save native plugins per-client in state

**Step 2: Run full test suite**

Run: `bun test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/core/sync.ts
git commit -m "feat(sync): add native install support to user workspace sync"
```

---

### Task 6: Update workspace-modify and user-workspace for ClientEntry

**Files:**
- Modify: `src/core/workspace-modify.ts` (lines 27-67)
- Modify: `src/core/user-workspace.ts` (lines 36-45, 372-390)
- Modify: `src/core/status.ts` (line 38, 85)

**Step 1: Update workspace-modify.ts**

Change `setClients` signature and `DEFAULT_PROJECT_CLIENTS`:

```typescript
import type { ClientEntry, ClientType } from '../models/workspace-config.js';

const DEFAULT_PROJECT_CLIENTS: ClientEntry[] = ['claude', 'copilot', 'codex', 'opencode'];

export async function setClients(
  clients: ClientEntry[],
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> { /* ... */ }
```

Also update `ensureWorkspace` default config:

```typescript
const defaultConfig: WorkspaceConfig = {
  repositories: [],
  plugins: [],
  clients: DEFAULT_PROJECT_CLIENTS,
};
```

**Step 2: Update user-workspace.ts**

Change `setUserClients` and `DEFAULT_USER_CLIENTS`:

```typescript
const DEFAULT_USER_CLIENTS: ClientEntry[] = [
  'copilot', 'codex', 'cursor', 'opencode', 'gemini',
  'factory', 'ampcode', 'vscode',
];

export async function setUserClients(
  clients: ClientEntry[],
): Promise<ModifyResult> { /* ... */ }
```

**Step 3: Update status.ts**

Change `WorkspaceStatusResult.clients` to `ClientEntry[]` or `string[]`. Since this is a display-oriented type, keep it as `string[]` for compatibility and extract client names:

```typescript
// Line 85 in getWorkspaceStatus:
clients: getClientTypes(config.clients),
```

Import `getClientTypes` from workspace-config.

**Step 4: Update existing tests**

In `tests/unit/core/workspace-modify-clients.test.ts`, the tests pass `ClientType[]` strings to `setClients` which is still valid since `ClientEntry` accepts strings. No changes needed if types align.

**Step 5: Run full test suite**

Run: `bun test`
Expected: PASS

**Step 6: Commit**

```bash
git add src/core/workspace-modify.ts src/core/user-workspace.ts src/core/status.ts
git commit -m "refactor: update workspace-modify and status for ClientEntry type"
```

---

### Task 7: Update CLI output formatting

**Files:**
- Modify: `src/cli/format-sync.ts`
- Modify: `src/cli/commands/plugin.ts`
- Modify: `src/cli/commands/workspace.ts`
- Modify: `src/cli/tui/actions/sync.ts`

**Step 1: Add formatNativeResult to format-sync.ts**

```typescript
import type { NativeSyncResult } from '../core/claude-native.js';

export function formatNativeResult(nativeResult: NativeSyncResult): string[] {
  const lines: string[] = [];
  if (nativeResult.marketplacesAdded.length > 0) {
    lines.push(`Marketplaces registered: ${nativeResult.marketplacesAdded.join(', ')}`);
  }
  for (const plugin of nativeResult.pluginsInstalled) {
    lines.push(`  + ${plugin} (installed via native CLI)`);
  }
  for (const { plugin, error } of nativeResult.pluginsFailed) {
    lines.push(`  ✗ ${plugin}: ${error}`);
  }
  for (const plugin of nativeResult.skipped) {
    lines.push(`  ⊘ ${plugin} (skipped — not a marketplace plugin)`);
  }
  return lines;
}
```

Update `buildSyncData` to include native results:

```typescript
...(result.nativeResult && {
  nativePlugins: {
    installed: result.nativeResult.pluginsInstalled,
    failed: result.nativeResult.pluginsFailed,
    skipped: result.nativeResult.skipped,
    marketplacesAdded: result.nativeResult.marketplacesAdded,
  },
}),
```

**Step 2: Update CLI commands**

In `plugin.ts` (`runSyncAndPrint` and `runUserSyncAndPrint`), add after MCP result printing:

```typescript
if (result.nativeResult) {
  const nativeLines = formatNativeResult(result.nativeResult);
  if (nativeLines.length > 0) {
    console.log('\nnative:');
    for (const line of nativeLines) {
      console.log(line);
    }
  }
}
```

Same pattern in `workspace.ts` (`syncCmd`) and `tui/actions/sync.ts`.

**Step 3: Run full test suite**

Run: `bun test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/cli/format-sync.ts src/cli/commands/plugin.ts src/cli/commands/workspace.ts src/cli/tui/actions/sync.ts
git commit -m "feat(cli): display native install results in sync output"
```

---

### Task 8: Update TUI client management for ClientEntry

**Files:**
- Modify: `src/cli/tui/actions/clients.ts`
- Modify: `src/cli/tui/actions/init.ts`

**Step 1: Update clients.ts**

The TUI multiselect works with `ClientType` strings. When reading current clients from config, extract types. When saving, pass string array (which is valid `ClientEntry[]`):

```typescript
import { getClientTypes } from '../../../models/workspace-config.js';

// When reading:
currentClients = getClientTypes(status.clients ?? []);

// When saving (selectedClients is already ClientType[]):
const result = await setClients(selectedClients, workspacePath);
```

Wait — `status.clients` is now `string[]` (from Task 6 where we used `getClientTypes`). So no change needed for reading.

For writing, `setClients` accepts `ClientEntry[]` and `string[]` satisfies that (strings are valid `ClientEntry`). So TUI client management should work without changes.

**Step 2: Review init.ts**

Same pattern — TUI multiselect returns `ClientType[]` strings, which are valid `ClientEntry[]`. No changes needed.

**Step 3: Run full test suite**

Run: `bun test`
Expected: PASS

**Step 4: Commit (if changes needed)**

```bash
git add src/cli/tui/actions/clients.ts src/cli/tui/actions/init.ts
git commit -m "refactor(tui): update client management for ClientEntry type"
```

---

### Task 9: Update workspace.yaml example and docs

**Files:**
- Create: `examples/workspaces/native-install/.allagents/workspace.yaml`
- Modify: existing example if relevant

**Step 1: Create native install example**

```yaml
# Example: Native plugin installation with install mode
#
# This workspace demonstrates using `install: native` on client entries
# to install plugins via the client's native CLI instead of copying files.
#
# Usage:
#   allagents workspace sync

repositories: []

plugins:
  - source: superpowers@obra/superpowers-marketplace

clients:
  - copilot
  - name: claude
    install: native
```

**Step 2: Commit**

```bash
git add examples/workspaces/native-install/
git commit -m "docs: add native install example workspace"
```

---

### Task 10: Close PR #156 and final integration test

**Step 1: Run full test suite**

Run: `bun test`
Expected: ALL PASS

**Step 2: Build and manual E2E test**

```bash
bun run build && ./dist/index.js
```

Test with the example workspace:
```bash
cd examples/workspaces/native-install
../../../dist/index.js workspace sync
```

**Step 3: Close PR #156**

```bash
gh pr close 156 --comment "Superseded by install mode approach — see new PR"
```

**Step 4: Push branch and create PR**

```bash
git push -u origin feat/install-mode
gh pr create --title "feat(install-mode): native plugin install via client entries" \
  --body "$(cat <<'EOF'
Closes #141

Replaces PR #156's `claude-native` client type with `install: native` on client entries.

## Summary
- Adds `InstallMode` (`file` | `native`) and `ClientEntry` (string | object) types
- Client entries support object form: `{ name: claude, install: native }`
- Plugin entries support `install` override for per-plugin control
- Native install falls back to file-based for non-marketplace plugins
- Sync state tracks native plugins per-client
- Reuses claude CLI module from PR #156

## YAML example
```yaml
clients:
  - copilot
  - name: claude
    install: native
plugins:
  - source: superpowers@obra/superpowers-marketplace  # native on claude, file on copilot
  - source: ./my-local-skill                          # file-based for all (can't install natively)
```

## Test plan
- [ ] Unit tests for schema (InstallMode, ClientEntry, helpers)
- [ ] Unit tests for sync state native tracking
- [ ] Unit tests for install mode resolution in sync pipeline
- [ ] Full test suite passes (all existing tests)
- [ ] Manual E2E with example workspace
EOF
)"
```
