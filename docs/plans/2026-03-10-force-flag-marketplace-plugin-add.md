# `--force` Flag for Marketplace and Plugin Add Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `--force` flag to `plugin marketplace add` and `plugin add` commands to replace existing entries instead of erroring, enabling idempotent script automation.

**Architecture:** Extend existing `addMarketplace()` and `addPlugin()` functions with an optional `force` parameter. When true, skip existence/duplicate checks and replace the entry. Update command handlers to accept the flag and pass it to core functions. Return a `replaced` field in results to signal updates occurred.

**Tech Stack:** TypeScript, cmd-ts (CLI framework), YAML configuration, existing test framework (bun:test)

---

## Task 1: Update `addMarketplace()` to support force parameter

**Files:**
- Modify: `src/core/marketplace.ts:236-310` (addMarketplace function and MarketplaceResult type)

**Step 1: Add force parameter and update return type**

Update the function signature and result type:

```typescript
// In MarketplaceResult type (find around line 50-60)
interface MarketplaceResult {
  success: boolean;
  error?: string;
  replaced?: boolean;  // Add this field
  location?: string;
}

// Update function signature at line 236
export async function addMarketplace(
  source: string,
  customName?: string,
  branch?: string,
  force?: boolean,  // Add this parameter
): Promise<MarketplaceResult> {
```

**Step 2: Update the duplicate check logic**

Find the existing marketplace check (around line 273-276):

```typescript
  // OLD CODE (keep this structure but modify):
  // Check if already registered by name
  if (registry.marketplaces[name]) {
    return {
      success: false,
      error: `Marketplace '${name}' already exists. Use 'update' to refresh it.`,
    };
  }

  // NEW CODE: Replace with this
  // Check if already registered by name
  if (registry.marketplaces[name]) {
    if (!force) {
      return {
        success: false,
        error: `Marketplace '${name}' already exists. Use 'update' to refresh it.`,
      };
    }
    // With force=true, we'll overwrite it below
  }
```

**Step 3: Update registry save to include replaced flag**

Find where the marketplace is added to the registry (look for `registry.marketplaces[name] = ...`). After the assignment, return success with `replaced: true` if it already existed:

```typescript
  // After adding/updating the marketplace in registry
  const wasReplaced = registry.marketplaces[name] !== undefined;
  registry.marketplaces[name] = { ... }; // existing code

  // When returning success, add replaced flag:
  return {
    success: true,
    replaced: wasReplaced && force,
    location: clonedPath,
  };
```

**Step 4: Run tests to verify changes don't break existing behavior**

Run: `bun test src/core/marketplace.test.ts`
Expected: All existing tests pass

**Step 5: Commit**

```bash
git add src/core/marketplace.ts
git commit -m "feat(marketplace): add force parameter to addMarketplace"
```

---

## Task 2: Update marketplace add command to accept --force flag

**Files:**
- Modify: `src/cli/commands/plugin.ts:305-350` (marketplaceAddCmd)

**Step 1: Add force flag to command args**

Find `marketplaceAddCmd` at line 305. Update the args:

```typescript
const marketplaceAddCmd = command({
  name: 'add',
  description: buildDescription(marketplaceAddMeta),
  args: {
    source: positional({ type: string, displayName: 'source' }),
    name: option({ type: optional(string), long: 'name', short: 'n', description: 'Custom name for the marketplace' }),
    branch: option({ type: optional(string), long: 'branch', short: 'b', description: 'Branch to checkout after cloning' }),
    force: option({ type: flag, long: 'force', short: 'f', description: 'Replace marketplace if it already exists' }),  // ADD THIS LINE
  },
  handler: async ({ source, name, branch, force }) => {  // ADD force parameter here
```

**Step 2: Pass force to addMarketplace call**

Find the call to `addMarketplace` inside the handler (around line 319):

```typescript
// OLD: const result = await addMarketplace(source, name, branch);
// NEW:
const result = await addMarketplace(source, name, branch, force);
```

**Step 3: Update success message to show replacement**

Find where the success output is generated (around line 330-345). After the `addMarketplace` call, add a message about replacement:

```typescript
  if (result.success) {
    // ADD THIS BLOCK before the existing output:
    if (result.replaced && !isJsonMode()) {
      console.log(`Marketplace '${name}' already exists. Replacing with new source.`);
    }

    // Keep existing output code...
    if (isJsonMode()) {
      jsonOutput({
        success: true,
        command: 'plugin marketplace add',
        data: {
          marketplace: {
            // ... existing data
            replaced: result.replaced,  // ADD THIS FIELD
          },
        },
      });
    }
```

