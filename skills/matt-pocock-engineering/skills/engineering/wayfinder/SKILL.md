---
name: wayfinder
description: Plan a huge chunk of work as a shared map of decision tickets, resolving one ticket at a time until the route to the destination is clear.
disable-model-invocation: true
---

# Wayfinder

Chart work too large for one agent session as a shared map of decisions. The destination may be a spec, a locked decision, or a change, but wayfinding is planning by default: resolve what must be decided before execution rather than executing the destination.

Refer to every map and ticket by its title in user-facing text. Keep tracker IDs inside links, never as the only name.

## Tracker

Use the repository's documented issue workflow when `docs/agents/issue-tracker.md` exists. If it does not, use this self-contained local Markdown tracker instead of requiring another setup skill:

- Map: `.scratch/<effort>/map.md`.
- Ticket: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`.
- Ticket metadata: `Type: research|prototype|grilling|task`, `Status: open|claimed|resolved`, and optional `Blocked by: NN, NN` lines.
- Frontier: open, unblocked, unclaimed tickets in numeric order.
- Claim: set `Status: claimed` before work.
- Resolve: append `## Answer`, set `Status: resolved`, then append a linked one-line gist to the map's Decisions so far.

For a hosted tracker, use its native child-issue, blocking, assignment, comment, and close operations. Assignment is the claim.

## Map

The map is an index, not a second copy of ticket details:

```markdown
## Destination

<What reaching the end of this map looks like.>

## Notes

<Domain, standing preferences, and capabilities relevant to every session.>

## Decisions so far

- [<resolved ticket title>](link): <one-line gist>

## Not yet specified

<In-scope fog that cannot yet be phrased as a precise question.>

## Out of scope

<Work deliberately beyond the destination.>
```

Each ticket asks one decision-sized question that fits one agent session. Create tickets only when the question can be stated precisely now. Keep dimly understood in-scope work under Not yet specified until earlier decisions sharpen it. Work beyond the destination belongs under Out of scope and never graduates.

## Ticket types

- **Research (agent-driven):** establish an external fact from primary sources. Run independent research concurrently where possible, cite sources, and save findings as a linked asset or resolution comment.
- **Prototype (human-in-the-loop):** make the cheapest concrete artifact that answers a design question. Keep it throwaway, runnable, visibly marked as a prototype, and link it from the ticket. Use a simple interactive artifact for logic/state questions and several switchable variations for UI questions.
- **Grilling (human-in-the-loop):** resolve a decision through focused interview rounds. Ask every currently unblocked question together, include recommendations, wait for answers, and stress-test them with concrete scenarios.
- **Task (agent- or human-driven):** perform prerequisite work that exposes facts needed by a later decision. It belongs on the map only because it unblocks a decision.

When terminology crystallizes, update the applicable `CONTEXT.md` immediately. Offer an ADR only for a hard-to-reverse, surprising tradeoff; keep routine decisions in their tickets.

## Chart a map

1. **Name the destination.** Interview the user on the outcome, scope, constraints, and domain language. Ask factual questions of the environment, not the user.
2. **Map the frontier breadth-first.** Surface precise decisions available now across the whole effort. Keep dependent or still-fuzzy areas in Not yet specified.
3. If the route is already clear and fits one session, stop and ask whether the user wants a normal plan instead; do not create ceremony.
4. Create the map and every currently precise ticket. Create tickets first, then wire blocking relationships once identities exist.
5. Start independent research tickets concurrently. Each researcher uses primary sources and records a cited answer on its ticket.
6. Stop after charting. Do not hand-resolve a human-in-the-loop ticket in the same session.

## Work through a map

Resolve at most one non-research ticket per session:

1. Load the map at low resolution; open related tickets only as needed.
2. Use the user-named ticket or the first frontier ticket. Claim it before work.
3. Resolve according to its type. For grilling, work the decision tree in rounds. For a prototype, state the exact question the artifact answers before creating it.
4. Record the answer on the ticket, close it, and add only a linked gist to Decisions so far.
5. Create newly visible tickets, wire dependencies, and graduate sharpened fog. Close and list anything revealed to be out of scope rather than treating it as a route decision.

Other sessions may update the tracker concurrently. Re-read map and ticket state immediately before claiming or writing.
