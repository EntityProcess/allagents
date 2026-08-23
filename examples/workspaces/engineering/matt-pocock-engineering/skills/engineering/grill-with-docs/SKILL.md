---
name: grill-with-docs
description: A relentless interview to sharpen a plan or design, which also creates ADRs and a glossary as decisions crystallize.
disable-model-invocation: true
---

# Grill With Docs

Interview the user until the plan or design has no silently assumed branches. Build a design tree: every decision branches into the decisions that depend on it.

## Work the frontier

The frontier is every question whose prerequisites are settled. Ask the whole frontier in one round, number each question, and include your recommended answer. Do not ask a question whose answer depends on another question still open in the same round.

Use this shape:

```text
Q1 — <title>: <question and concrete choices>
Recommendation: <answer and reason>

Q2 — <title>: <question and concrete choices>
Recommendation: <answer and reason>
```

Wait for the user's answers after each round. Recompute the tree from those answers, then ask the next frontier. Find environmental facts yourself with repository and research tools; ask the user only for decisions. Stress-test vague answers with concrete edge cases.

The interview ends only when the frontier is empty and the user confirms the shared understanding. Do not implement the plan as part of this skill.

## Maintain the domain model inline

Read `CONTEXT-MAP.md` or `CONTEXT.md` when present. Challenge terms that conflict with the glossary and distinguish overloaded concepts. When a domain term becomes precise, update the applicable `CONTEXT.md` immediately; create a root `CONTEXT.md` lazily if none exists.

Keep the glossary free of implementation details. Use this compact form:

```markdown
# <Context name>

<One or two sentence description.>

## Language

**Canonical term**:
<One or two sentence definition.>
_Avoid_: Ambiguous synonym, obsolete synonym
```

Offer an ADR only when a decision is hard to reverse, surprising without context, and the result of a real tradeoff. If all three hold, write the next sequential `docs/adr/NNNN-slug.md` with a short title and one to three sentences covering context, decision, and reason. Create the directory lazily. Do not create documentation for routine or reversible choices.
