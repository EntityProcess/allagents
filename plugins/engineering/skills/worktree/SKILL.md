---
name: worktree
description: Creates and removes isolated Git worktrees under a consistent repository sibling directory. Use when starting feature or fix work in a dedicated worktree, or cleaning up a finished worktree.
---

# Git Worktrees

Resolve this skill's directory, then invoke its bundled `scripts/worktree.sh`. Pass `-C <repo>` when the shell is not already inside the target repository.

## Add

```bash
<skill-directory>/scripts/worktree.sh -C <repo> add <branch> [start-point]
```

The script:

1. uses an existing local branch when present;
2. creates a tracking branch when `<remote>/<branch>` exists;
3. otherwise creates the branch from `start-point`, the remote default branch, or `HEAD`;
4. prints the created worktree path.

Fetch the remote before adding when the worktree must start from its latest state:

```bash
git -C <repo> fetch origin
<skill-directory>/scripts/worktree.sh -C <repo> add feat/example origin/main
```

Worktrees default to `<repo>__worktrees/<branch-with-slashes-as-dashes>`. Set `WORKTREE_ROOT` to use another parent and `WORKTREE_REMOTE` to use a remote other than `origin`.

## Remove

```bash
<skill-directory>/scripts/worktree.sh -C <repo> remove <branch-or-path>
<skill-directory>/scripts/worktree.sh -C <repo> remove --force <branch-or-path>
```

Normal removal preserves Git's dirty-worktree protection. Use `--force` only when discarding the worktree's uncommitted files is intended. Removal unregisters and deletes the worktree directory; it leaves the branch intact.

An add is complete when the script prints the new path and `git -C <repo> worktree list` contains it. A removal is complete when that path is absent.
