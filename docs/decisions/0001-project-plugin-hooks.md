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

AllAgents also needs to remove one plugin's hooks without disturbing another
plugin or user-owned repository configuration.

## Decision

For project-scoped Copilot plugins, AllAgents materializes native plugin hook
declarations into one AllAgents-owned repository hook file:
`.github/hooks/allagents.json`.

One aggregate file is used instead of one file per plugin because it gives the
sync engine a single ownership boundary and an atomic reconciliation target.
Install, update, and uninstall can regenerate the complete desired state
without inventing stable filenames, leaving stale per-plugin files, or touching
sibling user-owned hook files.

AllAgents creates or updates the aggregate only when its sync state records the
file as managed. An existing unowned `.github/hooks/allagents.json` is preserved
and reported as a warning. When no managed plugin hooks remain, AllAgents removes
only its managed aggregate.

Each plugin declaration is validated independently. If any event value is not
an array, the entire declaration from that plugin is rejected; valid declarations
from other plugins still aggregate. This matches GitHub's structural semantics
and avoids partially activating a malformed plugin.

For every command entry, AllAgents preserves declared environment variables but
binds `COPILOT_PLUGIN_ROOT` to that plugin's resolved installation path. The
trusted binding prevents one plugin declaration from redirecting commands to a
different root. Excluded declarations or hook payloads are not activated.

## Consequences

- Project-installed plugin hooks execute through Copilot's native repository
  hook discovery.
- User-owned hook files remain independent from AllAgents reconciliation.
- One malformed plugin does not suppress valid hooks from other plugins, but it
  receives no partial activation.
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
