import type {
  CatalogDiscoveryProvenance,
  CatalogInstallDescriptor,
  SkillCatalogAuthor,
  SkillCatalogCategory,
  SkillCatalogClassification,
  SkillCatalogInstallPolicy,
  SkillCatalogName,
  SkillCatalogSourceKind,
  SkillCatalogWarning,
} from '../models/skill-catalog.js';
import {
  RECOMMENDED_SKILL_CATALOG,
  catalogInstallDescriptor,
  catalogSourceIdentity,
  matchCatalogSource,
  pathWithinCatalogRoot,
  relativeToCatalogRoot,
} from './skill-catalog.js';
import { parseSkillMetadata } from '../validators/skill.js';

/**
 * GitHub Code Search wrapper for `allagents skill search`.
 *
 * Mirrors upstream `gh skill search`: runs up to four parallel Code Search
 * queries with descending priority (path → hyphenated content → query-as-owner
 * → primary content) and merges the results. This is what surfaces skills
 * that live at `plugins/<thing>/skills/...` but whose SKILL.md content never
 * mentions `<thing>` — the path-targeted query finds them when the bare
 * content query can't.
 *
 * Auth is resolved by `resolveGhToken`: env vars first, then `gh auth token`
 * so that credentials from `gh auth login` are picked up automatically. See
 * cli/cli issue #13293 for upstream tracking.
 */

const OWNER_REGEX = /^[A-Za-z0-9-]{1,39}$/;
const SEARCH_PAGE_SIZE = 100;
const MAX_RESULTS = 1000;
const CATALOG_QUERY_MAX_LENGTH = 240;

/**
 * GitHub username pattern: starts and ends with alphanumeric, may contain
 * single hyphens in between, 1–39 chars total. Matches what GitHub allows
 * for user/org logins.
 */
const COULD_BE_OWNER_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

export interface SkillSearchItem {
  /** Skill folder name (parent directory of SKILL.md). */
  name: string;
  /**
   * Optional namespace segment from `skills/<namespace>/<name>/SKILL.md`.
   * Empty string when the path is `skills/<name>/SKILL.md` or otherwise
   * non-namespaced. Two repos with the same skill name in different
   * namespaces (`kynan/commit` vs `will/commit`) stay distinct.
   */
  namespace: string;
  /** `owner/repo` */
  repo: string;
  /** Path to SKILL.md inside the repo. */
  path: string;
  /** Skill description, enriched from SKILL.md frontmatter when available. */
  description: string;
  /** File blob SHA. */
  sha: string;
  /** Repository star count (0 when unavailable). */
  stars: number;
  /** Exact source passed to installation. */
  installSource: string;
  /** Qualified selector relative to the exact installation root. */
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
}

export interface SkillSearchResult {
  query: string;
  items: SkillSearchItem[];
  total: number;
  truncated: boolean;
}

export interface SkillSearchOptions {
  owner?: string;
  catalog?: SkillCatalogName;
  page?: number;
  limit?: number;
}

export type InteractiveSkillSearchSectionId = 'recommended' | 'github';

export interface InteractiveSkillSearchSection {
  id: InteractiveSkillSearchSectionId;
  label: 'Recommended' | 'All GitHub';
  items: SkillSearchItem[];
  truncated: boolean;
  error?: {
    kind: SkillSearchError['kind'] | 'unknown';
    message: string;
  };
}

export interface InteractiveSkillSearchResult {
  query: string;
  sections: InteractiveSkillSearchSection[];
}

type InteractiveSkillSearchDeps = {
  search?: (
    query: string,
    options: SkillSearchOptions,
  ) => Promise<SkillSearchResult>;
};

const ENRICHMENT_CONCURRENCY = 10;

export class SkillSearchError extends Error {
  constructor(
    message: string,
    public readonly kind: 'validation' | 'rate-limit' | 'api',
  ) {
    super(message);
    this.name = 'SkillSearchError';
  }
}

/**
 * Validate caller-supplied arguments. Throws SkillSearchError on bad input
 * so the CLI handler can format the message consistently.
 */
export function validateSkillSearchArgs(
  query: string,
  options: SkillSearchOptions,
): void {
  const requestedCatalog = options.catalog as string | undefined;
  if (requestedCatalog !== undefined && requestedCatalog !== 'recommended') {
    throw new SkillSearchError(
      `Unknown skill catalog "${requestedCatalog}". Available catalogs: recommended.`,
      'validation',
    );
  }
  if (options.catalog !== undefined && options.owner !== undefined) {
    throw new SkillSearchError(
      '--catalog and --owner cannot be used together.',
      'validation',
    );
  }
  if (query.trim().length < 2) {
    throw new SkillSearchError(
      'Search query must be at least 2 characters.',
      'validation',
    );
  }
  if (options.page !== undefined && options.page < 1) {
    throw new SkillSearchError('--page must be >= 1.', 'validation');
  }
  if (
    options.limit !== undefined &&
    (options.limit < 1 || options.limit > 100)
  ) {
    throw new SkillSearchError(
      '--limit must be between 1 and 100.',
      'validation',
    );
  }
  if (options.owner !== undefined && !OWNER_REGEX.test(options.owner)) {
    throw new SkillSearchError(
      `Invalid --owner "${options.owner}": GitHub owners are alphanumeric + dashes, ≤ 39 chars.`,
      'validation',
    );
  }
}

