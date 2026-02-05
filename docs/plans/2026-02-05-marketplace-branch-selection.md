# Marketplace Branch Selection

**Issue:** [#65](https://github.com/EntityProcess/allagents/issues/65)

## Problem

When registering a marketplace via a GitHub URL that includes a branch (e.g., `https://github.com/owner/repo/tree/feat/my-branch`), the branch is silently discarded. The marketplace always clones the default branch.

## Design

Branch selection is supported through full GitHub URLs during `marketplace add` and via a `--branch` CLI flag. The branch is stored in `MarketplaceSource` as a separate field and used during clone and update operations.

### Changes

#### 1. `MarketplaceSource` — add `branch` field

```typescript
export interface MarketplaceSource {
  type: MarketplaceSourceType;  // 'github' | 'local'
  location: string;             // "owner/repo"
  branch?: string;              // "feat/v2" — only for non-default branches
}
```

The `branch` field is only set for non-default branches. When absent, the marketplace uses the repo's default branch (existing behavior).

#### 2. `parseMarketplaceSource` — extract branch from URL

Extend the GitHub URL regex to capture an optional `/tree/<branch>` suffix.

**Current regex:** `^https:\/\/github\.com\/([^/]+)\/([^/]+)`

**New regex:** Also captures `/tree/<branch>` where branch can contain `/` (e.g., `feat/v2`).

**Return value:** Add optional `branch` field to the return type.

```typescript
// Example inputs and outputs:
parseMarketplaceSource("https://github.com/owner/repo/tree/feat/v2")
// → { type: 'github', location: 'owner/repo', name: 'repo', branch: 'feat/v2' }

parseMarketplaceSource("https://github.com/owner/repo")
// → { type: 'github', location: 'owner/repo', name: 'repo' }  (unchanged)
```

The `name` stays as `repo` regardless of branch. Branch does not affect the auto-generated name.

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

**Registry entry:** The branch is stored in `source.branch`.

#### 4. `updateMarketplace` — use stored branch

When `source.branch` is set, checkout that branch before pulling:

```bash
git checkout <branch> && git pull
```

When `source.branch` is absent, use existing default-branch detection logic (unchanged).

#### 5. CLI — add `--branch` flag to `marketplace add`

```bash
allagents plugin marketplace add <source> [--name <name>] [--branch <branch>]
```

The `--branch` flag provides an alternative to embedding the branch in the URL. Useful for the `owner/repo` shorthand which has no natural syntax for branch.

### No changes to these

- **`MarketplaceEntry`** — no structural changes (branch lives in `source`).
- **`MarketplaceSource.location`** — stays as `owner/repo`. Same repo on different branches shares the same location.
- **`parsePluginSpec`** — no changes. Branch-pinned marketplaces are referenced by their registered `--name`, which is a simple marketplace name lookup.
- **Sync** — no changes. Sync resolves marketplaces by name via the registry and never interprets branch info.
- **`findMarketplace`** — no changes. Branch-pinned entries have distinct names, so no ambiguous lookups.

### Example workflows

**Single branch (common case):**

```bash
# Register a feature branch for testing
allagents plugin marketplace add https://github.com/WiseTechGlobal/CargoWise.Shared/tree/feat/v2 --name cw-shared-v2

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
# name: CargoWise.Shared

# Feature branch — must provide --name
allagents plugin marketplace add https://github.com/WiseTechGlobal/CargoWise.Shared/tree/feat/v2 --name cw-shared-v2

# Shorthand with --branch flag
allagents plugin marketplace add WiseTechGlobal/CargoWise.Shared --branch feat/v3 --name cw-shared-v3

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
