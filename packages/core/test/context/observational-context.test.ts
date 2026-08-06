import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ObservationalState } from '@noetic-tools/context';
import { observationalContext } from '@noetic-tools/context';
import type { MessageItem } from '@noetic-tools/types';
import { makeCtx, makeItemLog, makeScopedStorage } from '../_helpers';

describe('observationalContext', () => {
  it('has correct id and slot', () => {
    const layer = observationalContext();
    expect(layer.id).toBe('observational-context');
    expect(layer.slot).toBe(200);
  });

  it('init loads state from storage', async () => {
    const layer = observationalContext();
    const result = await layer.hooks.init!({
      storage: makeScopedStorage(),
      scopeKey: 'user-1',
      ctx: makeCtx(),
    });
    expect(result.state).toEqual({
      observations: [],
      buffer: [],
      bufferTokens: 0,
      version: 0,
    });
  });

  it('recall renders observations', async () => {
    const layer = observationalContext();
    const state = {
      observations: [
        'Tool X returns errors',
        'User prefers JSON',
      ],
      buffer: [],
      bufferTokens: 0,
      version: 1,
    };
    const result = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx: makeCtx(),
      state,
      budget: 1_000,
    });
    expect(result).not.toBeNull();
    assert(typeof result !== 'string');
    const msg = result!.items[0];
    assert(msg.type === 'message');
    const part = msg.content[0];
    assert(part.type === 'input_text');
    expect(part.text).toContain('Tool X returns errors');
  });

  it('store accumulates and compresses at threshold', async () => {
    // Token-based threshold: "test output" ≈ 3 tokens, so threshold 5 triggers after 2 items
    const layer = observationalContext({
      bufferThreshold: 5,
    });
    const state: ObservationalState = {
      observations: [],
      buffer: [],
      bufferTokens: 0,
      version: 0,
    };
    const msg: MessageItem = {
      id: '1',
      status: 'completed',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: 'test output',
        },
      ],
    };

    // First store: buffer grows
    const r1 = await layer.hooks.store!({
      newItems: [
        msg,
      ],
      log: makeItemLog(),
      response: {
        items: [
          msg,
        ],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      ctx: makeCtx(),
      state,
    });
    assert(r1 !== undefined);
    expect(r1.state.buffer).toHaveLength(1);

    // Second store: threshold reached, compresses
    const r2 = await layer.hooks.store!({
      newItems: [
        msg,
      ],
      log: makeItemLog(),
      response: {
        items: [
          msg,
        ],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      ctx: makeCtx(),
      state: r1.state,
    });
    assert(r2 !== undefined);
    expect(r2.state.observations).toHaveLength(1);
    expect(r2.state.observations[0]).toContain('Processed 2 items');
    expect(r2.state.buffer).toHaveLength(0);
  });

  it('onSpawn clones state', async () => {
    const layer = observationalContext();
    const parentState = {
      observations: [
        'obs1',
      ],
      buffer: [
        'buf1',
      ],
      bufferTokens: 1,
      version: 1,
    };
    const result = await layer.hooks.onSpawn!({
      parentState,
      childCtx: makeCtx(),
    });
    expect(result!.childState).toEqual(parentState);
    expect(result!.childState).not.toBe(parentState);
  });
});