/**
 * Whether `query` could plausibly be a GitHub user/org login (so it's worth
 * speculatively searching `user:<query>` for skills owned by that account).
 *
 * Matches the same rules GitHub enforces for new logins.
 */
export function couldBeOwner(query: string): boolean {
  return COULD_BE_OWNER_REGEX.test(query);
}

/**
 * One Code Search query, with its merge priority. Lower priority numbers
 * sort earlier in the merged result list.
 */
export interface SkillSearchQuery {
  /** 1 = path, 2 = hyphenated content, 3 = query-as-owner, 4 = primary content. */
  priority: 1 | 2 | 3 | 4;
  /** Short label used in failure logging. */
  label: 'path' | 'hyphen' | 'owner' | 'primary';
  /** The `q=` querystring value (no URL encoding). */
  q: string;
}

/**
 * Build the Code Search query set, mirroring what `gh skill search` does.
 *
 * Always emits:
 *   - Priority 1 — `filename:SKILL.md path:<hyphenated>` (path search — finds
 *     skills nested under `plugins/<ns>/skills/<name>/` even when the SKILL.md
 *     body never mentions the query term; highest merge priority so path hits
 *     win dedup over content hits for the same skill)
 *   - Priority 4 — `filename:SKILL.md <query>` (primary content search)
 *
 * Conditionally emits:
 *   - Priority 2 — `filename:SKILL.md <hyphenated>` (only when the query has
 *     spaces, so both "build worker" and "build-worker" forms are tried)
 *   - Priority 3 — `filename:SKILL.md user:<query>` (only when no explicit
 *     `--owner` is set AND the query looks like a GitHub login)
 */
export function buildSearchQueries(
  query: string,
  owner: string | undefined,
): SkillSearchQuery[] {
  const trimmed = query.trim();
  const pathTerm = trimmed.replace(/ /g, '-');
  const userClause = owner ? `user:${owner}` : '';
  const join = (...parts: string[]) => parts.filter(Boolean).join(' ');

  // P1 always: path search — finds skills by directory path even when content
  // doesn't mention the query term (e.g. `plugins/cargowise/skills/*/SKILL.md`
  // when searching "cargowise").
  const queries: SkillSearchQuery[] = [
    {
      priority: 1,
      label: 'path',
      q: join('filename:SKILL.md', `path:${pathTerm}`, userClause),
    },
  ];

  if (pathTerm !== trimmed) {
    queries.push({
      priority: 2,
      label: 'hyphen',
      q: join('filename:SKILL.md', pathTerm, userClause),
    });
  }

  if (!owner && couldBeOwner(trimmed)) {
    queries.push({
      priority: 3,
      label: 'owner',
      q: `filename:SKILL.md user:${trimmed}`,
    });
  }

  // P4 always: primary content search.
  queries.push({
    priority: 4,
    label: 'primary',
    q: join('filename:SKILL.md', trimmed, userClause),
  });

  return queries;
}

export interface CatalogSkillSearchQuery extends SkillSearchQuery {
  batch: number;
  required: boolean;
  repositories: readonly string[];
}

/** Build deterministic repository-qualified Code Search batches. */
export function buildCatalogSearchQueries(
  query: string,
): CatalogSkillSearchQuery[] {
  const repositories = [
    ...new Map(
      RECOMMENDED_SKILL_CATALOG.sources.map((source) => [
        source.repo.toLowerCase(),
        source.repo,
      ]),
    ).values(),
  ];
  const trimmed = query.trim();
  const pathTerm = trimmed.replace(/ /g, '-');
  const variants: Array<
    Pick<SkillSearchQuery, 'priority' | 'label'> & {
      prefix: string;
      required: boolean;
    }
  > = [
    {
      priority: 1,
      label: 'path',
      prefix: `filename:SKILL.md path:${pathTerm}`,
      required: false,
    },
  ];
  if (pathTerm !== trimmed) {
    variants.push({
      priority: 2,
      label: 'hyphen',
      prefix: `filename:SKILL.md ${pathTerm}`,
      required: false,
    });
  }
  variants.push({
    priority: 4,
    label: 'primary',
    prefix: `filename:SKILL.md ${trimmed}`,
    required: true,
  });

  // GitHub Code Search applies repeated repo qualifiers as a repository union;
  // unlike a parenthesized OR expression, this syntax is accepted by the API.
  // Returned items are still checked against the same batch and catalog roots.
  return variants.flatMap((variant) =>
    batchCatalogRepositories(variant.prefix, repositories).map(
      (batch, index): CatalogSkillSearchQuery => ({
        priority: variant.priority,
        label: variant.label,
        q: `${variant.prefix} ${batch.map((repo) => `repo:${repo}`).join(' ')}`,
        batch: index,
        required: variant.required,
        repositories: batch,
      }),
    ),
  );
}

