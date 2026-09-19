---
name: allagents
description: Manage AllAgents workspaces, plugins, skills, client targets, global profiles, and MCP servers through the allagents CLI. Use when a user asks to initialize, inspect, update, or configure AllAgents; install or remove plugins or skills; manage profiles; or add, inspect, authenticate, update, or remove MCP servers. Resolve current command syntax from machine-readable help instead of relying on remembered flags.
---

# AllAgents CLI

Use an AllAgents CLI runner as the authoritative mutation boundary. Prefer its commands over hand-editing AllAgents declarations or generated client files.

## Resolve the CLI runner

Choose one runner at the start of the task and use it for every discovery, execution, and verification command:

1. If `allagents` is on `PATH`, use `allagents`.
2. Otherwise, if `npx` is available, use `npx --yes allagents`.
3. If neither is available, stop and ask the user to install AllAgents or Node.js with npm.

Examples below use `allagents`; substitute the complete `npx --yes allagents` prefix when that is the selected runner. Do not mix runners within one operation.

## Resolve the current command contract

1. Confirm the installed version with `allagents --version`.
2. Discover top-level commands with `allagents --help --json`.
3. Narrow to the relevant group with `allagents <group> --help --json`.
4. Before execution, inspect the leaf command with `allagents <command> --help --json`.
5. Use the returned positionals, options, examples, interaction requirements, output schema, and JSON field allowlist as the source of truth.

Do not rely on memorized flags when structured help is available. Do not invent aliases or combine options that the leaf metadata does not advertise.

## Choose the interface

- Run `allagents` without arguments in an interactive terminal when the user wants to browse and make choices in the TUI.
- Use direct commands when the requested operation and destination are already known.
- For automation, use `--json`, explicit selectors, and non-interactive confirmation options advertised by the leaf help.
- Use `--json=<fields>` only with fields listed by that command. Use `--jq` only with JSON output.
- Treat the process exit code and structured success envelope as authoritative. Verify mutations with the corresponding list, get, or status command.

## Route the request

| Intent | Inspect first |
| --- | --- |
| Initialize or reconcile a workspace | `allagents --help --json`, then the selected workspace or update command help |
| Inspect declared and live state | `allagents status --help --json` |
| Install, list, update, or remove plugins | `allagents plugin --help --json` |
| Discover, install, enable, disable, or update skills | `allagents skill --help --json` |
| Add, inspect, authenticate, update, or remove MCP servers | `allagents mcp --help --json` |
| Install, inspect, update, or remove global profiles | `allagents profile --help --json` |
| Update a globally installed CLI | `allagents self update --help --json`; with the npx runner, use `npx --yes allagents@latest` and skip self-update |

Always continue from group help to the chosen leaf command before executing it.

## Destination and ownership rules

AllAgents keeps project, ordinary user, and named-profile state separate.

- Use the destination explicitly requested by the user.
- When a mutating command supports destination flags, pass the explicit project, user, or profile selector advertised by its help.
- Never guess a named profile.
- Do not treat generated client files as declarations. Change the AllAgents-owned declaration through the CLI, then let AllAgents update client configuration.
- If an update fails after a declaration mutation, report that split state and use the command's documented update or retry path. Do not silently rewrite generated files.

## MCP workflow

1. Select exactly one project, user, or named-profile destination.
2. Inspect `allagents mcp --help --json`, then the selected MCP leaf command help.
3. List the destination before destructive or authentication-changing operations.
4. Execute the mutation with an explicit destination when the help supports one.
5. Verify the result with the corresponding MCP list or get command in the same destination.

Never print credential values. Prefer environment-variable references for secret headers or environment values when the command contract supports them. Preserve OAuth browser and callback interaction when structured help marks it as required.

## Safety

- Review declared setup commands before running any workspace setup action. Setup is an explicit trust boundary.
- Use a dry-run option before a material mutation whenever the leaf help advertises one.
- Do not edit or delete user-owned client configuration outside AllAgents ownership records.
- Do not cross project, user, or profile boundaries to make a command succeed.
- Stop on validation, authentication, ownership, or partial-update errors; report the selected destination and the recovery command exposed by structured help.

## Completion

Report the command path used, selected destination and clients, structured result, and verification command. For a mutation, completion requires the declared state and the corresponding live or generated client state to agree, or an explicit partial-update error with its recovery path.
