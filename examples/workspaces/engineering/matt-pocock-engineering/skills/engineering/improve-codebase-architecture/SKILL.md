---
name: improve-codebase-architecture
description: Scan a codebase for deepening opportunities, present them as a visual HTML report, then grill through the selected candidate.
disable-model-invocation: true
---

# Improve Codebase Architecture

Survey a whole codebase for architectural friction and propose deepening opportunities: refactors that put substantial behavior behind a small interface. This is a macro architecture survey, not a diff or PR review.

## Vocabulary and invariants

Use these terms exactly:

- **Module:** anything with an interface and implementation: function, class, package, or tier-spanning slice.
- **Interface:** everything callers must know, including types, invariants, ordering, errors, configuration, and performance constraints.
- **Implementation:** behavior hidden inside a module.
- **Depth:** leverage at the interface. A deep module hides substantial behavior behind a small interface; a shallow module exposes nearly as much complexity as it contains.
- **Seam:** a place where behavior can change without editing the caller.
- **Adapter:** a concrete implementation occupying a seam.
- **Leverage:** capability callers gain per unit of interface they learn.
- **Locality:** change, bugs, knowledge, and verification concentrated in one place.

Do not substitute component or service for module, API for interface, or boundary for seam.

Apply these principles:

- The deletion test: deleting a useful module redistributes its complexity across callers; deleting a pass-through removes complexity.
- The interface is the test surface. Tests should exercise observable behavior through it and survive implementation refactors.
- One adapter is a hypothetical seam; two adapters justify a real one.
- A module may have private internal seams without exposing them to callers.
- Replace shallow-module tests with tests at the deepened interface; do not layer both suites permanently.

Classify dependencies before proposing a seam: in-process computation needs no adapter; local-substitutable I/O should use a real local stand-in; remote owned systems use a port plus production and in-memory adapters; true external systems use an injected port plus a mock adapter.

## Explore

Scope before scanning. If the user names a subsystem or pain point, use it. Otherwise inspect enough commit history to find recently changing hot spots; widen only when history is scattered. Read `CONTEXT-MAP.md` or `CONTEXT.md` and applicable ADRs before evaluating an area.

Use an independent codebase explorer when the host supports it. Explore organically and collect evidence:

- Understanding one concept requires bouncing among shallow modules.
- Interfaces are nearly as complex as implementations.
- Pure functions were extracted for testability while integration bugs remain elsewhere.
- Coupled modules leak knowledge across seams.
- Behavior is difficult to verify through the current interface.

Apply the deletion test to each candidate. Exclude speculative abstraction and cold code with no demonstrated change pressure.

## Present a visual report

Write a fresh self-contained HTML file to `$TMPDIR`, `/tmp`, or `%TEMP%` as `architecture-review-<timestamp>.html`; do not add it to the repository. Open it with the platform's normal browser command and report its absolute path.

Use Tailwind via CDN for layout and Mermaid via CDN for graph-shaped diagrams. Use static HTML, CSS, and inline SVG for editorial visuals. The report contains:

- Header with repository, date, and legend.
- One card per candidate with files, one-sentence problem, one-sentence solution, short benefits, recommendation strength (`Strong`, `Worth exploring`, or `Speculative`), and a side-by-side before/after diagram.
- An explicit warning when a candidate contradicts an ADR.
- A final Top recommendation card naming one candidate and why.

Prefer diagrams over prose. Use dependency graphs, call-graph collapse, stacked shallow bands, or interface-versus-implementation mass diagrams according to the evidence. Keep each diagram around 320px tall. Label benefits in terms of leverage, locality, interface size, and test surface.

Do not propose exact interfaces in the first report. Ask: “Which of these would you like to explore?”

## Grill the selected candidate

Once the user chooses, build a decision tree covering constraints, dependencies, seam placement, what the module hides, the interface callers need, migration, and which tests survive. Ask every currently unblocked question in one numbered round and include your recommendation. Wait for answers, recompute the frontier, and repeat until no branch remains silently assumed.

Find repository facts yourself. Stress-test choices with concrete domain scenarios. When a term becomes precise, update the applicable `CONTEXT.md` immediately; create a root glossary lazily if none exists. Keep glossary definitions to one or two sentences and free of implementation detail.

Offer an ADR only if the decision is hard to reverse, surprising without context, and a genuine tradeoff. If all three hold, record a short sequential file under `docs/adr/`.

## Design interfaces more than once

If the user wants concrete interface options, frame the constraints and dependency category, then produce at least three radically different designs independently:

1. Minimal interface with one to three entry points.
2. Flexible interface optimized for extension.
3. Interface optimized for the common caller.
4. A ports-and-adapters design when a remote seam genuinely exists.

For each, show the complete interface contract, usage, hidden implementation, dependency strategy, and tradeoffs. Compare depth, locality, and seam placement; then recommend one design or a specific hybrid.
