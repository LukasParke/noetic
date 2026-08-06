/**
 * Item-log batch stitching: what `loadItems` is allowed to weld together, and
 * what a rolled-back turn must leave behind on disk.
 *
 * Batches are keyed by their START offset, and a shorter batch written at an
 * offset does NOT erase a longer stale one — the old batch's tail stays
 * reachable under the NEXT offset key. Two independent producers of that shape:
 *
 *  - `seedSessionHistory` truncates the live log and clamps the watermark, but
 *    deletes no batches, so the next catch-up batch (whatever length the seeded
 *    history happens to be) lands on top of a differently-sized old one.
 *  - `rollbackTurn` after a failed turn does the same at the turn watermark, and
 *    because checkpoints fire per completed step, the recovery turn's batch
 *    boundaries move relative to the aborted turn's.
 *
 * Either way a blind sorted concat resurrects items from a discarded history —
 * silently, as structurally valid items, positioned as if they were the real
 * transcript. So: `loadItems` accepts a batch only at the offset it is actually
 * due (a gap or an overlap ends the stitch), and a rollback's orphaned batches
 * are DELETED on the owner's next checkpoint rather than merely hidden behind a
 * clamped `persistedCount`.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData, StorageAdapter } from '@noetic-tools/context';
import type { Item, LLMResponse, MessageItem, Step, StepLLM } from '@noetic-tools/types';
import { defaultItemSchemaRegistry } from '@noetic-tools/types';
import { loop } from '../../src/builders/loop-builder';
import { step } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { until } from '../../src/until/predicates';
import { assistantMessage } from '../_helpers';

//#region Helpers

/** Text carried by an item, for asserting on a stitched durable log. */
function itemTexts(item: Item): string[] {
  if (item.type !== 'message') {
    return [];
  }
  const texts: string[] = [];
  for (const part of item.content) {
    if (part.type === 'input_text' || part.type === 'output_text') {
      texts.push(part.text);
    }
  }
  return texts;
}

/** Every text in a stitched durable log, parsed the way `restore` parses it. */
function durableTexts(raw: readonly unknown[]): string[] {
  return defaultItemSchemaRegistry.parseMany(raw).flatMap(itemTexts);
}

let uniq = 0;

/**
 * One scripted model call. `'fail'` throws (aborting the turn); a number is how
 * many items the call returns, which is the lever that MOVES BATCH BOUNDARIES:
 * checkpoints fire per completed step, so the number of items landing between
 * two step boundaries decides each batch's length, and that is what makes a
 * recovery turn's batches misalign with an aborted turn's.
 */
type ScriptedCall = number | 'fail';

/**
 * A harness whose turn drives a 3-iteration loop, so checkpoints fire MID-turn
 * (after iterations 1 and 2) and a failure on the last model call rolls
 * genuinely-persisted partial state back — leaving TWO batches past the clamp,
 * which is what it takes for a longer recovery batch to span one of them without
 * superseding it. `script` is indexed per MODEL CALL, not per turn.
 */
function makeHarness(script: ScriptedCall[]): {
  harness: AgentHarness;
  checkpointStore: ReturnType<typeof createCheckpointStore>;
  storage: StorageAdapter;
} {
  const storage = createInMemoryStorage();
  const checkpointStore = createCheckpointStore({
    storage,
  });
  let call = 0;
  const n = uniq++;
  const chat: StepLLM<ContextData, string, string> = {
    kind: 'llm',
    id: `chat-${n}`,
    model: 'test/scripted',
    tools: [],
  };
  const body: Step<ContextData, string, string> = loop<ContextData, string, string>({
    id: `turn-body-${n}`,
    steps: [
      step.run<ContextData, string, string>({
        id: `pre-${n}`,
        execute: async (input) => input,
      }),
      chat,
    ],
    until: until.maxSteps(3),
    maxIterations: 3,
  });
  const harness = new AgentHarness({
    name: 'stitch-test',
    params: {},
    initialStep: body,
    storage,
    checkpointStore,
    _testCallModel: async (): Promise<LLMResponse> => {
      const mode = script[Math.min(call, script.length - 1)] ?? 1;
      const i = call++;
      if (mode === 'fail') {
        throw new Error(`scripted turn failure #${i}`);
      }
      const items: MessageItem[] = [];
      for (let k = 0; k < mode; k++) {
        items.push(assistantMessage(`answer ${i}.${k}`, `resp-${i}-${k}`));
      }
      return {
        items,
        usage: {
          inputTokens: 0,
          outputTokens: 1,
        },
      };
    },
  });
  return {
    harness,
    checkpointStore,
    storage,
  };
}

