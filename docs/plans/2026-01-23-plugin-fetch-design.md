# Plugin Fetch Command Design

**Date**: 2026-01-23
**Status**: Approved
**Phase**: 3 - Plugin Fetching

## Overview

Implement `allagents plugin fetch <url>` command to clone remote GitHub plugins to local cache directory. Supports force updates and provides clear user feedback.

## Architecture

### Core Module (`src/core/plugin.ts`)

**Main Function**:
```typescript
fetchPlugin(url: string, options?: { force?: boolean }): Promise<FetchResult>
```

**Responsibilities**:
- Validate GitHub URL using existing `parseGitHubUrl()` utility
- Check cache directory existence with `getPluginCachePath()`
- Execute `gh repo clone` or `git pull` via `execa`
- Return structured result (success/skip/error)

**Separation of Concerns**:
- Core module handles business logic and process execution
- CLI command handles argument parsing and user output
- Reuses existing utilities from `plugin-path.ts`

### CLI Command (`src/cli/commands/plugin.ts`)

**Responsibilities**:
- Parse command-line arguments and flags
- Call core module with appropriate options
- Format output messages for users
- Handle exit codes

### Cache Structure

```
~/.allagents/plugins/marketplaces/
  ├── owner-repo/           # Cloned repository
  ├── EntityProcess-allagents/
  └── anthropics-claude-plugins-official/
```

## Implementation Details

### Fetch Logic Flow

1. **Validate URL**: Use `parseGitHubUrl()` to extract owner/repo, throw error if invalid
2. **Determine cache path**: Use `getPluginCachePath(owner, repo)`
3. **Check cache state**:
   - If cache exists && !force → return "skip" result
   - If cache exists && force → execute `git pull` in cache directory
   - If cache doesn't exist → execute `gh repo clone`
4. **Execute command**: Use `execa` for cross-runtime compatibility
5. **Handle errors**: Provide actionable error messages

### Dependencies

**New Dependency**:
```json
"dependencies": {
  "execa": "^8.0.1"
}
```

**Rationale**: Works in both Node.js (npm global install) and Bun (development), unlike `Bun.spawn()` which is Bun-only.

### Exit Codes

- `0`: Success (fetched or skipped)
- `1`: Invalid URL
- `2`: gh CLI not available
- `3`: Clone/pull failed

### Error Handling

**gh not installed**:
```
Error: gh CLI not installed
  Install: https://cli.github.com
```

**Authentication failure**:
```
Error: GitHub authentication required
  Run: gh auth login
```

**Invalid URL**:
```
Error: Invalid GitHub URL format. Expected: https://github.com/owner/repo
```

**Repository not found**:
```
Error: Failed to fetch plugin: repository not found
```

## User Experience

### Command Interface

```bash
allagents plugin fetch <url>           # Fetch plugin
allagents plugin fetch <url> --force   # Force update if cached
```

### Output Messages

**Success (new fetch)**:
```
Fetching plugin from https://github.com/owner/repo...
✓ Plugin cached at: ~/.allagents/plugins/marketplaces/owner-repo
```

**Success (already cached)**:
```
Plugin already cached at: ~/.allagents/plugins/marketplaces/owner-repo
Use --force to update
```

**Success (force update)**:
```
Updating cached plugin from https://github.com/owner/repo...
✓ Plugin updated at: ~/.allagents/plugins/marketplaces/owner-repo
```

## Testing Strategy

### Unit Tests (`tests/unit/core/plugin.test.ts`)

**Test Coverage**:
- URL validation (valid/invalid GitHub URLs)
- Cache detection logic (exists vs doesn't exist)
- Force flag behavior (skip vs update)
- Error handling (gh not found, auth failures, network errors)
- Mock `execa` to avoid actual gh CLI calls

**Expected**: ~10-15 focused tests

### Integration Tests

**Manual Testing** (BATS later):
- Requires actual `gh` CLI installed
- Test real clone to temp cache directory
- Test force update with actual git pull
- Verify cache directory structure

### Coverage Goals

- Maintain 85%+ coverage requirement
- Focus on business logic, not gh CLI internals
- Mock external dependencies (execa, fs operations)

## Design Decisions

### Why execa instead of Bun.spawn()?

- Cross-runtime compatibility (Node.js + Bun)
- Users can install globally via `npm install -g allagents` (runs with Node.js)
- Industry standard for Node.js CLIs
- Better error handling and API than child_process

### Why skip by default, update with --force?

- Faster user experience (no unnecessary network calls)
- Gives users control over when to update
- Matches dotagents behavior pattern
- Clear intent with explicit flag

## Next Steps

1. Add `execa` dependency to package.json
2. Implement core `fetchPlugin()` function
3. Wire up CLI command with --force flag
4. Write comprehensive unit tests
5. Manual integration testing
6. Update @fix_plan.md
