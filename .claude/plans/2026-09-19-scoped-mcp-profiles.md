# Scoped MCP Destinations and Profile OAuth

## Goal

Make MCP declarations, synchronization, proxying, and OAuth state operate consistently across three explicit destinations:

- project: default or `--scope project`
- ordinary user config: `--scope user`
- named profile: `--profile <name>`

Profiles are first-class destinations, not client-name aliases. Project and user declarations continue to share ordinary OAuth credentials by URL; each profile owns an isolated credential cache under its profile root.

## Product contract

- `--scope` and `--profile` are mutually exclusive on every public MCP command.
- Omitting both selects the current project, except from the home directory where the project path aliases the ordinary user config and resolves to user scope. Explicit `--scope project` is rejected at that alias.
- A profile selector is singular and must name a declared profile. Profile MCP server names use `[A-Za-z0-9_.-]{1,100}`.
- `mcp add --client` is repeatable and remains comma-compatible. Values are trimmed, validated, deduplicated in first-seen order, and explicit empty segments are rejected.
- `mcp add` validates first, then persists the server declaration and server-local proxy intent in one atomically replaced document before synchronization.
- `mcp list` and `mcp get` read only inline declarations for the selected destination; they do not merge plugin-provided servers and redact header, environment, URL credential, and sensitive query values.
- `mcp reauth --profile <name>` removes and recreates only that profile's credentials.
- `mcp update --scope user` performs MCP-only reconciliation, not a full user workspace sync.
- Profile MCP reconciliation stays inside the profile plan/apply ownership model because Codex and OpenCode combine settings and MCP in one managed artifact.
- A declared but uninstalled profile may be edited, listed, or inspected without being implicitly installed. Synchronization is skipped with an explicit result. Installed profiles reconcile through the normal profile planner.
- Profile deletion removes the fixed profile-owned OAuth subtree before state deletion. Partial cleanup fails closed and remains retryable.
- Profile HTTP headers use exact `${ENV_VAR}` references. Generated bridges preserve only the environment binding and resolve its value at connection time.
- Local credential deletion does not revoke an authorization grant at the remote provider.

## Configuration model

Project and ordinary user destinations use top-level `mcpServers` and `mcpProxy`.

Profiles use destination-local fields:

```yaml
profiles:
  markets:
    clients:
      - name: codex
      - name: copilot
    mcpServers:
      tradingview:
        type: http
        url: https://mcp.tradingview.com/mcp
        clients: [codex, copilot]
    mcpProxy:
      servers:
        tradingview:
          proxy: [codex, copilot]
```

`profiles.<name>.mcpProxy` reuses the ordinary proxy schema. Proxy client selectors must be `*` or a client declared by that profile. The global `mcpProxy.clients` list becomes optional with an empty default so server-local routing does not require `clients: []` noise.

## Ownership and paths

Generated client files remain destination-native:

| Destination | Codex | Copilot |
| --- | --- | --- |
| project | `.codex/config.toml` | `.github/mcp.json` |
| user | `~/.codex/config.toml` | `~/.copilot/mcp-config.json` |
| profile | `~/.allagents/profiles/<name>/clients/codex/home/<name>.config.toml` | `~/.allagents/profiles/<name>/clients/copilot/home/mcp-config.json` |

OAuth cache ownership:

- project/user: `~/.allagents/oauth-proxy/<url-hash>/`
- profile: `~/.allagents/profiles/<name>/oauth-proxy/<url-hash>/`

Profile bridge commands include the hidden selector:

```text
npx -y allagents@<version> mcp proxy <url> --profile <name>
```

Ordinary project/user bridge commands remain byte-for-byte unchanged and omit `--profile`.

## Architecture

Introduce one validated destination discriminant resolved at the CLI boundary:

```ts
type McpDestination =
  | { kind: 'project'; workspacePath: string; configPath: string }
  | { kind: 'user'; configPath: string }
  | { kind: 'profile'; name: ProfileName; configPath: string };
```

Declaration access and mutation hide storage differences. A mutation acquires a destination-file lock, loads once with the scope-correct parser, selects the top-level or profile-local container, validates the destination-specific server and server-name schemas, updates the server and server-local proxy policy in one in-memory document, validates the entire document, and atomically replaces the destination file once.

Synchronization stays separate:

- project delegates to existing `syncMcpOnly`;
- user delegates to a new `syncUserMcpOnly`, extracted from the full user sync's existing adapter logic;
- installed profile delegates to profile plan/apply update; declared-only profile returns an explicit skipped reconciliation.

Profile planning filters and normalizes a client's MCP declarations before applying its profile-local proxy policy. The effective map is then passed to both settings and MCP serializers so combined artifacts remain correct.

## Implementation units

### U1 — Destination schemas and atomic declarations

**Files**
- `src/models/workspace-config.ts`
- `src/utils/workspace-parser.ts`
- `src/core/mcp-servers.ts`
- profile/schema/declaration tests

