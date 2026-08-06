import type { ContextLayer, ExecutionContext } from '@noetic-tools/types';
import {
  collectInputText,
  collectOutputText,
  createMessage,
  estimateTokens,
  Slot,
} from '@noetic-tools/types';
import { resolveScopeKey } from '../scope';

export interface ObservationalState {
  observations: string[];
  buffer: string[];
  bufferTokens: number;
  version: number;
}

const DEFAULT_BUFFER_THRESHOLD_TOKENS = 2_000;
const DEFAULT_MAX_OBSERVATIONS = 50;

export type ObserverFn = (buffer: string[]) => Promise<string[]>;

function emptyObservationalState(): ObservationalState {
  return {
    observations: [],
    buffer: [],
    bufferTokens: 0,
    version: 0,
  };
}

interface AccumulateConfig {
  threshold: number;
  maxObs: number;
  observer?: ObserverFn;
  /** Background-distillation bucket for the current scope key. */
  deferred: DeferredDistill;
}

/**
 * In-flight background distillations for one scope key. Results drain into
 * state on the next `store` / `onItemAppend` — distillation is eventually
 * visible, never turn-blocking. An LLM-backed observer used to add its full
 * round-trip latency to the user's turn (both hooks awaited it, with 60s
 * timeouts); now the turn pays only the buffer append.
 *
 * Keyed per scope key rather than per layer instance: one layer instance is
 * shared across every thread/resource on a harness, while its state is stored
 * per scope, so a single shared bucket would drain resource A's distillation
 * into resource B's observations.
 */
interface DeferredDistill {
  pending: Promise<string[]>[];
  ready: string[][];
}

/** Fold completed background batches into `observations`. Returns `s` unchanged
 *  (identity-comparable) when nothing has completed. */
function drainReady(s: ObservationalState, d: DeferredDistill, maxObs: number): ObservationalState {
  if (d.ready.length === 0) {
    return s;
  }
  const batches = d.ready.splice(0, d.ready.length);
  const observations = [
    ...s.observations,
    ...batches.flat(),
  ].slice(-maxObs);
  return {
    ...s,
    observations,
    version: s.version + 1,
  };
}

/**
 * Appends `texts` into the layer buffer and, once the token threshold is crossed,
 * distills the buffer into observations. Shared by `store` (assistant output) and
 * `onItemAppend` (user/tool input).
 */
function accumulate(
  s: ObservationalState,
  texts: string[],
  cfg: AccumulateConfig,
): ObservationalState {
  const deferred = cfg.deferred;
  const withReady = drainReady(s, deferred, cfg.maxObs);
  const newBuffer = [
    ...withReady.buffer,
    ...texts,
  ];
  const newTokens = texts.reduce((sum, t) => sum + estimateTokens(t), 0);
  const totalBufferTokens = withReady.bufferTokens + newTokens;
  if (totalBufferTokens >= cfg.threshold) {
    if (cfg.observer) {
      // Fire-and-collect: the observer runs off the turn path; its result
      // joins `ready` and drains into observations on a later hook.
      const run = Promise.resolve(cfg.observer(newBuffer)).then(
        (distilled) => {
          deferred.ready.push(distilled);
          return distilled;
        },
        () => {
          // A failed distillation drops its batch — same information loss as
          // the old path's diagnostic-and-continue, without stalling a turn.
          return [];
        },
      );
      deferred.pending.push(run);
      void run.finally(() => {
        const i = deferred.pending.indexOf(run);
        if (i !== -1) {
          deferred.pending.splice(i, 1);
        }
      });
      return {
        ...withReady,
        buffer: [],
        bufferTokens: 0,
      };
    }
    return {
      observations: [
        ...withReady.observations,
        `Processed ${newBuffer.length} items`,
      ].slice(-cfg.maxObs),
      buffer: [],
      bufferTokens: 0,
      version: withReady.version + 1,
    };
  }
  return {
    ...withReady,
    buffer: newBuffer,
    bufferTokens: totalBufferTokens,
  };
}

