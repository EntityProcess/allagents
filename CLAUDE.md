# AllAgents

A CLI tool for managing AI coding assistant plugins across multiple clients (Claude Code, GitHub Copilot, Cursor, etc.).

## Bug Reports and Issue Requirements

**Before writing any code for a bug fix, confirm you understand the actual problem.** Ask the user clarifying questions when:

- The issue description is vague or could have multiple root causes
- You cannot reproduce the reported behavior from the description alone
- The proposed solution in the issue doesn't clearly match the described problem
- The bug could be a user error (e.g., running a command from the wrong directory) rather than a code defect

Do NOT assume the first plausible-looking code path is the root cause. Verify the user's environment, exact commands run, and expected vs actual output before proposing a fix.

## Plans

Design documents and implementation plans are stored in `.claude/plans/`. These are temporary working documents - once implementation is complete, delete the plan and update official docs with any user-facing behavior.

## Git Workflow

### Commit Convention

Follow conventional commits: `type(scope): description`

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

Do NOT add `Co-Authored-By` attribution to commit messages.

### Issue Workflow

When working on a GitHub issue, **ALWAYS** follow this workflow:

1. **Create a worktree with a feature branch** from `main`:
   ```bash
   git worktree add ../allagents.worktrees/<type>-<short-description> -b <type>/<issue-number>-<short-description>
   # Example: git worktree add ../allagents.worktrees/feat-add-new-embedder -b feat/42-add-new-embedder
   cd ../allagents.worktrees/<type>-<short-description>
   ```

2. **Implement the changes** and commit following the commit convention

3. **Push the branch and create a Pull Request**:
   ```bash
   git push -u origin <branch-name>
   gh pr create --title "<type>(scope): description" --body "Closes #<issue-number>"
   ```

4. **Before merging**, ensure:
   - CI pipeline passes (all checks green)
   - Code has been reviewed if required
   - No merge conflicts with `main`

**IMPORTANT:** Never push directly to `main`. Always use branches and PRs.

### Pull Requests

**Always use squash merge** when merging PRs to main. This keeps the commit history clean with one commit per feature/fix.

```bash
# Using GitHub CLI to squash merge a PR
gh pr merge <PR_NUMBER> --squash --delete-branch --admin
```

Do NOT use regular merge or rebase merge, as these create noisy commit history with intermediate commits.

### After Squash Merge

Once a PR is squash-merged, its source branch diverges from main. **Do NOT** try to push additional commits from that branch—you will get merge conflicts.

For follow-up fixes:
```bash
git checkout main
git pull origin main
git checkout -b fix/<short-description>
# Apply fixes on the fresh branch
```

## Testing

Tests use `bun:test`. Run with `bun test` or target a specific file with `bun test tests/unit/core/foo.test.ts`.

### Approach

- One test per distinct code path. Avoid testing the same branch with slightly different inputs — if the code path is the same, one test is enough.
- Prefer covering the input matrix (e.g. config present/absent across scopes) but collapse cases that exercise identical logic.
- Tests should be fast and not slow down CI. Remove redundant tests rather than keeping them for completeness.

### Manual E2E Testing

**ALWAYS run manual E2E tests before marking a PR ready for review.** Build the CLI and test the actual user-facing behavior end-to-end. Draft PRs can be created early and committed to frequently, but E2E validation must happen before requesting review.

```bash
# Build the CLI in your worktree
bun run build

# Test the specific behavior your change affects
./dist/index.js sync
./dist/index.js plugin update
```

**How to E2E test:** Create a temporary workspace in `/tmp/`, configure it with a `workspace.yaml` that exercises your change, run the built CLI against it, and verify the filesystem result matches expectations. Clean up after.

**IMPORTANT: Never run `git config` in the repo directory.** If tests need git user config (e.g., for commits in a temp repo), always scope it to the temp directory: `git config --local user.name "Test"` inside the temp dir. Running `git config user.name` or `git config user.email` in the project root will silently override the user's identity for all future commits.

**Include E2E steps in the PR description** so human reviewers can reproduce the test. Document the exact commands you ran and what you verified.

Unit tests with mocks verify internal logic but miss integration bugs. Mocks that don't match real interfaces create false confidence.

### Unit Test Anti-patterns

Avoid tests that verify implementation details rather than behavior:

- **Bad**: "verify `updateMarketplace` was called with `'test-marketplace'`" — breaks on refactors, misses real bugs
- **Good**: "plugin updates successfully when marketplace exists" — tests actual outcome

If a mock doesn't match the real interface (e.g., missing a `name` field the real function returns), the test passes but production breaks. When writing mocks, match the actual return type.

### Git Worktrees

Use the default `allagents.worktrees/` directory (sibling to the repo, already in `.gitignore`). After creating a worktree, run `bun install` since worktrees do not share `node_modules`.

When done:
```bash
git worktree remove ../allagents.worktrees/<name>
```

## Architecture Notes

### MCP Server Sync

MCP servers from plugins are synced to VS Code's `mcp.json`. Key ownership rule:

- **We only track servers we added.** If a server already exists in the user's `mcp.json` before a plugin is installed, we must NOT track it — otherwise uninstalling the plugin would delete the user's manually-configured server.
- `trackedServers` in sync state = "servers we own and are responsible for updating/removing"
- Skipped servers (user-managed conflicts) must never be added to `trackedServers`

### CLI Output Paths

User-facing output for sync results is displayed from multiple entry points:
- `sync` command (`src/cli/commands/workspace.ts`) — also available as `workspace sync`
- `plugin install/uninstall/update` commands (`src/cli/commands/plugin.ts`)
- TUI interactive sync (`src/cli/tui/actions/sync.ts`)

Shared formatting lives in `src/cli/format-sync.ts`. When adding new sync output, update the shared module — not individual call sites.

### VSCode / Copilot Display Alias

`vscode` is a display alias for `copilot` **for artifact counts only** (skills, commands, agents, hooks). Since VS Code and Copilot share skill paths, their counts are merged under the `copilot` label.

**MCP output uses the raw client name** — no aliasing. This is because vscode and copilot have independent MCP support.

Internally, `vscode` and `copilot` remain distinct client types with separate path mappings (see `resolveClientMappings()` in `client-mapping.ts`).

## Publishing

**Never run `npm publish` directly.** Always use the two-step workflow:

1. `bun run publish:next` — publishes to the `next` tag
2. `bun run promote:latest` — promotes `next` to `latest` after testing

A `prepublishOnly` guard in `package.json` blocks direct `npm publish`. This prevents untested releases from going to `latest`.

## Troubleshooting

### agent-browser

If `agent-browser open` fails with "Missing X server or $DISPLAY" errors on Linux, the installed version may be outdated. Update to the latest version:

```bash
sudo npm update -g agent-browser
agent-browser --version  # Verify update
```

The browser runs in headless mode by default and should not require X11.
