# Recommended Skill Catalog Implementation Plan

**Status:** Implemented in draft PR #455; maintained product and verification plan
**Date:** 2026-08-24
**Implementation target:** `feat/recommended-skill-catalog`, kept current with `origin/main`

## Decision

Add one built-in, typed catalog named `recommended`. Preserve global GitHub as
the no-option core API, JSON, redirected-output, and non-TTY contract, while
making human discovery intuitive:

```text
allagents skill search <query> --catalog recommended
searchSkills(query, { catalog: 'recommended' })
searchInteractiveSkills(query) // Recommended, then deduplicated All GitHub
```

Without an explicit catalog or owner, both interactive search surfaces fetch a
catalog-bounded Recommended result set and the legacy global result set
concurrently after query submission. Recommended is rendered first. All GitHub
is rendered second after removing only identical canonical repository plus
qualified skill-path identities; display names alone never deduplicate. A
failure on one side is visibly reported and leaves the surviving side usable.

`--catalog` and `--owner` remain mutually exclusive and fail validation with
exit code 2. `--owner` remains global-only. When `--catalog recommended` is
present, the named catalog is a hard boundary: an empty result, source-health
failure, query-batch failure, or manifest failure never falls back to global
GitHub results. The catalog is not a marketplace registry; it describes
repositories, subtrees, valid marketplace-backed sources, search-only sources,
and external-lifecycle distributions without registering any of them in
`MarketplaceRegistry`.

The one user-facing catalog label is exactly **Recommended**. This is a
discovery label, not a security, trust, or license assertion. UI, JSON
documentation, and release notes must never call catalog entries “verified” or
“safe.” Every catalog result instead carries explicit source classification,
install policy, metadata, and warnings. Catalog membership must never claim
that a source is security-reviewed, license-approved, dependency-complete,
compatible with every client, or safe to bulk-install.

## Problem and observed repository state

`src/core/skill-search.ts` currently builds up to four global `filename:SKILL.md` GitHub Code Search queries, merges them by priority, filters hidden paths, ranks, enriches, deduplicates, and paginates. `SkillSearchOptions` has only `owner`, `page`, and `limit`. The CLI in `src/cli/commands/plugin-skills.ts` exposes the same three flags.

The interactive CLI currently loses source boundaries in two places:

1. `collectSelectedSkillSearchRepos()` reduces selected hits to `item.repo`.
2. `installFromSearch()` passes that repository root to `addPlugin()` or `addUserPlugin()`.

That is incorrect for two logical sources in one repository, such as `NousResearch/hermes-agent/skills` and `NousResearch/hermes-agent/optional-skills`. It also makes a selected skill-directory URL unsafe as an installation root: `src/core/transform.ts::copySkills()` copies only `SKILL.md` for a root-level standalone skill, while a repository or common subtree plus a qualified allowlist copies the complete selected skill directory recursively, including `references/`, scripts, and other sibling assets inside that directory.

Subpath identity is also currently collapsed:

- `src/core/workspace-modify.ts::resolveGitHubIdentity()` returns only lower-cased `owner/repo`.
- `findPluginEntryByGitHubIdentity()` and `canonicalizeGitHubPluginSource()` can promote two subtrees to their repository root.
- `src/cli/commands/plugin-skills.ts::recordSourceProvenance()` keys sync state by repository only.
- `src/core/sync.ts::buildSourcesProvenance()` also writes `sources[owner/repo]`.

Finally, clean clones currently fail before discovery. `src/core/git.ts::createGit()` supplies `filter.lfs.*` config values to `simple-git@3.30.0` but does not set `allowUnsafeFilter: true`. Clean-cache installs of `mattpocock/skills` and both Hermes subtrees hit simple-git's unsafe-filter rejection. Cache-seeded runs subsequently copied 36, 82, and 117 skills respectively with zero copy failures; those runs do not prove clean installability.

## Goals

1. Restrict search to one curated, static, versioned, typed source set when `catalog: 'recommended'` is requested.
2. Enforce canonical repository, effective ref, and exact segment-boundary subtree constraints in application code before ranking or pagination, with no global fallback.
3. Keep Hermes core and optional as different catalog identities even though they share one repository clone/cache.
4. Carry an exact install descriptor from catalog entry to selection, project workspace configuration, installation, and sync provenance.
5. Preserve complete skill directories by installing repository/common-subtree roots with qualified allowlists, never selected skill directories.
6. Respect marketplace manifests only for actual marketplace sources; never coerce plain repositories or subtrees into `MarketplaceRegistry`.
7. Surface category, homepage, author, SPDX metadata, suitability, license, lifecycle, dependency, and bulk-install warnings without a boolean trust field.
8. Separate read-only search/discovery provenance from actual install provenance.
9. Prove project-scoped installation from clean clones in disposable workspaces.
10. Require PR review, mandatory manifest validation, and read-only catalog health checks for catalog changes.

## Non-goals

- Replacing global GitHub search or changing its no-option default.
- Falling back to global GitHub when a named-catalog search cannot return a valid bounded result.
- Accepting arbitrary catalog refs in MVP. GitHub Code Search searches the repository default branch; non-default/tag/SHA refs remain out of scope until catalog search becomes ref-aware.
- Adding a user-selected catalog default to `workspace.yaml`; only provenance for an actual catalog install is persisted.
- Turning the catalog into a remote service, user-editable registry, marketplace registry, security scanner, vendored mirror, or repository mirror.
- Creating split generated/manual registries. There is one typed catalog object and one schema version.
- Adding a direct-to-main updater, shell-based catalog sync, or any mutation-capable catalog health command. Catalog changes arrive only through reviewed PRs.
- Adding a boolean `trusted`, `verified`, `safe`, or equivalent field. Suitability is represented by classification, install policy, warning codes, and health results.
- Provisioning MCP servers, Rube, API credentials, binaries, platform packages, browsers, or other skill dependencies.
- Declaring license compatibility or conducting legal/security approval.
- Automatically running upstream lifecycle scripts, especially gstack's setup/update flow.
- Bulk-installing optional or experimental sources by default.
- Making the broken nested Composio manifest installable.
- Adding `numman-ali/n-skills` itself as a source without a separate source-suitability decision; this revision incorporates its audited architectural decisions only.

## Public CLI and API contract

### CLI

Add to `src/cli/commands/plugin-skills.ts::searchCmd`:

```text
--catalog <name>   Restrict results to a built-in catalog. Initially: recommended.
```

Examples:

```text
allagents skill search testing --catalog recommended
allagents skill search testing --catalog recommended --page 2 --limit 10
allagents --json skill search testing --catalog recommended
```

Validation is centralized in `validateSkillSearchArgs()`:

