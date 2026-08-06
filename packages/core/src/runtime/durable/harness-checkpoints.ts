import type { LayerStateStore } from '@noetic-tools/context';
import type { Context, Item, ItemSchemaRegistry, RestoreContextOptions } from '@noetic-tools/types';
import type { CheckpointSnapshot, FrontierFrame } from '../../types/checkpoint';
import { CheckpointSchemaVersion } from '../../types/checkpoint';
import { ContextImpl } from '../context-impl';
import type { EventBroadcaster } from '../event-broadcaster';
import type { CheckpointStore } from './checkpoint-store';
import type { StepLedgerRetention, StepLedgerStore } from './step-ledger';
import { StepLedger } from './step-ledger';

//#region Handle interface

/**
 * Host wiring forwarded into the context `restoreFromCheckpoint` builds.
 * `RestoreContextOptions` covers the portable fields; core widens it with the
 * internal `_broadcaster` seam so a resumed turn keeps streaming framework UI
 * events.
 *
 * @internal
 */
export type RestoreCheckpointOptions = RestoreContextOptions & {
  /** @internal Event broadcaster the host attached to the original context. */
  _broadcaster?: EventBroadcaster;
};

/**
 * Minimum harness surface `captureCheckpoint` / `restoreFromCheckpoint`
 * require. `AgentHarness` already satisfies this shape via its
 * `@internal` readonly fields — defining it structurally keeps the free
 * functions loosely coupled to the harness implementation.
 *
 * @internal
 */
export interface CheckpointHarnessHandle {
  readonly checkpointStore?: CheckpointStore;
  /** Per-harness item-log watermarks (see {@link ItemLogPersistence}). */
  readonly itemLogPersistence: ItemLogPersistence;
  readonly stepLedgerStore?: StepLedgerStore;
  readonly stepLedgerRetention?: StepLedgerRetention;
  readonly layerStateStore: LayerStateStore;
  readonly itemSchemas: ItemSchemaRegistry;
  createContext(
    opts?: RestoreCheckpointOptions & {
      items?: Item[];
      threadId?: string;
      resourceId?: string;
      cwdInit?: string;
    },
  ): Context;
}

//#endregion

//#region captureCheckpoint

/**
 * Per-owner watermarks of how many items have already been persisted as
 * append-only batches. Item-log persistence is O(delta) per checkpoint rather
 * than O(full log): each checkpoint writes only the items appended since the
 * previous one under `execution:<ownerKey>:itemLog:<offset>`. `restore`
 * stitches the batches back together in order. In-memory state — after a host
 * restart the map is empty and the first checkpoint of a resumed execution
 * writes one catch-up batch (the offset in the key makes that idempotent).
 *
 * One instance PER HARNESS, never module-global: two harnesses with different
 * checkpoint stores but a colliding threadId ('main' is a natural choice)
 * would otherwise share a watermark, and whichever store is behind the shared
 * count would silently under-persist forever.
 *
 * `rollback` is the failed-turn seam: the session runner truncates the shared
 * session log back to the turn watermark, and any batch persisted mid-turn now
 * describes items the live log no longer has. The watermark must come back
 * with it — and the stale over-watermark batches must be DELETED, not merely
 * hidden — or every subsequent checkpoint would diff against a durable log that
 * is ahead of the live one (writing nothing while restore resurrects the
 * rolled-back items).
 *
 * @internal
 */
export class ItemLogPersistence {
  private readonly counts = new Map<string, number>();
  /**
   * Owners whose durable batches are known to hold rolled-back items, and the
   * lowest offset from which they do. Recorded by `rollback` and consumed by
   * the owner's NEXT `captureCheckpoint`, which deletes the batches before
   * appending. Deferred rather than done inside `rollback` because `rollback`
   * is a synchronous seam on the abort path (the session runner calls it from
   * `rollbackTurn`) and must not await storage there; the batches are
   * unreachable in the meantime anyway, since the clamped watermark bounds
   * every `persistedCount` written between the rollback and the cleanup.
   */
  private readonly dirtyFrom = new Map<string, number>();

