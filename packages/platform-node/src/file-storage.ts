import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StorageAdapter } from '@noetic-tools/core';

// Private replica of core's internal `frameworkCast` — kept local here
// so the unsafe escape hatch does not become part of `@noetic-tools/core`'s
// public API surface. This is NOT a "safer" pattern than exporting
// `frameworkCast`; it is the same identity coercion, just scoped to
// this file. `JSON.parse` returns `unknown` and the `StorageAdapter`
// contract hands the responsibility for `<T>` back to the caller —
// there is no schema at this boundary to validate against.
function typedCast<T>(value: unknown): T {
  // @ts-expect-error — identity coercion at the JSON.parse boundary
  return value;
}

/**
 * Narrow a caught value to a Node errno error. The async fs calls below
 * replaced pre-flight `existsSync` checks — checking existence and then
 * reading is a TOCTOU race once the read is awaited, so a missing file is
 * detected from `ENOENT` on the operation itself.
 */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

//#region Key <-> path mapping

/**
 * Map arbitrary storage keys to filesystem-safe path fragments. Colons,
 * slashes, and other special chars are encoded so keys containing
 * `execution:<uuid>:frontier` round-trip to a single filename and back
 * without collisions.
 *
 * Encoding is two-phase and unambiguous: first every literal underscore is
 * escaped (`_` → `_u`), then URI-encoding escapes the rest, then `%` becomes
 * `__`. The old single-phase scheme collapsed a key that legitimately
 * contained `__` into a `%` on decode — `decodeKey('a__b')` threw and the
 * key silently vanished from `list()` while `get()` still found it.
 *
 * @internal
 */
const ENCODED_SEP = '__';

function encodeKey(key: string): string {
  return encodeURIComponent(key.replaceAll('_', '_u')).replace(/%/g, ENCODED_SEP);
}

function decodeKey(encoded: string): string {
  return decodeURIComponent(encoded.replaceAll(ENCODED_SEP, '%')).replaceAll('_u', '_');
}

function keyToPath(root: string, key: string): string {
  return path.join(root, `${encodeKey(key)}.json`);
}

function pathToKey(file: string): string | null {
  if (!file.endsWith('.json')) {
    return null;
  }
  const base = file.slice(0, -'.json'.length);
  try {
    return decodeKey(base);
  } catch {
    return null;
  }
}

//#endregion

//#region Factory

/** @public Options for `createFileStorage`. */
export interface CreateFileStorageOptions {
  /**
   * Absolute path to the root directory under which storage entries are
   * written. The directory is created on first use (including any missing
   * parent components). Defaults to `~/.noetic/checkpoints` when omitted.
   */
  root?: string;
}

function defaultRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  return path.join(home, '.noetic', 'checkpoints');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, {
      recursive: true,
    });
  }
}

/**
 * @public
 * Create a file-backed `StorageAdapter` that writes each key to a JSON
 * file under the configured root directory. The default production-mode
 * backing for checkpoint storage.
 *
 * Writes are async (`node:fs/promises`) via a .tmp sibling + atomic
 * rename — core checkpoints after EVERY completed step, so a synchronous
 * write here would block the event loop (token streaming, socket pumps,
 * watchdog timers) once per step. The tmp+rename pattern keeps the
 * "half-written file found on restart" window to the rename itself.
 *
 * `list(prefix)` is served from an in-memory key index seeded by one
 * directory scan at construction and maintained on set/delete — the
 * durable outbound queue and the step ledger call `list` on hot paths,
 * and a per-call `readdir` over a flat root that also holds every ledger
 * shard and IPC frame made each call O(total keys).
 *
 * The index assumes this adapter instance is the only writer to `root`
 * for its lifetime (the same assumption the previous implementation made
 * implicitly for read-modify-write sequences). Two live adapters over one
 * root would see each other's writes via `get` but not via `list`.
 */
export function createFileStorage(options: CreateFileStorageOptions = {}): StorageAdapter {
  const root = options.root ?? defaultRoot();
  ensureDir(root);

  // Seed the key index from disk once; set/delete maintain it after that.
  const keyIndex = new Set<string>();
  for (const file of readdirSync(root)) {
    const key = pathToKey(file);
    if (key !== null) {
      keyIndex.add(key);
    }
  }

  async function readKey<T>(key: string): Promise<T | null> {
    const file = keyToPath(root, key);
    try {
      const raw = await readFile(file, 'utf8');
      if (raw.length === 0) {
        return null;
      }
      const parsed = JSON.parse(raw);
      return typedCast<T>(parsed);
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        return null;
      }
      console.warn(`createFileStorage: failed to read "${key}":`, err);
      return null;
    }
  }

  return {
    async get<T>(key: string): Promise<T | null> {
      return readKey<T>(key);
    },
    async set<T>(key: string, value: T): Promise<void> {
      ensureDir(root);
      const file = keyToPath(root, key);
      const tmp = `${file}.tmp`;
      // Write via a .tmp sibling then rename — reduces the "half-written
      // file found on restart" window to the rename itself. On crash mid-
      // write the main file either still holds the previous value, or the
      // rename completed. `rename` is the atomic step on POSIX filesystems.
      await writeFile(tmp, JSON.stringify(value));
      await rename(tmp, file);
      keyIndex.add(key);
    },
    async delete(key: string): Promise<void> {
      const file = keyToPath(root, key);
      keyIndex.delete(key);
      try {
        await unlink(file);
      } catch (err) {
        if (isErrnoException(err) && err.code === 'ENOENT') {
          return;
        }
        console.warn(`createFileStorage: failed to delete "${key}":`, err);
      }
    },
    async list(prefix: string): Promise<string[]> {
      const out: string[] = [];
      for (const key of keyIndex) {
        if (key.startsWith(prefix)) {
          out.push(key);
        }
      }
      // Callers (step ledger, durable queue) depend on lexicographic order
      // matching what a sorted directory listing produced.
      return out.sort();
    },
    async getMany<T>(keys: string[]): Promise<Map<string, T>> {
      // Parallel reads — local disk has no per-key round trip, but the
      // batch keeps callers on one code path and overlaps I/O waits. Each
      // read resolves to its own key so the pairing survives the reorder
      // a bare `Promise.all` over values would invite.
      const entries = await Promise.all(
        keys.map(async (key) => ({
          key,
          value: await readKey<T>(key),
        })),
      );
      const found = new Map<string, T>();
      for (const { key, value } of entries) {
        if (value === null) {
          continue;
        }
        found.set(key, value);
      }
      return found;
    },
  };
}

//#endregion