- Unknown catalog: `Unknown skill catalog "<value>". Available catalogs: recommended.`
- Catalog plus owner: `--catalog and --owner cannot be used together.`
- Both are `SkillSearchError` with `kind: 'validation'`; CLI exit code remains 2 and JSON uses the existing failed command envelope.
- Existing query length, page, limit, owner, API, and rate-limit behavior remains unchanged.

TTY search uses ordered, visually distinct sections:

- no explicit catalog or owner: Recommended first, then deduplicated All GitHub;
- explicit `--catalog recommended`: Recommended only, with strict failures;
- explicit `--owner`: All GitHub only, scoped to that owner;
- installable catalog results remain grouped by exact `installSource` for mutation;
- search-only and external-lifecycle results remain visible but disabled;
- warnings are included in hints and repeated before optional installation;
- no source is preselected, and only explicitly selected skills are enabled;
- one source is fetched/configured once and selected qualified selectors share one allowlist update;
- all source mutations complete before one project/user sync.

Non-TTY and JSON no-catalog output keep the legacy global result/table or JSON
envelope. JSON remains authoritative for full warnings. Neither path invokes a
catalog query unless `--catalog recommended` is explicit.

The full-screen TUI action
`src/cli/tui/actions/skills.ts::runSearchOnlineSkills()` uses the same
`searchInteractiveSkills()` provider and presentation rows. Selection keys map
back to the exact result, and catalog selections flow through the shared exact
descriptor transaction rather than reconstructing a repository source.

### Core API

In `src/core/skill-search.ts`:

```ts
export type SkillCatalogName = 'recommended';

export interface SkillSearchOptions {
  owner?: string;
  catalog?: SkillCatalogName;
  page?: number;
  limit?: number;
}
```

Extend `SkillSearchItem` additively. Replace boolean installability with an explicit policy enum; it describes supported behavior and is not a trust signal:

```ts
installSource: string;
installSelector: string;
installation: {
  policy: 'repository-install' | SkillCatalogInstallPolicy;
  reasonCodes: readonly string[];
};
catalog?: {
  name: SkillCatalogName;
  label: 'Recommended';
  version: 1;
  identity: string;
  sourceId: string;
  classification: SkillCatalogClassification;
  sourceKind: SkillCatalogSourceKind;
  category: SkillCatalogCategory;
  homepage: string;
  author: SkillCatalogAuthor;
  spdxLicense: string | null;
  warnings: readonly SkillCatalogWarning[];
  discovery: CatalogDiscoveryProvenance;
  installDescriptor: CatalogInstallDescriptor;
};
```

For global search, `installSource` is canonical `owner/repo`, `installSelector` is the existing qualified name, `installation.policy` is `repository-install`, and `catalog` is absent. This preserves existing default search/install behavior while eliminating downstream source reconstruction.

For catalog search, all catalog fields come from the matched source plus the bounded GitHub response. `SkillSearchResult` retains `query`, `items`, `total`, and `truncated`; no persistent catalog preference is added.

## One versioned typed catalog and source identity

Create `src/models/skill-catalog.ts` for data-independent catalog types plus `CatalogInstallDescriptorSchema`, and `src/core/skill-catalog.ts` for the single immutable catalog object, stable source IDs, metadata, lookup helpers, identity construction, path-boundary helpers, and warning text. This keeps `src/models/workspace-config.ts` from importing a core module. Neither file imports `src/core/marketplace.ts`, and there is no generated registry beside the manual catalog object.

```ts
export type SkillCatalogName = 'recommended';
export type SkillCatalogClassification =
  | 'recommended'
  | 'optional'
  | 'external-lifecycle';
export type SkillCatalogSourceKind =
  | 'repository'
  | 'subtree'
  | 'marketplace'
  | 'external-lifecycle';
export type SkillCatalogInstallPolicy =
  | 'direct-selective'
  | 'marketplace-selective'
  | 'search-only'
  | 'external-installer';
export type SkillCatalogBulkPolicy = 'allowed' | 'explicit-only' | 'forbidden';
export type SkillCatalogCategory =
  | 'software-engineering'
  | 'business-operations'
  | 'integrations'
  | 'general-purpose'
  | 'agent-engineering'
  | 'documentation'
  | 'knowledge-work';

export interface SkillCatalogAuthor {
  name: string;
  url: string;
}

export interface SkillCatalogWarning {
  code:
    | 'not-security-reviewed'
    | 'license-metadata'
    | 'license-ambiguous'
    | 'external-dependencies'
    | 'external-lifecycle'
    | 'broken-marketplace'
    | 'large-source'
    | 'optional-source';
  message: string;
}

export interface SkillCatalogSource {
  sourceId: string;
  repo: `${string}/${string}`;
  effectiveRef: string;
  approvedRoot: '.' | string;
  installRoot: '.' | string;
  installSource: string;
  installableSubpath?: string;
  displayName: string;
  description: string;
  category: SkillCatalogCategory;
  homepage: string;
  author: SkillCatalogAuthor;
  spdxLicense: string | null;
  classification: SkillCatalogClassification;
  sourceKind: SkillCatalogSourceKind;
  installPolicy: SkillCatalogInstallPolicy;
  bulkPolicy: SkillCatalogBulkPolicy;
  manifestBoundary: 'none' | 'authoritative';
  warnings: readonly SkillCatalogWarning[];
}

export interface SkillCatalog {
  schemaVersion: 1;
  name: 'recommended';
  label: 'Recommended';
  sources: readonly SkillCatalogSource[];
}
export const RECOMMENDED_SKILL_CATALOG: SkillCatalog = Object.freeze({
  schemaVersion: 1,
  name: 'recommended',
  label: 'Recommended',
  sources: Object.freeze(RECOMMENDED_SOURCE_ENTRIES),
});
```

`RECOMMENDED_SOURCE_ENTRIES` is a private, same-file typed constant populated exactly from the source and metadata tables below. It is not a second registry and is not emitted by a generator.

Stable `sourceId` values are borrowed as a design rule from the `numman-ali/n-skills` audit: kebab-case, human-assigned, never derived from display text, never reused, and unchanged when metadata changes. There is one catalog schema version. Increment it only for a catalog schema/semantic change, not ordinary source metadata edits.

Catalog identity is never repository identity. Define one constructor used by search, selection, config, and sync state:

```ts
catalogSourceIdentity({
  catalog: 'recommended',
  sourceId,
  effectiveRef,
  approvedRoot,
}): string
```

Its canonical serialized form is `recommended:<sourceId>@<effectiveRef>#<approvedRoot>`, using `.` for repository root. These four fields are mandatory and are the identity components. `repo` remains an explicit validated descriptor field but is never the sole deduplication, install, or provenance key.

`effectiveRef` is mandatory and, in MVP, must equal the repository's current default branch because GitHub Code Search is not arbitrary-ref-aware. `approvedRoot` is the hard search boundary; `.` means repository root. `installableSubpath` may narrow installation inside that boundary. `installSource` must encode the same repository, effective ref, and installation root, for example `NousResearch/hermes-agent@main/optional-skills`.

