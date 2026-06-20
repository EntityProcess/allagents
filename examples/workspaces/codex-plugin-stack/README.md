# Codex Plugin Stack Example

A copy-and-run workspace for installing a project-scoped Codex agent workflow
stack with AllAgents.

It includes:

- `workmux` for worktree/tmux workflow skills
- `agent-tui` skills for controlling interactive terminal sessions
- `beads` skills and Codex hooks
- `compound-engineering` skills without requiring the global Codex plugin install

## Running It

Scaffold a fresh copy anywhere:

```bash
allagents workspace init ./codex-plugin-stack-demo \
  --from EntityProcess/allagents/examples/workspaces/codex-plugin-stack
cd ./codex-plugin-stack-demo
```

Or run it in-place from this repository checkout:

```bash
cd examples/workspaces/codex-plugin-stack
allagents update
```

After sync, inspect:

```bash
find .codex/skills -maxdepth 2 -name SKILL.md
cat .codex/hooks.json
```

## Notes

AllAgents syncs project-local Codex skills and hooks. It does not write Codex's
global plugin registry, so the Compound Engineering command below is not needed
for this project-scoped setup:

```bash
bunx @every-env/compound-plugin install compound-engineering --to codex
```

Runtime binaries are still separate from plugin artifact sync. Install
`agent-tui` before using the agent-tui skills, and install `bd` before relying
on Beads commands or hooks.
