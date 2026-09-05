#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  worktree.sh [-C <repo>] add <branch> [start-point]
  worktree.sh [-C <repo>] remove [--force] [--merged] <branch-or-path>

Worktrees are created under <repo>__worktrees by default. Override the
location with WORKTREE_ROOT and the default remote with WORKTREE_REMOTE.
Branch slashes become dashes in directory names.
Pass --merged only after the branch's merge is confirmed. It removes the
worktree and deletes its checked-out local branch.
EOF
}

fail() {
  printf 'worktree: %s\n' "$*" >&2
  exit 1
}

repo_dir="."
if [[ "${1:-}" == "-C" ]]; then
  [[ $# -ge 3 ]] || {
    usage >&2
    exit 2
  }
  repo_dir="$2"
  shift 2
fi

repo_root="$(git -C "$repo_dir" rev-parse --show-toplevel 2>/dev/null)" ||
  fail "repository not found: $repo_dir"
remote="${WORKTREE_REMOTE:-origin}"
[[ -n "$remote" ]] || fail "WORKTREE_REMOTE must not be empty"

configured_root="${WORKTREE_ROOT:-${repo_root}__worktrees}"
if [[ "$configured_root" = /* ]]; then
  raw_worktree_root="${configured_root%/}"
else
  raw_worktree_root="${repo_root}/${configured_root%/}"
fi

worktree_path_for_branch() {
  local branch="$1"
  printf '%s/%s\n' "$worktree_root" "${branch//\//-}"
}

default_start_point() {
  local remote_head
  remote_head="$(git -C "$repo_root" symbolic-ref --quiet --short "refs/remotes/$remote/HEAD" 2>/dev/null || true)"
  printf '%s\n' "${remote_head:-HEAD}"
}

command="${1:-}"
case "$command" in
  add)
    [[ $# -ge 2 && $# -le 3 ]] || {
      usage >&2
      exit 2
    }

    branch="$2"
    start_point="${3:-$(default_start_point)}"
    git -C "$repo_root" check-ref-format --branch "$branch" >/dev/null 2>&1 ||
      fail "invalid branch name: $branch"

    mkdir -p "$raw_worktree_root"
    worktree_root="$(cd "$raw_worktree_root" && pwd -P)"
    path="$(worktree_path_for_branch "$branch")"
    [[ ! -e "$path" ]] || fail "path already exists: $path"

    if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch"; then
      git -C "$repo_root" worktree add "$path" "$branch"
    elif git -C "$repo_root" show-ref --verify --quiet "refs/remotes/$remote/$branch"; then
      git -C "$repo_root" worktree add --track -b "$branch" "$path" "$remote/$branch"
    else
      git -C "$repo_root" worktree add -b "$branch" "$path" "$start_point"
    fi

    printf '%s\n' "$path"
    ;;

  remove)
    shift
    force=()
    merged=false
    while [[ "${1:-}" == --* ]]; do
      case "$1" in
        --force) force=(--force) ;;
        --merged) merged=true ;;
        *)
          usage >&2
          exit 2
          ;;
      esac
      shift
    done
    [[ $# -eq 1 ]] || {
      usage >&2
      exit 2
    }

    [[ -d "$raw_worktree_root" ]] ||
      fail "worktree root does not exist: $raw_worktree_root"
    worktree_root="$(cd "$raw_worktree_root" && pwd -P)"

    target="$1"
    if [[ "$target" = /* ]]; then
      candidate="$target"
    else
      candidate="$repo_root/$target"
    fi
    if [[ -d "$candidate" ]]; then
      path="$(cd "$candidate" && pwd -P)"
    else
      path="$(worktree_path_for_branch "$target")"
    fi

    case "$path" in
      "$worktree_root"/*) ;;
      *) fail "refusing to remove a worktree outside $worktree_root" ;;
    esac

    [[ -d "$path" ]] || fail "worktree does not exist: $path"

    branch=""
    if [[ "$merged" == true ]]; then
      branch="$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null)" ||
        fail "cannot delete the branch for a detached worktree: $path"
      git_common_dir="$(git -C "$repo_root" rev-parse --git-common-dir)"
      if [[ "$git_common_dir" != /* ]]; then
        git_common_dir="$repo_root/$git_common_dir"
      fi
      git_common_dir="$(cd "$git_common_dir" && pwd -P)"
    fi
    git -C "$repo_root" worktree remove "${force[@]}" "$path"
    if [[ "$merged" == true ]]; then
      git --git-dir="$git_common_dir" branch -D "$branch"
    fi
    ;;

  -h|--help|help)
    usage
    ;;

  *)
    usage >&2
    exit 2
    ;;
esac
