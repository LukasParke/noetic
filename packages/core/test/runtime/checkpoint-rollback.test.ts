/**
 * Durable execution × failed turns: the item-log persistence watermark must
 * follow the session log through `rollbackTurn` truncation, and must be
 * harness-scoped rather than module-global.
 *
 * The bug this pins: `captureCheckpoint` tracks persisted-item counts, and a
 * naive implementation (a module-global map, never rolled back) would (a) leave
 * a mid-turn checkpoint's items durable forever after a failed turn truncated
 * the shared session log, so every later checkpoint diffed against a phantom
 * durable prefix and persisted nothing; and (b) be shared across every harness
 * in the process, so two harnesses with colliding threadIds poisoned each
 * other's delta accounting.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import type { Item, LLMResponse, MessageItem, Step, StepLLM } from '@noetic-tools/types';
import { defaultItemSchemaRegistry } from '@noetic-tools/types';
import { loop } from '../../src/builders/loop-builder';
import { step } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import { ItemLogPersistence, itemLogOwnerKey } from '../../src/runtime/durable/harness-checkpoints';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { until } from '../../src/until/predicates';
import { assistantMessage } from '../_helpers';

let uniq = 0;

/**
 * Items one 2-iteration turn appends: the user input, an assistant message per
 * model call, and the loop's carry-forward of iteration 1's output as
 * iteration 2's input. Named rather than inlined so the watermark arithmetic
 * below reads as "one turn / two turns" instead of magic 4 and 8.
 */
const ITEMS_PER_TURN = 4;

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

/**
 * Each turn drives a 2-iteration loop (2 model calls per turn). The step
 * boundary after iteration 1 fires `captureCheckpoint`, persisting the turn's
 * items MID-turn — so a failure on the turn's second model call exercises the
 * rollback seam against genuinely-persisted partial state. `responses` is
 * indexed per MODEL CALL, not per turn.
 */
