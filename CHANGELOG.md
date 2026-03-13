# Changelog

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
