# Design: `--force` Option for Marketplace and Plugin Add Commands

**Issue**: #225
**Date**: 2026-03-10

## Overview

Add a `--force` flag to both `plugin marketplace add` and `plugin add` commands that replaces existing entries instead of erroring out. This enables script automation and idempotent operations.

## Problem Statement

Currently:
- `allagents plugin marketplace add <source>` fails if the marketplace already exists
- `allagents plugin add <plugin>` fails if the plugin already exists

This breaks script automation—users cannot re-run provisioning scripts without manually removing existing entries first.

## Solution

Introduce a `--force` (`-f`) flag that:
1. Replaces the existing marketplace/plugin with the new source
2. Logs a message indicating it was replaced
3. Exits with code 0 (success) for consistent automation behavior

## Behavior

### Marketplace Add
```bash
# Without --force: errors if 'my-marketplace' exists
allagents plugin marketplace add https://github.com/owner/repo --name my-marketplace
# Error: Marketplace 'my-marketplace' already exists. Use 'update' to refresh it.

# With --force: replaces the existing marketplace
allagents plugin marketplace add https://github.com/owner/repo --name my-marketplace --force
# Output: Marketplace 'my-marketplace' already exists. Replacing with new source.
# Exit code: 0
```

### Plugin Add
```bash
# Without --force: errors if plugin already exists
allagents plugin add my-plugin@my-marketplace
# Error: Plugin already exists in .allagents/workspace.yaml: my-plugin@my-marketplace

# With --force: replaces the existing plugin
allagents plugin add my-plugin@my-marketplace --force
# Output: Plugin 'my-plugin@my-marketplace' already exists. Replacing with new source.
# Exit code: 0
```

## Implementation Details

### 1. Command Definitions (src/cli/commands/plugin.ts)

**marketplaceAddCmd** (line ~305):
- Add `force` flag option
- Pass to `addMarketplace()`

**pluginAddCmd** (line ~580):
- Add `force` flag option
- Pass to `addPlugin()`

### 2. Core Functions

**addMarketplace()** (src/core/marketplace.ts:236)
- Add `force?: boolean` parameter
- Current behavior: Check if marketplace exists (line 273), return error
- New behavior with force=true: Skip the error, proceed to update the registry
- Return result with `replaced: true` field when marketplace was updated

**addPlugin()** (src/core/workspace-modify.ts:105)
- Add `force?: boolean` parameter
- Pass to `addPluginToConfig()`

**addPluginToConfig()** (src/core/workspace-modify.ts:170)
- Add `force?: boolean` parameter
- Current behavior: Check exact match (line 181) and semantic duplicates (line 189), return error
- New behavior with force=true: Skip both checks, proceed to add/update the plugin
- Return result with `replaced: true` field when plugin was updated

### 3. Output Formatting

**Console Output**:
- Marketplace: `"Marketplace '${name}' already exists. Replacing with new source."`
- Plugin: `"Plugin '${plugin}' already exists. Replacing with new source."`

**JSON Output**:
- Include `{ replaced: true }` in the data object for both commands

### 4. User-Facing Behavior

- Exit code: Always 0 (success) when `--force` is used and entry is replaced
- No error reported in JSON mode—the operation succeeds as idempotent
- Original error messages remain for non-force paths (backwards compatible)

## Testing Strategy

### Unit Tests
- `addMarketplace` with force=true replaces existing marketplace
- `addMarketplace` with force=false errors on existing marketplace
- `addPluginToConfig` with force=true skips duplicate checks
- `addPluginToConfig` with force=false errors on existing plugin
- Return value includes `replaced: true` when appropriate

### E2E Tests
- Add marketplace, then add same marketplace with --force → verify it's updated
- Add plugin, then add same plugin with --force → verify it's updated
- Verify old entries are completely removed (not duplicated)
- Verify --force still validates source existence (invalid paths still error)
- Verify JSON output includes `replaced: true` flag

## Backwards Compatibility

- Default behavior (without --force): unchanged
- Existing scripts without --force continue to fail on duplicates (expected)
- Flag is optional, so no breaking changes to command interface

## Related Changes

None. This is a purely additive feature.
