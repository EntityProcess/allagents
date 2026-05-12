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
 * Run the GitHub Code Search request. Network/auth comes from the environment
 * via fetch + GITHUB_TOKEN; no extra deps.
 *
 * Items are returned in upstream relevance order. The handler may apply
 * name-match-first re-ranking on top of this — kept separate so the wire
 * format stays close to the gh-skill reference impl.
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
    // Skill name = parent dir of SKILL.md. For `skills/<name>/SKILL.md` this is
    // <name>; for repo-root `SKILL.md` the parent is the repo name.
    const parts = path.split('/');
    const name = parts.length >= 2 ? parts[parts.length - 2] ?? '' : item.repository?.full_name?.split('/').pop() ?? '';
    return {
      name,
      repo: item.repository?.full_name ?? '',
      path,
      description: item.repository?.description ?? '',
      sha: item.sha ?? '',
    };
  });

  return {
    query,
    items: rankItems(items, query),
    total: parsed.total_count ?? items.length,
    truncated: Boolean(parsed.incomplete_results),
  };
}

/**
 * Rank items: exact name match first, then prefix-match, then upstream order.
 * Mirrors gh-skill's relevance heuristic so users see the obvious hits up top.
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
  const name = item.name.toLowerCase();
  if (name === q) return 3;
  if (name.startsWith(q)) return 2;
  if (name.includes(q)) return 1;
  return 0;
}
