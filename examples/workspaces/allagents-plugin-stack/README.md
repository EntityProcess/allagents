# AllAgents Plugin Stack

A copy-and-run workspace for installing a project-scoped, multi-client (Codex,
Copilot, and Claude) agent workflow stack with AllAgents.

It includes:

- `workmux` for worktree/tmux workflow skills
- `agent-tui` skills for controlling interactive terminal sessions
- `beads` skills and Codex hooks
- `compound-engineering` skills without requiring the global Codex plugin install
- `understand-anything` codebase/knowledge-graph onboarding skills

## Running It

Scaffold a fresh copy anywhere:

```bash
allagents workspace init ./allagents-plugin-stack-demo \
  --from EntityProcess/allagents/examples/workspaces/allagents-plugin-stack
cd ./allagents-plugin-stack-demo
```

Or run it in-place from this repository checkout:

```bash
cd examples/workspaces/allagents-plugin-stack
allagents update
```

After sync, inspect the Codex output:

```bash
find .codex/skills -maxdepth 2 -name SKILL.md
cat .codex/hooks.json
```

Copilot and Claude equivalents are also generated according to the `clients`
list, such as `.copilot/` and `.claude/` project-scoped files.

## Notes

AllAgents syncs project-local skills, hooks, and client config for each configured
client. It does not write Codex's global plugin registry, so the Compound
Engineering command below is not needed for this project-scoped setup:

```bash
bunx @every-env/compound-plugin install compound-engineering --to codex
```

Runtime binaries are still separate from plugin artifact sync. Install
`agent-tui` before using the agent-tui skills, and install `bd` before relying
on Beads commands or hooks.
