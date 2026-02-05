# Marketplace Branch Selection

**Issue:** [#65](https://github.com/EntityProcess/allagents/issues/65)

## Problem

When registering a marketplace via a GitHub URL that includes a branch (e.g., `https://github.com/owner/repo/tree/feat/my-branch`), the branch is silently discarded. The marketplace always clones the default branch.

## Design

Branch selection is supported only through full GitHub URLs during `marketplace add`. It is treated as a separate clone — no special branch tracking in the registry.

### Changes

#### 1. `parseMarketplaceSource` — extract branch from URL

Extend the GitHub URL regex to capture an optional `/tree/<branch>` suffix.

**Current regex:** `^https:\/\/github\.com\/([^/]+)\/([^/]+)`

**New regex:** Also captures `/tree/<branch>` where branch can contain `/` (e.g., `feat/v2`).

**Return value:** Add optional `branch` field to the return type.

```typescript
// Example inputs and outputs:
parseMarketplaceSource("https://github.com/owner/repo/tree/feat/v2")
// → { type: 'github', location: 'owner/repo', name: 'repo/feat/v2', branch: 'feat/v2' }

parseMarketplaceSource("https://github.com/owner/repo")
// → { type: 'github', location: 'owner/repo', name: 'repo' }  (unchanged)
```

#### 2. `addMarketplace` — clone with branch flag

When a branch is present in the parsed source:

- Use `git clone -b <branch> https://github.com/<owner>/<repo>.git <path>` instead of `gh repo clone`.
- Auto-generate name as `repo/branch` (e.g., `WTG.AI.Prompts/feat/v2`).
- Clone directory uses the full name (with `/` in path).

When no branch is present, behavior is unchanged (`gh repo clone`).

#### 3. No changes to these

- **`MarketplaceEntry`** — no `branch` field needed. The clone itself tracks its branch.
- **`MarketplaceSource.location`** — stays as `owner/repo`. Branch-pinned entries share the same source location as the default-branch entry.
- **`updateMarketplace`** — already does `git pull` on whatever branch the clone is on. No changes.
- **`parsePluginSpec`** — no changes. Branch-pinned marketplaces are referenced by their registered name (e.g., `my-tool@WTG.AI.Prompts/feat/v2`), which is looked up as a simple marketplace name, not parsed as `owner/repo/subpath`.
- **Sync** — no changes. Sync resolves marketplaces by name via the registry and never interprets branch info.

### Naming convention

| Source | Auto-generated name |
|--------|-------------------|
| `https://github.com/owner/repo` | `repo` |
| `https://github.com/owner/repo/tree/feat/v2` | `repo/feat/v2` |
| `owner/repo` (shorthand) | `repo` |

Users can always override with `--name`.

### Why no ambiguity with subpath

The `parsePluginSpec` format `plugin@owner/repo/subpath` splits on `/` to extract `owner`, `repo`, and `subpath`. A branch like `feat/v2` could collide with subpath parsing.

This is avoided because branch selection only happens during `marketplace add` (via full GitHub URL). In plugin specs, users reference the marketplace by its registered name. The registered name (e.g., `WTG.AI.Prompts/feat/v2`) is looked up directly in the registry — `parsePluginSpec` never needs to distinguish branches from subpaths.

### Example workflow

```bash
# Register default branch
allagents marketplace add https://github.com/WiseTechGlobal/WTG.AI.Prompts
# name: WTG.AI.Prompts

# Register feature branch
allagents marketplace add https://github.com/WiseTechGlobal/WTG.AI.Prompts/tree/feat/v2
# name: WTG.AI.Prompts/feat/v2

# Reference plugins from each
# In workspace.yaml:
plugins:
  - my-tool@WTG.AI.Prompts           # default branch
  - my-tool@WTG.AI.Prompts/feat/v2   # feature branch

# Update pulls correct branch automatically
allagents marketplace update WTG.AI.Prompts/feat/v2
```
