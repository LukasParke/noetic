# Upstreaming notes — OpenRouter fork → Noetic

This branch (`port/openrouter-fixes`) ports the functional improvements from
OpenRouter's divergent fork of Noetic back onto upstream `main` (forked at
`e0f9e325`, ported onto `ead54108`). The fork's renames/branding are **not**
ported — everything here speaks current Noetic vocabulary (`ContextLayer`,
`@noetic-tools/context`, `noetic:*` item types) and sits on top of the
memory→context rename and the banded-assembly/cache-anchoring work.

Every commit says which fork commit(s) it came from. Every behavioral fix
carries tests; where the port deviated from the fork's diff, the deviation was
deliberate and is listed below. All suites green: **2,150+ pass / 0 fail**
across the workspace (baseline at `ead54108`: 2003 pass / 3 fail, plus 2
typecheck errors in core tests).

## Part 1 — Fixes and hardening (recommend reviewing in order)

| Commit | What it fixes | Origin |
|---|---|---|
| baseline clean | 2 pre-existing typecheck errors (`onComplete` hook variance, misplaced `ts-expect-error`) + the 3 always-red online eval suites (gate reads `OPENROUTER_API_KEY`, harness default only read `NOETIC_API_KEY`) | `35a0484e` |
| platform-node I/O round | file-storage key encoding was lossy for keys containing `__` (data loss); sync writes blocked the event loop; queue `clear()` reset `headSeq` (frame loss on resume); ack was an O(n) storage scan; IPC frames sharing a TCP chunk could execute out of order; error frames didn't correlate to their send (one failure rejected every pending ack); pid start-time via `ps` spawn per check | `1520c41b` |
| sub-harness reliability | error turns returned as success; wedged vendor sessions hung forever (now 120s idle watchdog, configurable); reasoning text silently dropped (now a `reasoning` item); concurrent first turns raced two sessions (now promise-valued session store) | `7b9c0f57` |
| eval optimizer | write-back could destroy uncommitted work (now a version-control guard, `--force-dirty` to override); cases ran serially (now bounded pool + `--concurrency`); judge harness rebuilt per score call; GEPA scope never reached discovery; tool candidate paths keyed by (mutable) name; dead `budget` knob removed; `walkStep` missed `provide`/`every` composites | `d83a27b7`, `2273baa1` |
| openui hardening | any client could `set` any key at any size (now declared-$var check + 16 KiB cap); concurrent prompts interleaved streams (409 while active); client disconnect leaked the stream; one client's replay dropped another's events (per-client watermarks); multi-thread mirrors were last-writer-wins (thread-keyed `readState`) | `b4b1d6ee` |
| doom-loop guard | a model stuck on the same tool call burned all 32 rounds; now trips after 4 identical rounds with a `doom_loop_detected` event | `ac816771` |
| tool-arg validation | model-provided tool args were **never validated** against the declared Zod schema — raw `JSON.parse` output went straight into user tool code. The programmatic `call-tool` path always validated; this closes the asymmetry (and makes chat-sdk's "validated at runtime by the harness" comment true). Plus: the tool resolved for the span is reused instead of a second linear scan per call | `0f27cd46` (validation + lookup halves) |
| perf: distillation/memoization | observational distillation no longer blocks the append pipeline (fire-and-collect, per-scope buckets); file-reference LLM scoring is now **opt-in** (see behavior changes); unified tool pool memoized per harness; per-`Tool` SDK conversion cached (byte-stable tools segment for provider prompt caches) | `dea4da45` |
| channel reaping + loop/park | every `channel()` minted state that lived for the harness lifetime — per-delegation channels leaked unboundedly (reap predicate re-derived to respect external channels and stream cursors); loop snapshots re-spread history per iteration; park jitter now deterministic; storage-less in-memory dispatch skips the handle round-trip | `4c62520a` |
| durable checkpoints | every snapshot inlined the full transcript — O(n²) write volume per session (~60x reduction measured). Items now persist as thread-keyed idempotent batches; restore stitches with one batched read and clamps the watermark (a partial store can't silently truncate); watermarks are per-harness (module state would cross-contaminate); failed turns roll back durably; step-ledger gap accounting survives storage outage bursts | `5f0a8054` + `22f8cfa9` + `5fc11f62`, folded to final shape |
| workflow runtime | JSON tool nodes bypassed validation/steering/tool-UI (now route through `executeToolCall`); duplicate node ids silently mis-hydrated (now `DUPLICATE_NODE_ID`, subflow-scope-aware); dynamic forks re-hydrated per invocation; `matchMode: 'exact'` for branch routes ('cat' matched 'concatenate'); planner revision loop now sees hydration config errors; run-node size cap | `fe92a309` |
| explicit compaction | complements the banded assembly: `CompactionItem` is a first-class logged record (survives checkpoint/resume, forked logs share the compacted prefix), `foldCompactions` projects the model view, `historyPressure`/`context_pressure` event replaces silent behavior at the budget edge, `compactHistory` composes with any summarizer | `ce6d44e9` (complementary parts only — see "what was NOT ported") |
| deterministic allocator | replaces the 60/40 split + infinite-headroom special cases: mins first, remainder proportional to caps, `'auto'` = fixed 2000-token cap. Deterministic block sizes are what let the cache-anchoring bands stay byte-stable when budgets are in play | `ce6d44e9` |
| ContextInput | `context([...])` — the builder's own output — was not assignable to `spawn`/`provide`/`react`'s `context` option (`ContextConfig` is invariant in its layers). Structural `ContextInput` fixes the builder's primary destination | `26cc5e55` |
| barrel exports | `StepEvery` (the one Step variant missing from the barrel) and `Lazy` (documented, unimportable) | `7711eaeb`, `3c4b0716` |

## Part 2 — Proposal: native multi-agent patterns (separate discussion)

Two commits, deliberately last and cleanly revertable:

1. **`defineAgent` / `asTool` / `handoff` / `quorum` / `teammate`** — a
   compositional multi-agent layer built entirely on existing primitives.
   One new pattern module + barrel exports; zero interpreter/runtime/Step
   changes. (fork `fa8a9d24`)
2. **Declarative agent workflow nodes** — `agent-tool` / `handoff` / `quorum`
   JSON node kinds, plus a `HydrationContext.nodeHydrators` extension seam so
   the hydrators live in `patterns/` and `builders/` stays ignorant of them.
   The seam is generally useful for any out-of-layer node kind. (fork
   `f063cc87`, rearchitected onto the seam)

If only one lands, take the first — it's self-contained.

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

- The doom-loop throw is a plain `Error` — a `loop().onError` cannot recover
  it (none of the 13 error kinds fits; adding one is a follow-up decision).
  The `doom_loop_detected` event and `context_pressure` event are also not
  yet in the runtime.mdx event table (docs not touched in this port).
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
- Spec/docs sync (this repo's rule) was intentionally out of scope: specs
  23/23a (checkpoint boundaries, frontier), 26 (matchMode, new node kinds),
  11/12 (compaction, allocator), and the runtime.mdx event table all need a
  follow-up pass before release.
