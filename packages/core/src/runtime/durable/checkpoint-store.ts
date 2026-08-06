import type { StorageAdapter } from '@noetic-tools/context';
import { storageGetMany } from '@noetic-tools/context';
import { NoeticConfigError } from '@noetic-tools/types';
import type { CheckpointSnapshot } from '../../types/checkpoint';
import { CheckpointSnapshotSchema } from '../../types/checkpoint';

//#region Keys

/**
 * Typed key constants for the checkpoint namespace. Every execution snapshot
 * lives under a single key so `save`/`load` are cheap single `get`/`set`
 * calls, while a `list` prefix enumeration exposes every known execution id
 * to the restart/reattach path. Auxiliary suffixes exist so future sharded
 * storage schemes can still co-locate snapshot fragments under a shared
 * execution prefix without bumping schemaVersion.
 *
 * @internal
 */
const EXEC_KEY_PREFIX = 'execution:';
const SNAPSHOT_SUFFIX = ':snapshot';
const FRONTIER_SUFFIX = ':frontier';
const LAYERS_SUFFIX = ':layers:';
const CWD_SUFFIX = ':cwd';
const ASK_USER_SUFFIX = ':askUser';
const ITEM_LOG_SUFFIX = ':itemLog';

export const CheckpointKeys = {
  ExecPrefix: EXEC_KEY_PREFIX,
  SnapshotSuffix: SNAPSHOT_SUFFIX,
  FrontierSuffix: FRONTIER_SUFFIX,
  LayersSuffix: LAYERS_SUFFIX,
  CwdSuffix: CWD_SUFFIX,
  AskUserSuffix: ASK_USER_SUFFIX,
  ItemLogSuffix: ITEM_LOG_SUFFIX,
} as const;

//#endregion

//#region Types

/**
 * @public
 * Typed wrapper around a `StorageAdapter` that owns the key layout for
 * checkpoint snapshots and validates every read with the canonical Zod
 * schema.
 *
 * Corruption or schema-version drift is surfaced as `NoeticConfigError`
 * (`code === 'CHECKPOINT_SCHEMA_MISMATCH'`) so callers can discard the
 * offending snapshot without crashing the host.
 */
export interface CheckpointStore {
  /** Persist a snapshot. Later calls for the same `executionId` overwrite. */
  save(snapshot: CheckpointSnapshot): Promise<void>;
  /** Load the snapshot for an execution, or `null` if none is recorded. */
  load(executionId: string): Promise<CheckpointSnapshot | null>;
  /**
   * Append an item-log batch starting at item index `offset`. Batches are the
   * O(delta) alternative to inlining the whole log in every snapshot; the
   * batch key embeds `offset` so a retried write is idempotent.
   *
   * `ownerKey` is an opaque owner identity, NOT an execution id — the session
   * owns the log across every turn in a thread, so callers pass
   * `thread:<threadId>` (falling back to `execution:<id>` for threadless
   * one-shot contexts). Implementations must not derive execution-scoped
   * behaviour from it.
   */
  appendItems?(ownerKey: string, offset: number, items: unknown[]): Promise<void>;
  /** Load and stitch persisted item batches, returning the first `count` items in order. */
  loadItems?(ownerKey: string, count: number): Promise<unknown[]>;
  /** List every `executionId` that has a persisted snapshot. */
  list(): Promise<
    ReadonlyArray<{
      executionId: string;
    }>
  >;
  /** Remove the snapshot for `executionId`. No-op when the key is absent. */
  clear(executionId: string): Promise<void>;
}

/** @public Options for `createCheckpointStore`. */
export interface CreateCheckpointStoreOptions {
  storage: StorageAdapter;
}

//#endregion

//#region Helpers

function snapshotKey(executionId: string): string {
  return `${EXEC_KEY_PREFIX}${executionId}${SNAPSHOT_SUFFIX}`;
}

/**
 * Prefix owning every item-log batch for one log owner. Physically
 * `execution:<ownerKey>:itemLog:` — the `execution:` namespace is shared so a
 * `list()` sweep still finds a log's fragments beside its snapshot, but the
 * owner key itself is thread-scoped in practice (`thread:<threadId>`).
 */