Invariants checked by unit and manifest validation:

- Stable source IDs and full catalog identities are unique; Hermes may share `repo` but never identity.
- Paths are normalized POSIX-relative segment paths with no leading/trailing slash, empty segment, `.` segment (except root sentinel), or `..` segment.
- Each `effectiveRef` equals the upstream default branch observed by the read-only health check; arbitrary refs fail validation in MVP.
- `installSource` parses back to the same repo/ref and `installRoot`.
- `external-installer` and `search-only` require `bulkPolicy: 'forbidden'`; optional entries require `explicit-only` or `forbidden`.
- Marketplace entries require `manifestBoundary: 'authoritative'`; plain repository/subtree entries require `none`.
- `spdxLicense: null` means no single catalog-asserted SPDX identifier, not “unlicensed.”
- Every entry includes the common `not-security-reviewed` warning through a shared helper, not duplicated strings.

`approvedRoot` is the search boundary. `installRoot` is the exact root cloned/resolved for installation and may be broader only when asset preservation or marketplace semantics require it. `installableSubpath` may narrow install eligibility inside the approved search boundary. All matching uses path segments, never string-prefix approximation.

## Initial source list and classifications

The `recommended` catalog is the name of the built-in catalog, not a claim that every member is generally recommended. It contains all entries below so users can search a known set while seeing each source's actual classification.

In this plan, `optional` is the optional/experimental classification requested by the product contract. The final five rows are the broadly reusable candidates sourced from EntityProcess's `ai-research-wiki` and rechecked against their upstream repositories: Anthropic Skills, Addy Osmani Agent Skills, Superpowers, Context Engineering Skills, and Anthropic Knowledge Work Plugins.

| Source ID | Repository | Effective ref | Approved root | Classification | Kind / install / bulk policy | Install source and audited facts |
|---|---|---|---|---|---|---|
| `gstack` | `garrytan/gstack` | `main` | `.` | `external-lifecycle` | `external-lifecycle` / `external-installer` / `forbidden` | `garrytan/gstack@main`; no AllAgents install action. 64 `SKILL.md`; MIT. Full distribution requires checkout, build/setup, host-specific generation, and updates. Generic copying is not a substitute. |
| `paperclip-companies` | `paperclipai/companies` | `main` | `.` | `optional` | `repository` / `direct-selective` / `explicit-only` | `paperclipai/companies@main`, installable only under `skills/`. Root-plus-qualified-allowlist preserves assets. 523 `SKILL.md` in the tree; supported root discovery exposes `company-creator` and `readme-updater`; all other hits are search-only. Licensing is ambiguous. |
| `mattpocock-skills` | `mattpocock/skills` | `main` | `.` | `recommended` | `marketplace` / `marketplace-selective` / `allowed` | `mattpocock/skills@main`; valid root marketplace manifest is authoritative. 36 recursive discoveries; MIT. |
| `composio-awesome-claude-skills` | `ComposioHQ/awesome-claude-skills` | `master` | `.` | `optional` | `repository` / `search-only` / `forbidden` | `ComposioHQ/awesome-claude-skills@master`; no generic/marketplace install. 864 discoverable directories; nested manifest has 107 missing/misresolved source paths; most skills require Rube/MCP; licensing is incomplete. |
| `hermes-core` | `NousResearch/hermes-agent` | `main` | `skills` | `recommended` | `subtree` / `direct-selective` / `allowed` | `NousResearch/hermes-agent@main/skills`; 82 skills; MIT. Exact boundary rejects optional and unrelated paths. |
| `hermes-optional` | `NousResearch/hermes-agent` | `main` | `optional-skills` | `optional` | `subtree` / `direct-selective` / `explicit-only` | `NousResearch/hermes-agent@main/optional-skills`; 117 skills; MIT; many platform/API/binary/service requirements. Never default bulk-install. |
| `anthropic-skills` | `anthropics/skills` | `main` | `skills` | `recommended` | `marketplace` / `marketplace-selective` / `allowed` | `anthropics/skills@main`, installed from repository root through its authoritative manifest. 20 audited skills; per-skill/repository license metadata caveat. |
| `addyosmani-agent-skills` | `addyosmani/agent-skills` | `main` | `skills` | `recommended` | `subtree` / `direct-selective` / `allowed` | `addyosmani/agent-skills@main/skills`; 24 audited skills; MIT. |
| `obra-superpowers` | `obra/superpowers` | `main` | `skills` | `recommended` | `subtree` / `direct-selective` / `allowed` | `obra/superpowers@main/skills`; 14 audited skills; MIT. |
| `context-engineering-skills` | `muratcankoylan/Agent-Skills-for-Context-Engineering` | `main` | `skills` | `recommended` | `repository` / `direct-selective` / `allowed` | `muratcankoylan/Agent-Skills-for-Context-Engineering@main`, repository root plus qualified allowlist; 23 repo-wide audited skills; MIT. |
| `anthropic-knowledge-work` | `anthropics/knowledge-work-plugins` | `main` | `.` | `recommended` | `marketplace` / `marketplace-selective` / `allowed` | `anthropics/knowledge-work-plugins@main`; local root marketplace plugins only. 212 audited skills; Apache-2.0. Unsupported remote URL/git-subdir entries fail closed. |

Metadata is mandatory catalog data, not runtime inference:

| Source ID | Category | Author | Author URL | Homepage | SPDX |
|---|---|---|---|---|---|
| `gstack` | `software-engineering` | Garry Tan | `https://github.com/garrytan` | `https://github.com/garrytan/gstack` | `MIT` |
| `paperclip-companies` | `business-operations` | Paperclip AI | `https://github.com/paperclipai` | `https://github.com/paperclipai/companies` | `null` |
| `mattpocock-skills` | `software-engineering` | Matt Pocock | `https://github.com/mattpocock` | `https://aihero.dev/skills` | `MIT` |
| `composio-awesome-claude-skills` | `integrations` | Composio | `https://github.com/ComposioHQ` | `https://github.com/ComposioHQ/awesome-claude-skills` | `null` |
| `hermes-core` | `general-purpose` | Nous Research | `https://github.com/NousResearch` | `https://github.com/NousResearch/hermes-agent` | `MIT` |
| `hermes-optional` | `integrations` | Nous Research | `https://github.com/NousResearch` | `https://github.com/NousResearch/hermes-agent` | `MIT` |
| `anthropic-skills` | `general-purpose` | Anthropic | `https://github.com/anthropics` | `https://github.com/anthropics/skills` | `null` |
| `addyosmani-agent-skills` | `software-engineering` | Addy Osmani | `https://github.com/addyosmani` | `https://skills.addy.ie` | `MIT` |
| `obra-superpowers` | `software-engineering` | obra | `https://github.com/obra` | `https://github.com/obra/superpowers` | `MIT` |
| `context-engineering-skills` | `agent-engineering` | Murat Can Koylan | `https://github.com/muratcankoylan` | `https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering` | `MIT` |
| `anthropic-knowledge-work` | `knowledge-work` | Anthropic | `https://github.com/anthropics` | `https://github.com/anthropics/knowledge-work-plugins` | `Apache-2.0` |