  get(ownerKey: string): number {
    return this.counts.get(ownerKey) ?? 0;
  }

  set(ownerKey: string, count: number): void {
    this.counts.set(ownerKey, count);
  }

  /**
   * A turn rolled the live log back to `length`. Clamp the watermark so the
   * next checkpoint re-persists from the truncation point, and mark the owner
   * dirty from `length` so that checkpoint also DELETES the batches the
   * truncation orphaned.
   *
   * Clamping alone is not enough. It only makes the stale batches unreachable
   * while this process's watermark stays clamped: `loadItems` reads whatever is
   * under the prefix, so as soon as the recovery turn's batch boundaries differ
   * from the aborted turn's — and they do, because checkpoints fire per
   * completed step and step boundaries move with the work — a stale batch
   * survives at an offset no recovery batch covers and gets stitched back in.
   */
  rollback(ownerKey: string, length: number): void {
    const current = this.counts.get(ownerKey);
    if (current === undefined || current <= length) {
      return;
    }
    this.counts.set(ownerKey, length);
    const existing = this.dirtyFrom.get(ownerKey);
    // Lowest wins: two rollbacks before the next checkpoint must clean from the
    // earlier point, or the window between them stays orphaned.
    this.dirtyFrom.set(ownerKey, existing === undefined ? length : Math.min(existing, length));
  }

  /**
   * Offset from which this owner's durable batches are stale, or `undefined`
   * when nothing was rolled back since the last cleanup.
   */
  dirtyOffset(ownerKey: string): number | undefined {
    return this.dirtyFrom.get(ownerKey);
  }

  /** The pending cleanup for `ownerKey` has been carried out. */
  clearDirty(ownerKey: string): void {
    this.dirtyFrom.delete(ownerKey);
  }

  /** Drop an owner's watermark (session teardown). */
  delete(ownerKey: string): void {
    this.counts.delete(ownerKey);
    this.dirtyFrom.delete(ownerKey);
  }
}

/**
 * Item batches are keyed by THREAD, not execution: the session owns the log
 * (one shared ItemLog across every turn in a thread), so its durable form is
 * thread-scoped too. A per-execution key would reset the delta watermark on
 * every turn (each turn creates a fresh executionId) and re-write the whole
 * transcript — O(n²) again, just spread across keys.
 *
 * Takes the two identity fields structurally rather than a whole `Context`, so
 * a caller holding only a threadId (the session) or only a persisted snapshot
 * (restore) can build the same key. `threadId` is optional here because a
 * snapshot's is: threadless one-shot executions fall back to `execution:<id>`.
 *
 * @internal
 */
export function itemLogOwnerKey(owner: { threadId?: string; id: string }): string {
  return owner.threadId ? `thread:${owner.threadId}` : `execution:${owner.id}`;
}

/**
 * Carry out the deferred cleanup a `rollback` recorded: delete every durable
 * batch for `ownerKey` at or past the rolled-back watermark, so this
 * checkpoint's catch-up batch is the ONLY thing describing items from that
 * offset on. One `list` per rollback, never per checkpoint — the dirty flag is
 * only set by `rollback` and is cleared here.
 *
 * A failure leaves the flag set so the next checkpoint retries, and keeps the
 * clamped watermark: `persistedCount` still bounds `loadItems` to the clean
 * prefix, so the worst case is the pre-fix behaviour rather than a lost turn.
 */
async function discardRolledBackBatches(
  h: CheckpointHarnessHandle,
  store: CheckpointStore,
  ownerKey: string,
): Promise<void> {
  const dirtyFrom = h.itemLogPersistence.dirtyOffset(ownerKey);
  if (dirtyFrom === undefined) {
    return;
  }
  if (!store.truncateItems) {
    // A third-party store predating `truncateItems` cannot be cleaned. Drop the
    // flag rather than listing on every future checkpoint for an owner whose
    // store will never honour it.
    h.itemLogPersistence.clearDirty(ownerKey);
    return;
  }
  try {
    await store.truncateItems(ownerKey, dirtyFrom);
    h.itemLogPersistence.clearDirty(ownerKey);
  } catch (err) {
    console.warn(
      `AgentHarness.checkpoint: failed to discard rolled-back item batches for "${ownerKey}":`,
      err,
    );
  }
}

