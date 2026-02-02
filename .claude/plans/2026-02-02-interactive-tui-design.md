# Interactive TUI for `allagents`

## Problem

When a user runs `allagents` with no arguments, they see a static help screen. This is unhelpful for new users who don't know which subcommand to use. We want an interactive guided wizard that surfaces the right actions based on context.

## Research

Reviewed TUI approaches across the ecosystem:

| Project | Library | Style |
|---------|---------|-------|
| dotagents (iannuttall) | `@clack/prompts` | Guided wizard with action loop |
| dot-agents | Pure Bash | No interactive UI |
| OpenSkills | `@inquirer/prompts` + `ora` | Selective prompts on commands |
| OpenSpec | None | Slash commands only |

**Decision:** Use `@clack/prompts` for a guided wizard. It's lightweight (~15KB), has a polished UX with spinners/notes/selects, and is proven by dotagents. We considered OpenTUI but it's pre-production with a Zig build dependency.

## Design

### Entry Point Behavior

When the user runs `allagents` with no arguments:
- If stdout is a TTY → launch interactive wizard
- If stdout is not a TTY (piped/CI) → show current help text (backward compatible)

### Architecture

```
src/cli/
  index.ts          ← modify: detect no-args + TTY → launch wizard
  tui/
    wizard.ts       ← main wizard loop
    context.ts      ← detect workspace state, build smart menu
    actions/
      init.ts       ← guided workspace init flow
      sync.ts       ← guided sync with progress
      status.ts     ← display workspace/plugin status
      plugins.ts    ← plugin install/uninstall/browse marketplace
      update.ts     ← self-update flow
```

### Dependencies

- `@clack/prompts` — prompt library (select, multiselect, confirm, spinner, note)
- `chalk` — terminal colors

### Context-Aware Smart Menu

The menu adapts based on detected workspace state:

**State 1: No workspace detected (first-time user)**
```
┌ allagents v0.9.0
│
◆ No workspace detected. What would you like to do?
│ ● Initialize a workspace
│ ○ Browse marketplace
│ ○ Install plugin (user scope)
│ ○ Exit
└
```

**State 2: Workspace exists, plugins need sync**
```
┌ allagents v0.9.0
│
◇ Workspace: ./my-project
│ 3 plugins installed · 1 needs sync
│
◆ What would you like to do?
│ ● Sync plugins (1 pending)
│ ○ View status
│ ○ Install plugin
│ ○ Manage plugins
│ ○ Browse marketplace
│ ○ Exit
└
```

**State 3: Everything synced**
```
┌ allagents v0.9.0
│
◇ Workspace: ./my-project
│ 3 plugins installed · All synced ✓
│
◆ What would you like to do?
│ ● View status
│ ○ Install plugin
│ ○ Manage plugins
│ ○ Browse marketplace
│ ○ Check for updates
│ ○ Exit
└
```

**Key principle:** The first option is always the most useful action for the current state.

### Plugin Installation Scope

When installing plugins interactively:
1. Browse marketplace → select plugin(s)
2. Prompt for scope:
   - "Project (this workspace)" — only if workspace detected in cwd
   - "User (global, all workspaces)" — always available
3. Confirm → install with spinner → return to menu

Same pattern for uninstall: show plugins grouped by scope, multiselect to remove.

### Error Handling

- Cancel at any prompt (Ctrl+C) → clean exit with "Cancelled" message
- Action failure → show error note, return to menu (don't crash out)
- Non-TTY → fall back to help text

### Key Constraints

- The wizard is a UI layer only — all business logic stays in `src/core/`
- Each action module wraps existing core functions with prompts/spinners
- The wizard is a simple `while(true)` action loop (like dotagents)

## Implementation Plan

### Task 1: Add dependencies
Add `@clack/prompts` and `chalk` to package.json.

### Task 2: Create context detection (`src/cli/tui/context.ts`)
- Detect if cwd has a workspace (`.allagents/workspace.yml`)
- Detect user-level config (`~/.allagents/`)
- Count installed plugins per scope
- Run lightweight sync-state check (are plugins stale?)
- Return a `TuiContext` object with workspace state

### Task 3: Create wizard loop (`src/cli/tui/wizard.ts`)
- `intro()` with app name and version
- Build context-aware menu based on `TuiContext`
- `select()` for action choice
- Dispatch to action handlers
- Loop until exit
- `outro()` on exit

### Task 4: Create action modules
- `src/cli/tui/actions/init.ts` — guided workspace init (path prompt, optional `--from` source)
- `src/cli/tui/actions/sync.ts` — sync with spinner and result display
- `src/cli/tui/actions/status.ts` — formatted status display using `note()`
- `src/cli/tui/actions/plugins.ts` — install (marketplace browse + scope select), uninstall (multiselect), list
- `src/cli/tui/actions/update.ts` — self-update with package manager detection

### Task 5: Wire into CLI entry point (`src/cli/index.ts`)
- Detect: no subcommand provided + stdout is TTY
- If both true → call wizard
- Otherwise → existing behavior

### Task 6: Tests
- Unit tests for context detection logic
- Integration test for wizard menu building based on context states