**Step 4: Run the CLI to verify syntax**

Run: `bun run build && ./dist/index.js plugin marketplace --help`
Expected: Output shows `--force` flag in help text

**Step 5: Commit**

```bash
git add src/cli/commands/plugin.ts
git commit -m "feat(marketplace): add --force flag to 'plugin marketplace add' command"
```

---

## Task 3: Update `addPlugin()` and `addPluginToConfig()` for force support

**Files:**
- Modify: `src/core/workspace-modify.ts:105-210` (addPlugin and addPluginToConfig functions and ModifyResult type)

**Step 1: Update return type with replaced field**

Find `ModifyResult` type (search for `interface ModifyResult` or similar):

```typescript
interface ModifyResult {
  success: boolean;
  error?: string;
  replaced?: boolean;  // Add this field
}
```

**Step 2: Update function signatures**

Update both functions:

```typescript
// Around line 105
export async function addPlugin(
  plugin: string,
  workspacePath: string = process.cwd(),
  force?: boolean,  // ADD this parameter
): Promise<ModifyResult> {
  // ... inside handler, pass force to addPluginToConfig:
  return await addPluginToConfig(plugin, configPath, autoRegistered, force);  // ADD force parameter

// Around line 170
async function addPluginToConfig(
  plugin: string,
  configPath: string,
  autoRegistered?: string,
  force?: boolean,  // ADD this parameter
): Promise<ModifyResult> {
```

**Step 3: Update duplicate checks in addPluginToConfig**

Find the existing duplicate checks (lines 181-200). Replace them with:

```typescript
  // Check if plugin already exists (exact match)
  const existingExactIndex = config.plugins.findIndex((entry) => getPluginSource(entry) === plugin);
  if (existingExactIndex !== -1) {
    if (!force) {
      return {
        success: false,
        error: `Plugin already exists in .allagents/workspace.yaml: ${plugin}`,
      };
    }
    // With force, we'll remove and re-add below
  }

  // Check for semantic duplicates (only if not forcing)
  if (!force) {
    const newIdentity = await resolveGitHubIdentity(plugin);
    if (newIdentity) {
      for (const existing of config.plugins) {
        const existingSource = getPluginSource(existing);
        const existingIdentity = await resolveGitHubIdentity(existingSource);
        if (existingIdentity === newIdentity) {
          return {
            success: false,
            error: `Plugin duplicates existing entry '${existingSource}': both resolve to ${newIdentity}`,
          };
        }
      }
    }
  }
```

**Step 4: Update the add logic to handle replacement**

Find where the plugin is added to config.plugins (around line 200-210). Update to remove old entry if force and existing found:

```typescript
  // Remove existing entry if force and found
  if (force && existingExactIndex !== -1) {
    config.plugins.splice(existingExactIndex, 1);
  }

  // Add the new plugin entry
  config.plugins.push(pluginEntry);

  // When returning success, include replaced flag:
  return {
    success: true,
    replaced: force && existingExactIndex !== -1,  // ADD this field
  };
```

**Step 5: Run tests**

Run: `bun test src/core/workspace-modify.test.ts`
Expected: All existing tests pass

**Step 6: Commit**

```bash
git add src/core/workspace-modify.ts
git commit -m "feat(plugin): add force parameter to addPlugin and addPluginToConfig"
```

---

## Task 4: Update plugin add command to accept --force flag

**Files:**
- Modify: `src/cli/commands/plugin.ts:560-620` (approximate, find pluginAddCmd)

**Step 1: Find and update pluginAddCmd**

Search for `const pluginAddCmd = command({`. Add the force flag to args:

```typescript
const pluginAddCmd = command({
  name: 'add',
  description: buildDescription(pluginInstallMeta),
  args: {
    plugin: positional({ type: string, displayName: 'plugin' }),
    force: option({ type: flag, long: 'force', short: 'f', description: 'Replace plugin if it already exists' }),  // ADD THIS
  },
  handler: async ({ plugin, force }) => {  // ADD force parameter
```

**Step 2: Pass force to addPlugin call**

Find the `addPlugin(plugin, ...)` call in the handler:

```typescript
// OLD: const result = await addPlugin(plugin, ...)
// NEW:
const result = await addPlugin(plugin, process.cwd(), force);
```

**Step 3: Update success message for replacement**

Find where success output is generated. Add message about replacement:

