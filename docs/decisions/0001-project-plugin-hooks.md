# ADR 0001: Materialize project plugin hooks as one managed repository hook file

- Status: Accepted
- Date: 2026-07-30

## Context

GitHub Copilot discovers repository hooks from `.github/hooks/*.json`, while
native plugin hooks may be declared in a plugin's `hooks.json` or
`hooks/hooks.json`. A plugin installed through an AllAgents project overlay is
not loaded by Copilot as a native plugin, so copying its scripts alone does not
activate its hook declaration. See the
[GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference).

This translation is independent of marketplace registration and package
metadata. AllAgents continues to support direct local and GitHub plugin sources
without a marketplace manifest or `plugin.json`. A plugin with no `hooks.json`
or `hooks/hooks.json` simply declares no Copilot hooks; its other artifacts
continue to sync normally.

AllAgents also needs to remove one plugin's hooks without disturbing another
plugin or user-owned repository configuration.

## Decision

For project-scoped Copilot plugins, AllAgents materializes native plugin hook
declarations into one AllAgents-owned repository hook file:
`.github/hooks/allagents.json`.

One aggregate file is used instead of one file per plugin because it gives the
sync engine a single ownership boundary and one reconciliation target.
Install, update, and uninstall can regenerate the complete desired state
without inventing stable filenames, leaving stale per-plugin files, or touching
sibling user-owned hook files.

When at least one managed hook entry remains, AllAgents creates the aggregate if
the path is absent. It updates an existing aggregate only when sync state
records the file as managed. An existing unowned
`.github/hooks/allagents.json` is preserved and reported as a warning. When no
managed plugin hooks remain, AllAgents removes only its managed aggregate.

Each hook declaration is checked independently. If it cannot be read or parsed
as JSON or lacks the version-1 `hooks` object envelope, AllAgents warns and
omits every entry from that declaration from the managed aggregate. A valid
envelope with `disableAllHooks: true` adds no entries. Otherwise, a non-array
event value also warns and omits the declaration. AllAgents does not fully
validate each hook entry. Skipping a declaration does not itself suppress the
plugin's other eligible artifacts, including repository hook files, and valid
hook declarations from other plugins still aggregate. Rejecting the
declaration as a unit avoids partial managed activation when its enabled event
structure is invalid.

For every command entry, AllAgents preserves declared environment variables but
overrides any declared `COPILOT_PLUGIN_ROOT` with that plugin's resolved
installation path. References through that variable therefore resolve to the
plugin's actual root. Excluded declarations or hook payloads are not activated.

## Consequences

- Project-installed plugin hooks execute through Copilot's native repository
  hook discovery.
- Marketplace registration and `plugin.json` remain optional for direct plugin
  sources; hook materialization runs only when a supported hook declaration is
  present.
- User-owned hook files remain independent from AllAgents reconciliation.
- Skipping a hook declaration does not itself suppress that plugin's other
  eligible artifacts or valid declarations from other plugins, but none of its
  entries enter the managed aggregate.
- The generated file contains absolute plugin paths. It is machine-local and
  should not be treated as portable configuration for cloud agents or another
  checkout where those paths do not exist.
- A user who already owns `.github/hooks/allagents.json` must rename it or choose
  another ownership arrangement before AllAgents can activate project hooks.

## Reconsider when

Revisit this decision if Copilot gains native project-overlay plugin loading,
provides a portable plugin-root binding for repository hooks, or remote/cloud
execution becomes a supported project-plugin target. Also reconsider the single
aggregate if plugins need independent trust, enablement, or failure policies that
cannot be represented safely in one managed file.