function makeHarness(opts?: { responses?: Array<'ok' | 'fail'> }): {
  harness: AgentHarness;
  checkpointStore: ReturnType<typeof createCheckpointStore>;
} {
  const storage = createInMemoryStorage();
  const checkpointStore = createCheckpointStore({
    storage,
  });
  const script = opts?.responses ?? [
    'ok',
  ];
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
    until: until.maxSteps(2),
    maxIterations: 2,
  });
  const harness = new AgentHarness({
    name: 'rollback-test',
    params: {},
    initialStep: body,
    storage,
    checkpointStore,
    _testCallModel: async (): Promise<LLMResponse> => {
      const mode = script[Math.min(call, script.length - 1)];
      const i = call++;
      if (mode === 'fail') {
        throw new Error(`scripted turn failure #${i}`);
      }
      const message: MessageItem = assistantMessage(`answer ${i}`, `resp-${i}`);
      return {
        items: [
          message,
        ],
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
  };
}

describe('item-log persistence watermark under turn rollback (D1)', () => {
  it('a failed turn rolls the persistence watermark back with the log', async () => {
    const { harness } = makeHarness({
      responses: [
        'ok',
        'ok',
        'ok',
        'fail',
        'ok',
        'ok',
      ],
    });

    // Turn 1 (calls 0,1) succeeds and persists the whole turn.
    await harness.execute('turn one', {
      threadId: 't-roll',
    });
    await harness.getAgentResponse({
      threadId: 't-roll',
    });
    const afterTurn1 = harness.itemLogPersistence.get('thread:t-roll');
    expect(afterTurn1).toBe(ITEMS_PER_TURN);

    // Turn 2 (calls 2,3): call 2 succeeds — the checkpoint after iteration 1
    // persists this turn's partial items — then call 3 fails. rollbackTurn
    // truncates the live log to the turn watermark; the persistence watermark
    // must come back with it.
    await harness.execute('turn two (will fail)', {
      threadId: 't-roll',
    });
    await harness
      .getAgentResponse({
        threadId: 't-roll',
      })
      .catch(() => undefined);
    const afterFail = harness.itemLogPersistence.get('thread:t-roll');
    expect(afterFail).toBeLessThanOrEqual(afterTurn1);

    // Turn 3 succeeds. If the watermark had stayed ahead of the truncated log
    // (the bug), this turn's items would be diffed against a phantom durable
    // prefix and NEVER persisted. It must land at exactly live-log length.
    await harness.execute('turn three', {
      threadId: 't-roll',
    });
    const resp = await harness.getAgentResponse({
      threadId: 't-roll',
    });
    expect(resp.text).toContain('answer');
    expect(harness.itemLogPersistence.get('thread:t-roll')).toBe(ITEMS_PER_TURN * 2);
  });

  it('restore never resurrects a rolled-back turn (durable = live)', async () => {
    const { harness, checkpointStore } = makeHarness({
      responses: [
        'ok',
        'ok',
        'ok',
        'fail',
        'ok',
        'ok',
      ],
    });
    const threadId = 't-resurrect';
    await harness.execute('turn one', {
      threadId,
    });
    await harness.getAgentResponse({
      threadId,
    });
    await harness.execute('turn two (will fail)', {
      threadId,
    });
    await harness
      .getAgentResponse({
        threadId,
      })
      .catch(() => undefined);
    await harness.execute('turn three', {
      threadId,
    });
    await harness.getAgentResponse({
      threadId,
    });

    // Stitch the durable log back the way restore would: under the THREAD owner
    // key, honouring the snapshot's persisted count.
    assert(checkpointStore.loadItems);
    const raw = await checkpointStore.loadItems(
      `thread:${threadId}`,
      harness.itemLogPersistence.get(`thread:${threadId}`),
    );
    const texts = durableTexts(raw);
    expect(texts).toContain('turn one');
    expect(texts).toContain('turn three');
    // The failed turn's input was rolled back from the live log; the durable
    // form must agree.
    expect(texts).not.toContain('turn two (will fail)');
  });
});

describe('watermarks are harness-scoped, not module-global (D2)', () => {
  it('two harnesses with the same threadId keep independent watermarks', async () => {
    const a = makeHarness();
    const b = makeHarness();

    await a.harness.execute('only harness A speaks', {
      threadId: 'main',
    });
    await a.harness.getAgentResponse({
      threadId: 'main',
    });

    expect(a.harness.itemLogPersistence.get('thread:main')).toBe(ITEMS_PER_TURN);
    // Harness B never ran a turn; a shared module-global map would show A's
    // count here and make B's first checkpoint under-persist from that offset.
    expect(b.harness.itemLogPersistence.get('thread:main')).toBe(0);
  });
});

describe('ItemLogPersistence contract', () => {
  it('an unknown owner reads as zero', () => {
    const p = new ItemLogPersistence();
    expect(p.get('thread:nobody')).toBe(0);
  });

  it('set then get round-trips per owner', () => {
    const p = new ItemLogPersistence();
    p.set('thread:a', 7);
    p.set('thread:b', 2);
    expect(p.get('thread:a')).toBe(7);
    expect(p.get('thread:b')).toBe(2);
  });

  it('rollback clamps a watermark that is ahead of the live log', () => {
    const p = new ItemLogPersistence();
    p.set('thread:a', 9);
    p.rollback('thread:a', 4);
    expect(p.get('thread:a')).toBe(4);
  });

  it('rollback never raises a watermark that is already at or below the log', () => {
    // The durable prefix is a prefix: a "rollback" to a LATER point would claim
    // items were persisted that never were, and the next checkpoint would skip
    // them forever.
    const p = new ItemLogPersistence();
    p.set('thread:a', 3);
    p.rollback('thread:a', 5);
    expect(p.get('thread:a')).toBe(3);
    p.rollback('thread:a', 3);
    expect(p.get('thread:a')).toBe(3);
  });

  it('rollback on an unseen owner records nothing (stays zero)', () => {
    // Seeding a watermark here would invent a durable prefix for a log whose
    // items were never written.
    const p = new ItemLogPersistence();
    p.rollback('thread:unseen', 6);
    expect(p.get('thread:unseen')).toBe(0);
  });

  it('delete drops an owner back to zero', () => {
    const p = new ItemLogPersistence();
    p.set('thread:a', 5);
    p.delete('thread:a');
    expect(p.get('thread:a')).toBe(0);
  });
});

describe('itemLogOwnerKey', () => {
  it('keys on the thread when there is one', () => {
    expect(
      itemLogOwnerKey({
        threadId: 'main',
        id: 'exec-1',
      }),
    ).toBe('thread:main');
  });

  it('falls back to the execution for a threadless one-shot context', () => {
    expect(
      itemLogOwnerKey({
        id: 'exec-1',
      }),
    ).toBe('execution:exec-1');
  });

  it('capture and restore derive the same key from their different inputs', () => {
    // Capture holds a live Context; restore holds a snapshot plus an
    // executionId. If these disagreed, restore would read an empty prefix.
    const fromContext = itemLogOwnerKey({
      threadId: 't',
      id: 'exec-live',
    });
    const fromSnapshot = itemLogOwnerKey({
      threadId: 't',
      id: 'exec-restored',
    });
    expect(fromContext).toBe(fromSnapshot);
  });
});