`null` SPDX values deliberately preserve licensing ambiguity or mixed/per-skill metadata. The order above is stable catalog order and the final relevance tie-breaker. Counts are audit evidence and drift sentinels, not runtime acceptance limits; upstream additions/removals do not automatically change classification or policy.

## Catalog search algorithm

### Query construction

Keep `buildSearchQueries(query, owner)` for global search. Add catalog-specific construction rather than overloading owner semantics:

1. Resolve `getSkillCatalog('recommended')` and deduplicate canonical repositories case-insensitively for network efficiency only. This does not deduplicate catalog identities; Hermes remains two sources.
2. Read-only preflight each unique repository through GitHub's repository/ref API. Require its default branch to equal every entry's `effectiveRef` and resolve the current head SHA. A mismatch or unavailable ref fails the named-catalog search with no global fallback. This constraint is why arbitrary refs are out of MVP.
3. Build the same semantic variants used today: path term, hyphenated content when applicable, and primary content. Catalog search omits query-as-owner because repository qualifiers define scope.
4. Batch repository qualifiers deterministically so each unencoded GitHub query stays below a documented 240-character internal ceiling. Each batch is emitted as a parenthesized OR group of exact `repo:owner/name` qualifiers. Never use `user:` or a broad owner qualifier for catalog mode.
5. Fetch page 1 at 100 results for advisory variants. For each primary batch, fetch enough 100-result pages to cover `page * limit * 3`, capped by GitHub's existing 1,000-result ceiling.
6. Dispatch independent query batches with `Promise.allSettled`. Any required repository/ref preflight or primary batch failure fails catalog search. Advisory failures may warn and merge survivors only when all catalog boundaries remain intact; none may trigger global search.

Unit tests must assert the literal qualifier set, deterministic batching, query-length ceiling, omission of non-catalog repositories, one network repository qualifier for Hermes, two Hermes catalog identities, default-ref enforcement, and no fallback calls.

### Application-side source enforcement

GitHub query qualifiers are only a first filter. Before `rankByRelevance()`, `truncateForProcessing()`, enrichment, name deduplication, or pagination:

1. Canonicalize response `repository.full_name` to lower case and require an exact catalog repository match.
2. Bind the response to the preflighted default branch/head and the entry's `effectiveRef`; never relabel a default-branch result as an arbitrary ref.
3. Normalize API paths as POSIX relative paths; reject empty paths, absolute paths, `.`/`..` segments, backslashes, and any basename other than `SKILL.md`.
4. Match `approvedRoot` by path segments:
   - `.` matches any valid path in that repository;
   - `skills` matches `skills/<...>/SKILL.md` and never `skills-old/...`;
   - `optional-skills` matches `optional-skills/<...>/SKILL.md` and never `optional-skills-old/...`;
   - exact boundary checks are case-sensitive because Git paths are case-sensitive.
5. If multiple entries in one repository match, select the entry with the longest matching `approvedRoot`; use stable catalog order only as a final tie-breaker.
6. Derive `installSelector` relative to `installRoot`. For repository roots with a `skills/` directory, strip the leading `skills/`; for subtree roots, strip the root. Preserve intermediate namespace segments so duplicate leaf names remain distinguishable.
7. Derive `installation.policy`, never a boolean:
   - `external-installer` and `search-only` remain those exact policies;
   - Paperclip hits outside exact `skills/`, or not resolvable by root discovery, become `search-only` with reason codes;
   - marketplace hits remain `marketplace-selective`, but the picker enables them only after manifest preflight resolves the selected path to a valid local plugin;
   - direct subtree/repository hits inside their installation boundary remain `direct-selective`.
8. Attach catalog identity, metadata, warning codes, discovery provenance, and exact install descriptor, then continue the existing hidden-directory filter, relevance scoring, enrichment, per-name cap, and pagination.

Catalog deduplication keys are `catalog identity + path`; repository alone is never a catalog key. Global mode retains `repo + qualifiedName`. Stable ordering for equal relevance scores is catalog order, repository, then path; do not depend on network completion order.

`total` is the application-filtered, de-duplicated working total. `truncated` is true if any GitHub batch is incomplete/capped or if additional filtered pages exist. Zero bounded hits returns zero catalog hits, not global results.

## Search-to-install design

Replace `collectSelectedSkillSearchRepos()` with `collectSelectedSkillSearchSources()` in `src/cli/commands/plugin-skills.ts`. A selection key is `catalog identity + repository path`; path or repository alone is insufficient.

```ts
interface SelectedSkillSearchSource {
  catalogIdentity?: string;
  installDescriptor?: CatalogInstallDescriptor;
  installSource: string;
  installPolicy: 'repository-install' | SkillCatalogInstallPolicy;
  classification?: SkillCatalogClassification;
  warnings: readonly SkillCatalogWarning[];
  selectors: string[];
}
```

Collection rules:

- Preserve displayed result order.
- Group catalog hits by full catalog identity and exact install descriptor, never by repo. Global hits continue grouping by normalized `installSource`.
- Deduplicate selectors within an identity while preserving order.
- Never merge `hermes-core` and `hermes-optional`.
- Reject selected keys absent from the current bounded result set.
- Global results continue to group at repository root and use the existing whole-repository install behavior.

For catalog direct-selective groups:

1. Fetch the repository once, resolving the declared common root.
2. Discover from that root and require every selected qualified selector to resolve exactly.
3. Upsert one plugin entry whose `source` is the catalog `installSource` and whose `skills` array contains selected qualified selectors plus any existing selectors for that exact source.
4. Do not promote the source to a broader common repository root.
5. Sync once after all selected groups are configured.

For catalog marketplace-selective groups:

1. Fetch/register the root as a marketplace using existing manifest semantics.
2. Resolve each selected hit to a valid manifest plugin and local skill path. A manifest is authoritative; recursive paths outside it are not installed.
3. Add only the required `plugin@marketplace` entries and set per-plugin qualified allowlists.
4. Reject remote manifest source types unsupported by the current installer rather than treating their paths as local.
5. Sync once after all groups are configured.

For optional groups, display warnings and require an explicit confirmation after selection. For `search-only` and `external-installer`, disable selection; if a stale/programmatic selection reaches the installer, return a validation-style error before config mutation. The external error includes the upstream lifecycle URL. No lifecycle script is executed by AllAgents.

## Discovery provenance, install descriptor, and persisted provenance

Discovery and installation are different observations and must not overwrite each other.

