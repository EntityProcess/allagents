# Marketplace Branch Selection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Support branch selection when registering a marketplace via GitHub URL or `--branch` flag.

**Architecture:** Branch is encoded in `MarketplaceSource.location` as `owner/repo/branch`. A `parseLocation()` helper extracts owner, repo, and branch. `addMarketplace` gains a `branch` parameter with naming rules (non-default branch requires `--name`, bare repo name is reserved for default branch). `updateMarketplace` uses the branch from location instead of detecting default branch. CLI gains `--branch` flag on `marketplace add`.

**Tech Stack:** TypeScript, bun:test, cmd-ts (CLI framework)

**Design doc:** `docs/plans/2026-02-05-marketplace-branch-selection.md`

---

### Task 1: Add `parseLocation` helper

**Files:**
- Modify: `src/core/marketplace.ts` (add after line 12, before the type declarations)
- Test: `tests/unit/core/marketplace-branch.test.ts`

**Step 1: Write the failing tests**

Create `tests/unit/core/marketplace-branch.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { parseLocation } from '../../../src/core/marketplace.js';

describe('parseLocation', () => {
  it('should parse owner/repo without branch', () => {
    expect(parseLocation('owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('should parse owner/repo with simple branch', () => {
    expect(parseLocation('owner/repo/my-branch')).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'my-branch',
    });
  });

  it('should parse owner/repo with nested branch', () => {
    expect(parseLocation('WiseTechGlobal/CargoWise.Shared/feat/v2')).toEqual({
      owner: 'WiseTechGlobal',
      repo: 'CargoWise.Shared',
      branch: 'feat/v2',
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/unit/core/marketplace-branch.test.ts`
Expected: FAIL — `parseLocation` is not exported

**Step 3: Write minimal implementation**

In `src/core/marketplace.ts`, add after the imports (after line 12):

```typescript
/**
 * Parse a marketplace location string into owner, repo, and optional branch.
 * Location format: "owner/repo" or "owner/repo/branch" (branch can contain slashes).
 */
export function parseLocation(location: string): { owner: string; repo: string; branch?: string } {
  const parts = location.split('/');
  const owner = parts[0];
  const repo = parts[1];
  const branch = parts.length > 2 ? parts.slice(2).join('/') : undefined;
  return { owner, repo, ...(branch !== undefined && { branch }) };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/unit/core/marketplace-branch.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/marketplace.ts tests/unit/core/marketplace-branch.test.ts
git commit -m "feat(marketplace): add parseLocation helper"
```

---

### Task 2: Extend `parseMarketplaceSource` to extract branch from URL

**Files:**
- Modify: `src/core/marketplace.ts:126-153` (the `parseMarketplaceSource` function)
- Test: `tests/unit/core/marketplace-branch.test.ts` (add tests)

**Step 1: Write the failing tests**

Append to `tests/unit/core/marketplace-branch.test.ts`:

```typescript
import { parseMarketplaceSource } from '../../../src/core/marketplace.js';

describe('parseMarketplaceSource branch extraction', () => {
  it('should extract branch from GitHub URL with /tree/', () => {
    const result = parseMarketplaceSource('https://github.com/owner/repo/tree/feat/v2');
    expect(result).toEqual({
      type: 'github',
      location: 'owner/repo/feat/v2',
      name: 'repo',
      branch: 'feat/v2',
    });
  });

  it('should extract simple branch from GitHub URL', () => {
    const result = parseMarketplaceSource('https://github.com/owner/repo/tree/main');
    expect(result).toEqual({
      type: 'github',
      location: 'owner/repo/main',
      name: 'repo',
      branch: 'main',
    });
  });

  it('should handle GitHub URL without branch (unchanged)', () => {
    const result = parseMarketplaceSource('https://github.com/owner/repo');
    expect(result).toEqual({
      type: 'github',
      location: 'owner/repo',
      name: 'repo',
    });
  });

  it('should handle GitHub URL with .git suffix and branch', () => {
    const result = parseMarketplaceSource('https://github.com/owner/repo.git/tree/dev');
    expect(result).toEqual({
      type: 'github',
      location: 'owner/repo/dev',
      name: 'repo',
      branch: 'dev',
    });
  });

  it('should not extract branch from owner/repo shorthand', () => {
    const result = parseMarketplaceSource('owner/repo');
    expect(result).toEqual({
      type: 'github',
      location: 'owner/repo',
      name: 'repo',
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/unit/core/marketplace-branch.test.ts`
Expected: FAIL — branch not extracted, location doesn't include branch