/**
 * Snapshot the execution state at a checkpoint boundary. No-op when no
 * `CheckpointStore` is configured — zero-config harnesses preserve
 * ephemeral semantics. Save failures are logged rather than thrown,
 * because a checkpoint failing must never abort an otherwise-successful
 * step.
 *
 * @internal
 */
export async function captureCheckpoint(h: CheckpointHarnessHandle, ctx: Context): Promise<void> {
  const store = h.checkpointStore;
  if (!store) {
    return;
  }
  /* The frontier is written for observability only (a host inspecting a crashed
   * execution can see what was in flight); restore never reads it — resume
   * re-enters from the root with the ledger replaying completed steps. Frame
   * `input`/`state` can embed arbitrarily large step inputs, so cap what one
   * checkpoint will carry rather than serialize a fork's whole payload on
   * every completed step. */
  const impl = ctx instanceof ContextImpl ? ctx : null;
  const frontier: FrontierFrame[] = impl
    ? impl.serialiseFrontier().map((frame) => ({
        stepId: frame.stepId,
        input: undefined,
      }))
    : [];
  const layers: Record<string, unknown> = {};
  for (const layer of ctx.layers ?? []) {
    const state = h.layerStateStore.get<unknown>(ctx.id, layer.id);
    if (state !== undefined) {
      layers[layer.id] = state;
    }
  }
  // Persist the item-log DELTA as an append-only batch. The snapshot itself
  // carries only the count (`itemLog.persistedCount`) — never the items — so
  // snapshot size and write cost stay O(layers + frontier) instead of O(n)
  // as the transcript grows (previously O(n²) over a session).
  const allItems = ctx.itemLog.items;
  const ownerKey = itemLogOwnerKey(ctx);
  await discardRolledBackBatches(h, store, ownerKey);
  const already = h.itemLogPersistence.get(ownerKey);
  if (allItems.length > already && store.appendItems) {
    const batch = allItems.slice(already);
    try {
      await store.appendItems(ownerKey, already, [
        ...batch,
      ]);
      h.itemLogPersistence.set(ownerKey, allItems.length);
    } catch (err) {
      console.warn(`AgentHarness.checkpoint: failed to persist item batch for "${ownerKey}":`, err);
      // Fall through: the snapshot still records the last durable count.
    }
  }
  const snapshot: CheckpointSnapshot = {
    schemaVersion: CheckpointSchemaVersion,
    executionId: ctx.id,
    threadId: ctx.threadId,
    resourceId: ctx.resourceId,
    frontier,
    layers,
    cwd: {
      current: ctx.cwdState.cwd,
      previous: ctx.cwdState.previousCwd,
    },
    // Ask-user queue snapshot is empty at the core layer — the code-agent
    // host is responsible for pushing pending prompts through this store
    // via `AskUserService` integration. Carrying the shape from day one
    // means future producers don't bump the schema version.
    askUser: [],
    itemLog: store.appendItems
      ? {
          items: [],
          persistedCount: h.itemLogPersistence.get(ownerKey),
        }
      : {
          // Legacy stores without appendItems keep the inline (O(n)) shape.
          items: [
            ...allItems,
          ],
        },
    capturedAt: new Date().toISOString(),
  };
  try {
    await store.save(snapshot);
  } catch (err) {
    console.warn(
      `AgentHarness.checkpoint: failed to persist snapshot for execution "${ctx.id}":`,
      err,
    );
  }
}

//#endregion

//#region restoreFromCheckpoint

/**
 * Rebuild a `Context` from a previously-persisted snapshot. Returns
 * `null` if no snapshot is recorded for `executionId`. Layer state is
 * replayed into `layerStateStore` keyed by the original executionId so
 * the restored context observes the pre-crash state through
 * `readLayerState` and the context projectors.
 *
 * `opts` carries the host's own context wiring (broadcaster, parent, state,
 * layer overrides) into the rebuilt context. A snapshot cannot round-trip live
 * objects, so a host that decorated the original context has to hand the same
 * decoration back here — otherwise the resumed run gets a bare context and
 * whatever depended on that wiring stops working silently. Snapshot-owned
 * fields always win: identity, item log, and cwd come from the persisted
 * record, never from `opts`.
 *
 * Preserves the original executionId on the returned context via
 * `Object.defineProperty` — adapter correlation across crash/restart
 * requires a stable id.
 *
 * @internal
 */