```ts
export interface CatalogInstallDescriptor {
  catalog: 'recommended';
  catalogVersion: 1;
  sourceId: string;
  repo: `${string}/${string}`;
  effectiveRef: string;
  approvedRoot: '.' | string;
  installSource: string;
  installRoot: '.' | string;
  sourceKind: SkillCatalogSourceKind;
  installPolicy: SkillCatalogInstallPolicy;
}

export interface CatalogDiscoveryProvenance {
  catalogIdentity: string;
  provider: 'github-code-search';
  repo: `${string}/${string}`;
  effectiveRef: string;
  catalogVersion: 1;
  approvedRoot: '.' | string;
  repositoryHeadSha: string;
  skillPath: string;
  blobSha: string;
}
```

`CatalogDiscoveryProvenance` describes why a search hit was admitted: catalog identity, preflighted default ref/head, approved search root, response path, and Code Search blob SHA. It is returned in the search result and may be logged for diagnostics, but it is not installation proof.

`CatalogInstallDescriptor` is immutable input to installation. Before mutation, the installer must re-resolve the exact repo/ref/root, reject descriptor drift, and clone/fetch `effectiveRef`. Arbitrary caller-provided ref overrides are rejected in MVP.

Extend `src/models/workspace-config.ts::PluginEntrySchema` with an optional `catalogSource` object matching `CatalogInstallDescriptor`. Every catalog-originated project install writes it; user-scope installs use the same schema for consistency. The ordinary `source` remains the exact fetch/install spelling, including `@<effectiveRef>` and subpath. Marketplace plugin entries retain `plugin@marketplace` in `source` and use `catalogSource` to preserve the originating repo/ref/approved root/install root.

```yaml
plugins:
  - source: NousResearch/hermes-agent@main/skills
    skills: [research/llm-wiki]
    catalogSource:
      catalog: recommended
      catalogVersion: 1
      sourceId: hermes-core
      repo: NousResearch/hermes-agent
      effectiveRef: main
      approvedRoot: skills
      installSource: NousResearch/hermes-agent@main/skills
      installRoot: skills
      sourceKind: subtree
      installPolicy: direct-selective
```

This is an additive workspace-schema-v2 field, not a schema-version migration. It prevents later sync/update code from reconstructing a catalog source from repository alone.

Preserve existing repository-promotion behavior for non-catalog `skill add` by making matching mode explicit in `upsertGitHubPluginSourceAllowlistInConfig()` and project/user wrappers:

```ts
{ identity: 'repository-promoting' | 'catalog-exact', catalogSource?: CatalogInstallDescriptor }
```

The default remains `repository-promoting`. Catalog installs require `catalog-exact`; they match/merge only identical full catalog identities and reject a conflicting descriptor. They never promote sibling catalog roots.

Extend `src/models/sync-state.ts::SyncStateSourceSchema` additively with optional `catalogSource` and `resolvedRoot`. Catalog sync-state keys are the canonical catalog identities:

```text
recommended:hermes-core@main#skills
recommended:hermes-optional@main#optional-skills
```

Actual install provenance is `{ catalogSource, resolvedRef, resolvedSha, resolvedRoot, pluginSpec }` captured after fetch/manifest resolution. It records the installed commit and root and is deliberately separate from the earlier discovery head/blob. The two Hermes records may share `resolvedSha` and physical repository cache, but never a state key. `src/core/plugin.ts::fetchCache` and `getPluginCachePath()` remain repository+ref keyed only for physical clone reuse.

`src/core/sync.ts::buildSourcesProvenance()` rebuilds the complete derived `sources` map. For catalog entries it requires persisted `catalogSource`, verifies source/ref/root consistency, and emits catalog-identity keys. For non-catalog entries it preserves existing keys. A legacy repo-only state record still parses and is replaced on the next full sync; workspace config is never inferred from old sync state.

Tests install core and optional in both orders and assert two workspace descriptors, two catalog-identity provenance keys, one physical cache identity, exact resolved roots/refs, and no promotion to repository root.

## Clean-clone fix

In `src/core/git.ts::createGit()`, set simple-git's `allowUnsafeFilter: true` alongside the existing `filter.lfs.*` config. Do not remove `GIT_LFS_SKIP_SMUDGE=1` or the LFS filter overrides; they prevent large LFS downloads during discovery/install. Do not apply a global user/repository git config.

Add a regression to `tests/unit/core/git.test.ts` that creates a disposable local origin and calls the real `cloneTo()` into an empty destination. The test must exercise the configured `filter.lfs.*` path so it fails with simple-git's unsafe-filter rejection if `allowUnsafeFilter` is removed. Assert clone success and expected tracked content; do not merely snapshot an options object.

This fix is stage zero for catalog install claims. A cache-seeded run is not acceptable evidence.

## Manifest validation, read-only health, and review gate

Create `src/core/skill-catalog-health.ts` with two reusable entry points:

```ts
validateSkillCatalog(catalog: SkillCatalog): CatalogValidationIssue[]
checkSkillCatalogHealth(catalog: SkillCatalog, deps): Promise<CatalogHealthReport>
```

`validateSkillCatalog()` is deterministic and offline: type/invariant checks, identity uniqueness, source/ref/root/install-source consistency, metadata presence, SPDX syntax when non-null, policy combinations, warning requirements, and absence of arbitrary refs.

`checkSkillCatalogHealth()` is networked but strictly read-only. It performs only GitHub GET requests and returns per-source statuses `healthy`, `drifted`, or `unreachable` with reason codes; it never clones, installs, writes config, updates refs, opens PRs, or executes source code. It checks:

1. repository exists and canonical name still matches;
2. default branch equals `effectiveRef` and the ref resolves;
3. `approvedRoot`, `installRoot`, and installable subpath exist at that ref;
4. representative `SKILL.md` paths remain within segment boundaries;
5. valid marketplace-selective entries have a parseable authoritative manifest at the effective ref;
6. every local manifest plugin source resolves inside `installRoot`, every selected skill path resolves inside `approvedRoot`, and no path escapes through `..`, absolute paths, symlinks, or misresolved relative sources;
7. search-only/external entries remain non-installable and retain required warning codes; Composio's broken nested manifest is reported as an expected health warning, never accepted as a marketplace manifest.

Create `scripts/validate-skill-catalog.ts`, importing the same catalog object and health functions. Add package scripts:

```json
"catalog:validate": "bun run scripts/validate-skill-catalog.ts --ci",
"catalog:health": "bun run scripts/validate-skill-catalog.ts --report"
```

Both modes are read-only. `--ci` fails on any static error, repository/ref/root drift, or invalid authoritative marketplace manifest. `--report` emits the same structured report for maintainers and exits nonzero for drift/unreachable sources; it never repairs anything.