**Change**
- Add optional/default-empty global proxy clients and profile-local `mcpProxy` validation.
- Add `McpDestination` resolution with scope/profile exclusion and profile-name validation.
- Generalize get/list/add/remove into destination-aware, atomic operations.
- Preserve unrelated user/profile YAML and remove obsolete project-only mutation APIs after callers migrate.

**Proof**
- Tests for user/profile access, atomic server-plus-proxy writes, concurrent update serialization, symbolic-link rejection, invalid profile selectors, profile-not-found, preservation, and proxy pruning.

### U2 — Profile-aware bridge and OAuth ownership

**Files**
- `src/core/mcp-proxy.ts`
- `src/core/mcp-http-stdio-proxy.ts`
- `src/cli/commands/mcp.ts` hidden proxy path
- proxy/OAuth tests

**Change**
- Add a validated optional profile scope to generated bridges and runtime OAuth resolution.
- Preserve profile header secrets as `--header-env <header>=<variable>` bindings and resolve them only at the connection boundary.
- Keep ordinary cache behavior unchanged and never persist resolved profile secret values.

**Proof**
- Exact argv tests, ordinary/profile path tests, reset isolation, traversal rejection, OAuth E2E coverage.

### U3 — Profile materialization and lifecycle cleanup

**Files**
- `src/core/profile/plan.ts`
- `src/core/profile/manager.ts`
- `src/core/profile/files.ts` only if a shared safe-removal helper is needed
- profile planner/manager/adapter tests

**Change**
- Filter each client’s servers before proxy transformation.
- Serialize effective proxied maps through existing adapters and report truthful disclosures.
- Remove only `<profile-root>/oauth-proxy` during profile teardown, including declared-only profiles, before state deletion; reject symlink/non-directory roots and retain state on failure.

**Proof**
- Exact Codex/Copilot materialization, cross-profile isolation, removal cleanup, unrelated-file preservation, hostile symlink failure.

### U4 — Ordinary user MCP-only synchronization

**Files**
- `src/core/mcp-sync.ts`
- `src/core/sync.ts`
- sync/state tests

**Change**
- Extract one reusable user MCP adapter orchestrator from full user sync.
- Add `syncUserMcpOnly` without plugin artifact/native/profile side effects.
- Preserve name-based ownership, unrelated sync state, and unattempted or failed client ownership.

**Proof**
- User Codex/Copilot destinations, selector filtering, preservation of untracked entries and unrelated state, profiles ignored by ordinary sync, missing/invalid config behavior, dry-run behavior.

### U5 — Public command routing

**Files**
- `src/cli/commands/mcp.ts`
- `src/cli/metadata/mcp.ts`
- CLI/E2E tests

**Change**
- Add shared destination flags to add/remove/list/get/reauth/update.
- Route declaration access, authentication, mutation, and reconciliation through one resolved destination.
- Parse repeatable plus CSV-compatible `--client` values strictly.
- Add stable destination information to JSON results and destination-aware human output.

**Proof**
- Default project compatibility; explicit project/user/profile flows; scope/profile conflict; repeatable/mixed client forms; unknown/empty selector rejection before auth or mutation; profile reauth isolation.

### U6 — Documentation and generated schema

**Files**
- `README.md`
- `docs/src/content/docs/docs/guides/mcp-proxy.mdx`
- `docs/src/content/docs/docs/reference/cli.mdx`
- `docs/src/content/docs/docs/reference/configuration.mdx`
- generated workspace schemas

**Change**
- Document destination semantics, repeatable clients, profile-local proxy configuration, exact file/cache paths, generated `--profile`, and local reset versus remote revocation.
- Remove stale `allagents update --scope` documentation.
- Regenerate the user workspace JSON schema.

**Proof**
- Schema generator and docs build succeed; examples match executable command help.

## Verification

Focused red/green checks are run per unit. Final verification:

```bash
bun run build
bun run typecheck
bun run lint
bun run docs:build
bun test
bun run test:e2e
```

Manual isolated-home E2E:

1. Project add/update produces `.codex/config.toml` and `.github/mcp.json`.
2. User add/update produces `~/.codex/config.toml` and `~/.copilot/mcp-config.json` without running a full workspace sync.
3. Installed profile add/update produces the profile Codex/Copilot files with generated `--profile <name>` bridge arguments.
4. Two profiles targeting the same URL resolve different OAuth cache directories; project and user resolve the shared ordinary directory.
5. `mcp reauth --profile` removes only the selected profile credentials.
6. Profile removal deletes its OAuth subtree while preserving unrelated residue safely.
7. Real Codex and Copilot clients can invoke a TradingView MCP tool through the materialized bridge where installed credentials permit it.

## Risks controlled

- No profile-qualified global client IDs; policy remains destination-local.
- No direct profile file writes outside the ownership-aware planner.
- No full user sync from an MCP-only command.
- No profile-root recursive deletion; only the fixed OAuth subtree is lifecycle-owned.
- No selector widening from empty repeatable arguments.
- No cache-path construction from an unvalidated profile name.
- No separate declaration/proxy writes that can leave partial configuration.
