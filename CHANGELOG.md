# Changelog

## [Unreleased]

### Breaking Changes

- **MCP proxy command**: Removed the temporary `allagents mcp proxy-stdio` alias. Use `allagents mcp proxy <serverUrl>` instead.

  **Migration**: Re-run `allagents mcp update` or `allagents update` after upgrading so synced client configs are regenerated with `mcp proxy`.

### Added

- **Recommended skill catalog**: Added `allagents skill search <query> --catalog recommended`, a hard discovery boundary over curated repository, subtree, marketplace-backed, search-only, and external-lifecycle sources. The catalog includes gstack, Paperclip companies, Matt Pocock skills, Composio awesome skills, distinct Hermes core and optional roots, Anthropic skills and knowledge-work plugins, Addy Osmani skills, obra superpowers, and context-engineering skills.
- Catalog results expose classification, install policy, warnings, source metadata, exact install source and selector, and separate discovery provenance. **Recommended** is a discovery label, not a security, trust, quality, or license guarantee.
- Interactive `skill search` and full-screen TUI discovery now fetch Recommended and global GitHub results concurrently, render Recommended first and All GitHub second, and let Recommended win exact repository/skill-path duplicates. Partial failures are labeled while surviving results remain usable. JSON, redirected no-catalog output, owner-scoped search, and explicit strict catalog search keep their previous boundaries. Exact catalog install descriptors survive selection in both interactive surfaces. Optional sources require confirmation, while search-only and external-installer sources remain non-installable.
- Added authenticated, read-only catalog health validation in CI for repository/ref/root drift, skill presence, local authoritative marketplace paths, and source identity. The check never mutates, vendors, or automatically updates catalog entries.

### Fixed

- Clean Git clones now pass Git LFS filter overrides as supported `simple-git` configuration arguments, so project-scoped installs succeed without a pre-seeded cache while still preventing LFS smudge downloads.

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