Add a `Catalog Manifest` job to `.github/workflows/ci.yml` that installs project dependencies and runs `bun run catalog:validate` with the workflow's read-only `GITHUB_TOKEN` (`contents: read`; no write permissions). Configure the repository ruleset/branch protection before implementation merge so this job is required and catalog changes require at least one human approval; record that setting and the health report/upstream SHAs in the PR. Any modification to `src/core/skill-catalog.ts`, catalog validation, or catalog policy must arrive through that path. If the required-check/approval rule cannot be enabled, catalog implementation remains blocked. No direct-to-main updater or automated catalog-writing workflow is added.

## Exact repository changes

### New files

- `src/models/skill-catalog.ts`
  - Catalog/source/metadata/provenance types and Zod `CatalogInstallDescriptorSchema`; no catalog entries or registry data.
- `src/core/skill-catalog.ts`
  - Single schema-version-1 `Recommended` catalog, stable source IDs, explicit repo/ref/roots, metadata, warnings, identity constructor, and segment-boundary helpers.
- `src/core/skill-catalog-health.ts`
  - Offline validation and dependency-injected read-only GitHub health/manifest checks.
- `scripts/validate-skill-catalog.ts`
  - Read-only `--ci` and `--report` entry points over the same catalog/validator.
- `tests/unit/core/skill-catalog.test.ts`
  - Typed-data invariants, identity, metadata, policies, exact boundaries, and Hermes separation.
- `tests/unit/core/skill-catalog-health.test.ts`
  - Ref/root drift, manifest traversal/misresolution, status reporting, and zero-mutation dependency assertions.

- `tests/unit/models/skill-catalog.test.ts`
  - Descriptor schema acceptance/rejection and versioned serialization.

### Modified production and configuration files

- `src/core/skill-search.ts`
  - Add `catalog` option, policy/metadata/provenance result fields, default-ref preflight, deterministic repository batching, and hard-boundary filtering before rank/pagination.
  - Keep no-option global behavior, but never invoke it as catalog fallback.
- `src/cli/commands/plugin-skills.ts`
  - Add `--catalog`, catalog-identity selection grouping, exact-descriptor direct/marketplace installers, warnings, and one final sync.
  - Persist `catalogSource`; record actual install provenance separately from discovery provenance.
- `src/cli/metadata/plugin-skills.ts::skillsSearchMeta`
  - Document `--catalog`, mutual exclusion, Recommended label, policy/metadata/provenance JSON fields, no fallback, and arbitrary-ref exclusion.
- `src/cli/tui/actions/skills.ts::runSearchOnlineSkills`
  - Consume `installSource`; keep this TUI surface on global search in this change.
- `src/utils/plugin-path.ts`
  - Parse/render exact repo/ref/root descriptors and retain segment-safe path normalization; repository identity is not catalog identity.
- `src/models/workspace-config.ts::PluginEntrySchema`
  - Add optional typed `catalogSource: CatalogInstallDescriptor` while retaining workspace schema version 2.
- `src/core/workspace-modify.ts`
  - Add repository-promoting versus catalog-exact upsert mode and preserve/validate catalog descriptors.
- `src/core/user-workspace.ts`
  - Thread catalog-exact mode and descriptor through user-scoped allowlist upsert.
- `src/models/sync-state.ts::SyncStateSourceSchema`
  - Add optional catalog descriptor and resolved root while retaining sync-state schema version 1.
- `src/core/sync.ts::buildSourcesProvenance`
  - Emit full catalog-identity keys and exact root/ref install provenance.
- `src/core/git.ts::createGit`
  - Enable `allowUnsafeFilter` for the intentional fixed LFS filters.
- `package.json`
  - Add `catalog:validate` and `catalog:health` scripts.
- `.github/workflows/ci.yml`
  - Add the `Catalog Manifest` validation job with read-only token permissions; mark it required in the repository ruleset before merge.

`src/core/marketplace.ts` and `src/utils/marketplace-manifest-parser.ts` remain marketplace dependencies rather than catalog registries. Reuse their manifest schemas/resolution rules; do not store catalog entries in `MarketplaceRegistry`.

### Modified tests

- `tests/unit/core/skill-search.test.ts`
- `tests/unit/cli/skill-search-summary.test.ts`
- `tests/unit/cli/skills-add-standalone-install.test.ts`
- `tests/unit/core/github-skill-source-promotion.test.ts`
- `tests/unit/core/git.test.ts`
- `tests/unit/models/workspace-config.test.ts`
- `tests/unit/models/sync-state-schema.test.ts`
- `tests/e2e/plugin-skills.test.ts`

Add a focused TUI unit only if the existing action is first made dependency-injectable without production-only indirection; otherwise cover `installSource` through the exported selection helper and perform the TUI smoke check manually.

### Documentation and changelog

- `README.md` command table: add `allagents skill search <query> [--catalog recommended]`, label the catalog Recommended, and state global is the no-option default but never a catalog fallback.
- `docs/src/content/docs/docs/reference/cli.mdx`: add complete search syntax, flags, metadata/policy/provenance JSON fields, mutual exclusion, no-fallback behavior, default-ref-only MVP, and project config descriptor semantics.
- `docs/src/content/docs/docs/guides/marketplaces.mdx`: distinguish catalog sources from marketplaces and document authoritative-manifest validation without registering plain repositories.
- `CHANGELOG.md` under `Unreleased` / `Added`: Recommended catalog search, versioned source identity, exact ref/root descriptors, read-only health/CI validation, and warnings. Under `Fixed`: clean clone failure caused by simple-git unsafe LFS filter validation.

## Automated test matrix

### Catalog data and boundaries

- Every source row above is present with exact source ID, repository, effective ref, approved root, install root/source, classification, kind, install policy, bulk policy, metadata, SPDX value, and warnings.
- Catalog schema version and label are exactly `1` and `Recommended`.
- Full identity serialization includes catalog, source ID, effective ref, and approved root; repository-only keys reject.
- Unknown catalog rejects.
- `catalog + owner` rejects before token resolution or network access.
- `skills/x/SKILL.md` matches Hermes core.
- `optional-skills/x/SKILL.md` matches Hermes optional.
- `optional-skills-old/x/SKILL.md`, `skills-old/x/SKILL.md`, and `docs/x/SKILL.md` match neither Hermes entry.
- Repository case is normalized; Git path case is not.
- Absolute, traversal, backslash, and non-`SKILL.md` paths reject.
- Paperclip `skills/company-creator/SKILL.md` has `direct-selective` policy and ambiguous-license warning; a hit elsewhere in the repository has `search-only` policy.
- Composio and gstack results remain visible with different non-install policies.

### Query, ref, and merge behavior