async function runTurn(harness: AgentHarness, threadId: string, text: string): Promise<void> {
  await harness.execute(text, {
    threadId,
  });
  await harness
    .getAgentResponse({
      threadId,
    })
    .catch(() => undefined);
}

//#endregion

describe('loadItems stitches only contiguous batches', () => {
  it('a shorter batch at offset 0 does not leave the old longer batch stitchable', async () => {
    /* The verified reseed repro, at the store level. Run 1 wrote batches at 0
     * (len 2), 2 (len 3) and 5 (len 2). `seedSessionHistory` reset the watermark
     * but deleted nothing, so the catch-up batch at 0 is len 3 — which spans past
     * the old offset-2 key without superseding it. Blind concat returned
     * [new0,new1,new2,old2,old3,old4]: three items from a DISCARDED history,
     * structurally valid and positioned as if they were the transcript.
     *
     * The stale offset-2 batch now ends the stitch, so this returns the clean
     * 3-item prefix. Deliberately a prefix and not the full 6: at the store level
     * the offsets alone cannot say whether the batch at 2 or the one at 3 is the
     * newer writer, and a short read is what the watermark clamp in `restore` is
     * built to absorb. The batches never reach this state through the real reseed
     * path anyway — the rollback marks the owner dirty and the next checkpoint
     * deletes them (see 'reseeded history does not resurrect...' below, which
     * asserts the full correct transcript end to end). */
    const storage = createInMemoryStorage();
    const store = createCheckpointStore({
      storage,
    });
    assert(store.appendItems);
    assert(store.loadItems);
    const owner = 'thread:reseeded';

    await store.appendItems(owner, 0, [
      'old0',
      'old1',
    ]);
    await store.appendItems(owner, 2, [
      'old2',
      'old3',
      'old4',
    ]);
    await store.appendItems(owner, 5, [
      'old5',
      'old6',
    ]);
    // Reseed: the watermark goes back to 0, then the catch-up batch lands.
    await store.appendItems(owner, 0, [
      'new0',
      'new1',
      'new2',
    ]);
    await store.appendItems(owner, 3, [
      'new3',
      'new4',
      'new5',
    ]);

    const stitched = await store.loadItems(owner, 6);
    expect(stitched).toEqual([
      'new0',
      'new1',
      'new2',
    ]);
    // Specifically: nothing from the discarded history came back, in any position.
    expect(stitched).not.toContain('old2');
    expect(stitched).not.toContain('old3');
    expect(stitched).not.toContain('old4');
    expect(stitched).not.toContain('old5');
  });

  it('...and the reseed path deletes those batches, so the full new log stitches', async () => {
    // Same offsets, but with the truncation a rollback now schedules: the stale
    // batches are gone before the catch-up batch lands, so there is no
    // discontinuity to stop at and all six new items stitch.
    const storage = createInMemoryStorage();
    const store = createCheckpointStore({
      storage,
    });
    assert(store.appendItems);
    assert(store.loadItems);
    assert(store.truncateItems);
    const owner = 'thread:reseeded-clean';

    await store.appendItems(owner, 0, [
      'old0',
      'old1',
    ]);
    await store.appendItems(owner, 2, [
      'old2',
      'old3',
      'old4',
    ]);
    await store.appendItems(owner, 5, [
      'old5',
      'old6',
    ]);
    await store.truncateItems(owner, 0);
    await store.appendItems(owner, 0, [
      'new0',
      'new1',
      'new2',
    ]);
    await store.appendItems(owner, 3, [
      'new3',
      'new4',
      'new5',
    ]);

    expect(await store.loadItems(owner, 6)).toEqual([
      'new0',
      'new1',
      'new2',
      'new3',
      'new4',
      'new5',
    ]);
  });

  it('an overlapping stale batch ends the stitch instead of appending after the good items', async () => {
    // No superseding batch covers offset 2, so the stale one there is the only
    // candidate — and it overlaps what is already stitched (3 items). The stitch
    // must stop at the clean prefix rather than append discarded items.
    const storage = createInMemoryStorage();
    const store = createCheckpointStore({
      storage,
    });
    assert(store.appendItems);
    assert(store.loadItems);
    const owner = 'thread:overlap';

    await store.appendItems(owner, 2, [
      'stale2',
      'stale3',
    ]);
    await store.appendItems(owner, 0, [
      'good0',
      'good1',
      'good2',
    ]);

    expect(await store.loadItems(owner, 4)).toEqual([
      'good0',
      'good1',
      'good2',
    ]);
  });

  it('a missing leading batch is a short read, not a silent re-positioning', async () => {
    /* Deleting the leading batch used to return ['i5','i6','i7'] positioned as
     * items 0..2 — a corrupted log that `restore`'s `Math.min(persistedCount,
     * length)` clamp would then seed a watermark over. */
    const storage = createInMemoryStorage();
    const store = createCheckpointStore({
      storage,
    });
    assert(store.appendItems);
    assert(store.loadItems);
    const owner = 'thread:hole';

    await store.appendItems(owner, 0, [
      'i0',
      'i1',
      'i2',
      'i3',
      'i4',
    ]);
    await store.appendItems(owner, 5, [
      'i5',
      'i6',
      'i7',
    ]);
    for (const key of await storage.list(`execution:${owner}:itemLog:`)) {
      if (key.endsWith('00000000')) {
        await storage.delete(key);
      }
    }

    expect(await store.loadItems(owner, 8)).toEqual([]);
  });

  it('a missing middle batch does not weld the two sides together', async () => {
    const storage = createInMemoryStorage();
    const store = createCheckpointStore({
      storage,
    });
    assert(store.appendItems);
    assert(store.loadItems);
    const owner = 'thread:middle-hole';

    await store.appendItems(owner, 0, [
      'a',
      'b',
    ]);
    await store.appendItems(owner, 2, [
      'c',
      'd',
    ]);
    await store.appendItems(owner, 4, [
      'e',
      'f',
    ]);
    for (const key of await storage.list(`execution:${owner}:itemLog:`)) {
      if (key.endsWith('00000002')) {
        await storage.delete(key);
      }
    }

    // The prefix before the hole, and nothing from after it.
    expect(await store.loadItems(owner, 6)).toEqual([
      'a',
      'b',
    ]);
  });

  it('contiguous batches still stitch to the full log (the fix is not a blanket refusal)', async () => {
    const storage = createInMemoryStorage();
    const store = createCheckpointStore({
      storage,
    });
    assert(store.appendItems);
    assert(store.loadItems);
    const owner = 'thread:happy';

    await store.appendItems(owner, 0, [
      'a',
      'b',
    ]);
    await store.appendItems(owner, 2, [
      'c',
    ]);
    await store.appendItems(owner, 3, [
      'd',
      'e',
    ]);

    expect(await store.loadItems(owner, 5)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    // `count` still truncates a longer durable log.
    expect(await store.loadItems(owner, 3)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('truncateItems removes the batches a rollback orphaned', () => {
  it('drops whole batches at or past the cut and trims a straddling one', async () => {
    const storage = createInMemoryStorage();
    const store = createCheckpointStore({
      storage,
    });
    assert(store.appendItems);
    assert(store.loadItems);
    assert(store.truncateItems);
    const owner = 'thread:truncate';

    await store.appendItems(owner, 0, [
      'a',
      'b',
    ]);
    await store.appendItems(owner, 2, [
      'c',
      'd',
      'e',
    ]);
    await store.appendItems(owner, 5, [
      'f',
    ]);

    // Cut at 3: the offset-5 batch goes entirely, the offset-2 batch straddles
    // and keeps only its first item.
    await store.truncateItems(owner, 3);

    expect(await store.loadItems(owner, 6)).toEqual([
      'a',
      'b',
      'c',
    ]);
    // A later append at the cut point continues cleanly.
    await store.appendItems(owner, 3, [
      'C',
      'D',
    ]);
    expect(await store.loadItems(owner, 5)).toEqual([
      'a',
      'b',
      'c',
      'C',
      'D',
    ]);
  });

  it('a cut on a batch boundary leaves the prefix byte-identical', async () => {
    const storage = createInMemoryStorage();
    const store = createCheckpointStore({
      storage,
    });
    assert(store.appendItems);
    assert(store.loadItems);
    assert(store.truncateItems);
    const owner = 'thread:boundary';

    await store.appendItems(owner, 0, [
      'a',
      'b',
    ]);
    await store.appendItems(owner, 2, [
      'c',
      'd',
    ]);
    await store.truncateItems(owner, 2);

    expect(await store.loadItems(owner, 4)).toEqual([
      'a',
      'b',
    ]);
  });

  it('a cut at 0 clears the owner entirely', async () => {
    const storage = createInMemoryStorage();
    const store = createCheckpointStore({
      storage,
    });
    assert(store.appendItems);
    assert(store.loadItems);
    assert(store.truncateItems);
    const owner = 'thread:wipe';

    await store.appendItems(owner, 0, [
      'a',
      'b',
    ]);
    await store.appendItems(owner, 2, [
      'c',
    ]);
    await store.truncateItems(owner, 0);

    expect(await storage.list(`execution:${owner}:itemLog:`)).toEqual([]);
    expect(await store.loadItems(owner, 3)).toEqual([]);
  });
});

describe('a rolled-back turn leaves no durable trace at any checkpoint cadence', () => {
  it('the stitched durable log equals the live log when the recovery turn writes LONGER batches', async () => {
    /* The verified asymmetric-cadence repro, at the batch offsets this harness
     * actually produces. Turn 2 checkpoints at offsets 6, 7 and 8 (the last of
     * length 2) and then fails → the watermark clamps to 6, but batch@8 stays on
     * disk. Turn 3's second model call returns THREE items instead of one, so its
     * batch@7 has length 3 and spans right across offset 8 without superseding
     * that key. Unfixed, batch@8's contents — items from the ABORTED turn — were
     * concatenated after turn 3's, then the whole thing truncated to `count`, so
     * a resumed session replayed 'answer 3.0'/'answer 4.0' (which the user never
     * saw succeed) and lost the real final items. */
    const { harness, checkpointStore } = makeHarness([
      1,
      1,
      1, // turn 1
      1,
      1,
      'fail', // turn 2 — two mid-turn checkpoints, then aborts
      3,
      1,
      1, // turn 3 — recovery, LONGER batch at the clamped offset
      1,
      1,
      1, // turn 4 — keeps appending past the stale offset
    ]);
    const threadId = 'cadence-longer';

    await runTurn(harness, threadId, 'turn one');
    await runTurn(harness, threadId, 'turn two (will fail)');
    await runTurn(harness, threadId, 'turn three');
    await runTurn(harness, threadId, 'turn four');

    assert(checkpointStore.loadItems);
    const watermark = harness.itemLogPersistence.get(`thread:${threadId}`);
    const raw = await checkpointStore.loadItems(`thread:${threadId}`, watermark);

    // The durable log IS the live log — same items, same order, same length.
    const live = await harness.previewRequestItems({
      threadId,
    });
    expect(durableTexts(raw)).toEqual(live.flatMap(itemTexts));
    expect(raw.length).toBe(watermark);

    const texts = durableTexts(raw);
    expect(texts).toContain('turn one');
    expect(texts).toContain('turn three');
    expect(texts).toContain('turn four');
    expect(texts).not.toContain('turn two (will fail)');
  });

  it('...and when the recovery turn writes SHORTER batches than the aborted one', async () => {
    /* The other direction. The aborted turn's mid-turn call returns THREE items,
     * so its batch@7 is long; the recovery turn writes a 1-item batch at the same
     * key, which cannot erase the stale one — the old batch's tail stays reachable
     * under the NEXT offset. This is the half the continuity check catches on its
     * own, and it must hold too. */
    const { harness, checkpointStore } = makeHarness([
      1,
      1,
      1, // turn 1
      1,
      3,
      'fail', // turn 2 — a LONG mid-turn batch, then aborts
      1,
      1,
      1, // turn 3 — recovery writes shorter batches
      1,
      1,
      1, // turn 4
    ]);
    const threadId = 'cadence-shorter';

    await runTurn(harness, threadId, 'alpha');
    await runTurn(harness, threadId, 'beta (will fail)');
    await runTurn(harness, threadId, 'gamma');
    await runTurn(harness, threadId, 'delta');

    assert(checkpointStore.loadItems);
    const watermark = harness.itemLogPersistence.get(`thread:${threadId}`);
    const raw = await checkpointStore.loadItems(`thread:${threadId}`, watermark);
    const live = await harness.previewRequestItems({
      threadId,
    });

    expect(durableTexts(raw)).toEqual(live.flatMap(itemTexts));
    expect(durableTexts(raw)).toContain('alpha');
    expect(durableTexts(raw)).toContain('gamma');
    expect(durableTexts(raw)).not.toContain('beta (will fail)');
  });

  it('a restarted host restores exactly the live transcript after a failed turn', async () => {
    // End to end through `restore` on a FRESH harness (empty watermark map), which
    // is the documented normal recovery path and the one that reads the batches
    // rather than the in-memory count.
    const { harness, checkpointStore, storage } = makeHarness([
      1,
      1,
      1, // turn 1
      1,
      1,
      'fail', // turn 2 aborts
      3,
      1,
      1, // turn 3 — recovery, misaligned batches
    ]);
    const threadId = 'restart-after-fail';

    await runTurn(harness, threadId, 'kept one');
    await runTurn(harness, threadId, 'discarded (will fail)');
    await runTurn(harness, threadId, 'kept two');

    const live = await harness.previewRequestItems({
      threadId,
    });
    const ids = await checkpointStore.list();
    const executionId = ids[ids.length - 1]?.executionId;
    assert(executionId);

    const resumed = new AgentHarness({
      name: 'stitch-resumed',
      params: {},
      storage,
      checkpointStore: createCheckpointStore({
        storage,
      }),
    });
    const restored = await resumed.restore(executionId);
    assert(restored);

    expect(restored.itemLog.items.flatMap(itemTexts)).toEqual(live.flatMap(itemTexts));
    const restoredTexts = restored.itemLog.items.flatMap(itemTexts);
    expect(restoredTexts).toContain('kept one');
    expect(restoredTexts).toContain('kept two');
    expect(restoredTexts).not.toContain('discarded (will fail)');
  });

  it('reseeded history does not resurrect the pre-seed transcript on restore', async () => {
    /* `seedSessionHistory` is the other producer of the misaligned-batch shape,
     * and `chat-sdk` calls it on every first-contact thread. */
    const { harness, checkpointStore, storage } = makeHarness([
      1,
      1,
      1, // pre-seed turn: batches at 0, 1, 2
      1,
      1,
      1, // post-seed turn: the catch-up batch lands on top of them
    ]);
    const threadId = 'reseed-restore';

    await runTurn(harness, threadId, 'pre-seed history');
    harness.seedSessionHistory(threadId, [
      assistantMessage('seeded A', 'seed-a'),
      assistantMessage('seeded B', 'seed-b'),
      assistantMessage('seeded C', 'seed-c'),
    ]);
    await runTurn(harness, threadId, 'post-seed turn');

    const live = await harness.previewRequestItems({
      threadId,
    });
    const ids = await checkpointStore.list();
    const executionId = ids[ids.length - 1]?.executionId;
    assert(executionId);

    const resumed = new AgentHarness({
      name: 'reseed-resumed',
      params: {},
      storage,
      checkpointStore: createCheckpointStore({
        storage,
      }),
    });
    const restored = await resumed.restore(executionId);
    assert(restored);

    expect(restored.itemLog.items.flatMap(itemTexts)).toEqual(live.flatMap(itemTexts));
    expect(restored.itemLog.items.flatMap(itemTexts)).not.toContain('pre-seed history');
  });
});
