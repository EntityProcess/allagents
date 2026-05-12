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
 * Auth comes from `GITHUB_TOKEN` when present; unauthenticated requests are
 * subject to the public Code Search rate limit (10 req/min). See cli/cli
 * issue #13293 for upstream tracking.
 */

const OWNER_REGEX = /^[A-Za-z0-9-]{1,39}$/;

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
  /** Repo description (often empty for Code Search results). */
  description: string;
  /** File blob SHA. */
  sha: string;
}

export interface SkillSearchResult {
  query: string;
  items: SkillSearchItem[];
  total: number;
  truncated: boolean;
}

export interface SkillSearchOptions {
  owner?: string;
  page?: number;
  limit?: number;
}

export class SkillSearchError extends Error {
  constructor(message: string, public readonly kind: 'validation' | 'rate-limit' | 'api') {
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
  if (query.trim().length < 2) {
    throw new SkillSearchError('Search query must be at least 2 characters.', 'validation');
  }
  if (options.page !== undefined && options.page < 1) {
    throw new SkillSearchError('--page must be >= 1.', 'validation');
  }
  if (options.limit !== undefined && (options.limit < 1 || options.limit > 100)) {
    throw new SkillSearchError('--limit must be between 1 and 100.', 'validation');
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
  /** 1 = path, 2 = hyphenated, 3 = query-as-owner, 4 = primary content. */
  priority: 1 | 2 | 3 | 4;
  /** Short label used in failure logging. */
  label: 'path' | 'hyphen' | 'owner' | 'primary';
  /** The `q=` querystring value (no URL encoding). */
  q: string;
}

/**
 * Build the parallel Code Search query set, ordered by priority.
 *
 * Always emits:
 *   - Priority 1 — `filename:SKILL.md path:<pathTerm>` (+ optional user filter)
 *   - Priority 4 — `filename:SKILL.md <query>`           (+ optional user filter)
 *
 * Conditionally emits:
 *   - Priority 2 — `filename:SKILL.md <pathTerm>` (only when the hyphenated
 *     pathTerm differs from the bare query, i.e. when the query has spaces)
 *   - Priority 3 — `filename:SKILL.md user:<query>` (only when no explicit
 *     `--owner` is set AND the query itself could plausibly be a GitHub
 *     login)
 *
 * The path query is what surfaces e.g. CargoWise skills at
 * `plugins/cargowise/skills/...` even when the SKILL.md content doesn't
 * mention "cargowise" — `path:cargowise` matches the directory name.
 */
export function buildSearchQueries(
  query: string,
  owner: string | undefined,
): SkillSearchQuery[] {
  const trimmed = query.trim();
  const pathTerm = trimmed.replace(/ /g, '-');
  const userClause = owner ? `user:${owner}` : '';
  const join = (...parts: string[]) => parts.filter(Boolean).join(' ');

  const queries: SkillSearchQuery[] = [
    { priority: 1, label: 'path', q: join('filename:SKILL.md', `path:${pathTerm}`, userClause) },
  ];

  if (pathTerm !== trimmed) {
    queries.push({ priority: 2, label: 'hyphen', q: join('filename:SKILL.md', pathTerm, userClause) });
  }

  if (!owner && couldBeOwner(trimmed)) {
    queries.push({ priority: 3, label: 'owner', q: `filename:SKILL.md user:${trimmed}` });
  }

  queries.push({ priority: 4, label: 'primary', q: join('filename:SKILL.md', trimmed, userClause) });

  return queries;
}

/**
 * Map a GitHub API response to a SkillSearchError. The 403 / rate-limit body
 * has a distinctive `documentation_url` and `message` shape; everything else
 * falls back to a generic API error.
 */
function classifyApiError(status: number, body: unknown): SkillSearchError {
  const msg = typeof body === 'object' && body !== null && 'message' in body
    ? String((body as { message: unknown }).message ?? '')
    : '';
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
 * Render the namespace-qualified skill name (`<namespace>/<name>`) when a
 * namespace is set, or just `<name>` otherwise. Used as the dedup key
 * together with the repo full name.
 */
export function qualifiedName(item: Pick<SkillSearchItem, 'name' | 'namespace'>): string {
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
    // Drop a trailing `SKILL.md` segment if present.
    const meaningful =
      afterSkills[afterSkills.length - 1] === 'SKILL.md'
        ? afterSkills.slice(0, -1)
        : afterSkills;
    if (meaningful.length >= 2) {
      const namespace = meaningful[0] ?? '';
      const name = meaningful[1] ?? '';
      if (namespace && name) return { namespace, name };
    }
    if (meaningful.length === 1 && meaningful[0]) {
      return { namespace: '', name: meaningful[0] };
    }
  }

  // No `skills` segment — use the parent directory of SKILL.md as the name.
  if (parts.length >= 2) {
    const parent = parts[parts.length - 2];
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
      repository?: { full_name?: string; description?: string };
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
    };
  });

  return {
    items,
    total: parsed.total_count ?? items.length,
    truncated: Boolean(parsed.incomplete_results),
  };
}

/**
 * Run the multi-query Code Search and merge results.
 *
 * Behaviour:
 *   - Up to four queries are built via `buildSearchQueries` and dispatched in
 *     parallel with `Promise.allSettled`.
 *   - The primary (priority 4) result is required: if it fails, the error
 *     propagates. Other queries are advisory — failures are logged and the
 *     surviving buckets still merge.
 *   - Items are concatenated in priority order (1 → 4), then deduped by
 *     `repo + qualifiedName` keeping the first occurrence. That makes the
 *     path bucket win over the content bucket when both match the same skill.
 *
 * Network/auth come from `process.env.GITHUB_TOKEN` / `GH_TOKEN` when set;
 * unauthenticated requests share the public 10 req/min Code Search rate limit.
 */
export async function searchSkills(
  query: string,
  options: SkillSearchOptions = {},
  deps: { fetch?: typeof fetch; logger?: (msg: string) => void } = {},
): Promise<SkillSearchResult> {
  validateSkillSearchArgs(query, options);
  const fetchFn = deps.fetch ?? fetch;
  const logger = deps.logger ?? ((msg: string) => process.stderr.write(`${msg}\n`));

  const page = options.page ?? 1;
  const limit = options.limit ?? 30;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  const queries = buildSearchQueries(query, options.owner);
  const settled = await Promise.allSettled(
    queries.map((entry) => runOneQuery(entry.q, page, limit, token, fetchFn)),
  );

  // Locate the primary (priority 4) result. If it failed, surface its error.
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
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      logger(`Warning: skill search "${entry.label}" query failed: ${reason}`);
    }
  }

  // Concatenate items in priority order (lower priority number first).
  buckets.sort((a, b) => a.priority - b.priority);
  const mergedItems = buckets.flatMap((b) => b.result.items);

  const deduped = dedupeItems(mergedItems);

  return {
    query,
    items: deduped,
    total: deduped.length,
    truncated: buckets.some((b) => b.result.truncated),
  };
}

/**
 * Drop duplicate hits by `repo + qualifiedName`. Same folder surfaced by
 * multiple query buckets (e.g. both `path:` and content match) collapses to
 * one entry, with the higher-priority bucket's occurrence winning because
 * items are merged in priority order before this runs.
 */
function dedupeItems(items: SkillSearchItem[]): SkillSearchItem[] {
  const seen = new Set<string>();
  const out: SkillSearchItem[] = [];
  for (const item of items) {
    const key = `${item.repo}#${qualifiedName(item)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
