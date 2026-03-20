# Client Native Install Shorthand

## Problem

Configuring a client with native install mode requires verbose object syntax:

```yaml
clients:
  - name: claude
    install: native
```

This is awkward for a binary choice and harder to expose in the TUI compared to a simple string value.

The CLI already supports `client:mode` syntax via `parseClientEntries()` (used by `--client` flag in `workspace init`), but the YAML schema does not — creating an inconsistency.

## Solution

Add a colon-separated string shorthand `"client:mode"` to the `ClientEntrySchema` union. After parsing, the shorthand produces the same `{ name, install }` object as the explicit form, unifying the YAML and CLI syntax.

### Supported syntax

```yaml
clients:
  - claude              # bare string → { name: "claude", install: "file" }
  - claude:native       # shorthand  → { name: "claude", install: "native" }
  - claude:file         # explicit file mode (equivalent to bare "claude")
  - name: claude        # object form (unchanged, kept as escape hatch)
    install: native
```

## Schema Change

In `src/models/workspace-config.ts`, replace the current `ClientEntrySchema` union with a `z.union` that uses a `z.string().transform()` branch with a `.pipe()` to validate the output type.

The string branch handles both bare strings and colon shorthand:

1. If the string contains no colon, validate as `ClientTypeSchema` and return as-is (bare string behavior, unchanged)
2. If the string contains a colon, split on the **first** colon only (`indexOf(':')` + `slice`, not `split(':')`)
3. Validate the left side against `ClientTypeSchema`
4. Validate the right side against `InstallModeSchema`
5. Return `{ name: clientType, install: installMode }`

### Edge cases rejected at parse time

- `":native"` — empty client name, fails `ClientTypeSchema` validation
- `"claude:"` — empty mode, fails `InstallModeSchema` validation
- `"claude:native:extra"` — first-colon split gives mode `"native:extra"`, fails `InstallModeSchema` validation
- `"CLAUDE:NATIVE"` — `ClientTypeSchema` and `InstallModeSchema` are case-sensitive enums, so uppercase fails
- `"fakeclient:native"` — fails `ClientTypeSchema` validation
- `"claude:bogus"` — fails `InstallModeSchema` validation

### Zod union ordering

The string branch uses `z.string()` which would match all strings. To avoid ambiguity with `ClientTypeSchema` (also a string), we combine them into a **single** string transform branch that handles both bare and colon cases, rather than having separate `ClientTypeSchema` and `z.string().transform()` branches. The union becomes:

1. `z.string().transform()` — handles bare strings AND colon shorthand (new, replaces the old `ClientTypeSchema` branch)
2. `z.object({ name, install })` — object form (unchanged)

### TypeScript type

The inferred `ClientEntry` type remains `ClientType | { name: ClientType, install: InstallMode }`. The transform outputs either a bare `ClientType` string or an object — same as today.

## Existing precedent: `parseClientEntries()`

`parseClientEntries()` in `src/cli/commands/workspace.ts` already implements identical `client:mode` colon parsing for the `--client` CLI flag. After this change, we should refactor `parseClientEntries()` to delegate to `ClientEntrySchema.parse()` for single-entry validation, keeping its own comma-splitting logic. This deduplicates the validation and ensures CLI and YAML stay in sync.

## Downstream Impact

- **`normalizeClientEntry()`**: No change needed. The transform produces either a `ClientType` string (bare) or `{ name, install }` object — the same two shapes it already handles.
- **`getClientTypes()`**: No change — does `typeof e === 'string' ? e : e.name` which handles both shapes. Colon strings are transformed to objects before reaching this function since all call sites go through schema parsing.
- **`getClientInstallMode()`**: No change — delegates to `normalizeClientEntry()`.
- **`resolveInstallMode()`**: No change — operates on normalized `{ name, install }`.
- **Sync engine (`src/core/sync.ts`)**: No change — all client entries are schema-parsed before reaching sync.
- **TUI (`src/cli/tui/prompt-clients.ts`)**: No change now. Currently returns bare `ClientType` strings (file mode). Exposing native as a TUI option is a follow-up.

### Serialization / round-trip

The YAML config is read-only from the schema's perspective — `workspace.yaml` is parsed but never written back by the sync engine. The `workspace init` command writes the config once using the TUI-selected values (bare strings). No round-trip concern.

## Example Update

`examples/workspaces/native-install/.allagents/workspace.yaml` updated to use shorthand:

```yaml
clients:
  - copilot
  - claude:native
```

## Tests

### Schema unit tests (new)

- `"claude"` parses to `"claude"` (bare string, unchanged)
- `"claude:native"` parses to `{ name: "claude", install: "native" }`
- `"claude:file"` parses to `{ name: "claude", install: "file" }`
- `{ name: "claude", install: "native" }` parses correctly (object form)
- `"claude:bogus"` rejects
- `"fakeclient:native"` rejects
- `":native"` rejects
- `"claude:"` rejects
- `"claude:native:extra"` rejects
- Full `WorkspaceConfigSchema` parse with mixed client formats works

### `parseClientEntries()` refactor test

- Existing `parse-client-entries.test.ts` tests continue passing after refactor to use schema

### Existing tests

- `sync-install-mode.test.ts` passes unchanged — internal representation is the same