**Step 3: Write minimal implementation**

Update the return type of `parseMarketplaceSource` at `src/core/marketplace.ts:126-130` to include optional `branch`:

```typescript
export function parseMarketplaceSource(source: string): {
  type: MarketplaceSourceType;
  location: string;
  name: string;
  branch?: string;
} | null {
```

Replace the GitHub URL block at `src/core/marketplace.ts:140-153` with:

```typescript
  // GitHub URL
  if (source.startsWith('https://github.com/')) {
    const match = source.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/(.+))?$/);
    if (match) {
      const [, owner, repo, branch] = match;
      if (!repo) return null;
      const location = branch ? `${owner}/${repo}/${branch}` : `${owner}/${repo}`;
      return {
        type: 'github',
        location,
        name: repo,
        ...(branch && { branch }),
      };
    }
    return null;
  }
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/unit/core/marketplace-branch.test.ts`
Expected: PASS

**Step 5: Run existing tests to verify no regression**

Run: `bun test tests/unit/core/marketplace.test.ts`
Expected: PASS (existing tests unchanged)

**Step 6: Commit**

```bash
git add src/core/marketplace.ts tests/unit/core/marketplace-branch.test.ts
git commit -m "feat(marketplace): extract branch from GitHub URL in parseMarketplaceSource"
```

---

### Task 3: Add branch support to `addMarketplace`

**Files:**
- Modify: `src/core/marketplace.ts:186-304` (the `addMarketplace` function)
- Test: `tests/unit/core/marketplace-branch.test.ts` (add tests)

**Step 1: Write the failing tests**

Append to `tests/unit/core/marketplace-branch.test.ts`. These tests mock `execa` to avoid real cloning:

```typescript
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
```

Note: Because `addMarketplace` calls `execa` (for `gh` and `git`), this test file needs to mock `execa` similar to `marketplace-update.test.ts`. Create a **separate** test file for the `addMarketplace` branch tests to isolate the mock:

