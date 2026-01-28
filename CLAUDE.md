# AllAgents

A CLI tool for managing AI coding assistant plugins across multiple clients (Claude Code, GitHub Copilot, Cursor, etc.).

## Plans

Design documents and implementation plans are stored in `.claude/plans/`. These are temporary working documents - once implementation is complete, delete the plan and update official docs with any user-facing behavior.

## Git Workflow

### Commit Convention

Follow conventional commits: `type(scope): description`

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

### Issue Workflow

When working on a GitHub issue or creating an OpenSpec proposal, **ALWAYS** follow this workflow:

1. **Create a feature branch** from `main`:
   ```bash
   git checkout main
   git pull origin main
   git checkout -b <type>/<issue-number>-<short-description>
   # Example: feat/42-add-new-embedder
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
gh pr merge <PR_NUMBER> --squash --delete-branch

# Or with auto-merge enabled
gh pr merge <PR_NUMBER> --squash --auto
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

### Git Worktrees

When creating a git worktree, place it in a **sibling folder** using the naming convention `projectname_branchname`:

```bash
# From the repository root
git worktree add ../allagents_docs-update docs/update-readme
git worktree add ../allagents_feat-new-feature feat/new-feature
```
