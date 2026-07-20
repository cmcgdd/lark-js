/**
 * DataSnapshot - an immutable snapshot of data at a location.
 * Received in event callbacks and from once() operations.
 *
 * Priority Handling:
 * - Priority is stored as a regular child value `.priority` in the data
 * - val() strips `.priority` from returned objects (so app code doesn't see it)
 * - getPriority() reads from the data's `.priority` field
 *
 * Wrapped Primitives:
 * - Primitives with priority are stored as `{ '.value': x, '.priority': y }`
 * - val() automatically unwraps these to return just the primitive value
 */

import type { DatabaseReference } from './DatabaseReference';
import type { LarkDatabase } from './LarkDatabase';
import type { QueryParams } from './protocol/messages';
import { coerceArrays } from './utils/coerce';
import { getKey, getValueAtPath, joinPath, normalizePath } from './utils/path';
import { getSortedKeys } from './utils/sort';

/**
 * Check if data is a wrapped primitive.
 * Wrapped primitives are objects with:
 * - { '.value': x, '.priority': y } - full form
 * - { '.value': x } - when server strips null priority
 * This is the wire format for primitives with priority.
 */
function isWrappedPrimitive(data: unknown): data is { '.value': unknown; '.priority'?: unknown } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  const keys = Object.keys(data);
  // Full form: exactly '.value' and '.priority'
  if (keys.length === 2 && '.value' in data && '.priority' in data) {
    return true;
  }
  // Stripped form: only '.value' (server strips null priority)
  if (keys.length === 1 && '.value' in data) {
    return true;
  }
  return false;
}

/**
 * Recursively strip priority metadata from data.
 * - Unwraps wrapped primitives: { '.value': x, '.priority': y } → x
 * - Strips '.priority' from objects
 * - Recursively processes all children
 */
function stripPriorityMetadata(data: unknown): unknown {
  // Return null for non-existent data, never undefined
  if (data === null || data === undefined) {
    return null;
  }

  // Non-objects pass through (primitives)
  if (typeof data !== 'object') {
    return data;
  }

  // Arrays: recursively process elements
  if (Array.isArray(data)) {
    return data.map(stripPriorityMetadata);
  }

  // Check for wrapped primitive: { '.value': x, '.priority': y }
  if (isWrappedPrimitive(data)) {
    // Recursively process the value in case it's nested
    return stripPriorityMetadata(data['.value']);
  }

  // Regular object: strip .priority and null values, recursively process children
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === '.priority') {
      continue; // Skip priority metadata
    }
    const stripped = stripPriorityMetadata(value);
    // Omit null values from objects (null = deleted/non-existent)
    if (stripped !== null) {
      result[key] = stripped;
    }
  }

  // If object is now empty (only had .priority or null values), return null
  return Object.keys(result).length > 0 ? result : null;
}

export class DataSnapshot {
  private readonly _data: unknown;
  private readonly _path: string;
  private readonly _db: LarkDatabase;
  private readonly _volatile: boolean;
  private readonly _serverTimestamp: number | null;
  private readonly _queryParams: QueryParams | null;
  private readonly _orderedKeys: string[] | null;

  constructor(
    data: unknown,
    path: string,
    db: LarkDatabase,
    options: {
      volatile?: boolean;
      serverTimestamp?: number | null;
      queryParams?: QueryParams | null;
      orderedKeys?: string[] | null;
    } = {}
  ) {
    this._data = data;
    this._path = normalizePath(path);
    this._db = db;
    this._volatile = options.volatile ?? false;
    this._serverTimestamp = options.serverTimestamp ?? null;
    this._queryParams = options.queryParams ?? null;
    this._orderedKeys = options.orderedKeys ?? null;
  }

  /**
   * Get a DatabaseReference for the location of this snapshot.
   */
  get ref(): DatabaseReference {
    return this._db.ref(this._path);
  }

  /**
   * Get the last segment of the path (the "key"), or null for root.
   */
  get key(): string | null {
    return getKey(this._path);
  }

  /**
   * Get the data value, with metadata stripped.
   *
   * - Strips `.priority` from objects (it's metadata, not user data)
   * - Unwraps `{ '.value': x, '.priority': y }` to just `x` (wrapped primitives)
   *
   * @typeParam T - Optional type for the returned value. Defaults to `any`.
   * @example
   * ```typescript
   * // Untyped (returns any)
   * const data = snapshot.val();
   *
   * // Typed (returns User)
   * const user = snapshot.val<User>();
   * ```
   */
  val<T = any>(): T {
    // Strip priority metadata, then render integer-keyed maps as arrays.
    return coerceArrays(stripPriorityMetadata(this._data)) as T;
  }

  /**
   * Check if data exists at this location (is not null/undefined).
   * Returns false for priority-only nodes (only .priority, no actual value).
   */
  exists(): boolean {
    if (this._data === null || this._data === undefined) {
      return false;
    }

    // Check for priority-only object (no actual data, just metadata)
    if (typeof this._data === 'object' && !Array.isArray(this._data)) {
      const keys = Object.keys(this._data);
      if (keys.length === 1 && keys[0] === '.priority') {
        return false;
      }
    }

    return true;
  }