- Catalog queries contain only exact catalog `repo:` qualifiers.
- Unique repository network preflight treats Hermes once while retaining two catalog identities.
- Default branch/ref mismatch fails catalog search; no global search function is called.
- Arbitrary requested ref, tag, or SHA rejects in MVP.
- Long qualifier sets split under the query ceiling without omission or duplication.
- Query-as-owner is absent in catalog mode.
- A forged response from a non-catalog repository is discarded.
- Segment-boundary filtering occurs before truncation, ranking, enrichment, and pagination; fill a first response page with out-of-boundary hits and prove valid later hits survive.
- A required preflight/primary batch failure fails the search. Zero bounded hits stays zero. Neither path falls back globally.
- Equal-score results have deterministic catalog/repository/path ordering.
- Global query literals and existing relevance tests remain unchanged.

### Selection and install behavior

- Selection keys distinguish identical paths and identical repositories under different catalog identities.
- Multiple skills from one full catalog identity/descriptor produce one group and ordered unique selectors.
- Hermes core and optional produce two groups.
- Catalog direct installs write an exact ref-qualified common root/subtree source, never a selected skill directory.
- Selected nested skill fixtures copy `SKILL.md`, `references/`, scripts, and nested assets.
- Project workspace entries persist full `catalogSource`; marketplace plugin specs retain originating descriptor.
- Catalog-exact upsert retains two Hermes config entries in both install orders.
- Existing non-catalog sibling skill URLs still pass repository-promoting tests.
- Optional install requires confirmation; cancellation mutates nothing.
- Search-only/external stale selections fail before config/cache mutation.
- Marketplace selections outside an authoritative validated manifest fail closed.
- One selection transaction invokes one final sync.

### Provenance, validation, and clone behavior

- Discovery provenance contains bounded path/blob plus preflighted ref/head and is not reused as actual install provenance.
- Actual install provenance contains full descriptor, resolved ref/SHA/root, and catalog-identity state key.
- Real empty-destination clone succeeds with LFS filters enabled.
- Core and optional share physical repository cache/fetch but write two catalog-identity provenance records.
- Legacy repo-only sync-state input parses; next complete sync emits current catalog-identity keys and drops obsolete derived keys.
- Static catalog validation rejects missing metadata, invalid SPDX syntax, duplicate identity, illegal policy combinations, and non-default/arbitrary refs.
- Read-only health tests return `healthy`, `drifted`, or `unreachable`; injected mutating dependencies are never called.
- Authoritative marketplace manifest validation rejects missing/misresolved/escaping paths; Composio remains a warned search-only source.

### CLI and JSON

- `--catalog recommended` reaches `searchSkills()` and prints the Recommended label plus policy/warnings.
- Unknown catalog and catalog-owner conflict return exit 2 in text and JSON modes.
- JSON items contain exact install source/selector, policy reason codes, metadata, catalog identity, discovery provenance, and install descriptor; no `trusted`, `verified`, `safe`, or `installable` boolean exists.
- No-flag CLI and TUI searches remain global.
- Non-TTY mode never prompts or installs.

## Project-scoped disposable install matrix

Run this only after the clone regression and focused automated tests pass. From the implementation worktree, build once, capture the exact CLI path, then use that built CLI for every row:

```sh
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
bun run build
CLI="$REPO_ROOT/dist/index.js"
```

Each row gets a unique temporary `HOME` and project directory so no user cache, registry, credentials file, or workspace can make a clean clone appear successful. Initialize every row exactly as follows, execute the row's named catalog search and project install exercise from the matrix, inspect the three named outputs, then delete the case root:

```sh
CASE_ROOT="$(mktemp -d)"
export HOME="$CASE_ROOT/home"
mkdir -p "$HOME" "$CASE_ROOT/project"
cd "$CASE_ROOT/project"
"$CLI" init .
# Execute the matrix row's catalog search and project-scoped install attempt.
# Inspect .allagents/workspace.yaml, .allagents/sync-state.json,
# and .agents/skills/ (the initialized universal-client target).
rm -rf "$CASE_ROOT"
```

Do not run `git config` outside a disposable fixture. Record command, upstream HEAD SHA, selected selectors or manifest plugins, copied/failed counts, resulting source strings, warnings, and asset checks in the implementation PR description.

| Source | Clean project-scoped exercise | Required observation |
|---|---|---|
| gstack | Search catalog and attempt selection | `recommended:gstack@main#.` discovery stays bounded; picker blocks generic install and points to upstream lifecycle. No workspace mutation. |
| paperclip companies | Search, select `company-creator`, project install | Config source is `paperclipai/companies@main` with full descriptor and qualified allowlist; installed directory includes `references/`; ambiguous-license warning shown. |
| mattpocock skills | Search and install through manifest | Descriptor preserves `mattpocock/skills@main`; mandatory authoritative-manifest validation passes; recursive discoveries outside valid manifest resolution do not install. |
| Composio awesome skills | Search and attempt selection | Identity uses `@master#.`; results are optional/search-only with broken-manifest, dependency, and licensing warnings. No registration/install/config mutation. |
| Hermes core | Search and install selected core skills; separate explicit full disposable discovery check | Source is exactly `NousResearch/hermes-agent@main/skills`; config descriptor identity is `recommended:hermes-core@main#skills`; clean clone succeeds; discovery count is 82 at audited revision; selected copies have zero failures. |
| Hermes optional | Search and install one selected optional skill after warning; separate explicit full disposable discovery check | Source is exactly `NousResearch/hermes-agent@main/optional-skills`; config descriptor identity is `recommended:hermes-optional@main#optional-skills`; no default bulk selection; discovery count is 117; requirements warning shown. |
| Hermes core + optional | Install both in the same disposable project, then reverse order in a second project | Two ref/root-preserving config descriptors and two catalog-identity provenance keys, one physical cache, exact boundaries, zero source promotion. |
| anthropics skills | Search and marketplace-selective install | Descriptor preserves `anthropics/skills@main`, approved root `skills`, and repository install root; only manifest-declared local skill paths install; license-metadata warning remains visible. |
| addyosmani agent skills | Search and project-selective install | Exact `addyosmani/agent-skills@main/skills` source/descriptor, audited discovery count 24, complete selected directories, zero failures. |
| obra superpowers | Search and project-selective install | Exact `obra/superpowers@main/skills` source/descriptor, audited discovery count 14, complete selected directories, zero failures. |
| context engineering | Search and project-selective install | Descriptor preserves ref, approved `skills` root, and repository install root; audited discovery count 23, zero failures. |
| Anthropic knowledge work | Search and marketplace-selective install of local manifest entries | Descriptor preserves `anthropics/knowledge-work-plugins@main` root; audited search count 212; mandatory manifest validation passes for local entries; unsupported remote entries fail closed. |

Count drift is not automatically a failure. If upstream HEAD differs from the audited revision, record the new count and classify every delta before updating catalog expectations. Missing assets, boundary leakage, manifest misresolution, config collapse, clone failure, or any copy failure is a release blocker.

## Incorporated `numman-ali/n-skills` audit decisions

Architectural audit reference: `numman-ali/n-skills` commit `b1c6173aa7f83c569248996e1db1b9ae7afdb76f`.