```typescript
  if (result.success) {
    // ADD THIS BLOCK:
    if (result.replaced && !isJsonMode()) {
      console.log(`Plugin '${plugin}' already exists. Replacing with new source.`);
    }

    // Update JSON output to include replaced field:
    if (isJsonMode()) {
      jsonOutput({
        success: true,
        command: 'plugin add',
        data: {
          // ... existing data
          replaced: result.replaced,  // ADD THIS
        },
      });
    }
```

**Step 4: Verify CLI changes**

Run: `bun run build && ./dist/index.js plugin add --help`
Expected: Output shows `--force` flag in help text

**Step 5: Commit**

```bash
git add src/cli/commands/plugin.ts
git commit -m "feat(plugin): add --force flag to 'plugin add' command"
```

---

## Task 5: Write unit tests for marketplace add with --force

**Files:**
- Modify: `tests/unit/core/marketplace.test.ts` (create if doesn't exist)

**Step 1: Write test for force replacing existing marketplace**

Add to marketplace test file:

```typescript
test('addMarketplace with force replaces existing marketplace', async () => {
  // Setup: create initial marketplace
  const source1 = 'https://github.com/test/repo1';
  const result1 = await addMarketplace(source1, 'test-mp');
  expect(result1.success).toBe(true);
  expect(result1.replaced).toBeFalsy();

  // Action: add same name with different source and force=true
  const source2 = 'https://github.com/test/repo2';
  const result2 = await addMarketplace(source2, 'test-mp', undefined, true);

  // Assert: second add succeeds with replaced=true
  expect(result2.success).toBe(true);
  expect(result2.replaced).toBe(true);

  // Verify: registry has updated source
  const registry = await loadRegistry();
  expect(registry.marketplaces['test-mp'].location).toContain('repo2');
});

test('addMarketplace without force errors on existing', async () => {
  // Setup
  await addMarketplace('https://github.com/test/repo1', 'test-mp');

  // Action
  const result = await addMarketplace('https://github.com/test/repo2', 'test-mp', undefined, false);

  // Assert
  expect(result.success).toBe(false);
  expect(result.error).toContain('already exists');
  expect(result.replaced).toBeFalsy();
});
```

**Step 2: Run tests**

Run: `bun test tests/unit/core/marketplace.test.ts -t "force"`
Expected: Both tests pass

**Step 3: Commit**

```bash
git add tests/unit/core/marketplace.test.ts
git commit -m "test(marketplace): add tests for --force flag"
```

---

## Task 6: Write unit tests for plugin add with --force

**Files:**
- Modify: `tests/unit/core/workspace-modify.test.ts` (create if doesn't exist)

**Step 1: Write test for force replacing existing plugin**

Add to workspace-modify test file:

```typescript
test('addPlugin with force replaces existing plugin', async () => {
  const tempDir = await createTempWorkspace();

  // Setup: add initial plugin
  const result1 = await addPlugin('plugin1@marketplace1', tempDir);
  expect(result1.success).toBe(true);
  expect(result1.replaced).toBeFalsy();

  // Action: add same plugin with different marketplace and force=true
  const result2 = await addPlugin('plugin1@marketplace2', tempDir, true);

  // Assert: second add succeeds with replaced=true
  expect(result2.success).toBe(true);
  expect(result2.replaced).toBe(true);

  // Verify: config only has one entry
  const config = await loadWorkspaceConfig(tempDir);
  const plugin1Entries = config.plugins.filter((p) => p.startsWith('plugin1'));
  expect(plugin1Entries.length).toBe(1);
  expect(plugin1Entries[0]).toContain('marketplace2');
});

test('addPlugin without force errors on existing', async () => {
  const tempDir = await createTempWorkspace();

  // Setup
  await addPlugin('plugin1@marketplace1', tempDir);

  // Action
  const result = await addPlugin('plugin1@marketplace1', tempDir, false);

  // Assert
  expect(result.success).toBe(false);
  expect(result.error).toContain('already exists');
  expect(result.replaced).toBeFalsy();
});

test('addPlugin with force skips semantic duplicate check', async () => {
  const tempDir = await createTempWorkspace();

  // Setup: add plugin via GitHub shorthand
  await addPlugin('owner/repo@marketplace', tempDir);

  // Action: add same repo via full URL with force=true
  const result = await addPlugin('https://github.com/owner/repo@marketplace', tempDir, true);

  // Assert: succeeds despite semantic duplicate
  expect(result.success).toBe(true);
  expect(result.replaced).toBe(true);
});
```

**Step 2: Run tests**

Run: `bun test tests/unit/core/workspace-modify.test.ts -t "force"`
Expected: All tests pass

**Step 3: Commit**

```bash
git add tests/unit/core/workspace-modify.test.ts
git commit -m "test(plugin): add tests for --force flag"
```

---

## Task 7: E2E test marketplace add with --force

**Files:**
- Test: Manual E2E in temp workspace

**Step 1: Create temp workspace and marketplace**

```bash
# From project root
mkdir -p /tmp/test-force-mp
cd /tmp/test-force-mp

# Build CLI
cd /home/christso/projects/allagents
bun run build

# Initialize test workspace
./dist/index.js workspace init

# Add initial marketplace
./dist/index.js plugin marketplace add https://github.com/test/marketplace1 --name test-mp
# Expected: "marketplace added successfully"

# Verify it's registered
./dist/index.js plugin marketplace list
# Expected: test-mp listed with repo1
```

**Step 2: Try adding without --force (should error)**

```bash
./dist/index.js plugin marketplace add https://github.com/test/marketplace2 --name test-mp
# Expected: Error "Marketplace 'test-mp' already exists"
```

**Step 3: Add with --force (should succeed and replace)**

```bash
./dist/index.js plugin marketplace add https://github.com/test/marketplace2 --name test-mp --force
# Expected: "Marketplace 'test-mp' already exists. Replacing with new source."
```

**Step 4: Verify replacement**

```bash
./dist/index.js plugin marketplace list
# Expected: test-mp now points to marketplace2
```

**Step 5: Test JSON output**

```bash
./dist/index.js plugin marketplace add https://github.com/test/marketplace3 --name test-mp --force --json
# Expected: { success: true, replaced: true, ... }
```

**Step 6: Cleanup**

```bash
rm -rf /tmp/test-force-mp
```

**Step 7: Document in commit**

```bash
git add -A
git commit -m "test(e2e): verify --force flag for marketplace add

Tested:
- marketplace add with --force replaces existing entry
- marketplace add without --force errors on duplicate
- JSON output includes replaced: true flag
- marketplace list shows updated reference"
```

---

## Task 8: E2E test plugin add with --force

**Files:**
- Test: Manual E2E in temp workspace

**Step 1: Create temp workspace with marketplace**

```bash
mkdir -p /tmp/test-force-plugin
cd /tmp/test-force-plugin

# Create workspace and register marketplace
cd /home/christso/projects/allagents
bun run build

./dist/index.js workspace init --from /tmp/test-force-plugin
cd /tmp/test-force-plugin

# Register a test marketplace (or use well-known one)
allagents plugin marketplace add ./test-marketplace --name test-mp
# (Assuming ./test-marketplace exists with a valid plugin)
```

**Step 2: Add initial plugin**

```bash
./dist/index.js plugin add my-plugin@test-mp
# Expected: success

# Verify
cat .allagents/workspace.yaml
# Expected: my-plugin@test-mp in plugins list
```

**Step 3: Try adding without --force (should error)**

```bash
./dist/index.js plugin add my-plugin@test-mp
# Expected: Error "Plugin already exists"
```

**Step 4: Add with --force (should succeed and replace)**

```bash
./dist/index.js plugin add my-plugin@test-mp --force
# Expected: "Plugin 'my-plugin@test-mp' already exists. Replacing with new source."
```

**Step 5: Verify no duplicates**

```bash
cat .allagents/workspace.yaml
# Expected: my-plugin@test-mp appears only once
```

**Step 6: Test with semantic duplicate (different URL, same repo)**

```bash
./dist/index.js plugin add owner/repo --force
# Expected: succeeds with force even if semantically duplicate
```

**Step 7: Cleanup**

```bash
rm -rf /tmp/test-force-plugin
```

**Step 8: Document in commit**

```bash
git add -A
git commit -m "test(e2e): verify --force flag for plugin add

Tested:
- plugin add with --force replaces existing entry
- plugin add without --force errors on duplicate
- semantic duplicate check is skipped with --force
- no duplicate entries in workspace.yaml after replace"
```

---

## Summary of Changes

**Modified Files:**
- `src/core/marketplace.ts` - Add force parameter, update duplicate check logic
- `src/core/workspace-modify.ts` - Add force parameter to addPlugin and addPluginToConfig
- `src/cli/commands/plugin.ts` - Add --force flag to both marketplace and plugin add commands
- `tests/unit/core/marketplace.test.ts` - New tests for force behavior
- `tests/unit/core/workspace-modify.test.ts` - New tests for force behavior

**New Output:**
- When `--force` used and entry replaced: "Marketplace/Plugin '...' already exists. Replacing with new source."
- JSON output includes `{ replaced: true }` field when applicable

**Backwards Compatibility:**
- Default behavior (no --force) unchanged
- All existing tests continue to pass
- Exit codes consistent with success