describe('observationalContext deferred distillation (M8, redesigned)', () => {
  function assistantItem(text: string): MessageItem {
    return {
      id: 'a1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text,
        },
      ],
    };
  }

  const emptyResponse = {
    items: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
    },
  };

  it('declares no LLM-headroom timeouts — distillation runs off the turn path', () => {
    const layer = observationalContext();
    // The observer is fire-and-collect now: hooks only append to the buffer,
    // so the default hook timeouts are sufficient and the turn never blocks
    // on an LLM distillation call.
    expect('timeouts' in layer).toBe(false);
  });

  it('crossing the threshold with an observer clears the buffer without blocking', async () => {
    let resolveObserver: ((v: string[]) => void) | undefined;
    const layer = observationalContext({
      bufferThreshold: 1,
      observer: () =>
        new Promise<string[]>((resolve) => {
          resolveObserver = resolve;
        }),
    });
    const ctx = makeCtx();
    const before = Date.now();
    const result = await layer.hooks.store({
      newItems: [
        assistantItem('a long enough assistant answer to cross the threshold'),
      ],
      log: makeItemLog(),
      response: emptyResponse,
      ctx,
      state: {
        observations: [],
        buffer: [],
        bufferTokens: 0,
        version: 0,
      },
    });
    // Returned immediately (no await on the observer)...
    expect(Date.now() - before).toBeLessThan(1_000);
    expect(result.state.buffer).toEqual([]);
    expect(result.state.observations).toEqual([]);

    // ...and the observation lands on a later hook once the observer resolves.
    assert(resolveObserver);
    resolveObserver([
      'deferred fact',
    ]);
    await Bun.sleep(1);

    const drained = await layer.hooks.store({
      newItems: [],
      log: makeItemLog(),
      response: emptyResponse,
      ctx,
      state: result.state,
    });
    expect(drained.state.observations).toEqual([
      'deferred fact',
    ]);
    // The drain bumps version so downstream churn tracking sees the change.
    expect(drained.state.version).toBe(result.state.version + 1);
  });

  it('a failed distillation drops its batch instead of stalling the turn', async () => {
    const layer = observationalContext({
      bufferThreshold: 1,
      observer: () => Promise.reject(new Error('observer exploded')),
    });
    const ctx = makeCtx();
    const result = await layer.hooks.store({
      newItems: [
        assistantItem('enough text to cross the tiny threshold'),
      ],
      log: makeItemLog(),
      response: emptyResponse,
      ctx,
      state: {
        observations: [],
        buffer: [],
        bufferTokens: 0,
        version: 0,
      },
    });
    expect(result.state.buffer).toEqual([]);
    await Bun.sleep(1);

    const after = await layer.hooks.store({
      newItems: [],
      log: makeItemLog(),
      response: emptyResponse,
      ctx,
      state: result.state,
    });
    expect(after.state.observations).toEqual([]);
  });

  it('keeps deferred batches keyed per scope so resources cannot cross-contaminate', async () => {
    // One layer instance is shared across every resource on a harness, while
    // its state is stored per scope key. A single shared bucket would drain
    // resource A's distillation into resource B's observations.
    let resolveA: ((v: string[]) => void) | undefined;
    const layer = observationalContext({
      bufferThreshold: 1,
      observer: () =>
        new Promise<string[]>((resolve) => {
          resolveA = resolve;
        }),
    });
    const ctxA = makeCtx({
      resourceId: 'user-a',
    });
    const ctxB = makeCtx({
      resourceId: 'user-b',
    });
    const emptyState = {
      observations: [],
      buffer: [],
      bufferTokens: 0,
      version: 0,
    };

    const a1 = await layer.hooks.store({
      newItems: [
        assistantItem('resource A text long enough to cross the threshold'),
      ],
      log: makeItemLog(),
      response: emptyResponse,
      ctx: ctxA,
      state: emptyState,
    });
    assert(resolveA);
    resolveA([
      'A-only fact',
    ]);
    await Bun.sleep(1);

    // B drains its own (empty) bucket — A's batch must not appear here.
    const b1 = await layer.hooks.store({
      newItems: [],
      log: makeItemLog(),
      response: emptyResponse,
      ctx: ctxB,
      state: emptyState,
    });
    expect(b1.state.observations).toEqual([]);

    // A still gets it.
    const a2 = await layer.hooks.store({
      newItems: [],
      log: makeItemLog(),
      response: emptyResponse,
      ctx: ctxA,
      state: a1.state,
    });
    expect(a2.state.observations).toEqual([
      'A-only fact',
    ]);
  });

  it('recall never mutates state, so a drained batch cannot demote the anchor band', async () => {
    // `bandFor` forces the live band for any layer whose recall returns state.
    // Draining in store/onItemAppend keeps recall pure and the layer anchorable.
    const layer = observationalContext();
    const state = {
      observations: [
        'known fact',
      ],
      buffer: [],
      bufferTokens: 0,
      version: 1,
    };
    const recall = await layer.hooks.recall({
      log: makeItemLog(),
      query: '',
      ctx: makeCtx(),
      state,
      budget: 1_000,
    });
    assert(recall);
    // `state` is absent from recall's return type entirely, so the lifecycle's
    // `result.state !== undefined` mutatedState check can never fire here.
    expect(Object.hasOwn(recall, 'state')).toBe(false);
    expect(recall.items.length).toBe(1);
  });
});
