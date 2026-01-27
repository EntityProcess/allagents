# File-Level Source Sync Design

## Problem

When AGENTS.md is deleted locally or updated remotely, changes aren't synced:
- User deletes AGENTS.md locally → not restored on next sync
- AGENTS.md updated in remote source → changes not pulled down

## Solution

Enable file-level source declarations with always-sync behavior. The source is the single source of truth; local copies are generated artifacts that get overwritten on every sync.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Source of truth | Remote/source, not local | Users edit at source, not locally |
| Deleted file behavior | Restore from source | Local deletion is not intentional removal |
| GitHub cache behavior | Always pull | `git pull` is no-op when unchanged; ensures freshness |
| WORKSPACE-RULES | Always inject for agent files | Keeps workspace discovery working transparently |
| Missing source file | Fail sync entirely | Fail fast with clear error before any changes |

## Schema Changes

### Current Format (still supported)

```yaml
workspace:
  source: ../shared-config  # base directory for relative paths
  files:
    - AGENTS.md                    # string shorthand, relative to source
    - source: docs/custom.md       # object, relative to source
      dest: README.md
```

### New Format (file-level sources)

```yaml
workspace:
  source: ../shared-config  # optional default base
  files:
    # String shorthand - relative to workspace.source
    - AGENTS.md

    # Explicit local source
    - dest: AGENTS.md
      source: ../other-config/AGENTS.md

    # GitHub full URL
    - dest: AGENTS.md
      source: https://github.com/WiseTechGlobal/WTG.AI.Prompts/tree/main/plugins/cargowise/AGENTS.md

    # GitHub shorthand
    - dest: AGENTS.md
      source: WiseTechGlobal/WTG.AI.Prompts/plugins/cargowise/AGENTS.md
```

### Resolution Priority

1. If file entry has explicit `source:` → use it directly
2. If file entry has no `source:` → resolve relative to `workspace.source`
3. If no `workspace.source` and no explicit `source:` → validation error

## GitHub URL Formats

Reuse existing `plugin-path.ts` logic. Supported formats:

- `https://github.com/owner/repo/tree/branch/path/to/file.md`
- `github.com/owner/repo/path/to/file.md`
- `gh:owner/repo/path/to/file.md`
- `owner/repo/path/to/file.md` (shorthand)
- Local: `./relative/path` or `/absolute/path`

## Caching Strategy

GitHub repos are cached at the repo level: `~/.allagents/plugins/marketplaces/{owner}-{repo}/`

If a plugin and a file source reference the same repo, they share the cache:

```yaml
plugins:
  - WiseTechGlobal/WTG.AI.Prompts/plugins/cargowise

workspace:
  files:
    - dest: AGENTS.md
      source: WiseTechGlobal/WTG.AI.Prompts/plugins/cargowise/AGENTS.md
```

Both use: `~/.allagents/plugins/marketplaces/WiseTechGlobal-WTG.AI.Prompts/`

## Sync Flow

```
1. Validation Phase
   ├── Load workspace.yaml
   ├── Validate all plugins
   ├── Validate all file sources exist
   │   ├── Local: check file exists
   │   └── GitHub: verify path exists in repo
   └── Abort if any validation fails

2. Fetch Phase
   ├── Collect unique GitHub repos (from plugins + file sources)
   ├── For each repo:
   │   ├── If not cached → clone
   │   └── If cached → git pull (always, no --force needed)
   └── Deduplicated by owner/repo

3. Purge Phase
   ├── Load sync-state.json
   └── Remove previously synced files

4. Copy Phase
   ├── Copy plugin folders from cache
   ├── Copy individual files from sources
   │   ├── Local source → copy directly
   │   └── GitHub source → copy from cache
   └── Inject WORKSPACE-RULES into AGENTS.md/CLAUDE.md

5. Save Phase
   └── Update sync-state.json with all synced files
```

## Files to Modify

### `src/models/workspace-config.ts`
- Update `WorkspaceFileEntry` schema to allow `source` to be GitHub URL or absolute path
- Add validation for new source formats

### `src/utils/plugin-path.ts`
- Extract/expose helpers for file source resolution
- Add `parseFileSource()` function (similar to `parsePluginSource()`)

### `src/core/transform.ts`
- Update `copyWorkspaceFiles()` to handle GitHub sources
- Resolve file from cache when source is GitHub URL

### `src/core/sync.ts`
- Collect unique repos from both plugins and file sources
- Always pull cached repos (remove skip-if-cached logic for repos with file sources)
- Add file source validation in validation phase

### `src/core/plugin.ts`
- Ensure `fetchPlugin()` can be reused for file source repos
- Consider renaming to `fetchGitHubRepo()` or extracting shared logic

## Backwards Compatibility

- Existing `workspace.files` entries continue working unchanged
- String entries still resolve relative to `workspace.source`
- Object entries with relative `source:` still resolve relative to `workspace.source`
- Only new capability: `source:` can now be GitHub URL or absolute path

## Error Messages

```
# Missing local source
Error: File source not found: ../config/AGENTS.md

# Missing GitHub path
Error: Path not found in repository: WiseTechGlobal/WTG.AI.Prompts/plugins/cargowise/AGENTS.md

# No source resolution
Error: Cannot resolve file 'AGENTS.md' - no workspace.source configured and no explicit source provided
```

## Test Cases

1. **Local source sync**: File copied from local path, WORKSPACE-RULES injected
2. **GitHub source sync**: Repo cloned/pulled, file copied from cache
3. **Shared cache**: Plugin and file from same repo use single cache
4. **Always pull**: Cached repo is pulled even without --force
5. **Missing source fails**: Sync aborts if source file doesn't exist
6. **Local deletion restored**: Deleted AGENTS.md restored on next sync
7. **Remote update synced**: Changed source file overwrites local on sync