/** Render observations as a tagged bullet list. */
function renderObservations(observations: ReadonlyArray<string>): string {
  const bullets = observations.map((o) => `- ${o}`).join('\n');
  return `<observations>\n${bullets}\n</observations>`;
}

/**
 * Render the most recent observations that fit within `budget` tokens (rendered
 * output included). Drops oldest observations first; returns null if not even
 * the single newest observation fits.
 */
function renderObservationsWithinBudget(
  observations: ReadonlyArray<string>,
  budget: number,
): string | null {
  for (let start = 0; start < observations.length; start++) {
    const text = renderObservations(observations.slice(start));
    if (estimateTokens(text) <= budget) {
      return text;
    }
  }
  return null;
}

export interface ObservationalContextConfig {
  bufferThreshold?: number;
  maxObservations?: number;
  scope?: 'thread' | 'resource';
  observer?: ObserverFn;
}

/**
 * Creates a context layer that buffers raw items and distills them into observations when a token threshold is reached.
 *
 * @public
 * @param config - Optional configuration for buffer threshold, max observations, scope, and observer function.
 * @returns A `ContextLayer` that accumulates and summarizes observations over time.
 */
export function observationalContext(config?: ObservationalContextConfig) {
  const maxObs = config?.maxObservations ?? DEFAULT_MAX_OBSERVATIONS;
  const threshold = config?.bufferThreshold ?? DEFAULT_BUFFER_THRESHOLD_TOKENS;
  const observer = config?.observer;
  const scope = config?.scope ?? 'resource';
  // One bucket per scope key: this layer instance is shared across every
  // thread/resource on a harness, but its state is stored per scope.
  const deferredByScope = new Map<string, DeferredDistill>();
  const deferredFor = (ctx: ExecutionContext): DeferredDistill => {
    const key = resolveScopeKey(scope, ctx);
    let bucket = deferredByScope.get(key);
    if (!bucket) {
      bucket = {
        pending: [],
        ready: [],
      };
      deferredByScope.set(key, bucket);
    }
    return bucket;
  };

  return {
    id: 'observational-context' as const,
    name: 'Observational Context',
    slot: Slot.OBSERVATIONS,
    scope,
    budget: {
      min: 500,
      max: 2_500,
    },
    // No LLM in the hook path any more — distillation is deferred, so the
    // default hook timeouts are ample.
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<ObservationalState>('state');
        return {
          state: saved ?? emptyObservationalState(),
        };
      },

      async recall({ state, budget }) {
        if (!state?.observations?.length) {
          return null;
        }
        // Trim to the most recent observations that fit within the token budget.
        const text = renderObservationsWithinBudget(state.observations, budget);
        if (text === null) {
          return null;
        }
        return {
          items: [
            createMessage(text, 'developer'),
          ],
          tokenCount: estimateTokens(text),
        };
      },

      // Captures assistant output text. Also the drain point for background
      // distillations: `store` runs every turn and its returned state is always
      // persisted, so a completed batch lands without `recall` mutating state
      // (which would force this layer out of the anchor band for that turn).
      async store({ newItems, state, ctx }) {
        const s = state ?? emptyObservationalState();
        const texts = collectOutputText(newItems);
        return {
          state: accumulate(s, texts, {
            threshold,
            maxObs,
            observer,
            deferred: deferredFor(ctx),
          }),
        };
      },

      // Captures user input and tool output text (pass-through; no transform).
      async onItemAppend({ items, state, ctx }) {
        const s = state ?? emptyObservationalState();
        const texts = collectInputText(items);
        const deferred = deferredFor(ctx);
        if (texts.length === 0) {
          // Still fold in anything that finished, so a quiet append is not a
          // missed drain opportunity.
          const drained = drainReady(s, deferred, maxObs);
          return drained === s
            ? {
                items,
              }
            : {
                items,
                state: drained,
              };
        }
        return {
          items,
          state: accumulate(s, texts, {
            threshold,
            maxObs,
            observer,
            deferred,
          }),
        };
      },

      async onSpawn({ parentState }) {
        return {
          childState: structuredClone(parentState),
        };
      },
    },
  } satisfies ContextLayer<ObservationalState>;
}
