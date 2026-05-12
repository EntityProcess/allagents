/**
 * GitHub Code Search wrapper for `allagents skill search`.
 *
 * Hits `GET /search/code` with a `path:SKILL.md filename:SKILL.md <query>`
 * pattern, ranks results by relevance, and maps rate-limit errors to a
 * single actionable message so callers never see a raw 403 / HTML dump.
 *
 * Auth comes from `GITHUB_TOKEN` when present; unauthenticated requests are
 * subject to the public Code Search rate limit (10 req/min). See cli/cli
 * issue #13293 for upstream tracking.
 */

const OWNER_REGEX = /^[A-Za-z0-9-]{1,39}$/;

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
 * Build the `q=` querystring value: `<query> filename:SKILL.md path:SKILL.md [user:<owner>]`.
 */
function buildQueryString(query: string, owner: string | undefined): string {
  const parts = [query.trim(), 'filename:SKILL.md', 'path:SKILL.md'];
  if (owner) parts.push(`user:${owner}`);
  return parts.join(' ');
}

/**
 * Render the namespace-qualified skill name (`<namespace>/<name>`) when a
 * namespace is set, or just `<name>` otherwise. Used both for ranking
 * (so `kynan/commit` matches the query "kynan/commit") and as the dedup
 * key together with the repo full name.
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
 * Run the GitHub Code Search request. Network/auth comes from the environment
 * via fetch + GITHUB_TOKEN; no extra deps.
 *
 * Items are returned in upstream relevance order, then re-ranked by
 * qualified-name match against the query and deduped by
 * `repo + qualifiedName`. Dedup matters because Code Search will sometimes
 * return the same skill folder twice via different match contexts.
 */
export async function searchSkills(
  query: string,
  options: SkillSearchOptions = {},
  deps: { fetch?: typeof fetch } = {},
): Promise<SkillSearchResult> {
  validateSkillSearchArgs(query, options);
  const fetchFn = deps.fetch ?? fetch;

  const page = options.page ?? 1;
  const limit = options.limit ?? 30;
  const q = buildQueryString(query, options.owner);
  const url = new URL('https://api.github.com/search/code');
  url.searchParams.set('q', q);
  url.searchParams.set('per_page', String(limit));
  url.searchParams.set('page', String(page));

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'allagents-cli',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
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

  // GitHub Code Search response shape: { total_count, incomplete_results, items: [...] }
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

  const deduped = dedupeItems(items);

  return {
    query,
    items: rankItems(deduped, query),
    total: parsed.total_count ?? deduped.length,
    truncated: Boolean(parsed.incomplete_results),
  };
}

/**
 * Drop duplicate hits by `repo + qualifiedName`. The Code Search API can
 * return the same skill folder more than once when multiple lines in
 * SKILL.md match the query; the user only cares about the folder.
 *
 * Preserves the first occurrence so upstream relevance order is respected
 * before re-ranking.
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

/**
 * Rank items: exact qualified-name match first, then prefix-match, then
 * substring, then upstream order. Using `qualifiedName` means a query like
 * `kynan/commit` matches the namespaced skill exactly while a query like
 * `commit` still falls through to substring matches on both
 * `kynan/commit` and `will/commit`.
 */
function rankItems(items: SkillSearchItem[], query: string): SkillSearchItem[] {
  const q = query.toLowerCase();
  return [...items].sort((a, b) => {
    const aScore = score(a, q);
    const bScore = score(b, q);
    return bScore - aScore;
  });
}

function score(item: SkillSearchItem, q: string): number {
  const qn = qualifiedName(item).toLowerCase();
  if (qn === q) return 3;
  if (qn.startsWith(q)) return 2;
  if (qn.includes(q)) return 1;
  return 0;
}
