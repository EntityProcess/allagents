# AllAgents

A CLI tool for managing AI coding assistant plugins across multiple clients (Claude Code, GitHub Copilot, Cursor, etc.).

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
   # From the repository root
   cd /path/to/allagents
   git worktree add ../allagents_<type>-<short-description> <type>/<issue-number>-<short-description>
   # Example: git worktree add ../allagents_feat-add-new-embedder feat/42-add-new-embedder
   cd ../allagents_<type>-<short-description>
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

### Git Worktrees

**ALWAYS use git worktrees for feature development.** This allows you to work on multiple branches simultaneously without switching contexts.

Create worktrees in a **sibling folder** using the naming convention `projectname_branchname`:

```bash
# From the repository root
git worktree add ../allagents_<branchname> <branchname>

# Examples:
git worktree add ../allagents_feat-new-feature feat/new-feature
git worktree add ../allagents_fix-bug-123 fix/123-description
```

When done:
```bash
# Remove worktree after branch is merged
git worktree remove ../allagents_<branchname>
```

## Troubleshooting

### agent-browser

If `agent-browser open` fails with "Missing X server or $DISPLAY" errors on Linux, the installed version may be outdated. Update to the latest version:

```bash
sudo npm update -g agent-browser
agent-browser --version  # Verify update
```

The browser runs in headless mode by default and should not require X11.