function batchCatalogRepositories(
  prefix: string,
  repositories: readonly string[],
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  for (const repository of repositories) {
    const candidate = [...current, repository];
    const query = `${prefix} ${candidate.map((repo) => `repo:${repo}`).join(' ')}`;
    if (query.length > CATALOG_QUERY_MAX_LENGTH && current.length > 0) {
      batches.push(current);
      current = [repository];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Map a GitHub API response to a SkillSearchError. The 403 / rate-limit body
 * has a distinctive `documentation_url` and `message` shape; everything else
 * falls back to a generic API error.
 */
function classifyApiError(status: number, body: unknown): SkillSearchError {
  const msg =
    typeof body === 'object' && body !== null && 'message' in body
      ? String((body as { message: unknown }).message ?? '')
      : '';
  if (status === 401) {
    return new SkillSearchError(
      'GitHub Code Search requires authentication. Run `gh auth login` or set GITHUB_TOKEN.',
      'api',
    );
  }
  if (status === 403 && /rate limit/i.test(msg)) {
    return new SkillSearchError(
      'GitHub Code Search rate limit exceeded. Authenticate with `gh auth login` or set GITHUB_TOKEN to raise the quota.',
      'rate-limit',
    );
  }
  if (status === 422) {
    return new SkillSearchError(
      `GitHub rejected the search query: ${msg || 'unprocessable entity'}.`,
      'api',
    );
  }
  return new SkillSearchError(
    `GitHub Code Search returned ${status}${msg ? `: ${msg}` : ''}.`,
    'api',
  );
}

/**
 * Resolve a GitHub API token for Code Search, mirroring the lookup order used
 * by the `gh` CLI:
 *   1. `GITHUB_TOKEN` env var
 *   2. `GH_TOKEN` env var
 *   3. `gh auth token` — reads the active credential from `gh`'s config/keyring
 *
 * Returns `undefined` when no credential is available (unauthenticated).
 */
export async function resolveGhToken(): Promise<string | undefined> {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  try {
    const { execFile } = await import('node:child_process');
    return await new Promise<string | undefined>((resolve) => {
      execFile('gh', ['auth', 'token'], { timeout: 3000 }, (err, stdout) => {
        resolve(err ? undefined : stdout.trim() || undefined);
      });
    });
  } catch {
    return undefined;
  }
}

/**
 * Render the namespace-qualified skill name (`<namespace>/<name>`) when a
 * namespace is set, or just `<name>` otherwise. Used as the dedup key
 * together with the repo full name.
 */
export function qualifiedName(
  item: Pick<SkillSearchItem, 'name' | 'namespace'>,
): string {
  return item.namespace ? `${item.namespace}/${item.name}` : item.name;
}

/**
 * Extract `(namespace, name)` from a Code Search `path` entry.
 *
 * Layouts handled:
 *   - `skills/<ns>/<name>/SKILL.md`   → { namespace: <ns>, name: <name> }
 *   - `<prefix>/skills/<ns>/<name>/SKILL.md` (plugin subdir)
 *                                     → { namespace: <ns>, name: <name> }
 *   - `skills/<name>/SKILL.md`        → { namespace: '',   name: <name> }
 *   - `<name>/SKILL.md`               → { namespace: '',   name: <name> }
 *   - `SKILL.md` at repo root         → { namespace: '',   name: <repoFallback> }
 *
 * Anything that doesn't fit drops to the bare parent-directory fallback.
 */
function parseSkillPath(
  path: string,
  repoFallback: string,
): { namespace: string; name: string } {
  const parts = path.split('/').filter(Boolean);

  // Find the last `skills` segment so nested layouts
  // (e.g., `plugins/foo/skills/<ns>/<name>/SKILL.md`) still parse.
  const skillsIdx = parts.lastIndexOf('skills');
  if (skillsIdx !== -1) {
    const afterSkills = parts.slice(skillsIdx + 1);
    // Drop a trailing SKILL.md segment (case-insensitive — the Code Search
    // API matches filename:SKILL.md against skill.md, SKILL.MD, etc.).
    const meaningful =
      afterSkills[afterSkills.length - 1]?.toLowerCase() === 'skill.md'
        ? afterSkills.slice(0, -1)
        : afterSkills;
    if (meaningful.length >= 2) {
      const namespace = meaningful[0] ?? '';
      const name = meaningful[1] ?? '';
      if (namespace && name) return { namespace, name };
    }
    if (meaningful.length === 1 && meaningful[0]) {
      // Only use the segment before `skills` as namespace when it sits inside a
      // `plugins/` directory (e.g. `plugins/cargowise/skills/<name>/SKILL.md`).
      // Hidden output dirs like `.agents/skills/` or `.copilot/skills/` must
      // not leak their directory name as a namespace.
      const nsFromPlugin =
        skillsIdx >= 2 && parts[skillsIdx - 2] === 'plugins'
          ? (parts[skillsIdx - 1] ?? '')
          : '';
      return { namespace: nsFromPlugin, name: meaningful[0] };
    }
  }

  // No `skills` segment — use the parent directory of the skill file as the name.
  // Skip the file itself (last segment) and use the directory before it.
  const lastPart = parts[parts.length - 1]?.toLowerCase() ?? '';
  const fileIdx = lastPart.endsWith('.md')
    ? parts.length - 2
    : parts.length - 1;
  if (fileIdx >= 0) {
    const parent = parts[fileIdx];
    if (parent) return { namespace: '', name: parent };
  }

  return { namespace: '', name: repoFallback };
}

/**
 * Result of running a single Code Search query.
 */
interface QueryRunResult {
  items: SkillSearchItem[];
  total: number;
  truncated: boolean;
}

/**
 * Issue one Code Search request and parse the response into SkillSearchItem.
 */
async function runOneQuery(
  q: string,
  page: number,
  limit: number,
  token: string | undefined,
  fetchFn: typeof fetch,
): Promise<QueryRunResult> {
  const url = new URL('https://api.github.com/search/code');
  url.searchParams.set('q', q);
  url.searchParams.set('per_page', String(limit));
  url.searchParams.set('page', String(page));

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'allagents-cli',
  };
  if (token) headers.Authorization = `token ${token}`;

  const response = await fetchFn(url.toString(), { headers });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // ignore — classifyApiError handles missing body gracefully
  }
  if (!response.ok) {
    throw classifyApiError(response.status, body);
  }

  const parsed = body as {
    total_count?: number;
    incomplete_results?: boolean;
    items?: Array<{
      path?: string;
      sha?: string;
      repository?: {
        full_name?: string;
        description?: string;
        stargazers_count?: number;
      };
    }>;
  };

  const items: SkillSearchItem[] = (parsed.items ?? []).map((item) => {
    const path = item.path ?? '';
    const repo = item.repository?.full_name ?? '';
    const repoFallback = repo.split('/').pop() ?? '';
    const { namespace, name } = parseSkillPath(path, repoFallback);
    return {
      name,
      namespace,
      repo,
      path,
      description: item.repository?.description ?? '',
      sha: item.sha ?? '',
      stars: item.repository?.stargazers_count ?? 0,
      installSource: repo,
      installSelector: namespace ? `${namespace}/${name}` : name,
      installation: {
        policy: 'repository-install',
        reasonCodes: [],
      },
    };
  });

  return {
    items,
    total: parsed.total_count ?? items.length,
    truncated: Boolean(parsed.incomplete_results),
  };
}

async function fetchPrimaryPages(
  q: string,
  page: number,
  limit: number,
  token: string | undefined,
  fetchFn: typeof fetch,
  acceptItem?: (item: SkillSearchItem) => boolean,
): Promise<QueryRunResult> {
  const needed = page * limit * 3;
  const requestedPages = Math.min(
    Math.max(1, Math.ceil(needed / SEARCH_PAGE_SIZE)),
    MAX_RESULTS / SEARCH_PAGE_SIZE,
  );
  const maxPages = acceptItem ? MAX_RESULTS / SEARCH_PAGE_SIZE : requestedPages;

  const items: SkillSearchItem[] = [];
  let accepted = 0;
  let total = 0;
  let truncated = false;

  for (let currentPage = 1; currentPage <= maxPages; currentPage += 1) {
    const result = await runOneQuery(
      q,
      currentPage,
      SEARCH_PAGE_SIZE,
      token,
      fetchFn,
    );
    items.push(...result.items);
    accepted += acceptItem
      ? result.items.filter(acceptItem).length
      : result.items.length;
    total = result.total;
    truncated = truncated || result.truncated;

    if (result.items.length < SEARCH_PAGE_SIZE) break;
    if (currentPage >= requestedPages && accepted >= needed) break;
  }
  truncated = truncated || items.length < Math.min(total, MAX_RESULTS);

  return { items, total, truncated };
}

/**
 * Run the multi-query Code Search and merge results.
 *
 * Behaviour:
 *   - Up to four queries are built via `buildSearchQueries` and dispatched in
 *     parallel with `Promise.allSettled`.
 *   - The primary content (priority 4) result is required: if it fails, the
 *     error propagates. Other queries are advisory — failures are logged and
 *     the surviving buckets still merge.
 *   - Items are concatenated in priority order (path=1 → hyphen=2 → owner=3
 *     → primary=4), then deduped by `repo + qualifiedName` keeping the first
 *     occurrence. Path hits win over content hits for the same skill.
 *
 * Auth is resolved by `resolveGhToken` (env vars → `gh auth token`) so
 * credentials from `gh auth login` are used automatically.
 */
export async function searchSkills(
  query: string,
  options: SkillSearchOptions = {},
  deps: {
    fetch?: typeof fetch;
    logger?: (msg: string) => void;
    tokenResolver?: () => Promise<string | undefined>;
  } = {},
): Promise<SkillSearchResult> {
  validateSkillSearchArgs(query, options);
  const fetchFn = deps.fetch ?? fetch;
  const logger =
    deps.logger ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  const page = options.page ?? 1;
  const limit = options.limit ?? 15;
  const token = await (deps.tokenResolver ?? resolveGhToken)();

  if (options.catalog === 'recommended') {
    return searchCatalogSkills(query, page, limit, token, fetchFn, logger);
  }

  const queries = buildSearchQueries(query, options.owner);
  const settled = await Promise.allSettled(
    queries.map((entry) =>
      entry.priority === 4
        ? fetchPrimaryPages(entry.q, page, limit, token, fetchFn)
        : runOneQuery(entry.q, 1, SEARCH_PAGE_SIZE, token, fetchFn),
    ),
  );

  // Locate the primary content (priority 4) result. If it failed, surface its error.
  const primaryIdx = queries.findIndex((q) => q.priority === 4);
  const primarySettled = settled[primaryIdx];
  if (primarySettled?.status === 'rejected') {
    throw primarySettled.reason;
  }

  // Collect successful buckets paired with their queries; log failures.
  type Bucket = { priority: number; result: QueryRunResult };
  const buckets: Bucket[] = [];
  for (let i = 0; i < queries.length; i++) {
    const entry = queries[i];
    const outcome = settled[i];
    if (!entry || !outcome) continue;
    if (outcome.status === 'fulfilled') {
      buckets.push({ priority: entry.priority, result: outcome.value });
    } else {
      // Non-primary failure — log and continue. Primary failures are handled above.
      const reason =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
      logger(`Warning: skill search "${entry.label}" query failed: ${reason}`);
    }
  }

  // Concatenate items in priority order (lower priority number first).
  buckets.sort((a, b) => a.priority - b.priority);
  const mergedItems = buckets.flatMap((b) => b.result.items);

  const deduped = dedupeItems(mergedItems);
  // Drop workspace-synced output paths. Repos that commit synced plugin files
  // to hidden output dirs (`.agents/skills/`, `.copilot/skills/`) produce
  // duplicate hits with identical content. Filter by the first path segment:
  // any segment starting with `.` is a hidden directory we never want to show.
  const visible = deduped.filter((item) => {
    const firstSegment = item.path.split('/')[0] ?? '';
    return !firstSegment.startsWith('.');
  });

  rankByRelevance(visible, query);
  const workingSet = truncateForProcessing(visible, page, limit);
  await Promise.all([
    fetchStarsForItems(workingSet, token, fetchFn),
    enrichDescriptionsForItems(workingSet, token, fetchFn),
  ]);

  const filtered = filterByRelevance(workingSet, query);
  rankByRelevance(filtered, query);
  const dedupedByName = deduplicateByName(filtered);
  const { items: finalItems, totalPages } = paginate(
    dedupedByName,
    page,
    limit,
  );

  return {
    query,
    items: finalItems,
    total: dedupedByName.length,
    truncated: buckets.some((b) => b.result.truncated) || totalPages > page,
  };
}

/**
 * Search provider for human-driven discovery.
 *
 * With no explicit catalog or owner, Recommended and global GitHub are fetched
 * independently and concurrently. This keeps catalog matches outside global
 * ranking/page limits. Explicit catalog and owner searches remain single-scope
 * and fail with the strict `searchSkills` contract.
 */
export async function searchInteractiveSkills(
  query: string,
  options: SkillSearchOptions = {},
  deps: InteractiveSkillSearchDeps = {},
): Promise<InteractiveSkillSearchResult> {
  const strictSearch = deps.search ?? searchSkills;

  if (options.catalog !== undefined) {
    const result = await strictSearch(query, options);
    return {
      query: result.query,
      sections: [
        {
          id: 'recommended',
          label: 'Recommended',
          items: result.items,
          truncated: result.truncated,
        },
      ],
    };
  }

  if (options.owner !== undefined) {
    const result = await strictSearch(query, options);
    return {
      query: result.query,
      sections: [
        {
          id: 'github',
          label: 'All GitHub',
          items: result.items,
          truncated: result.truncated,
        },
      ],
    };
  }

  const recommendedOptions: SkillSearchOptions = {
    ...options,
    catalog: 'recommended',
  };
  const sharedToken = deps.search ? undefined : resolveGhToken();
  const combinedSearch =
    deps.search ??
    ((searchQuery: string, searchOptions: SkillSearchOptions) =>
      searchSkills(searchQuery, searchOptions, {
        tokenResolver: () => sharedToken as Promise<string | undefined>,
      }));
  const [recommended, github] = await Promise.allSettled([
    combinedSearch(query, recommendedOptions),
    combinedSearch(query, options),
  ]);

  const recommendedItems =
    recommended.status === 'fulfilled' ? recommended.value.items : [];
  const recommendedIdentities = new Set(
    recommendedItems.map(interactiveSkillIdentity),
  );
  const githubItems =
    github.status === 'fulfilled'
      ? github.value.items.filter(
          (item) => !recommendedIdentities.has(interactiveSkillIdentity(item)),
        )
      : [];

  return {
    query,
    sections: [
      {
        id: 'recommended',
        label: 'Recommended',
        items: recommendedItems,
        truncated:
          recommended.status === 'fulfilled'
            ? recommended.value.truncated
            : false,
        ...(recommended.status === 'rejected' && {
          error: interactiveSearchError(recommended.reason),
        }),
      },
      {
        id: 'github',
        label: 'All GitHub',
        items: githubItems,
        truncated:
          github.status === 'fulfilled' ? github.value.truncated : false,
        ...(github.status === 'rejected' && {
          error: interactiveSearchError(github.reason),
        }),
      },
    ],
  };
}

/** Canonical repository plus exact discovered skill path. */
export function interactiveSkillIdentity(item: SkillSearchItem): string {
  const path = item.path.replace(/\\/g, '/').replace(/^\/+/, '');
  return `${item.repo.trim().toLowerCase()}#${path}`;
}

function interactiveSearchError(
  error: unknown,
): NonNullable<InteractiveSkillSearchSection['error']> {
  return {
    kind: error instanceof SkillSearchError ? error.kind : 'unknown',
    message: error instanceof Error ? error.message : String(error),
  };
}

interface CatalogRepositoryPreflight {
  repo: string;
  effectiveRef: string;
  headSha: string;
}

async function searchCatalogSkills(
  query: string,
  page: number,
  limit: number,
  token: string | undefined,
  fetchFn: typeof fetch,
  logger: (message: string) => void,
): Promise<SkillSearchResult> {
  const preflight = await preflightCatalogRepositories(token, fetchFn);
  const queries = buildCatalogSearchQueries(query);
  const settled = await Promise.allSettled(
    queries.map((entry) =>
      entry.required
        ? fetchPrimaryPages(
            entry.q,
            page,
            limit,
            token,
            fetchFn,
            (item) => attachCatalogSource(item, preflight) !== null,
          )
        : runOneQuery(entry.q, 1, SEARCH_PAGE_SIZE, token, fetchFn),
    ),
  );

  type CatalogBucket = {
    priority: number;
    batch: number;
    result: QueryRunResult;
  };
  const buckets: CatalogBucket[] = [];
  for (let index = 0; index < queries.length; index += 1) {
    const entry = queries[index];
    const outcome = settled[index];
    if (!entry || !outcome) continue;
    if (outcome.status === 'rejected') {
      if (entry.required) throw outcome.reason;
      const reason =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
      logger(
        `Warning: Recommended catalog "${entry.label}" batch ${entry.batch + 1} failed: ${reason}`,
      );
      continue;
    }
    buckets.push({
      priority: entry.priority,
      batch: entry.batch,
      result: outcome.value,
    });
  }
  buckets.sort(
    (left, right) => left.priority - right.priority || left.batch - right.batch,
  );

  const bounded = buckets
    .flatMap((bucket) => bucket.result.items)
    .map((item) => attachCatalogSource(item, preflight))
    .filter((item): item is SkillSearchItem => item !== null);
  const deduped = dedupeItems(bounded);
  const visible = deduped.filter((item) => {
    const firstSegment = item.path.split('/')[0] ?? '';
    return !firstSegment.startsWith('.');
  });

  rankCatalogByRelevance(visible, query);
  const workingSet = truncateForProcessing(visible, page, limit);
  await Promise.all([
    fetchStarsForItems(workingSet, token, fetchFn),
    enrichDescriptionsForItems(workingSet, token, fetchFn),
  ]);
  const filtered = filterByRelevance(workingSet, query);
  rankCatalogByRelevance(filtered, query);
  const dedupedByName = deduplicateByName(filtered);
  const { items, totalPages } = paginate(dedupedByName, page, limit);
  return {
    query,
    items,
    total: dedupedByName.length,
    truncated:
      buckets.some((bucket) => bucket.result.truncated) || totalPages > page,
  };
}

async function preflightCatalogRepositories(
  token: string | undefined,
  fetchFn: typeof fetch,
): Promise<ReadonlyMap<string, CatalogRepositoryPreflight>> {
  const sourcesByRepository = new Map<
    string,
    (typeof RECOMMENDED_SKILL_CATALOG.sources)[number]
  >();
  for (const source of RECOMMENDED_SKILL_CATALOG.sources) {
    const key = source.repo.toLowerCase();
    const existing = sourcesByRepository.get(key);
    if (existing && existing.effectiveRef !== source.effectiveRef) {
      throw new SkillSearchError(
        `Catalog repository ${source.repo} has conflicting effective refs.`,
        'validation',
      );
    }
    if (!existing) sourcesByRepository.set(key, source);
  }

  const headers = buildGitHubApiHeaders(token);
  const results = await Promise.all(
    [...sourcesByRepository.values()].map(async (source) => {
      const repositoryResponse = await fetchFn(
        `https://api.github.com/repos/${source.repo}`,
        { headers },
      );
      let repositoryBody: unknown = null;
      try {
        repositoryBody = await repositoryResponse.json();
      } catch {
        // Error classification below handles an empty body.
      }
      if (!repositoryResponse.ok) {
        throw classifyApiError(repositoryResponse.status, repositoryBody);
      }
      const repositoryFullName =
        repositoryBody &&
        typeof repositoryBody === 'object' &&
        'full_name' in repositoryBody &&
        typeof repositoryBody.full_name === 'string'
          ? repositoryBody.full_name
          : undefined;
      const defaultBranch =
        repositoryBody &&
        typeof repositoryBody === 'object' &&
        'default_branch' in repositoryBody &&
        typeof repositoryBody.default_branch === 'string'
          ? repositoryBody.default_branch
          : undefined;
      if (
        repositoryFullName?.toLowerCase() !== source.repo.toLowerCase() ||
        defaultBranch !== source.effectiveRef
      ) {
        throw new SkillSearchError(
          `Recommended catalog source ${source.sourceId} no longer resolves to ${source.repo}@${source.effectiveRef}.`,
          'api',
        );
      }

      const refResponse = await fetchFn(
        `https://api.github.com/repos/${source.repo}/git/ref/heads/${encodeURIComponent(source.effectiveRef)}`,
        { headers },
      );
      let refBody: unknown = null;
      try {
        refBody = await refResponse.json();
      } catch {
        // Error classification below handles an empty body.
      }
      if (!refResponse.ok) throw classifyApiError(refResponse.status, refBody);
      const refObject =
        refBody && typeof refBody === 'object' && 'object' in refBody
          ? refBody.object
          : undefined;
      const headSha =
        refObject &&
        typeof refObject === 'object' &&
        'sha' in refObject &&
        typeof refObject.sha === 'string'
          ? refObject.sha
          : undefined;
      if (!headSha) {
        throw new SkillSearchError(
          `Recommended catalog source ${source.sourceId} did not resolve a head SHA.`,
          'api',
        );
      }
      return {
        key: source.repo.toLowerCase(),
        value: {
          repo: source.repo,
          effectiveRef: source.effectiveRef,
          headSha,
        },
      };
    }),
  );
  return new Map(results.map((result) => [result.key, result.value]));
}

function attachCatalogSource(
  item: SkillSearchItem,
  preflight: ReadonlyMap<string, CatalogRepositoryPreflight>,
): SkillSearchItem | null {
  const repository = preflight.get(item.repo.toLowerCase());
  if (!repository) return null;
  const source = matchCatalogSource(item.repo, item.path);
  if (!source || source.effectiveRef !== repository.effectiveRef) return null;
  const relativePath = relativeToCatalogRoot(item.path, source.installRoot);
  if (relativePath === null || !relativePath.endsWith('/SKILL.md')) return null;

  let selector = relativePath.slice(0, -'/SKILL.md'.length);
  if (source.installRoot === '.' && selector.startsWith('skills/')) {
    selector = selector.slice('skills/'.length);
  }
  if (!selector) return null;

  let policy = source.installPolicy;
  const reasonCodes: string[] = [];
  if (
    source.installableSubpath &&
    !pathWithinCatalogRoot(item.path, source.installableSubpath)
  ) {
    policy = 'search-only';
    reasonCodes.push('outside-installable-subpath');
  }
  if (policy === 'search-only') reasonCodes.push('search-only-source');
  if (policy === 'external-installer') reasonCodes.push('external-lifecycle');

  const identity = catalogSourceIdentity({
    catalog: 'recommended',
    sourceId: source.sourceId,
    effectiveRef: source.effectiveRef,
    approvedRoot: source.approvedRoot,
  });
  return {
    ...item,
    installSource: source.installSource,
    installSelector: selector,
    installation: { policy, reasonCodes },
    catalog: {
      name: 'recommended',
      label: RECOMMENDED_SKILL_CATALOG.label,
      version: RECOMMENDED_SKILL_CATALOG.schemaVersion,
      identity,
      sourceId: source.sourceId,
      classification: source.classification,
      sourceKind: source.sourceKind,
      category: source.category,
      homepage: source.homepage,
      author: source.author,
      spdxLicense: source.spdxLicense,
      warnings: source.warnings,
      discovery: {
        catalogIdentity: identity,
        provider: 'github-code-search',
        repo: source.repo,
        effectiveRef: source.effectiveRef,
        catalogVersion: 1,
        approvedRoot: source.approvedRoot,
        repositoryHeadSha: repository.headSha,
        skillPath: item.path,
        blobSha: item.sha,
      },
      installDescriptor: catalogInstallDescriptor(source),
    },
  };
}

function rankCatalogByRelevance(items: SkillSearchItem[], query: string): void {
  const sourceOrder = new Map(
    RECOMMENDED_SKILL_CATALOG.sources.map((source, index) => [
      source.sourceId,
      index,
    ]),
  );
  items.sort((left, right) => {
    const score = relevanceScore(right, query) - relevanceScore(left, query);
    if (score !== 0) return score;
    const source =
      (sourceOrder.get(left.catalog?.sourceId ?? '') ??
        Number.MAX_SAFE_INTEGER) -
      (sourceOrder.get(right.catalog?.sourceId ?? '') ??
        Number.MAX_SAFE_INTEGER);
    return (
      source ||
      left.repo.localeCompare(right.repo) ||
      left.path.localeCompare(right.path)
    );
  });
}

/**
 * Drop duplicate hits by `repo + qualifiedName`. Same folder surfaced by
 * multiple query buckets (e.g. both `in:path` and content match) collapses to
 * one entry, with the higher-priority bucket's occurrence winning because
 * catalog entries use full identity + path; global entries use repository +
 * qualified name. Higher-priority query buckets win.
 */
function dedupeItems(items: SkillSearchItem[]): SkillSearchItem[] {
  const seen = new Set<string>();
  const out: SkillSearchItem[] = [];
  for (const item of items) {
    const key = item.catalog
      ? `${item.catalog.identity}#${item.path}`
      : `${item.repo}#${qualifiedName(item)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function splitRepo(item: Pick<SkillSearchItem, 'repo'>): {
  owner: string;
  repoName: string;
} {
  const [owner = item.repo, repoName = ''] = item.repo.split('/', 2);
  return { owner, repoName };
}

function relevanceScore(item: SkillSearchItem, query: string): number {
  const term = query.trim().toLowerCase();
  const termHyphen = term.replace(/ /g, '-');
  const name = item.name.toLowerCase();
  const namespace = item.namespace.toLowerCase();
  const description = item.description.toLowerCase();

  let score = 0;
  if (name === term || name === termHyphen) {
    score += 3000;
  } else if (name.includes(term) || name.includes(termHyphen)) {
    score += 1000;
  }

  if (namespace?.includes(term)) {
    score += 500;
  }

  if (description.includes(term)) {
    score += 100;
  }

  if (item.stars > 0) {
    score += Math.floor(Math.sqrt(item.stars) * 30);
  }

  return score;
}

function rankByRelevance(items: SkillSearchItem[], query: string): void {
  items.sort((a, b) => relevanceScore(b, query) - relevanceScore(a, query));
}

function filterByRelevance(
  items: SkillSearchItem[],
  query: string,
): SkillSearchItem[] {
  const term = query.trim().toLowerCase();
  const termHyphen = term.replace(/ /g, '-');

  return items.filter((item) => {
    const { owner, repoName } = splitRepo(item);
    return (
      item.name.toLowerCase().includes(term) ||
      item.name.toLowerCase().includes(termHyphen) ||
      item.namespace.toLowerCase().includes(term) ||
      item.description.toLowerCase().includes(term) ||
      owner.toLowerCase().includes(term) ||
      repoName.toLowerCase().includes(term)
    );
  });
}

function truncateForProcessing(
  items: SkillSearchItem[],
  page: number,
  limit: number,
): SkillSearchItem[] {
  const maxToProcess = Math.max(page * limit * 3, limit * 3);
  return items.length > maxToProcess ? items.slice(0, maxToProcess) : items;
}

function deduplicateByName(items: SkillSearchItem[]): SkillSearchItem[] {
  const maxPerName = 3;
  const counts = new Map<string, number>();
  const out: SkillSearchItem[] = [];

  for (const item of items) {
    const key = qualifiedName(item).toLowerCase();
    const count = counts.get(key) ?? 0;
    if (count >= maxPerName) continue;
    counts.set(key, count + 1);
    out.push(item);
  }

  return out;
}

function paginate(
  items: SkillSearchItem[],
  page: number,
  limit: number,
): { items: SkillSearchItem[]; totalPages: number } {
  if (items.length === 0) {
    return { items: [], totalPages: 0 };
  }

  const totalPages = Math.ceil(items.length / limit);
  const start = (page - 1) * limit;
  return {
    items: items.slice(start, start + limit),
    totalPages,
  };
}

/**
 * Fetch star counts for unique repos in parallel and annotate items in-place.
 * The GitHub Code Search API does not include stargazers_count in repository
 * objects, so we call /repos/{owner}/{repo} for each unique repo. Failures
 * are silently ignored (stars stay 0) so the search still succeeds.
 */
async function fetchStarsForItems(
  items: SkillSearchItem[],
  token: string | undefined,
  fetchFn: typeof fetch,
): Promise<void> {
  const uniqueRepos = [...new Set(items.map((i) => i.repo))];
  const headers = buildGitHubApiHeaders(token);

  const starsMap = new Map<string, number>();
  await forEachWithConcurrency(
    uniqueRepos,
    ENRICHMENT_CONCURRENCY,
    async (repo) => {
      try {
        const res = await fetchFn(`https://api.github.com/repos/${repo}`, {
          headers,
        });
        if (!res.ok) return;
        const body = (await res.json()) as { stargazers_count?: number };
        starsMap.set(repo, body.stargazers_count ?? 0);
      } catch {
        // ignore — stars stay 0
      }
    },
  );

  for (const item of items) {
    const s = starsMap.get(item.repo);
    if (s !== undefined) item.stars = s;
  }
}