Borrowed decisions, now reflected throughout this plan:

- stable human-assigned source IDs;
- one schema-versioned typed catalog;
- explicit repository, effective ref, approved search root, and install root;
- category, homepage, author, and nullable SPDX metadata;
- separate discovery provenance and actual install provenance;
- catalog identity composed from catalog name, source ID, effective ref, and approved root;
- PR review, mandatory authoritative-manifest validation, and read-only health reporting;
- segment-boundary application filtering and no global fallback;
- exact descriptor/root/ref persistence through project workspace config.

Explicitly not borrowed:

- vendoring or mirroring upstream content;
- a direct-to-main updater or automated registry writer;
- shell-based catalog synchronization;
- boolean trust/safety/verification fields;
- dependency installation or lifecycle execution;
- split generated and hand-maintained registries.

The audit commit informs architecture but does not, by itself, add `numman-ali/n-skills` as a catalog source. Adding it later requires an evidence-backed source row, classification, ref/root, metadata, manifest policy, warnings, disposable project install, health result, and reviewed PR. No finding is invented here.

## Migration and compatibility

- Workspace schema remains version 2 with an additive optional `catalogSource` descriptor. Existing entries parse unchanged; catalog-originated entries never drop this descriptor during modify/sync/update.
- Sync-state schema remains version 1 with additive optional catalog descriptor/resolved-root fields. `sources` is derived state; a full sync replaces obsolete repository-only catalog provenance with full catalog-identity keys.
- Existing global `searchSkills()` calls, JSON no-catalog output, and redirected no-catalog output preserve their behavior.
- TTY no-owner/no-catalog discovery is intentionally additive: it uses the new interactive provider and shows Recommended before deduplicated All GitHub.
- Existing `--owner`, pagination, rate-limit, relevance, and global install behavior remain intact; owner scope never injects catalog sources from other owners.
- Marketplace registries are neither seeded nor modified merely by searching or health checking. Registration occurs only after explicit install selection for a valid marketplace entry.
- No migration guesses catalog provenance for pre-existing repository entries. Only a future explicit catalog install/update can attach a descriptor.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| GitHub Code Search ignores/misparses a large repository qualifier expression. | Deterministic short query batches, literal query tests, application-side exact repository/root filtering, fatal required-batch failures, no fallback. |
| Search result comes from a different ref than installation. | MVP requires catalog ref to equal upstream default; read-only preflight binds discovery head; exact descriptor forces install ref; provenance remains separate. |
| Boundary prefix error leaks `optional-skills-old`. | Segment-based approved-root matcher with adversarial cases before ranking/pagination. |
| Combined interactive discovery increases request count and can hit Code Search rate limits. | Resolve authentication once, fetch catalog and global sets concurrently with independent limits, label section-local failures, preserve surviving results, and never reinterpret a failed strict catalog query as global. |
| Search results advertise paths a manifest cannot install. | Mandatory authoritative-manifest CI validation plus install-time preflight; fail closed. |
| Two Hermes entries collapse in config or state. | Full catalog identity, persisted exact descriptors, catalog-exact upsert, two-order E2E matrix. |
| Selected skill loses assets. | Explicit install root plus qualified allowlist; asset-bearing fixture and Paperclip `references/` check. |
| Optional source installs hundreds of skills accidentally. | `bulkPolicy: 'explicit-only'`, no preselection, warning confirmation, stale-selection guard. |
| Recommended label is mistaken for endorsement. | Required warnings and metadata; never expose verified/safe/trusted booleans or wording. |
| Upstream ref/layout/count/license changes. | Read-only health report and required CI validation; record upstream SHA; catalog changes only through reviewed PRs. |
| Health tooling mutates upstream/local state. | GET-only dependency surface, mutation-negative tests, no repair/update mode. |
| LFS workaround weakens git safety globally. | Set `allowUnsafeFilter` only on the controlled `simple-git` instance with fixed filter keys; never accept user-supplied filters or alter global git config. |

## Staged execution order

1. **Fix clean clones first.** Add `allowUnsafeFilter`, the real local-clone regression, and confirm clean remote Matt/Hermes clones reach discovery.
2. **Add the one versioned catalog and validator.** Land stable IDs, metadata, explicit refs/roots, full identity, policy enums, static invariants, and audited source rows.
3. **Add read-only health and CI manifest gate.** Implement GET-only checks, package scripts, required `Catalog Manifest` job, and review evidence format.
4. **Extend the core search API.** Add catalog option, default-ref preflight, qualifier batching, segment-boundary enforcement, metadata/discovery provenance, stable ordering, and no-fallback tests.
5. **Persist exact install descriptors.** Extend workspace/sync-state schemas additively; implement catalog-exact upsert and full catalog-identity provenance keys.
6. **Implement catalog-aware CLI selection/install.** Add flag/validation, identity grouping, exact direct/marketplace descriptors, warnings, one-sync transaction, and stale-selection guards.
7. **Update both interactive consumers.** Share concurrent grouped discovery and stable presentation rows; preserve exact catalog selection/install descriptors in the full-screen TUI.
8. **Run focused automated suites.** Catalog, health/manifest, search, selection, workspace identity, provenance, clone, and plugin-skills E2E.
9. **Run the disposable project matrix.** Fresh `HOME` per row, built CLI, actual remote sources, exact config/state/filesystem evidence.
10. **Update durable docs and changelog.** README, CLI reference, marketplace distinction, maintenance/review gate, and `Unreleased` entries.
11. **Final reviewed PR gate.** Attach health report/upstream SHAs, pass mandatory manifest CI, obtain human review, and verify the catalog is labeled Recommended without endorsement language.

## Implementation completion criteria

Implementation is complete only when:

- `allagents skill search <query> --catalog recommended` and `searchSkills(query, { catalog: 'recommended' })` enforce catalog/ref/root hard boundaries without global fallback;
- `--catalog` plus `--owner` and any arbitrary ref override fail as specified;
- all source rows expose exact IDs, refs/roots, metadata, classification, policy, warnings, and full identities;
- gstack and Composio cannot enter generic install flows;
- Paperclip preserves `company-creator/references`;
- Hermes core and optional remain distinct in result identity, selection, workspace descriptors, and actual install provenance;
- discovery and install provenance remain separate;
- clean clones succeed without cache seeding;
- authoritative marketplace manifests pass the required CI validator and install-time preflight;
- read-only health checks report drift without mutation;
- project workspace config preserves exact catalog install descriptor/root/ref through subsequent sync/update;
- global search remains the core API, JSON, non-TTY, and owner-scoped no-catalog default; interactive no-owner/no-catalog discovery shows Recommended first without becoming a named-catalog fallback;
- focused tests and every applicable disposable matrix row pass with evidence recorded in the implementation PR;
- the reviewed PR passes `Catalog Manifest` CI and README, CLI reference, marketplace guide, and changelog match the shipped contract.
