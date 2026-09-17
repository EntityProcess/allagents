---
title: "Plugin and skill update performance research"
date: 2026-09-16
type: research
---

# Plugin and skill update performance research

## Conclusion

**Verdict on the suspicion:** it is substantially correct for AllAgents' selected remote inputs, but not literally true for every configured item.

- **[Source fact] Plugin update:** AllAgents invokes update handling for every selected installation. A successful pull of an existing direct GitHub cache is reported as `updated` without comparing its old and new HEAD, and a successful marketplace pull likewise has no changed/no-op result. Local paths and failures are exceptions, and marketplace pulls are deduplicated by marketplace name within each scope. Because the command trusts the inflated `updated` count, a no-op pull can still trigger scope sync. See [`src/cli/commands/plugin.ts:1310-1375`](../../src/cli/commands/plugin.ts#L1310-L1375), [`src/cli/commands/plugin.ts:1405-1478`](../../src/cli/commands/plugin.ts#L1405-L1478), [`src/core/plugin.ts:198-238`](../../src/core/plugin.ts#L198-L238), [`src/core/plugin.ts:430-548`](../../src/core/plugin.ts#L430-L548), and [`src/core/marketplace.ts:970-1067`](../../src/core/marketplace.ts#L970-L1067).
- **[Source fact] Skill update:** AllAgents still needs its temporary-checkout inspection to protect against upstream deletion, but after inspection it never compares each node's `currentSha` with the already-recorded inspected SHA. Every accepted safe unit is reconciled, fetched/reset, labeled `updated`, and included in scope sync even when all revisions are equal. See [`src/core/skill-update.ts:469-596`](../../src/core/skill-update.ts#L469-L596), [`src/cli/skill-update.ts:736-820`](../../src/cli/skill-update.ts#L736-L820), [`src/core/skill-update.ts:658-689`](../../src/core/skill-update.ts#L658-L689), and [`src/cli/skill-update.ts:864-931`](../../src/cli/skill-update.ts#L864-L931).
- **[Recommendation]** Fix result truthfulness and the post-inspection equal-SHA path first. Those are small, local changes that eliminate unnecessary persistent writes and syncs without weakening deletion detection. Add a remote-revision precheck before temporary cloning only afterward.

The useful comparator lesson is not "all other tools hash everything." Each comparator has deliberate boundaries: `skills@1.5.26` avoids unchanged global rewrites but not ordinary project rewrites; Codex skips unchanged marketplace roots but force-reinstalls configured plugins after a changed root; Oh My Pi's bulk marketplace upgrade is version-gated but selected upgrade is unconditional; `plugins@1.3.4` has no update command at all.

## Observed AllAgents behavior

### Source path

1. **Plugin inventory and execution.** The CLI inventories project/user installations, narrows only when a positional plugin selector is present, and serially calls `updatePlugin` for each selected `(spec, scope)` ([`src/cli/commands/plugin.ts:1310-1375`](../../src/cli/commands/plugin.ts#L1310-L1375), [`src/cli/commands/plugin.ts:1439-1457`](../../src/cli/commands/plugin.ts#L1439-L1457)). Marketplace refresh is memoized only within one scope; repeat consumers receive a synthetic bare success, so they cannot know whether the first refresh changed anything ([`src/cli/commands/plugin.ts:1405-1437`](../../src/cli/commands/plugin.ts#L1405-L1437)).
2. **Plugin no-op and failure classification.** `fetchPlugin` calls `pull`, then returns `action: 'updated'` for every successful call. It maps a pull exception to successful `skipped`, conflating "cached copy remains usable" with "remote check succeeded and nothing changed" ([`src/core/plugin.ts:212-238`](../../src/core/plugin.ts#L212-L238)). `pull` itself returns no revision/result information, although the Git module already uses `listRemote` for repository/ref checks ([`src/core/git.ts:90-127`](../../src/core/git.ts#L90-L127)).
3. **Marketplace writes and scope amplification.** Remote marketplace update checks out/pulls, always changes `lastUpdated`, and rewrites the appropriate registry after success; its result has no changed/no-op action ([`src/core/marketplace.ts:970-1067`](../../src/core/marketplace.ts#L970-L1067)). The code can read local marketplace HEAD/date but does not compare it with a remote revision ([`src/core/marketplace.ts:2022-2044`](../../src/core/marketplace.ts#L2022-L2044)). Any plugin result marked `updated` causes every requested scope to sync; under `--scope all`, a real user-only change can therefore cause both project and user sync ([`src/cli/commands/plugin.ts:1459-1478`](../../src/cli/commands/plugin.ts#L1459-L1478)).
4. **External marketplace ordering.** The current external-plugin path parses the old manifest, remembers its external URL, refreshes the marketplace, then fetches the old URL; the marketplace result is discarded from the final action ([`src/core/plugin.ts:489-548`](../../src/core/plugin.ts#L489-L548)). A manifest change that moves the external source can therefore update the wrong checkout.
5. **Skill inspection and mutation.** Each selected physical unit shallow-clones needed root/dependency nodes, records exact SHAs, and discovers the complete upstream skill set before cleaning up the temporary checkouts ([`src/cli/skill-update.ts:736-820`](../../src/cli/skill-update.ts#L736-L820)). This is valuable deletion safety. The execution phase nevertheless reconciles first, advances every inspected node, commits, marks the unit `updated`, and queues each selected scope for sync without testing revision equality ([`src/core/skill-update.ts:658-689`](../../src/core/skill-update.ts#L658-L689)). Advancing fetches and hard-resets the managed cache to the inspected SHA; execution then syncs offline ([`src/cli/skill-update.ts:864-931`](../../src/cli/skill-update.ts#L864-L931)).
6. **Skill-level attribution is lost.** Execution collapses each physical refresh unit to one status plus numeric `skillCounts`; it does not retain the names/subpaths of updated survivors ([`src/core/skill-update.ts:219-246`](../../src/core/skill-update.ts#L219-L246), [`src/core/skill-update.ts:598-610`](../../src/core/skill-update.ts#L598-L610)). Human output therefore prints `Updated <source>` and an aggregate count, while JSON likewise exposes unit/source/counts without identifying which skills changed ([`src/cli/commands/skill-update.ts:147-216`](../../src/cli/commands/skill-update.ts#L147-L216)). By contrast, `skills@1.5.26` names each queued skill in `Updating <skill>…` and `✓ Updated <skill>` output ([pinned source](https://github.com/vercel-labs/skills/blob/d667282815248da03a08a18272b5d2eef9caf77c/src/update.ts#L690-L735)).

### Controlled no-op probes

**[Runtime observation]** A throwaway probe gave `executeSkillUpdatePlan` equal current and inspected SHAs. All mutation callbacks still ran:

```json
{"currentSha":"same-sha","inspectedSha":"same-sha","status":"updated","calls":["advance","commit","sync"],"syncedScopes":["project"]}
```

**[Runtime observation]** A second probe gave `fetchPlugin` an existing cache and a successful no-op pull dependency. It still reported `updated`:

```json
{"simulatedPullChangedFiles":false,"pulls":1,"action":"updated","success":true}
```

Together, the source and probes show that AllAgents currently wastes temporary clones for known-current skill sources, persistent fetch/reset/reconciliation work after equal-SHA inspection, plugin/marketplace registry writes on no-op pulls, misleading result counts, and downstream syncs caused by those misleading results.

### User-provided global `skills` trace

**[User-provided runtime observation]** The captured `npx skills update` run separates discovery from mutation: it first identifies the `Global` scope, prints one `Checking skills from source: <repo>` line for each of six distinct sources, reports `Found 1 global update(s)`, then names `write-like-chris` during both the attempted and successful update before finishing with `✓ Updated 1 skill(s)`.

This clarifies three user-visible concepts that AllAgents currently conflates: **sources checked**, **skill updates found**, and **skill updates successfully applied**. Source progress does not imply that a source changed; only skills in the found-update set enter the apply phase. The pattern is worth copying, with two additions: AllAgents should report source check failures explicitly and should expose the reason/identity behind a detected change when verbose or JSON output is requested. This trace is global-scope evidence only and does not change the separate finding that ordinary project-scoped `skills@1.5.26` updates reinstall every eligible selected skill.

**[Source confirmation]** The ordering is not ambiguous: the pinned implementation groups candidates by `source + ref`, then uses a serial `for...of` loop and awaits that source's tree API request or clone/discovery before starting the next group ([`updateGlobalSkills`](https://github.com/vercel-labs/skills/blob/d667282815248da03a08a18272b5d2eef9caf77c/src/update.ts#L548-L735)). The six source checks in the trace are therefore sequential, not concurrent. All changed skills are accumulated first; the later apply loop also processes updates serially.

## Comparator matrix

| Tool and pinned evidence | What update actually does | Are unchanged items touched? | Boundary that matters for AllAgents |
|---|---|---|---|
| `skills@1.5.26` (`gitHead d667282…`) ([npm metadata](https://registry.npmjs.org/skills/1.5.26), [pinned update source](https://github.com/vercel-labs/skills/blob/d667282815248da03a08a18272b5d2eef9caf77c/src/update.ts#L320-L1047)) | Global well-known skills compare an index/content digest; ordinary global GitHub skills compare recorded folder tree SHA, with clone/content-hash fallback. Ordinary project Git sources are cloned and each eligible selected skill is passed to `add`; project `computedHash` is not consulted ([global path](https://github.com/vercel-labs/skills/blob/d667282815248da03a08a18272b5d2eef9caf77c/src/update.ts#L489-L737), [project path](https://github.com/vercel-labs/skills/blob/d667282815248da03a08a18272b5d2eef9caf77c/src/update.ts#L739-L972), [lock definition](https://github.com/vercel-labs/skills/blob/d667282815248da03a08a18272b5d2eef9caf77c/src/local-lock.ts#L14-L94)). | **Global ordinary/well-known:** unchanged skills are not reinstalled or lock-rewritten. **Ordinary project Git:** eligible selected skills are reinstalled even when byte-identical; the installer removes and recopies the target ([installer](https://github.com/vercel-labs/skills/blob/d667282815248da03a08a18272b5d2eef9caf77c/src/installer.ts#L185-L199), [install loop](https://github.com/vercel-labs/skills/blob/d667282815248da03a08a18272b5d2eef9caf77c/src/installer.ts#L295-L448)). | This is the important project/global distinction: it would be false to claim that all `npx skills update` modes avoid rewrites. Its strongest reusable idea is changed-item gating where reliable source metadata exists, plus conservative deletion handling ([deletion path](https://github.com/vercel-labs/skills/blob/d667282815248da03a08a18272b5d2eef9caf77c/src/update.ts#L261-L317)). |
| `plugins@1.3.4` ([npm metadata](https://registry.npmjs.org/plugins/1.3.4), signed artifact [tarball](https://registry.npmjs.org/plugins/-/plugins-1.3.4.tgz), [published bundle](https://unpkg.com/plugins@1.3.4/dist/index.js)) | There is no update/check command. Dispatch recognizes `add`, `discover`, and `targets`; `plugins update` is interpreted as installation from a source named `update`. Re-running `add` deletes/reclones a remote cache and rebuilds target staging without a content/version comparison (bundle locations `dist/index.js:1975-1987`, `2298-2305`, `830-836`; [published README](https://unpkg.com/plugins@1.3.4/README.md)). | At the CLI layer, selected file-based plugins are restaged/reinstalled even when unchanged; some native target CLIs decide their own final behavior. | This is not an update model to copy. It establishes only that unconditional reinstall remains common when a tool has no update contract. The examined tarball is identified by registry SHA-1 `5ad10f83297266757439ff8c1e3ba55f5a263860` and integrity `sha512-N7xfx54jBkDph49WNRe9EOjvT0mQlPIXcrsRl1BHOS9GlvOJBFLd0agWapq5vTVjM1PJ71hnZotVZ2AAYCdj2A==` ([registry metadata](https://registry.npmjs.org/plugins/1.3.4)). |
| OpenAI Codex at `7f83d492…` ([revision](https://github.com/openai/codex/commit/7f83d4922d7e92a36c1c1e4f61159a5815d45360)) | Curated startup sync and configured Git marketplace upgrade first compare remote/local revision and skip an unchanged root ([startup sync](https://github.com/openai/codex/blob/7f83d4922d7e92a36c1c1e4f61159a5815d45360/codex-rs/core-plugins/src/startup_sync.rs), [marketplace upgrade](https://github.com/openai/codex/blob/7f83d4922d7e92a36c1c1e4f61159a5815d45360/codex-rs/core-plugins/src/marketplace_upgrade.rs)). Curated plugin cache also skips the active version. A changed configured marketplace force-reinstalls configured plugins, while explicit `plugin add` stages/replaces unconditionally ([loader](https://github.com/openai/codex/blob/7f83d4922d7e92a36c1c1e4f61159a5815d45360/codex-rs/core-plugins/src/loader.rs), [store](https://github.com/openai/codex/blob/7f83d4922d7e92a36c1c1e4f61159a5815d45360/codex-rs/core-plugins/src/store.rs)). | Unchanged marketplace roots and equal active curated versions are untouched. A changed marketplace can still reinstall individually unchanged configured plugins; explicit add is unconditional. | Codex supports revision gating as the first cheap layer, not as perfect per-plugin precision. Standalone filesystem skills are watched/reloaded locally and have no central remote update protocol ([skills service](https://github.com/openai/codex/blob/7f83d4922d7e92a36c1c1e4f61159a5815d45360/codex-rs/ext/skills/src/host_service.rs), [official skill docs](https://learn.chatgpt.com/docs/build-skills)). |
| Oh My Pi at `acf943d3…` ([revision](https://github.com/can1357/oh-my-pi/commit/acf943d3c8dc1ed135b42aa33fef4d9d2ff61c9a)) | Bulk `omp plugin upgrade` compares installed and catalog versions and upgrades only stale `(plugin, scope)` pairs. A named upgrade does not compare versions and force-reinstalls each targeted installed scope ([manager](https://github.com/can1357/oh-my-pi/blob/acf943d3c8dc1ed135b42aa33fef4d9d2ff61c9a/packages/coding-agent/src/extensibility/plugins/marketplace/manager.ts#L747-L902), [CLI](https://github.com/can1357/oh-my-pi/blob/acf943d3c8dc1ed135b42aa33fef4d9d2ff61c9a/packages/coding-agent/src/cli/plugin-cli.ts#L311-L356)). | Bulk upgrade leaves equal versions untouched. Selected upgrade is unconditional; entries without catalog versions are skipped, so same-version content changes are invisible ([official marketplace docs](https://github.com/can1357/oh-my-pi/blob/acf943d3c8dc1ed135b42aa33fef4d9d2ff61c9a/docs/marketplace.md#L34-L76)). | Its bulk/selected split is explicit but too surprising for AllAgents' default: a name selector should narrow work, not silently imply force. Version-only checks are also insufficient for Git sources. |

## Prioritized recommendations

### P0 — Correct no-op classification before optimizing discovery

1. **Plugin pulls:** capture local HEAD before and after a successful pull and return `up-to-date` when equal. A failed pull/remote check must be `failed` or `unknown`, never successful `skipped`/`up-to-date`.
2. **Marketplace pulls:** return the same changed/no-op/failure distinction, do not rewrite `lastUpdated`/registry merely because a no-op check succeeded, and propagate the first real refresh result to every plugin consumer instead of synthesizing success for duplicates.
3. **Skill execution:** use the SHAs already present on `CheckoutNode.currentSha` and `unit.inspectedNodes`. When every node SHA is equal, every managed cache is clean and healthy, and there is no deletion or configuration impact, return `up-to-date` before reconciliation, persistent cache advancement, commit, or scope sync. Otherwise, preserve the cache and report `needs-repair` unless the caller explicitly chose repair behavior.
4. **Skill results:** retain per-skill identity through execution. For every checked skill, emit at least `name`, qualified `subpath`, `source`, `scope`, and outcome; human output should name each actually updated/removed/retained skill instead of only its backing source.

**Why first:** this changes neither update discovery nor deletion safety. It fixes observable truth and removes unnecessary persistent mutation with the smallest surface area.

### P1 — Avoid expensive skill inspection when revision equality is knowable

Perform one cheap remote-revision check per canonical physical source/ref before temporary cloning. If every node matches a healthy managed cache, the upstream tree at that revision cannot have acquired a deletion, so return `up-to-date` without clone/discovery. If ref resolution, authentication, cache health, or dirtiness is ambiguous, fall back to today's exact-revision temporary-checkout preflight. Never treat inability to check as unchanged.

Use one canonical resolver for the precheck, temporary inspection, and advancement paths:

- Input is the normalized physical remote identity, requested ref, and the existing Git authentication environment. The result is the normalized commit SHA plus ref kind.
- A missing ref resolves the remote's symbolic `HEAD` and then its advertised commit.
- A fully qualified branch resolves only that branch. A lightweight tag resolves its advertised commit; an annotated tag resolves its peeled commit. An unqualified name that collides between a branch and tag is ambiguous and takes the exact-inspection fallback rather than guessing.
- An immutable commit pin is already the target revision, but inspection must still prove that it is fetchable. It has no moving remote head to compare.
- Authentication, transport, malformed advertisement, or unsupported-ref failures take the exact-inspection fallback when that path can preserve current state. Otherwise they return `check-failed`, `failed`, or `unknown` according to the result contract.

### P2 — Model plugin updates as physical source graphs

Represent a marketplace root plus any external plugin checkout as one dependency graph. Inspect the refreshed marketplace manifest before resolving the external URL, deduplicate checks across plugins and scopes, and sync only scopes containing changed sources. This fixes the stale-old-manifest path and cross-scope sync amplification together.

An external repository identity is a code-authority boundary, not ordinary update metadata. Normalize scheme, host, and repository path before comparing the old and proposed source. Reuse the install path's allowed-scheme and host policy. A change of authority requires explicit interactive approval before credentials are sent or code is fetched; `--check` reports `decision-required`, and neither non-interactive mode nor `--force` supplies approval.

### P3 — Add explicit control and later precision

- `--force` intentionally repairs/resets/reinstalls even when the tracked revision matches.
- `--check` performs all availability/safety checks but makes no persistent mutation.
- Named selection narrows candidates; it does **not** imply force.
- Later, add per-plugin/per-skill tree fingerprints to avoid reinstall when a repository revision changed outside installed roots. Do this after revision gating; it is more precise but more complex.
- Consider bounded concurrency only after physical-source deduplication and correct result propagation. Auto-update scheduling is outside this performance fix.

## Proposed command and result contract

| Situation | Default `update` | `--check` | `--force` | Required result |
|---|---|---|---|---|
| Remote revision/content unchanged and managed cache healthy | Check, do not write or sync | Check only | Reconcile/reset/reinstall and sync intentionally | `up-to-date` by default/check; `updated` under force |
| Remote changed, no destructive impact | Apply exact inspected revision; sync only affected scopes | Report available change, no mutation | Apply | `updated` when applied; `update-available` when check-only |
| Upstream deletion requires a decision | Preserve current confirmation/retention policy | Report `decision-required` with reason `upstream-deletion`, no mutation | Force must not silently authorize deletion | `retained`, `removed`, or `cancelled` after a decision; `decision-required` before one |
| Local source | Do not invent a remote update | Same | Optional explicit local repair only if defined | `local`/`skipped` |
| Remote verification fails but the installed/cache state remains usable | Preserve current state and warn that freshness is unverified | Same, with a non-zero exit | Same; force is not permission to hide failure | `check-failed`, never `up-to-date` |
| Remote inspection/apply fails or no usable state remains | Leave persistent state unchanged | Same | Same | `failed` or `unknown`, never `up-to-date` |
| External repository authority changes | Require explicit approval before credentials or fetch | Report the proposed transition, no mutation | Force does not authorize the transition | `decision-required` until approved |
| Dirty managed cache at equal upstream revision | Do not call it an upstream update | Report `needs-repair` | Repair/reset explicitly | `needs-repair` or `updated` under force |

Human and JSON output share one exhaustive outcome enum: `up-to-date`, `update-available`, `updated`, `decision-required`, `retained`, `removed`, `cancelled`, `local`, `skipped`, `needs-repair`, `check-failed`, `failed`, and `unknown`. Every terminal source or consumer result maps to exactly one outcome.

Replace ambiguous `checked` totals with:

- `sourcesChecked`: canonical physical source/ref checks actually attempted.
- `pluginsChecked`: installed plugin consumers evaluated, counted once per plugin identity and scope.
- `skillsChecked`: installed skill consumers evaluated, counted once per `name` + qualified `subpath` + scope.

Outcome totals are derived from consumer result records and expose a counter for every enum member: `upToDate`, `updateAvailable`, `updated`, `decisionRequired`, `retained`, `removed`, `cancelled`, `local`, `skipped`, `needsRepair`, `checkFailed`, `failed`, and `unknown`. Unit/source results retain per-plugin and per-skill identity, including `name`, qualified `subpath`, `source`, `scope`, outcome, and machine-readable reason. Aggregate counters must equal the corresponding records rather than being maintained separately.

A scope is sync-eligible only when an applied result changed that scope. `check-failed` means freshness could not be verified but all required local state remains usable: ordinary update prints a warning and exits successfully, while `--check` exits non-zero. `failed` and `unknown` are always visible and non-zero. An unchanged run exits successfully without writes.

### Human output order

Human output follows the operation lifecycle: physical source-check progress; discovered updates and decision-required impacts; applied per-plugin/per-skill outcomes grouped under their source; source failures; then one aggregate summary. The default view names changed, removed, retained, repaired, decision-required, and failed consumers; unchanged consumers collapse into counts. A fully unchanged run prints the number of physical sources checked plus plugin and skill consumer totals, then states that no writes or syncs occurred. JSON always includes every result record and its reason.

## Implementation risks

- **Ref resolution:** default HEAD, branches, lightweight and annotated/peeled tags, immutable pins, authentication, and force-pushed refs need one canonical resolver.
- **Dirty caches:** SHA equality does not prove a clean worktree. Current skill advancement hard-resets local tracked edits. Treat dirtiness as explicit repair state, preferably requiring `--force`; do not report it as an upstream update.
- **Deletion guarantees:** preserve full-depth discovery, exact inspected-SHA advancement, confirmation, rollback, cross-scope shared-cache boundaries, and offline sync. A failed/ambiguous precheck must take the existing safe path.
- **External marketplace movement:** resolve an external plugin from the newly inspected manifest, not the old local manifest. Marketplace and external checkout form one transaction boundary.
- **Revision granularity:** a repository revision may change outside installed roots. Revision gating is still a large win; tree/content fingerprints are a later precision layer.
- **Result propagation:** one deduplicated source check may feed many installations. Preserve one authoritative result and attribute its changed scopes/consumers rather than fabricating per-caller success.

## Performance validation

Benchmark current main before implementation with controlled local bare remotes so network variance cannot hide filesystem and process costs. Cover warm no-op, one changed source, and remote-check failure across six physical sources and both scopes. Record total time plus time spent in revision resolution, temporary checkout, inspection, reconciliation, and sync.

The release target is the acceptance check below: the P1 warm no-op path must cut median time by at least 50% and p95 by at least 30% across 20 post-warmup runs; changed-source median and p95 may regress by at most 10%. Record live-remote timings separately as observational evidence, not as the deterministic release gate.

## Behavioral acceptance checks

1. **Unchanged direct plugin:** exactly one remote check; no cache, client, config, timestamp, or registry write; no sync; result `up-to-date`.
2. **Changed direct plugin:** update to the resolved revision, sync only its installation scopes, and report `updated`.
3. **Unchanged embedded marketplace with N installed plugins:** exactly one marketplace source check, zero persistent writes/syncs, and N `up-to-date` consumer results derived from that authoritative check.
4. **Cross-scope isolation:** with `--scope all` and only a user source changed, run user sync once and project sync zero times.
5. **Equal skill node SHAs after inspection:** with clean healthy managed caches, do not call reconcile, advance, commit, or sync; report `up-to-date`.
6. **Remote revision equal before inspection:** with a clean healthy cache, do not create a temporary checkout or run discovery; report `up-to-date`.
7. **Changed skill revision:** retain the existing deletion preflight, confirmation/non-interactive retention, exact-SHA advancement, rollback, and offline sync behavior.
8. **Remote check ambiguity/failure:** fall back to exact inspection when safe; otherwise report `failed`/`unknown`, preserve persistent state, and never print `up-to-date`.
9. **External marketplace URL change:** refresh/inspect the marketplace first and fetch the URL from the new manifest; rollback both graph nodes on failure.
10. **Dirty equal-revision cache:** default/check reports `needs-repair` without reset; `--force` intentionally resets/reinstalls and reports the action.
11. **Named selection:** checks only matching consumers but retains normal no-op gating; it never implies force.
12. **Check-only mode:** `--check` reports available updates/deletions/failures with zero cache, registry, config, client, or sync mutations.
13. **Skill attribution:** when one source contains multiple installed skills and only a subset changes, human output names each changed skill and its outcome; JSON returns the same per-skill identities and statuses, while aggregate totals remain consistent.
14. **Result accounting:** every source and consumer has exactly one outcome; each aggregate outcome total equals the number of matching result records; physical-source, plugin-consumer, and skill-consumer counts remain distinct.
15. **External source authority change:** do not send credentials, fetch, apply, or sync until the user explicitly approves the normalized repository transition; check-only and non-interactive runs report `decision-required`.
16. **Performance target:** in a controlled local-bare-remote fixture with six physical sources, after warmup and across 20 runs, the P1 warm no-op median is at most 50% of the current-main baseline and p95 is at most 70%; the changed-source path's median and p95 regress by no more than 10%.

## Deferred / Open Questions

### From 2026-09-17 review

- **No-write guarantee versus in-place pulls** — P0 — Correct no-op classification before optimizing discovery (P1, adversarial, confidence 100)

  Unchanged and failed plugin checks can alter persistent Git state before classification. The plan must choose staged application after a remote precheck or explicitly weaken its zero-write and failure-atomicity guarantees.

- **Exact skill attribution timing** — P0 — Correct no-op classification before optimizing discovery (P1, feasibility, product, scope, confidence 100)

  Implementers cannot identify only the changed skills without a content-difference mechanism. The plan must choose whether exact per-skill attribution is part of the first delivery or a separate observability follow-up.

- **External plugin graph delivery boundary** — P2 — Model plugin updates as physical source graphs (P1, feasibility, scope, confidence 100)

  Check-only inspection and two-node rollback need a complete transaction design. The plan must choose whether to specify that architecture here or move external-source correctness into a separate plan.

- **Marketplace result propagation sequencing** — P0 — Correct no-op classification before optimizing discovery (P1, scope, confidence 75)

  The first delivery cannot propagate one authoritative marketplace result to every consumer unless part of the later deduplication design moves earlier. The plan must choose earlier memoization and fan-out or narrower first-delivery guarantees.

- **Check and repair mode scope** — P3 — Add explicit control and later precision (P2, scope, design, confidence 100)

  Shipping check and repair modes now requires complete flag-combination, local-source, destructive-impact, and exit-code behavior. The plan must choose that larger contract or defer both modes to a follow-up.

## Sources and limitations

- **AllAgents baseline:** source behavior was checked at worktree revision `3eae4bd63cdb35418e5ac16b1eb100febc5b70b2` and fetched `origin/main` `2af576cd5ecf68a3f5c7c3e37588266577607c5b`; the relevant behavior was identical. All local claims above cite exact repository paths and ranges. The two no-op observations came from dependency-controlled throwaway probes, not live network runs.
- **`skills`:** pinned to npm `skills@1.5.26`, source `d667282815248da03a08a18272b5d2eef9caf77c`, tarball [`skills-1.5.26.tgz`](https://registry.npmjs.org/skills/-/skills-1.5.26.tgz), SHA-1 `1fa24b1ae298034ec5153277630a05433a3f42a9`, integrity `sha512-D5jnWoMPDRQ3fJM3RpQH8SBrAS9tmVlTC7OdOB2tk7D6nORbRnw8RLwjVj81IIGlxwWuBthEgUChM7SOZGvTHQ==` ([official npm metadata](https://registry.npmjs.org/skills/1.5.26)). Runtime probes covered unchanged public-GitHub project/global installs but not changed/private/well-known/copy-mode paths.
- **`plugins`:** pinned to the official npm `plugins@1.3.4` artifact and registry integrity above. Its package-declared repository was unavailable during research, so claims are limited to the signed published bundle/README and a controlled Kimi reinstall; delegated native target behavior was not inferred.
- **Codex:** pinned to first-party commit [`7f83d492…`](https://github.com/openai/codex/commit/7f83d4922d7e92a36c1c1e4f61159a5815d45360). The repository is fast-moving; no package version is asserted for that commit. Findings are source/documentation-backed rather than runtime-tested.
- **Oh My Pi:** pinned to first-party commit [`acf943d3…`](https://github.com/can1357/oh-my-pi/commit/acf943d3c8dc1ed135b42aa33fef4d9d2ff61c9a) / `@oh-my-pi/pi-coding-agent` `18.2.1` ([package](https://github.com/can1357/oh-my-pi/blob/acf943d3c8dc1ed135b42aa33fef4d9d2ff61c9a/packages/coding-agent/package.json#L1-L8)). Findings are source-backed; no mutating CLI trace was run.
