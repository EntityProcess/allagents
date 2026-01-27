# Future: Discriminated Union Schema for File Sources

## Problem

The current file source parsing relies on heuristics to distinguish between:
- Local relative paths: `config/settings.json`
- GitHub shorthand: `owner/repo/path/file.md`
- Explicit URLs: `https://github.com/...`

This creates edge cases:
1. Paths with 2 segments are ambiguous (`config/file.json` vs `owner/repo`)
2. `../path` vs `./path` have different resolution bases
3. Windows paths with backslashes need special handling
4. Multiple duplicate `isExplicitGitHubSource` functions across codebase

## Proposed Solution

Add optional `type` field to file sources for explicit disambiguation.

### Schema

```yaml
workspace:
  source: ./shared-config
  files:
    # String shorthand - unchanged, always relative to workspace.source
    - AGENTS.md

    # Object without type - current behavior with heuristics
    - source: config/settings.json
      dest: settings.json

    # Object WITH type - explicit, no ambiguity
    - dest: TEAM-RULES.md
      source:
        type: local
        path: ../team-config/rules.md

    - dest: REMOTE.md
      source:
        type: github
        repo: owner/repo
        path: path/to/file.md
        ref: main  # optional branch/tag
```

### Type Definitions

```typescript
type FileSourceType = 'local' | 'github';

interface LocalFileSource {
  type: 'local';
  path: string;  // Resolved from workspace root
}

interface GitHubFileSource {
  type: 'github';
  repo: string;   // owner/repo
  path: string;   // path within repo
  ref?: string;   // branch or tag (default: default branch)
}

type ExplicitFileSource = LocalFileSource | GitHubFileSource;

// Updated schema
const WorkspaceFileSchema = z.union([
  z.string(),
  z.object({
    source: z.union([
      z.string(),  // Current format (heuristic parsing)
      z.object({   // New explicit format
        type: z.literal('local'),
        path: z.string(),
      }),
      z.object({
        type: z.literal('github'),
        repo: z.string(),
        path: z.string(),
        ref: z.string().optional(),
      }),
    ]).optional(),
    dest: z.string().optional(),
  }),
]);
```

## Benefits

1. **Zero ambiguity** - `type` field determines behavior explicitly
2. **Cross-platform safe** - No path parsing heuristics needed
3. **Easier validation** - Type-specific validation rules
4. **Self-documenting** - Schema is obvious from YAML
5. **Backwards compatible** - String sources still work with heuristics

## Migration Path

1. Keep current heuristic-based parsing as default
2. Add new explicit `type` field as optional
3. When `type` is present, use explicit parsing
4. Document explicit format as recommended for complex cases
5. Eventually deprecate ambiguous heuristic cases

## Implementation Tasks

- [ ] Update `WorkspaceFileSchema` in `workspace-config.ts`
- [ ] Add type guards for discriminated union
- [ ] Update `parseFileSource` to handle explicit types
- [ ] Update `resolveFileSourcePath` for new format
- [ ] Update `validateFileSources` for type-specific validation
- [ ] Add tests for explicit type format
- [ ] Update documentation
- [ ] Add migration guide

## Priority

Low - Current implementation works for common cases. Implement when:
- Users report cross-platform issues
- More source types needed (e.g., S3, Azure Blob)
- Ambiguity causes real-world problems
