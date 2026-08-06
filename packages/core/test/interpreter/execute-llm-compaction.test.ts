/**
 * Compaction reaching the model, through the interpreter.
 *
 * The unit suite (test/context/compaction.test.ts) proves `foldCompactions` is
 * correct in isolation. This proves the interpreter actually applies it: a
 * compaction record written to the item log must shrink what `callModel`
 * receives, and crossing `compactAt` must surface as a `context_pressure`
 * framework event rather than a silent trim.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData, ContextLayer } from '@noetic-tools/context';
import { compactionAsItem, createCompaction } from '@noetic-tools/context';
import type {
  CallModelRequest,
  Item,
  ProjectionPolicy,
  StepLLM,
  StreamEvent,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { executeLLM } from '../../src/interpreter/execute-action';
import { ContextImpl } from '../../src/runtime/context-impl';
import { EventBroadcaster } from '../../src/runtime/event-broadcaster';
import { makeLLMResponse, makeMockHarness } from '../_helpers';

//#region Helpers

/** A real broadcaster that also records what it was asked to emit. */
class RecordingBroadcaster extends EventBroadcaster {
  readonly events: StreamEvent[] = [];

  override emit(event: StreamEvent): void {
    this.events.push(event);
    super.emit(event);
  }
}

/** One inert layer — enough to put executeLLM on the layer-bearing assembly path. */
const LAYERS: ContextLayer[] = [
  {
    id: 'inert',
    slot: 275,
    scope: 'execution',
    hooks: {},
  },
];

const STEP: StepLLM<ContextData, string, string> = {
  kind: 'llm',
  id: 'compaction-step',
  model: 'gpt-4',
};

interface Rig {
  ctx: ContextImpl;
  events: StreamEvent[];
  request: () => CallModelRequest;
}

/** An executeLLM rig with a recording broadcaster and a captured model request. */
function makeRig(): Rig {
  let captured: CallModelRequest | undefined;
  const harness = makeMockHarness();
  harness.callModel = async (request) => {
    captured = request;
    return makeLLMResponse('done');
  };
  const broadcaster = new RecordingBroadcaster();
  const ctx = new ContextImpl({
    harness,
    _broadcaster: broadcaster,
  });
  return {
    ctx,
    events: broadcaster.events,
    request: () => {
      assert(captured !== undefined, 'callModel was never invoked');
      return captured;
    },
  };
}

/** Seed `count` user turns of roughly `pad` characters each. */
function seedTurns(ctx: ContextImpl, count: number, pad = 0): void {
  for (let i = 0; i < count; i++) {
    ctx.itemLog.append(
      frameworkCast<Item>({
        id: `u-${i}`,
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [
          {
            type: 'input_text',
            text: `q-${i} ${'x'.repeat(pad)}`,
          },
        ],
      }),
    );
  }
}

/** Framework events of one type, unwrapped to their data payloads. */
function frameworkData(events: StreamEvent[], type: string): Array<Record<string, unknown>> {
  const matches: Array<Record<string, unknown>> = [];
  for (const event of events) {
    if (event.source !== 'framework' || !event.type.endsWith(`:${type}`)) {
      continue;
    }
    assert(typeof event.data === 'object' && event.data !== null);
    matches.push(frameworkCast<Record<string, unknown>>(event.data));
  }
  return matches;
}

//#endregion

