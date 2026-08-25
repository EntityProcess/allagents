# Changelog

## [Unreleased]

### Breaking Changes

- **MCP proxy command**: Removed the temporary `allagents mcp proxy-stdio` alias. Use `allagents mcp proxy <serverUrl>` instead.

  **Migration**: Re-run `allagents mcp update` or `allagents update` after upgrading so synced client configs are regenerated with `mcp proxy`.

- **Plugin Git ref terminology**: Renamed workspace plugin `pin` to `ref`, CLI
  `--pin` to `--ref`, and sync-state `pinnedRef` to `requestedRef`. Inline
  `owner/repo@ref` sources are unchanged.

  **Migration**: Replace `pin:` with `ref:` in plugin objects and `--pin` with
  `--ref` in scripts. This is a clean cutover; the old names are not accepted.


## [1.0.0] - 2026-03-13

### Breaking Changes

- **Workspace schema v2**: Skill selection is now configured inline on each plugin entry rather than via top-level `disabledSkills`/`enabledSkills` arrays.

  **Before (v1):**
  ```yaml
  plugins:
    - superpowers@marketplace
  enabledSkills:
    - superpowers:brainstorming
  disabledSkills:
    - my-tools:verbose-logging
  ```

  **After (v2):**
  ```yaml
  version: 2
  plugins:
    - source: superpowers@marketplace
      skills: [brainstorming]
    - source: my-tools@marketplace
      skills:
        exclude: [verbose-logging]
  ```

  **Migration**: Automatic — existing `workspace.yaml` files are migrated to v2 format on the next `allagents workspace sync`. No manual action required.

### Added
- Top-level `allagents skills` command as shorthand for `allagents plugin skills`
- `allagents skills add --from <source>` to install a plugin and enable a skill in one step
- Auto-wrap support for flat SKILL.md repos (npx skills ecosystem compatibility)
- `allagents plugin install --skill` now works even when plugin is already installed