  /**
   * Get a child snapshot at the specified path.
   *
   * Special handling:
   * - `.priority` returns the priority value
   * - For wrapped primitives, only `.priority` returns data; other paths return null
   * - Non-existent paths return a snapshot with val() === null
   */
  child(path: string): DataSnapshot {
    const childPath = joinPath(this._path, path);

    // Special case: .priority returns the priority value
    if (path === '.priority') {
      const priority = this.getPriority();
      return new DataSnapshot(priority, childPath, this._db, {
        volatile: this._volatile,
        serverTimestamp: this._serverTimestamp,
      });
    }

    // For wrapped primitives, no children exist (except .priority handled above)
    if (isWrappedPrimitive(this._data)) {
      return new DataSnapshot(null, childPath, this._db, {
        volatile: this._volatile,
        serverTimestamp: this._serverTimestamp,
      });
    }

    const childData = getValueAtPath(this._data, path);
    // Convert undefined to null
    return new DataSnapshot(childData ?? null, childPath, this._db, {
      volatile: this._volatile,
      serverTimestamp: this._serverTimestamp,
    });
  }

  /**
   * Check if this snapshot has any children.
   * Excludes `.priority` metadata from consideration.
   * Wrapped primitives have no children.
   */
  hasChildren(): boolean {
    if (typeof this._data !== 'object' || this._data === null) {
      return false;
    }
    // Wrapped primitives have no children
    if (isWrappedPrimitive(this._data)) {
      return false;
    }
    // Count keys excluding .priority
    const keys = Object.keys(this._data).filter(k => k !== '.priority');
    return keys.length > 0;
  }

  /**
   * Check if this snapshot has a specific child.
   * `.priority` is always accessible if it exists.
   * Wrapped primitives have no children except `.priority`.
   */
  hasChild(path: string): boolean {
    // .priority is accessible if it exists
    if (path === '.priority') {
      return this.getPriority() !== null;
    }
    // Wrapped primitives have no other children
    if (isWrappedPrimitive(this._data)) {
      return false;
    }
    const childData = getValueAtPath(this._data, path);
    return childData !== undefined && childData !== null;
  }

  /**
   * Get the number of children.
   * Excludes `.priority` metadata from count.
   * Wrapped primitives have 0 children.
   */
  numChildren(): number {
    if (typeof this._data !== 'object' || this._data === null) {
      return 0;
    }
    // Wrapped primitives have no children
    if (isWrappedPrimitive(this._data)) {
      return 0;
    }
    // Count keys excluding .priority
    return Object.keys(this._data).filter(k => k !== '.priority').length;
  }

  /**
   * Iterate over children in the correct order.
   * Uses pre-computed orderedKeys if available (from subscription View),
   * otherwise computes sorted keys based on query params.
   * Excludes `.priority` metadata from iteration.
   * Wrapped primitives have no children to iterate.
   */
  forEach(callback: (child: DataSnapshot) => boolean | void): void {
    if (typeof this._data !== 'object' || this._data === null) {
      return;
    }

    // Wrapped primitives have no children
    if (isWrappedPrimitive(this._data)) {
      return;
    }

    // Use pre-computed orderedKeys if available (from subscription View),
    // otherwise compute sorted keys based on query params
    const keys = this._orderedKeys ?? getSortedKeys(this._data, this._queryParams);
    for (const key of keys) {
      const childSnap = this.child(key);
      if (callback(childSnap) === true) {
        break;
      }
    }
  }

  /**
   * Get the priority of the data at this location.
   * Priority is stored as `.priority` in the data object.
   */
  getPriority(): number | string | null {
    if (this._data && typeof this._data === 'object' && !Array.isArray(this._data)) {
      const priority = (this._data as Record<string, unknown>)['.priority'];
      if (typeof priority === 'number' || typeof priority === 'string') {
        return priority;
      }
    }
    return null;
  }

  /**
   * Check if this snapshot was from a volatile (high-frequency) update.
   */
  isVolatile(): boolean {
    return this._volatile;
  }

  /**
   * Get the server timestamp for this snapshot (milliseconds since Unix epoch).
   * Only present on volatile value events. Use deltas between timestamps for
   * interpolation rather than absolute times to avoid clock sync issues.
   */
  getServerTimestamp(): number | null {
    return this._serverTimestamp;
  }

  /**
   * Export the snapshot data with priority metadata intact.
   * Unlike val(), this preserves `.value` and `.priority` wrappers.
   * Useful for serializing data while preserving priorities.
   *
   * @typeParam T - Optional type for the returned value. Defaults to `any`.
   */
  exportVal<T = any>(): T {
    return this._data as T;
  }

  /**
   * Export the snapshot data as JSON.
   * Same as exportVal() - preserves priority metadata.
   *
   * @typeParam T - Optional type for the returned value. Defaults to `any`.
   */
  toJSON<T = any>(): T {
    return this._data as T;
  }
}