describe('executeLLM — compaction folded into the request', () => {
  it('a compaction record in the log shrinks what the model receives', async () => {
    const rig = makeRig();
    seedTurns(rig.ctx, 10);
    const beforeCount = rig.ctx.itemLog.items.length;

    const compaction = createCompaction({
      items: rig.ctx.itemLog.items,
      replacesUntil: 8,
      summary: 'the first eight turns, summarized',
    });
    rig.ctx.itemLog.append(compactionAsItem(compaction));

    await executeLLM(STEP, '', rig.ctx, LAYERS);

    const sent = rig.request().items;
    // The log GREW (compaction is append-only) but the view SHRANK.
    expect(rig.ctx.itemLog.items.length).toBeGreaterThan(beforeCount);
    expect(sent.length).toBeLessThan(beforeCount);
    // The summary reached the model in place of the covered prefix...
    const texts = sent.flatMap((item) =>
      item.type === 'message'
        ? item.content.flatMap((part) =>
            'text' in part
              ? [
                  part.text,
                ]
              : [],
          )
        : [],
    );
    expect(texts.some((t) => t.includes('the first eight turns, summarized'))).toBe(true);
    expect(texts.some((t) => t.includes('q-0'))).toBe(false);
    // ...and the uncompacted tail survived.
    expect(texts.some((t) => t.includes('q-9'))).toBe(true);
    // The raw record itself never goes to the provider.
    expect(sent.some((i) => i.type === compaction.type)).toBe(false);
  });

  it('folds on the no-layers path too', async () => {
    const rig = makeRig();
    seedTurns(rig.ctx, 6);
    const compaction = createCompaction({
      items: rig.ctx.itemLog.items,
      replacesUntil: 5,
      summary: 'earlier turns',
    });
    rig.ctx.itemLog.append(compactionAsItem(compaction));

    await executeLLM(STEP, '', rig.ctx);

    const sent = rig.request().items;
    expect(sent.some((i) => i.type === compaction.type)).toBe(false);
    const texts = sent.flatMap((item) =>
      item.type === 'message'
        ? item.content.flatMap((part) =>
            'text' in part
              ? [
                  part.text,
                ]
              : [],
          )
        : [],
    );
    expect(texts.some((t) => t.includes('earlier turns'))).toBe(true);
    expect(texts.some((t) => t.includes('q-0'))).toBe(false);
  });

  it('leaves an uncompacted log untouched', async () => {
    const rig = makeRig();
    seedTurns(rig.ctx, 4);

    await executeLLM(STEP, '', rig.ctx, LAYERS);

    const texts = rig.request().items.flatMap((item) =>
      item.type === 'message'
        ? item.content.flatMap((part) =>
            'text' in part
              ? [
                  part.text,
                ]
              : [],
          )
        : [],
    );
    for (let i = 0; i < 4; i++) {
      expect(texts.some((t) => t.includes(`q-${i}`))).toBe(true);
    }
  });
});

describe('executeLLM — context_pressure event', () => {
  // A budget tight enough that 40 padded turns cross the default 80% compactAt.
  const tightPolicy: ProjectionPolicy = {
    tokenBudget: 2_000,
    responseReserve: 200,
    overflow: 'sliding_window',
  };
  const tightStep: StepLLM<ContextData, string, string> = {
    ...STEP,
    projection: tightPolicy,
  };

  it('emits context_pressure when folded history crosses compactAt', async () => {
    const rig = makeRig();
    seedTurns(rig.ctx, 40, 120);

    await executeLLM(tightStep, '', rig.ctx, LAYERS);

    const emitted = frameworkData(rig.events, 'context_pressure');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].nodeId).toBe(tightStep.id);
    const historyTokens = emitted[0].historyTokens;
    const compactAt = emitted[0].compactAt;
    assert(typeof historyTokens === 'number' && typeof compactAt === 'number');
    expect(historyTokens).toBeGreaterThan(compactAt);
  });

  it('stays silent under the threshold', async () => {
    const rig = makeRig();
    seedTurns(rig.ctx, 2);

    await executeLLM(tightStep, '', rig.ctx, LAYERS);

    expect(frameworkData(rig.events, 'context_pressure')).toHaveLength(0);
  });

  it('a compaction that relieves the pressure silences the event', async () => {
    const rig = makeRig();
    seedTurns(rig.ctx, 40, 120);
    const compaction = createCompaction({
      items: rig.ctx.itemLog.items,
      replacesUntil: 39,
      summary: 'everything before the last turn',
    });
    rig.ctx.itemLog.append(compactionAsItem(compaction));

    await executeLLM(tightStep, '', rig.ctx, LAYERS);

    // Measured POST-fold, so relieving the pressure genuinely turns the signal
    // off — otherwise an agent that compacted would keep being told to compact.
    expect(frameworkData(rig.events, 'context_pressure')).toHaveLength(0);
  });

  it('honours step.emit === false', async () => {
    const rig = makeRig();
    seedTurns(rig.ctx, 40, 120);

    await executeLLM(
      {
        ...tightStep,
        emit: false,
      },
      '',
      rig.ctx,
      LAYERS,
    );

    expect(frameworkData(rig.events, 'context_pressure')).toHaveLength(0);
  });

  it('honours an emit predicate that filters the event out', async () => {
    const rig = makeRig();
    seedTurns(rig.ctx, 40, 120);
    const asked: string[] = [];

    await executeLLM(
      {
        ...tightStep,
        emit: (eventType) => {
          asked.push(eventType);
          return eventType !== 'context_pressure';
        },
      },
      '',
      rig.ctx,
      LAYERS,
    );

    expect(asked).toContain('context_pressure');
    expect(frameworkData(rig.events, 'context_pressure')).toHaveLength(0);
  });
});