async function enrichDescriptionsForItems(
  items: SkillSearchItem[],
  token: string | undefined,
  fetchFn: typeof fetch,
): Promise<void> {
  const headers = buildGitHubApiHeaders(token);

  const descriptionMap = new Map<string, string>();
  const uniqueSkills = [
    ...new Set(items.map((item) => `${item.repo}#${item.sha}`)),
  ];

  await forEachWithConcurrency(
    uniqueSkills,
    ENRICHMENT_CONCURRENCY,
    async (key) => {
      const [repo, sha] = key.split('#');
      if (!repo || !sha) return;

      try {
        const res = await fetchFn(
          `https://api.github.com/repos/${repo}/git/blobs/${sha}`,
          { headers },
        );
        if (!res.ok) return;

        const body = (await res.json()) as {
          content?: string;
          encoding?: string;
        };
        const content = decodeGitBlob(body.content, body.encoding);
        if (!content) return;

        const metadata = parseSkillMetadata(content);
        if (!metadata?.description) return;

        descriptionMap.set(key, metadata.description);
      } catch {
        // Ignore metadata fetch failures and keep the repo description fallback.
      }
    },
  );

  for (const item of items) {
    const description = descriptionMap.get(`${item.repo}#${item.sha}`);
    if (description) item.description = description;
  }
}

async function forEachWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;

  let nextIndex = 0;
  const runWorker = async () => {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) return;
      await worker(items[currentIndex] as T);
    }
  };

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}

function buildGitHubApiHeaders(
  token: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'allagents-cli',
  };
  if (token) headers.Authorization = `token ${token}`;
  return headers;
}

function decodeGitBlob(
  content: string | undefined,
  encoding: string | undefined,
): string | undefined {
  if (!content) return undefined;
  if (!encoding || encoding === 'utf-8') return content;
  if (encoding !== 'base64') return undefined;
  return Buffer.from(content.replace(/\s+/g, ''), 'base64').toString('utf8');
}
