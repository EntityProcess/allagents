# Duplicate Skill Name Handling

## Problem

When two plugins define skills with the same folder name, one overwrites the other during sync. There's no namespace or qualifier system to prevent collisions.

## Naming Rules

1. **No conflict** - Use skill folder name as-is
   - Example: `coding-standards`

2. **Skill folder name conflicts across plugins** - Qualify with plugin name using underscore separator
   - Example: `foo_coding-standards` and `bar_coding-standards`

3. **Both plugin name AND skill folder name conflict** - Add org/UUID prefix
   - GitHub source: `anthropic_my-plugin_coding-standards`
   - Local source: `a1b2c3_my-plugin_coding-standards` (6-char deterministic hash)

## Detection Logic

During sync, collect all skills from all plugins first, then:
1. Group skills by folder name
2. For groups with >1 skill, check if plugin names are unique
3. If plugin names also conflict, use org/UUID as final disambiguator

## Implementation Approach

### Where to change

`src/core/transform.ts` in the `copySkills()` function (lines 156-226)

### New logic flow

1. **First pass** - Collect all skills from all plugins:
   ```
   Map<skillFolder, Array<{plugin, source, orgOrUuid}>>
   ```

2. **Build qualified names** - For each skill:
   - If only one skill with that folder name → use folder name as-is
   - If multiple skills share folder name but different plugin names → `{plugin}_{skill}`
   - If multiple skills share both → `{orgOrUuid}_{plugin}_{skill}`

3. **Second pass** - Copy skills using the resolved names

### Deriving org/UUID

- GitHub URL source (e.g., `github:anthropic/superpowers`) → extract org (`anthropic`)
- Local path source → generate deterministic 6-char hash from the absolute path

```typescript
import { createHash } from 'crypto';

function getShortId(localPath: string): string {
  return createHash('sha256')
    .update(localPath)
    .digest('hex')
    .substring(0, 6);
}
```

## Files to Modify

| File | Change |
|------|--------|
| `src/core/transform.ts` | Refactor `copySkills()` to two-pass with name resolution |
| `src/utils/hash.ts` (new) | Small utility for 6-char deterministic hash |
| `src/utils/source-parser.ts` (new or existing) | Extract org from GitHub URLs |

## Edge Cases

- Plugin source URL parsing: `github:anthropic/repo` vs `github:anthropic/repo#branch` vs local paths
- Skill folder names that already contain underscores (e.g., `my_skill` from plugin `foo` → `foo_my_skill`)
- Empty or missing org in GitHub URL (fallback to hash)

## Tests to Add

- No conflict → skill name unchanged
- Skill conflict with different plugins → `plugin_skill` format
- Skill + plugin conflict with GitHub sources → `org_plugin_skill` format
- Skill + plugin conflict with local sources → `hash_plugin_skill` format
- Mixed sources (some GitHub, some local) with conflicts
