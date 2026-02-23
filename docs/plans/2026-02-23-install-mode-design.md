# Install Mode on Client Entries

Replaces PR #156's `claude-native` client type with an `install` property on client entries, cleanly separating "which client" from "how to install".

## Problem

PR #156 adds `claude-native` as a new client type for native CLI plugin installation. This conflates two orthogonal concepts (client identity vs installation mechanism), creates a fake `ClientMapping` with `skillsPath: ''`, and would require naming explosion (`copilot-native`, etc.) as more clients add native install support.

## Three Installation Patterns

| Pattern | Where files go | In git? | YAML |
|---------|---------------|---------|------|
| Universal | `.agents/skills/` | Yes | `clients: [universal]` |
| Client-specific | `.claude/skills/`, `.github/skills/` | Yes | `clients: [claude, copilot]` |
| Native | Client's own registry | No | `clients: [{ name: claude, install: native }]` |

## YAML Surface

### Client entries

String shorthand implies `install: file` (default, unchanged behavior):

```yaml
clients:
  - copilot              # shorthand for { name: copilot, install: file }
  - universal
  - name: claude
    install: native      # uses claude CLI instead of file copy
```

### Plugin-level override

`install` on a plugin entry overrides the client-level default:

```yaml
clients:
  - name: claude
    install: native

plugins:
  - source: superpowers@obra/superpowers-marketplace
    # inherits native from client config

  - source: my-local-skill
    install: file        # override: force file-based even for native clients
```

## Schema Changes

### workspace-config.ts

```typescript
const InstallModeSchema = z.enum(['file', 'native']);
type InstallMode = z.infer<typeof InstallModeSchema>;

const ClientEntrySchema = z.union([
  ClientTypeSchema,
  z.object({
    name: ClientTypeSchema,
    install: InstallModeSchema.default('file'),
  }),
]);
type ClientEntry = z.infer<typeof ClientEntrySchema>;

// Updated plugin entry
const PluginEntrySchema = z.union([
  PluginSourceSchema,
  z.object({
    source: PluginSourceSchema,
    clients: z.array(ClientTypeSchema).optional(),
    install: InstallModeSchema.optional(),
  }),
]);

// Updated workspace config
const WorkspaceConfigSchema = z.object({
  // ...existing fields...
  clients: z.array(ClientEntrySchema),  // was z.array(ClientTypeSchema)
  // ...existing fields...
});
```

`ClientTypeSchema` stays unchanged — no `claude-native` value. Only real client names.

### sync-state.ts

Per-client native tracking:

```typescript
interface SyncStateData {
  files: Partial<Record<ClientType, string[]>>;
  mcpServers?: Partial<Record<McpScope, string[]>>;
  nativePlugins?: Partial<Record<ClientType, string[]>>;  // per-client
}
```

## Install Mode Resolution

For each (plugin, client) pair during sync:

1. If plugin has explicit `install:` → use that
2. Else if client entry has `install:` → use that
3. Else → `'file'` (default)

When effective mode is `native`:
- Marketplace plugin → use client's native CLI (e.g., `claude plugin install`)
- Non-marketplace plugin → fallback to file-based copy automatically

## Sync Flow

1. **Parse client entries** — normalize string shorthands to `{ name, install }` objects
2. **Build sync plans** — resolve effective install mode per (plugin, client) pair
3. **Split plugins per client** — separate into file-based and native lists
4. **File-based sync** — existing logic, unchanged
5. **Native sync** — call `syncNativePlugins()` per native client
6. **Declarative uninstall** — compare current vs previous native specs per-client, uninstall removed
7. **Save state** — track native plugins per-client in sync state

## Reused from PR #156

The core `claude-native.ts` module is kept:
- `executeClaudeCommand()`, `addMarketplace()`, `installPlugin()`, `uninstallPlugin()`
- `toClaudePluginSpec()`, `extractMarketplaceSource()`
- `syncNativePlugins()`, `NativeSyncResult` type

## Removed from PR #156

- `claude-native` from `ClientTypeSchema` enum
- `claude-native` entries from `CLIENT_MAPPINGS` / `USER_CLIENT_MAPPINGS`
- `isNativeClient()` function (replaced by install mode resolution)

## Output

`formatNativeResult()` is reused. Header changes from `claude-native:` to `claude (native):`.

## Helper Functions Needed

```typescript
// Normalize client entries to uniform shape
function normalizeClientEntry(entry: ClientEntry): { name: ClientType; install: InstallMode }

// Extract unique ClientType values from entries (for existing code that needs string[])
function getClientTypes(entries: ClientEntry[]): ClientType[]

// Get install mode for a specific client
function getClientInstallMode(entries: ClientEntry[], client: ClientType): InstallMode

// Resolve effective install mode for a (plugin, client) pair
function resolveInstallMode(
  pluginEntry: PluginEntry,
  clientEntry: { name: ClientType; install: InstallMode },
): InstallMode
```

## Examples

```yaml
# Universal file-based (any client reads .agents/)
clients: [universal]

# Client-specific file-based
clients: [claude, copilot, codex]

# Native install for Claude
clients:
  - name: claude
    install: native

# Mixed: file for most, native for Claude
clients:
  - copilot
  - universal
  - name: claude
    install: native

# Plugin-level override: native client, but one plugin forced to file
clients:
  - name: claude
    install: native
plugins:
  - source: superpowers@obra/superpowers-marketplace
  - source: my-local-skill
    install: file
```
