# Universal `.agents` Folder Support

## Problem

Currently allagents copies skills to provider-specific folders (`.copilot/skills/`, `.opencode/skills/`, `.cursor/skills/`, etc.). Many AI agents now support a universal `.agents/skills/` folder, which:
- Reduces duplication when syncing to multiple clients
- Reduces choice fatigue for users
- Aligns with emerging industry convention

## Solution

Use `.agents/skills/` as the default for clients that support it, keep provider-specific folders for clients that don't.

### Client Mapping Changes

| Client | Current Folder | New Folder | Reason |
|--------|---------------|------------|--------|
| `copilot` | `.github/skills/` | `.agents/skills/` | Supports universal |
| `codex` | `.codex/skills/` | `.agents/skills/` | Supports universal |
| `opencode` | `.opencode/skills/` | `.agents/skills/` | Supports universal |
| `gemini` | `.gemini/skills/` | `.agents/skills/` | Supports universal |
| `ampcode` | (none) | `.agents/skills/` | Supports universal |
| `claude` | `.claude/skills/` | `.claude/skills/` | Has own ecosystem |
| `cursor` | `.cursor/skills/` | `.cursor/skills/` | Not in universal list |
| `factory` | `.factory/skills/` | `.factory/skills/` | Not in universal list |
| `vscode` | (none) | (none) | Workspace generator |

### Sync Logic Changes

Add deduplication to avoid copying skills multiple times to the same path:

```typescript
// Collect unique skill paths from configured clients
const uniqueSkillPaths = new Set<string>();
for (const client of config.clients) {
  const mapping = CLIENT_MAPPINGS[client];
  if (mapping.skillsPath) {
    uniqueSkillPaths.add(mapping.skillsPath);
  }
}

// Copy skills once per unique path
for (const skillsPath of uniqueSkillPaths) {
  copySkills(skills, skillsPath);
}
```

### Backward Compatibility

- No automatic migration of existing folders
- Old folders (`.copilot/skills/`, `.opencode/skills/`) remain but become stale
- Users can manually delete old folders
- Future: optionally add `allagents cleanup` command

## Implementation Tasks

1. [ ] Update `CLIENT_MAPPINGS` in `src/models/client-mapping.ts`
   - Change `skillsPath` to `.agents/skills/` for: copilot, codex, opencode, gemini, ampcode

2. [ ] Update `USER_CLIENT_MAPPINGS` in `src/models/client-mapping.ts`
   - Same changes for user-level paths

3. [ ] Add deduplication in sync logic (`src/core/sync.ts` or `src/core/transform.ts`)
   - Collect unique `skillsPath` values before copying
   - Copy skills once per unique path

4. [ ] Update tests
   - Test deduplication with multiple universal clients
   - Test mixed clients (universal + provider-specific)
   - Test user-level sync deduplication

5. [ ] Update documentation/release notes

## Testing

1. Configure `[copilot, codex, opencode]` → verify `.agents/skills/` written once
2. Configure `[claude, copilot, cursor]` → verify three separate folders
3. User-level sync works with deduplication
4. Empty `skillsPath` (vscode) doesn't cause issues
