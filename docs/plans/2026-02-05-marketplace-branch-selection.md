# Marketplace Branch Selection

**Issue:** [#65](https://github.com/EntityProcess/allagents/issues/65)

## Problem

When registering a marketplace via a GitHub URL that includes a branch (e.g., `https://github.com/owner/repo/tree/feat/my-branch`), the branch is silently discarded. The marketplace always clones the default branch.

## Design

Branch selection is supported through full GitHub URLs during `marketplace add` and via a `--branch` CLI flag. The branch is encoded in `MarketplaceSource.location` (e.g., `owner/repo/branch`) and used during clone and update operations.

### Changes

#### 1. `MarketplaceSource.location` — encode branch in location

No schema changes. The existing `location` field carries the branch:

| Scenario | `location` value |
|----------|-----------------|
| Default branch | `owner/repo` |
| Non-default branch | `owner/repo/feat/v2` |

Code that needs the repo for cloning extracts the first two segments (`owner/repo`). Code that needs the branch extracts everything after the second `/`, if present.

Helper to extract parts:

```typescript
function parseLocation(location: string): { owner: string; repo: string; branch?: string } {
  const parts = location.split('/');
  const owner = parts[0];
  const repo = parts[1];
  const branch = parts.length > 2 ? parts.slice(2).join('/') : undefined;
  return { owner, repo, branch };
}
```

#### 2. `parseMarketplaceSource` — extract branch from URL

Extend the GitHub URL regex to capture an optional `/tree/<branch>` suffix.

**Current regex:** `^https:\/\/github\.com\/([^/]+)\/([^/]+)`

**New regex:** Also captures `/tree/<branch>` where branch can contain `/` (e.g., `feat/v2`).

```typescript
// Example inputs and outputs:
parseMarketplaceSource("https://github.com/owner/repo/tree/feat/v2")
// → { type: 'github', location: 'owner/repo/feat/v2', name: 'repo', branch: 'feat/v2' }

parseMarketplaceSource("https://github.com/owner/repo")
// → { type: 'github', location: 'owner/repo', name: 'repo' }  (unchanged)
```

The `name` stays as `repo` regardless of branch. The `branch` in the return value is a convenience for `addMarketplace` — it is not stored separately in the registry.

#### 3. `addMarketplace` — clone with branch, enforce naming rules

**Signature change:** Add optional `branch` parameter (for `--branch` CLI flag).

```typescript
export async function addMarketplace(
  source: string,
  customName?: string,
  branch?: string,       // new: from --branch flag or parsed from URL
): Promise<MarketplaceResult>
```

Branch can come from either the URL (`/tree/<branch>`) or the `--branch` flag. If both are provided, the explicit flag wins.

**Naming rules:**

| Scenario | Name | `--name` required? |
|----------|------|--------------------|
| Default branch | `repo` (auto) | No |
| Non-default branch | — | **Yes, mandatory** |
| Non-default branch with `--name repo` | Error | — |

The name `repo` (the bare repo name) is **reserved for the default branch**. Registering a non-default branch without `--name` is an error. Registering a non-default branch with `--name` equal to the bare repo name is also an error, even if the default branch isn't registered yet. This prevents a footgun where someone registers a feature branch first and blocks the expected name for the default branch later.

**Cloning:**

When a branch is specified, use `gh repo clone` followed by `git checkout <branch>` as a post-clone step. This preserves the existing `gh` auth mechanism instead of switching to `git clone -b` which uses different credentials.

**Registry entry:** The location is stored as `owner/repo/branch` (e.g., `WiseTechGlobal/CargoWise.Shared/feat/v2`).

#### 4. `updateMarketplace` — use branch from location

Extract the branch from `source.location` using `parseLocation()`. When a branch is present, checkout that branch before pulling:

```bash
git checkout <branch> && git pull
```

When no branch is present (only `owner/repo`), use existing default-branch detection logic (unchanged).

#### 5. CLI — add `--branch` flag to `marketplace add`

```bash
allagents plugin marketplace add <source> [--name <name>] [--branch <branch>]
```

The `--branch` flag provides an alternative to embedding the branch in the URL. Useful for the `owner/repo` shorthand which has no natural syntax for branch.

### No changes to these

- **`MarketplaceSource` interface** — no schema changes. `location` is already a string.
- **`MarketplaceEntry`** — no changes.
- **`parsePluginSpec`** — no changes. Branch-pinned marketplaces are referenced by their registered `--name`, which is a simple marketplace name lookup.
- **Sync** — no changes. Sync resolves marketplaces by name via the registry and never interprets branch info.
- **`findMarketplace`** — no changes. Branch-pinned entries have distinct names, so no ambiguous lookups. The fallback by `source.location` would match on the full `owner/repo/branch` string, which is correct.

### Example workflows

**Single branch (common case):**

```bash
# Register a feature branch for testing
allagents plugin marketplace add https://github.com/WiseTechGlobal/CargoWise.Shared/tree/feat/v2 --name cw-shared-v2
# name: cw-shared-v2, location: WiseTechGlobal/CargoWise.Shared/feat/v2

# In workspace.yaml:
plugins:
  - my-tool@cw-shared-v2

# Update pulls the correct branch
allagents plugin marketplace update cw-shared-v2
```

**Multiple branches of same repo:**

```bash
# Default branch — auto-named
allagents plugin marketplace add https://github.com/WiseTechGlobal/CargoWise.Shared
# name: CargoWise.Shared, location: WiseTechGlobal/CargoWise.Shared

# Feature branch — must provide --name
allagents plugin marketplace add https://github.com/WiseTechGlobal/CargoWise.Shared/tree/feat/v2 --name cw-shared-v2
# name: cw-shared-v2, location: WiseTechGlobal/CargoWise.Shared/feat/v2

# Shorthand with --branch flag
allagents plugin marketplace add WiseTechGlobal/CargoWise.Shared --branch feat/v3 --name cw-shared-v3
# name: cw-shared-v3, location: WiseTechGlobal/CargoWise.Shared/feat/v3

# In workspace.yaml:
plugins:
  - my-tool@CargoWise.Shared    # default branch
  - my-tool@cw-shared-v2        # feat/v2
  - my-tool@cw-shared-v3        # feat/v3
```

**Error cases:**

```bash
# Non-default branch without --name → error
allagents plugin marketplace add https://github.com/owner/repo/tree/feat/v2
# Error: --name is required when registering a non-default branch

# Non-default branch using reserved name → error
allagents plugin marketplace add https://github.com/owner/repo/tree/feat/v2 --name repo
# Error: name "repo" is reserved for the default branch of owner/repo
```