function itemBatchPrefix(ownerKey: string): string {
  return `${EXEC_KEY_PREFIX}${ownerKey}${ITEM_LOG_SUFFIX}:`;
}

/** Zero-padded so lexicographic key order matches item order under `list()`. */
function itemBatchKey(ownerKey: string, offset: number): string {
  return `${itemBatchPrefix(ownerKey)}${String(offset).padStart(8, '0')}`;
}

function executionIdFromSnapshotKey(key: string): string | null {
  if (!key.startsWith(EXEC_KEY_PREFIX) || !key.endsWith(SNAPSHOT_SUFFIX)) {
    return null;
  }
  const start = EXEC_KEY_PREFIX.length;
  const end = key.length - SNAPSHOT_SUFFIX.length;
  if (end <= start) {
    return null;
  }
  return key.slice(start, end);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseSnapshot(raw: unknown, executionId: string): CheckpointSnapshot {
  const parsed = CheckpointSnapshotSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  const observedVersion =
    isJsonRecord(raw) && 'schemaVersion' in raw ? raw.schemaVersion : 'unknown';
  throw new NoeticConfigError({
    code: 'CHECKPOINT_SCHEMA_MISMATCH',
    message: `Checkpoint snapshot for execution "${executionId}" failed schema validation (observed schemaVersion=${String(
      observedVersion,
    )}).`,
    hint: 'The snapshot was produced by a different runtime version. Clear the snapshot via CheckpointStore.clear() and restart the execution.',
  });
}

//#endregion

//#region Factory

export function createCheckpointStore(options: CreateCheckpointStoreOptions): CheckpointStore {
  const { storage } = options;

  async function save(snapshot: CheckpointSnapshot): Promise<void> {
    // Persisted shape is the validated snapshot. The adapter is free to
    // JSON-encode it internally; `InMemoryStorage` stores by reference which
    // is fine because `CheckpointSnapshotSchema.parse` is deep-immutable.
    await storage.set(snapshotKey(snapshot.executionId), snapshot);
  }

  async function load(executionId: string): Promise<CheckpointSnapshot | null> {
    const raw = await storage.get<unknown>(snapshotKey(executionId));
    if (raw === null) {
      return null;
    }
    return parseSnapshot(raw, executionId);
  }

  async function list(): Promise<
    ReadonlyArray<{
      executionId: string;
    }>
  > {
    const keys = await storage.list(EXEC_KEY_PREFIX);
    const out: Array<{
      executionId: string;
    }> = [];
    for (const key of keys) {
      const id = executionIdFromSnapshotKey(key);
      if (id !== null) {
        out.push({
          executionId: id,
        });
      }
    }
    return out;
  }

  async function appendItems(ownerKey: string, offset: number, items: unknown[]): Promise<void> {
    await storage.set(itemBatchKey(ownerKey, offset), items);
  }

  async function loadItems(ownerKey: string, count: number): Promise<unknown[]> {
    const prefix = itemBatchPrefix(ownerKey);
    const keys = (await storage.list(prefix)).sort();
    /* One batch read, not a round trip per batch key — restore over a
     * network-backed adapter is where an N+1 hurts most. */
    const batches = await storageGetMany<unknown[]>(storage, keys);
    const out: unknown[] = [];
    for (const key of keys) {
      const batch = batches.get(key);
      if (batch) {
        out.push(...batch);
      }
      if (out.length >= count) {
        break;
      }
    }
    return out.slice(0, count);
  }

  /**
   * Drops the snapshot plus any item batches owned by this execution.
   *
   * KNOWN GAP: batches for a thread-scoped log live under owner key
   * `thread:<threadId>`, which no executionId matches, so those batches are
   * not garbage-collected here. A resumed session never stitches them back
   * (`restore` honours the snapshot's `persistedCount`, and the snapshot is
   * gone), so this is a storage leak rather than a correctness bug. Clearing
   * them needs the owner key, which only the harness holds.
   */
  async function clear(executionId: string): Promise<void> {
    await storage.delete(snapshotKey(executionId));
    for (const key of await storage.list(itemBatchPrefix(executionId))) {
      await storage.delete(key);
    }
  }

  return {
    save,
    load,
    appendItems,
    loadItems,
    list,
    clear,
  };
}

//#endregion
