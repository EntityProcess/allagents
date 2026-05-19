const SKILL_SUBCOMMANDS = new Set(['list', 'remove', 'add', 'search']);

export function normalizeSkillAlias(args: string[]): string[] {
  if (args.length === 0) return args;
  return args[0] === 'skills'
    ? ['skill', ...args.slice(1)]
    : args;
}

function shouldUseSkillSearchShorthand(rest: string[]): boolean {
  const first = rest[0] ?? '';
  if (rest.length === 0) return false;
  if (first.startsWith('-') || SKILL_SUBCOMMANDS.has(first)) return false;

  // Keep the shorthand narrow: multi-token queries and hyphenated names are
  // clearly search-shaped, while a lone bare word should still behave like a
  // subcommand lookup so typos remain visible.
  return rest.length > 1 || /[-\s]/.test(first);
}

export function normalizeSkillHelpArgs(args: string[]): string[] {
  const normalized = normalizeSkillAlias(args);
  if (normalized.length === 0 || normalized[0] !== 'skill') {
    return normalized;
  }

  const [, ...rest] = normalized;
  return shouldUseSkillSearchShorthand(rest)
    ? ['skill', 'search']
    : normalized;
}

/**
 * Normalize the canonical `skill` command path and support a narrow search
 * shorthand for obviously query-shaped invocations:
 *   - `allagents skills ...`      -> `allagents skill ...`
 *   - `allagents skill pr-search` -> `allagents skill search pr-search`
 *   - `allagents skill pr search` -> `allagents skill search pr search`
 *   - `allagents skill "pr search"` -> `allagents skill search "pr search"`
 *
 * A plain single bare word like `allagents skill terraform` stays unchanged so
 * typos of real subcommands still surface as parser errors instead of silently
 * turning into a search.
 */
export function normalizeSkillArgs(args: string[]): string[] {
  const normalized = normalizeSkillAlias(args);
  if (normalized.length === 0 || normalized[0] !== 'skill') {
    return args;
  }

  const [, ...rest] = normalized;
  if (rest.length === 0) {
    return ['skill'];
  }

  if (!shouldUseSkillSearchShorthand(rest)) {
    return ['skill', ...rest];
  }
  return ['skill', 'search', ...rest];
}
