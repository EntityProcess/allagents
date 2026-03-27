# Contributing to AllAgents

Thanks for contributing.

## The One Rule

**Understand your change.** If you can't explain what your code does, why it belongs in AllAgents, and how it affects existing behavior, don't submit it yet.

Using AI tools is fine. Shipping code you don't understand is not.

## Before You Build

For non-trivial features or behavior changes, open an issue first and wait for maintainer alignment.

## Development Setup

```bash
bun install
bun run build
bun test
```

Run CLI changes from source during development:

```bash
bun run dev workspace init test-ws
bun run dev update
```

## Before Submitting a PR

- PR explains what changed and why
- Tests are updated when relevant
- No unrelated refactors in the same PR
- Pre-push hooks pass (`lint`, `typecheck`, `test` run automatically on push)
- Manual E2E test: build the CLI (`bun run build`) and run against a temp workspace

## Workflow

- Branch from `main`
- Use conventional commits: `type(scope): description`
- Open a PR (draft is fine)
- Squash merge when approved

## Publishing

Never run `npm publish` directly. Use the two-step workflow:

1. `bun run publish:next` — publishes to the `next` tag
2. `bun run promote:latest` — promotes `next` to `latest` after testing

## Architecture

See [CLAUDE.md](./CLAUDE.md) for architecture notes, coding standards, and AI agent guidelines.
