# Client Native Install Shorthand

## Problem

Configuring a client with native install mode requires verbose object syntax:

```yaml
clients:
  - name: claude
    install: native
```

This is awkward for a binary choice and harder to expose in the TUI compared to a simple string value.

## Solution

Add a colon-separated string shorthand `"client:mode"` to the `ClientEntrySchema` union. After parsing, the shorthand produces the same `{ name, install }` object as the explicit form.

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

In `src/models/workspace-config.ts`, the `ClientEntrySchema` union gains a new `z.string().transform()` branch that:

1. Detects strings containing a colon
2. Splits into `clientType` and `installMode`
3. Validates `clientType` against `ClientTypeSchema`
4. Validates `installMode` against `InstallModeSchema`
5. Returns `{ name: clientType, install: installMode }`

Invalid inputs like `"claude:bogus"` or `"fakeclient:native"` fail at parse time with a Zod validation error.

The union order becomes:
1. `ClientTypeSchema` — bare string like `"claude"` (unchanged)
2. `z.string().transform()` — colon shorthand like `"claude:native"` (new)
3. `z.object({ name, install })` — object form (unchanged)

## Downstream Impact

- **`normalizeClientEntry()`**: No change needed. Bare strings still produce `{ name, install: "file" }`. Colon strings are already transformed to objects by the schema.
- **`getClientTypes()`, `getClientInstallMode()`**: No change — they delegate to `normalizeClientEntry()`.
- **`resolveInstallMode()`**: No change — operates on normalized `{ name, install }`.
- **Sync engine (`src/core/sync.ts`)**: No change — consumes normalized entries.
- **TUI (`src/cli/tui/prompt-clients.ts`)**: No change now. Currently returns bare `ClientType` strings (file mode). Exposing native as a TUI option is a follow-up.

## Example Update

`examples/workspaces/native-install/.allagents/workspace.yaml` updated to use shorthand:

```yaml
clients:
  - copilot
  - claude:native
```

## Tests

- **Schema unit tests**: `"claude:native"` parses correctly, `"claude:file"` works, `"claude:bogus"` rejects, `"fakeclient:native"` rejects, bare strings and object form still work
- **Existing tests**: `sync-install-mode.test.ts` should pass unchanged since internal representation is the same
