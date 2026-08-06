# Upstreaming notes — OpenRouter fork → Noetic

This branch (`port/openrouter-fixes`) ports the functional improvements from
OpenRouter's divergent fork of Noetic back onto upstream `main` (forked at
`e0f9e325`, ported onto `ead54108`). The fork's renames/branding are **not**
ported — everything here speaks current Noetic vocabulary (`ContextLayer`,
`@noetic-tools/context`, `noetic:*` item types) and sits on top of the
memory→context rename and the banded-assembly/cache-anchoring work.

Every ported commit cites its fork origin; commits without a fork origin — the
notes file itself, the inspector glyph fix (`928d63c3`, new work for an
upstream-only package the fork does not have), and the post-port review-round
fixes — say so in their own bodies. Every behavioral fix carries tests; where
the port deviated from the fork's diff, the deviation was deliberate and is
listed below. All suites green: **2,150+ pass / 0 fail** across the workspace
(baseline at `ead54108`: 2003 pass / 3 fail, plus 2 typecheck errors in core
tests).

## Part 1 — Fixes and hardening (recommend reviewing in order)

| Commit | What it fixes | Origin |
|---|---|---|
| baseline clean | 2 pre-existing typecheck errors (`onComplete` hook variance, misplaced `ts-expect-error`) + the 3 always-red online eval suites (gate reads `OPENROUTER_API_KEY`, harness default only read `NOETIC_API_KEY`) | `35a0484e` |
| platform-node I/O round | file-storage key encoding was lossy for keys containing `__` (data loss); sync writes blocked the event loop; queue `clear()` reset `headSeq` (frame loss on resume); ack was an O(n) storage scan; IPC frames sharing a TCP chunk could execute out of order; error frames didn't correlate to their send (one failure rejected every pending ack); pid start-time via `ps` spawn per check | `1520c41b` |
| sub-harness reliability | error turns returned as success; wedged vendor sessions hung forever (now 120s idle watchdog, configurable); reasoning text silently dropped (now a `reasoning` item); concurrent first turns raced two sessions (now promise-valued session store) | `7b9c0f57` |
| eval optimizer | write-back could destroy uncommitted work (now a version-control guard, `--force-dirty` to override); cases ran serially (now bounded pool + `--concurrency`); judge harness rebuilt per score call; GEPA scope never reached discovery; tool candidate paths keyed by (mutable) name; dead `budget` knob removed; `walkStep` missed `provide`/`every` composites | `d83a27b7`, `2273baa1` |
| openui hardening | any client could `set` any key at any size (now declared-$var check + 16 KiB cap); concurrent prompts interleaved streams (409 while active); client disconnect leaked the stream; one client's replay dropped another's events (per-client watermarks); multi-thread mirrors were last-writer-wins (thread-keyed `readState`) | `b4b1d6ee` |
| doom-loop guard | a model stuck on the same tool call burned all 32 rounds; now trips after 4 identical rounds with a `doom_loop_detected` event | `ac816771` |
| tool-arg validation | model-provided tool args were **never validated** against the declared Zod schema — raw `JSON.parse` output went straight into user tool code. The programmatic `tool` step path (`executeTool`) always validated; this closes the asymmetry (and makes chat-sdk's "validated at runtime by the harness" comment true). Plus: the tool resolved for the span is reused instead of a second linear scan per call | `0f27cd46` (validation + lookup halves) |
| perf: distillation/memoization | observational distillation no longer blocks the append pipeline (fire-and-collect, per-scope buckets); file-reference LLM scoring is now **opt-in** (see behavior changes); unified tool pool memoized per harness; per-`Tool` SDK conversion cached (byte-stable tools segment for provider prompt caches) | `dea4da45` |
| channel reaping + loop/park | every `channel()` minted state that lived for the harness lifetime — per-delegation channels leaked unboundedly (reap predicate re-derived to respect external channels and stream cursors); loop snapshots re-spread history per iteration; park jitter now deterministic; storage-less in-memory dispatch skips the handle round-trip | `4c62520a` |
| durable checkpoints | every snapshot inlined the full transcript — O(n²) write volume per session (~60x reduction measured). Items now persist as thread-keyed idempotent batches; restore stitches with one batched read and clamps the watermark (a partial store can't silently truncate); watermarks are per-harness (module state would cross-contaminate); failed turns roll back durably; step-ledger gap accounting survives storage outage bursts | `5f0a8054` + `22f8cfa9` + `5fc11f62`, folded to final shape |
| workflow runtime | JSON tool nodes bypassed validation/steering/tool-UI (now route through `executeToolCall`); duplicate node ids silently mis-hydrated (now `DUPLICATE_NODE_ID`, subflow-scope-aware); dynamic forks re-hydrated per invocation; `matchMode: 'exact'` for branch routes ('cat' matched 'concatenate'); planner revision loop now sees hydration config errors; run-node size cap | `fe92a309` |
| explicit compaction | complements the banded assembly: `CompactionItem` is a first-class logged record (survives checkpoint/resume, forked logs share the compacted prefix), `foldCompactions` projects the model view, `historyPressure`/`context_pressure` event replaces silent behavior at the budget edge, `compactHistory` composes with any summarizer | `ce6d44e9` (complementary parts only — see "what was NOT ported") |
| deterministic allocator | replaces the 60/40 split + infinite-headroom special cases: mins first, remainder proportional to caps, `'auto'` = fixed 2000-token cap. Deterministic block sizes are what let the cache-anchoring bands stay byte-stable when budgets are in play | `ce6d44e9` |
| ContextInput | `context([...])` — the builder's own output — was not assignable to `spawn`/`provide`/`react`'s `context` option (`ContextConfig` is invariant in its layers). Structural `ContextInput` fixes the builder's primary destination | `26cc5e55` |
| barrel exports | `StepEvery` (the one Step variant missing from the barrel) and `Lazy` (documented, unimportable) | `7711eaeb`, `3c4b0716` |

## Part 2 — Proposal: native multi-agent patterns (separate discussion)

Two commits, deliberately last in the review order:

1. **`defineAgent` / `asTool` / `handoff` / `quorum` / `teammate`** — a
   compositional multi-agent layer built entirely on existing primitives.
   One new pattern module + barrel exports; zero interpreter/runtime/Step
   changes. (`4cccf95d`, fork `fa8a9d24`)
2. **Declarative agent workflow nodes** — `agent-tool` / `handoff` / `quorum`
   JSON node kinds, plus a `HydrationContext.nodeHydrators` extension seam so
   the hydrators live in `patterns/` and `builders/` stays ignorant of them.
   The seam is generally useful for any out-of-layer node kind. (`77cb290d`,
   fork `f063cc87`, rearchitected onto the seam)

### Dropping the tranche

The tranche is **not** a clean `git revert` of those two commits on its own —
two later commits reach back into it, so the revert must include them:

- `928d63c3` (inspector glyphs) adds the `'agent-tool'`/`handoff`/`quorum`
  entries to `GLYPHS: Record<GraphNodeKind, string>`. `GraphNodeKind` is
  derived from `WorkflowNode['kind']`, so reverting the node kinds without
  this commit leaves the inspector red (TS2739, three keys with no kinds).
- `efc2b689` (the `ContextInput` row in the Part 1 table) modifies
  `packages/core/src/patterns/agents.ts` — a file `4cccf95d` created. Its
  revert therefore hits `CONFLICT (modify/delete)` on that path.

To drop the tranche, revert all three together and resolve the one conflict by
deleting the file:

```sh
git revert --no-commit 928d63c3 77cb290d 4cccf95d
git rm --force packages/core/src/patterns/agents.ts   # resolves the modify/delete
git commit
```

Verified: with that resolution the tree has no remaining conflicts and both
`packages/core` and `packages/inspector` typecheck clean. Nothing outside the
tranche imports `patterns/agents`, so deleting it is the whole resolution — the
`efc2b689` hunk on that file was only the `ContextConfig | ContextLayer[]` →
`ContextInput` rename, and the rest of `efc2b689` (the actual `ContextInput`
fix) survives the revert intact.

If only one of the two lands, take the first — it is self-contained apart from
the barrel exports.

## Deliberate behavior changes (flagging so nobody finds them the hard way)

- **file-reference `scoringModel` default `''`** — LLM relevance scoring is
  now opt-in. The old default silently issued a claude-haiku call per new
  `#file` reference inside the append pipeline. Heuristic scoring is the new
  default; docs page still describes the old default (not updated here).
- **allocator `'auto'` cap** — a layer with `'auto'`/omitted budget got up to
  ~60% of the post-reserve window; it now gets a fixed 2000 tokens. Declare
  explicit budgets for layers that need more. `historyBudget` removed from
  the allocator's return type (no readers in src).
- **eval `budget` knob removed** — it was accepted and silently ignored
  end-to-end. Semver-major on `@noetic-tools/eval`.
- **queue `clear()` keeps `headSeq` monotonic** — post-clear `getHeadSeq()`
  no longer returns 0 (that reset is what caused frame loss on resume).
- **openui `set` events are validated** — previously accepted unconditionally.
- **checkpoint snapshots from stores implementing `appendItems`** carry
  `persistedCount` instead of inline items (legacy stores keep the inline
  shape; optional schema field, no version bump).
- **`createFileStorage` is single-writer-per-root** for `list()` (in-memory
  key index; two adapters over one root see each other via `get` but not
  `list`). Documented in its JSDoc.

## What was NOT ported, and why

- **The fork's placement system (`'front' | 'tail'`) and never-trim assembly**
  — superseded by upstream's richer anchor/live bands + pin map + epochs.
  The compaction port folds at the call sites instead, composing with the
  bands rather than replacing them.
- **`needsApproval` enforcement gate** — upstream's chat-sdk ships its own
  approval design (self-gating tools via external-channel parking); a
  fail-closed harness gate would deny every chat-sdk gated tool before its
  own gate runs. **Open issue worth filing**: core still enforces nothing for
  plain tools even though `needsApproval` is declared, span-recorded, and
  documented as enforcing.
- **recallMode/RecallCache and the re-render side channel deletions** — the
  fork removed them, but both are live features here (the fork's "dead code"
  claim was wrong for the re-render channel); deleting them is a design
  conversation, not a port.
- **`ProjectionPolicy.overflow`/`windowSize` removal** — `windowSize` is
  load-bearing in the projector today. (`overflowModel` genuinely has no
  readers, if you want a free deletion.)
- **Execution targets / run registry / bench suites** — fork-specific
  infrastructure, out of scope for this round.

## Notes for reviewers

- The doom-loop guard's throw shape and its recovery story are covered in the
  post-port review round below (the guard is result-aware and its threshold is
  configurable). The `doom_loop_detected` and `context_pressure` events are not
  yet in the runtime.mdx event table (docs not touched in this port).
- **`loop()` snapshot `history` is frozen at runtime but still typed
  `unknown[]`.** `executeLoop` builds one `Object.freeze([...history])` per
  iteration and shares it with the snapshot, replacing a per-verdict spread
  copy. In-place mutation of `snapshot.history` was never a supported
  operation — nothing in the runtime reads mutations back — but code that did
  it used to silently no-op and now throws a `TypeError` from inside the
  `until` predicate. Narrowing `Snapshot.history` to `ReadonlyArray<unknown>`
  is the honest type and a candidate follow-up; it is a semver-major on
  `@noetic-tools/types`, so it was left out of a port branch.
- **Workflow tool nodes surface tool failures as `WORKFLOW_TOOL_CALL_FAILED`
  config errors.** Routing JSON tool nodes through `executeToolCall` (for arg
  validation, steering, and tool-UI) means a throwing tool is caught there and
  reduced to an error string, which `hydrateToolNode` wraps in a
  `NoeticConfigError`. A typed `NoeticError`'s `detail.kind` therefore does not
  survive the boundary — it is stringified into the message. Kind-based retry
  or `onError` policies around a JSON workflow should gate on the failing node
  rather than the error kind. This is a known tradeoff of routing through
  `executeToolCall`; threading the original `cause` back out is the follow-up
  that would restore kind-based recovery.
- Compaction folding happens on the model-request paths; `prepareBandedView`
  and cache-anchoring see unfolded history. Correct today (they operate on
  layer output, not the history band) — but if anchoring ever keys an epoch
  on a history hash, the fold must move ahead of it.
- Sentrux: the port adds one `layer_direction` violation
  (`workflow-hydrator.ts → adapters/openrouter.ts`, from routing tool nodes
  through `executeToolCall`) next to the same file's pre-existing violation
  of the same class. The fork later resolved this by reclassifying the
  hydrator as a compiler in `patterns/`; that refactor is worth doing here
  too but was out of scope for a port.
- Spec/docs sync (this repo's rule) was largely out of scope: specs 23/23a
  (checkpoint boundaries, frontier), 26 (matchMode, new node kinds), 11/12
  (compaction, allocator), `04-spawn`'s and `08-runtime`'s `context?:
  ContextLayer[]` signatures, and the runtime.mdx event table all still need a
  follow-up pass before release. The two exceptions, both fixed in the review
  round below because they published a signature that does not compile:
  `operators/spawn.mdx`, `operators/provide.mdx`, and the `spawn` line of
  `specs/01-step-type.md` now say `ContextInput`.

## Post-port review round

An adversarial review of this branch found fifteen issues; the confirmed ones
are fixed here, each with a regression test proved red against the unfixed
code. These commits have no fork origin — they are fixes to the port itself:

- **session-log item-schema registry** — the session-owned `ItemLog` was bound
  to the base registry, so it rejected every layer- and tool-declared item type.
- **checkpoint item batches: stale-batch stitching + rollback sweep** — a
  shorter batch never superseded a longer stale one at the same offset, and
  rolled-back batches could resurrect on restore when checkpoint cadence
  differed between turns. Stitching is now gap-aware and rollback sweeps
  superseded batches (`truncateItems`).
- **warm layer hydration keys on scope** — the warm pointer keyed on `threadId`
  alone, leaking `resource`- and `global`-scoped layer state across scope
  boundaries; the key now carries each layer's resolved scope key.
- **compaction fold index space** — the fold was applied to a system-stripped
  array while `replacesUntil` indexed the unstripped one, silently deleting
  live turns. Folding now happens before partitioning.
- **doom-loop guard** — the fingerprint is result-aware (a progressing poll
  breaks the streak) and the threshold is configurable.
- **file-storage legacy-key migration** — the new `_u`-escaping encoder orphaned
  every existing on-disk key containing `_`; reads now fall back to the legacy
  filename.
- **allocator minimums guarantee** — declared mins are satisfied against the
  full available window and only the discretionary remainder is rationed by
  `LAYER_POOL_SHARE`, restoring spec 11's "minimums first" normative claim.
- **`context_pressure` latch** — the once-per-step latch was set on
  non-emitting paths too, so a first assembly below the threshold permanently
  suppressed the event for that step.
- **vocabulary and docs accuracy** — this file, plus one fork Step-kind name
  that survived in the tool-arg validation comment (it now names the `tool`
  step and `executeTool`) and the `ContextInput` doc/spec signatures above.