Create `tests/unit/core/marketplace-add-branch.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execaCalls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
const execaMock = mock(
  (cmd: string, args: string[], opts?: { cwd?: string; stdin?: string }) => {
    execaCalls.push({ cmd, args, cwd: opts?.cwd });

    // Mock gh --version
    if (cmd === 'gh' && args[0] === '--version') {
      return Promise.resolve({ stdout: 'gh version 2.0.0', stderr: '' });
    }

    // Mock gh repo clone — create the directory to simulate clone
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'clone') {
      const clonePath = args[3];
      if (clonePath) mkdirSync(clonePath, { recursive: true });
      return Promise.resolve({ stdout: '', stderr: '' });
    }

    // Mock git checkout
    if (cmd === 'git' && args[0] === 'checkout') {
      return Promise.resolve({ stdout: '', stderr: '' });
    }

    return Promise.resolve({ stdout: '', stderr: '' });
  },
);

mock.module('execa', () => ({
  execa: execaMock,
}));

const { addMarketplace, loadRegistry } = await import('../../../src/core/marketplace.js');

describe('addMarketplace branch support', () => {
  let originalHome: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = join(tmpdir(), `marketplace-add-branch-test-${Date.now()}`);
    process.env.HOME = testHome;
    mkdirSync(join(testHome, '.allagents'), { recursive: true });
    execaCalls.length = 0;
    execaMock.mockClear();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('should error when non-default branch is specified without --name', async () => {
    const result = await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('--name is required');
  });

  it('should error when --name matches bare repo name for non-default branch', async () => {
    const result = await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
      'repo',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('reserved for the default branch');
  });

  it('should clone and checkout branch when --name is provided', async () => {
    const result = await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
      'repo-v2',
    );
    expect(result.success).toBe(true);
    expect(result.marketplace?.name).toBe('repo-v2');
    expect(result.marketplace?.source.location).toBe('owner/repo/feat/v2');

    // Verify gh repo clone was called with owner/repo (not owner/repo/feat/v2)
    const cloneCall = execaCalls.find(
      (c) => c.cmd === 'gh' && c.args[1] === 'clone',
    );
    expect(cloneCall).toBeDefined();
    expect(cloneCall!.args[2]).toBe('owner/repo');

    // Verify git checkout was called with the branch
    const checkoutCall = execaCalls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'checkout',
    );
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall!.args[1]).toBe('feat/v2');
  });

  it('should store branch in location in registry', async () => {
    await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
      'repo-v2',
    );
    const registry = await loadRegistry();
    expect(registry.marketplaces['repo-v2'].source.location).toBe('owner/repo/feat/v2');
  });

  it('should accept --branch flag with owner/repo shorthand', async () => {
    const result = await addMarketplace('owner/repo', 'repo-v2', 'feat/v2');
    expect(result.success).toBe(true);
    expect(result.marketplace?.source.location).toBe('owner/repo/feat/v2');
  });

  it('should prefer explicit --branch over URL branch', async () => {
    const result = await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
      'repo-override',
      'feat/v3',
    );
    expect(result.success).toBe(true);
    expect(result.marketplace?.source.location).toBe('owner/repo/feat/v3');
  });

  it('should clone default branch without checkout when no branch specified', async () => {
    const result = await addMarketplace('https://github.com/owner/repo');
    expect(result.success).toBe(true);

    const checkoutCall = execaCalls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'checkout',
    );
    expect(checkoutCall).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/unit/core/marketplace-add-branch.test.ts`
Expected: FAIL — `addMarketplace` doesn't accept branch parameter, no naming rules

**Step 3: Write minimal implementation**

Update `addMarketplace` signature at `src/core/marketplace.ts:186-189`:

```typescript
export async function addMarketplace(
  source: string,
  customName?: string,
  branch?: string,
): Promise<MarketplaceResult> {
```

After `const parsed = parseMarketplaceSource(source);` and its null check (after line 197), add branch resolution:

```typescript
  // Resolve branch: explicit --branch flag wins over URL-parsed branch
  const effectiveBranch = branch || parsed.branch;

  // Naming rules for non-default branches
  if (effectiveBranch) {
    if (!customName) {
      return {
        success: false,
        error: `--name is required when registering a non-default branch.\n  Example: allagents plugin marketplace add ${source} --name <custom-name>`,
      };
    }
    if (customName === parsed.name) {
      return {
        success: false,
        error: `Name '${customName}' is reserved for the default branch of ${parsed.location}.\n  Choose a different --name for branch '${effectiveBranch}'.`,
      };
    }
  }
```

Update the location used when creating the entry. After the clone block (around line 254 in the current code), before `// Read manifest to get canonical name`, update the location to include the branch. Replace the entry creation block at `src/core/marketplace.ts:286-294`:

```typescript
  // Build location with branch if applicable
  const entryLocation = effectiveBranch
    ? `${parsed.location}/${effectiveBranch}`
    : parsed.location;

  // Create entry
  const entry: MarketplaceEntry = {
    name,
    source: {
      type: parsed.type,
      location: entryLocation,
    },
    path: marketplacePath,
    lastUpdated: new Date().toISOString(),
  };
```

Note: `parsed.location` is always `owner/repo` (without branch) since `parseMarketplaceSource` now stores the branch separately in its return value. But wait — we changed `parseMarketplaceSource` in Task 2 to include the branch in `location`. We need to ensure consistency. Actually, looking at the Task 2 implementation, `parseMarketplaceSource` already returns `location` with the branch included. So for URL sources, `parsed.location` already has the branch. But for shorthand + `--branch` flag, `parsed.location` is just `owner/repo`. So the logic should be:

```typescript
  // Build location with branch if applicable
  // For URLs, parsed.location may already include the branch from parseMarketplaceSource.
  // For shorthand + --branch flag, we need to append it.
  // Use effective branch to determine the final location.
  const baseLocation = parsed.branch
    ? parsed.location.slice(0, parsed.location.length - parsed.branch.length - 1)
    : parsed.location;
  const entryLocation = effectiveBranch
    ? `${baseLocation}/${effectiveBranch}`
    : baseLocation;
```

Actually, this is getting complex. Simpler approach: always compute `baseLocation` from `parseLocation` helper, then reconstruct:

```typescript
  const { owner, repo } = parseLocation(parsed.location);
  const entryLocation = effectiveBranch
    ? `${owner}/${repo}/${effectiveBranch}`
    : `${owner}/${repo}`;
```

This works for both URL (where `parsed.location` might include branch) and shorthand (where it doesn't). Use this approach.

After the clone succeeds (inside the `if (parsed.type === 'github')` block, after the `gh repo clone` call at line 240), add the branch checkout:

```typescript
      // If a branch was specified, checkout that branch after cloning
      if (effectiveBranch) {
        try {
          await execa('git', ['checkout', effectiveBranch], {
            cwd: marketplacePath,
            stdin: 'ignore',
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            error: `Failed to checkout branch '${effectiveBranch}': ${msg}`,
          };
        }
      }
```

Also update the `gh repo clone` call to use `owner/repo` (without branch). Currently at line 240 it uses `parsed.location` which now might include the branch for URL sources. Replace:

```typescript
        await execa('gh', ['repo', 'clone', parsed.location, marketplacePath], { stdin: 'ignore' });
```

With:

```typescript
        await execa('gh', ['repo', 'clone', `${owner}/${repo}`, marketplacePath], { stdin: 'ignore' });
```

This requires moving the `parseLocation` call earlier, before the clone block.

**Step 4: Run test to verify it passes**

Run: `bun test tests/unit/core/marketplace-add-branch.test.ts`
Expected: PASS

**Step 5: Run all existing tests**

Run: `bun test tests/unit/core/marketplace.test.ts tests/unit/core/marketplace-update.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/core/marketplace.ts tests/unit/core/marketplace-add-branch.test.ts
git commit -m "feat(marketplace): add branch support to addMarketplace with naming rules"
```

---

### Task 4: Update `updateMarketplace` to use branch from location

**Files:**
- Modify: `src/core/marketplace.ts:379-472` (the `updateMarketplace` function)
- Test: `tests/unit/core/marketplace-update.test.ts` (add test)

**Step 1: Write the failing test**

Append to `tests/unit/core/marketplace-update.test.ts` inside the `describe('updateMarketplace')` block:

```typescript
  it('should checkout stored branch instead of detecting default branch', async () => {
    // Update registry to include a branch in location
    const registry = {
      version: 1,
      marketplaces: {
        'test-mp-branch': {
          name: 'test-mp-branch',
          source: { type: 'github', location: 'owner/test-mp/feat/v2' },
          path: marketplacePath,
          lastUpdated: '2024-01-01T00:00:00.000Z',
        },
      },
    };
    const registryDir = join(testHome, '.allagents');
    writeFileSync(
      join(registryDir, 'marketplaces.json'),
      JSON.stringify(registry, null, 2),
    );

    execaCalls.length = 0;

    const results = await updateMarketplace('test-mp-branch');

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);

    const gitCalls = execaCalls.filter((c) => c.cmd === 'git');

    // Should NOT call symbolic-ref (no default branch detection)
    const symbolicRefCall = gitCalls.find((c) => c.args[0] === 'symbolic-ref');
    expect(symbolicRefCall).toBeUndefined();

    // Should checkout feat/v2 directly
    const checkoutCall = gitCalls.find((c) => c.args[0] === 'checkout');
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall!.args[1]).toBe('feat/v2');

    // Should pull
    const pullCall = gitCalls.find((c) => c.args[0] === 'pull');
    expect(pullCall).toBeDefined();
  });
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/unit/core/marketplace-update.test.ts`
Expected: FAIL — `updateMarketplace` still detects default branch even when location has a branch

**Step 3: Write minimal implementation**

In `updateMarketplace` at `src/core/marketplace.ts`, replace the default branch detection and checkout block (lines 416-448) with:

```typescript
    try {
      // Check if location includes a branch
      const { branch: storedBranch } = parseLocation(marketplace.source.location);

      let targetBranch: string;
      if (storedBranch) {
        // Branch-pinned marketplace: use stored branch directly
        targetBranch = storedBranch;
      } else {
        // Default branch marketplace: detect default branch (existing logic)
        targetBranch = 'main';
        try {
          const { stdout } = await execa(
            'git',
            ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
            { cwd: marketplace.path, stdin: 'ignore' },
          );
          const ref = stdout.trim();
          targetBranch = ref.startsWith('origin/')
            ? ref.slice('origin/'.length)
            : ref;
        } catch {
          try {
            const { stdout } = await execa(
              'git',
              ['remote', 'show', 'origin'],
              { cwd: marketplace.path, stdin: 'ignore' },
            );
            const match = stdout.match(/HEAD branch:\s*(\S+)/);
            if (match?.[1]) {
              targetBranch = match[1];
            }
          } catch {
            // Network unavailable; fall back to 'main'
          }
        }
      }

      await execa('git', ['checkout', targetBranch], {
        cwd: marketplace.path,
        stdin: 'ignore',
      });
      await execa('git', ['pull'], { cwd: marketplace.path, stdin: 'ignore' });
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/unit/core/marketplace-update.test.ts`
Expected: PASS (all 4 tests including the new one)

**Step 5: Commit**

```bash
git add src/core/marketplace.ts tests/unit/core/marketplace-update.test.ts
git commit -m "feat(marketplace): use stored branch in updateMarketplace"
```

---

### Task 5: Add `--branch` flag to CLI

**Files:**
- Modify: `src/cli/commands/plugin.ts:252-265` (marketplace add command)
- Modify: `src/cli/metadata/plugin.ts:17-38` (marketplace add metadata)

**Step 1: Update CLI command to accept `--branch`**

In `src/cli/commands/plugin.ts:252-265`, add the `branch` option to `args` and pass it to `addMarketplace`:

```typescript
const marketplaceAddCmd = command({
  name: 'add',
  description: buildDescription(marketplaceAddMeta),
  args: {
    source: positional({ type: string, displayName: 'source' }),
    name: option({ type: optional(string), long: 'name', short: 'n', description: 'Custom name for the marketplace' }),
    branch: option({ type: optional(string), long: 'branch', short: 'b', description: 'Branch to checkout after cloning' }),
  },
  handler: async ({ source, name, branch }) => {
    try {
      if (!isJsonMode()) {
        console.log(`Adding marketplace: ${source}...`);
      }

      const result = await addMarketplace(source, name, branch);
```

**Step 2: Update metadata**

In `src/cli/metadata/plugin.ts`, add the `--branch` option and an example to `marketplaceAddMeta`:

Add to the `examples` array:
```typescript
    'allagents plugin marketplace add owner/repo --branch feat/v2 --name custom',
```

Add to the `options` array:
```typescript
    { flag: '--branch', short: '-b', type: 'string', description: 'Branch to checkout after cloning (requires --name)' },
```

**Step 3: Run the full test suite to verify no regressions**

Run: `bun test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/cli/commands/plugin.ts src/cli/metadata/plugin.ts
git commit -m "feat(marketplace): add --branch flag to marketplace add CLI"
```

---

### Task 6: Final verification and cleanup

**Step 1: Run the full test suite**

Run: `bun test`
Expected: All tests PASS

**Step 2: Run linting and typecheck**

Run: `bunx biome lint src && tsc --noEmit`
Expected: No errors

**Step 3: Commit any fixes if needed**

**Step 4: Final commit message for squash merge reference**

The branch should have these commits:
1. `feat(marketplace): add parseLocation helper`
2. `feat(marketplace): extract branch from GitHub URL in parseMarketplaceSource`
3. `feat(marketplace): add branch support to addMarketplace with naming rules`
4. `feat(marketplace): use stored branch in updateMarketplace`
5. `feat(marketplace): add --branch flag to marketplace add CLI`