export async function restoreFromCheckpoint(
  h: CheckpointHarnessHandle,
  executionId: string,
  opts?: RestoreCheckpointOptions,
): Promise<Context | null> {
  const store = h.checkpointStore;
  if (!store) {
    return null;
  }
  const snapshot = await store.load(executionId);
  if (!snapshot) {
    return null;
  }
  for (const [layerId, state] of Object.entries(snapshot.layers)) {
    h.layerStateStore.set(executionId, layerId, state);
  }
  let rawItems: unknown[] = snapshot.itemLog.items;
  const persistedCount = snapshot.itemLog.persistedCount ?? 0;
  if (persistedCount > 0 && store.loadItems) {
    /* Derived from the SNAPSHOT's threadId, not the executionId argument: capture
     * wrote the batches under the log's owner key, so restore has to read the
     * same one or it finds nothing and the resumed session comes back empty. */
    const ownerKey = itemLogOwnerKey({
      threadId: snapshot.threadId,
      id: executionId,
    });
    rawItems = await store.loadItems(ownerKey, persistedCount);
    /* Seed the delta watermark so the next checkpoint appends from the right
     * offset instead of re-writing history. Clamped to what was actually
     * recovered: on a short/torn read the watermark must track the real durable
     * prefix, so the next checkpoint re-persists the gap. */
    h.itemLogPersistence.set(ownerKey, Math.min(persistedCount, rawItems.length));
  }
  const items: Item[] = h.itemSchemas.parseMany(rawItems);
  const cwdInit = snapshot.cwd?.current ?? undefined;
  /* Caller wiring first, snapshot second: a host may legitimately swap the context
   * layers or hang the restored execution under a new parent, but it must never be
   * able to override the identity/history the snapshot is the record of. */
  const ctx = h.createContext({
    ...opts,
    items,
    threadId: snapshot.threadId,
    resourceId: snapshot.resourceId,
    cwdInit,
  });
  if (ctx instanceof ContextImpl) {
    Object.defineProperty(ctx, 'id', {
      value: executionId,
      configurable: false,
      writable: false,
      enumerable: true,
    });
    /* Attach the recovered completion ledger. `createContext` already built a fresh
     * one keyed to a throwaway id; the restored context needs the entries recorded
     * under THIS execution, or `execute()` would replay nothing and re-run the whole
     * tree. Assigned the same way `id` is, to keep `createContext`'s public options
     * free of resume-only fields. */
    if (h.stepLedgerStore) {
      const recovered = await h.stepLedgerStore.load(executionId);
      Object.defineProperty(ctx, 'ledger', {
        value: new StepLedger({
          executionId,
          store: h.stepLedgerStore,
          recovered,
          retention: h.stepLedgerRetention,
        }),
        configurable: false,
        writable: false,
        enumerable: true,
      });
    }
  }
  return ctx;
}

//#endregion

//#region clearCheckpoint

/**
 * Discard every recovery record for one execution: the snapshot and the completion
 * ledger. Clearing the snapshot alone would strand the ledger's shards under
 * `execution:<id>:ledger:*` forever, since nothing else enumerates them.
 *
 * This is the operation a host performs when resume is no longer valid — most often
 * because the workflow changed. Replay happens at the coarsest completed granularity,
 * so a step edited *beneath* a recorded parent is invisible to divergence detection and
 * the old output would be replayed over the new tree. Clear, then start fresh.
 *
 * @internal
 */
export async function clearCheckpoint(
  h: CheckpointHarnessHandle,
  executionId: string,
): Promise<void> {
  await h.checkpointStore?.clear(executionId);
  await h.stepLedgerStore?.clear(executionId);
}

//#endregion
