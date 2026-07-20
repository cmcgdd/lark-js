/**
 * View - represents a client's subscription to a database path.
 *
 * Each View encapsulates all state for a single subscription:
 * - Path and query parameters
 * - Event callbacks by type
 * - Ordered children (keys in sorted order, sorted by client)
 * - Local cache of visible data
 *
 * This mirrors the server's View concept, enabling:
 * - Per-View caching (no shared global cache)
 * - Client-side sorting (ignores server's ak/mv hints)
 * - Local-first writes (future)
 * - Independent reconnection per View
 */

import type { DataSnapshot } from '../DataSnapshot';
import { EventType } from '../protocol/constants';
import { QueryParams } from '../protocol/messages';
import { getValueAtPath, joinPath, normalizePath, setValueAtPath } from '../utils/path';
import { getSortedKeys, compareKeys, getSortValue, compareEntries, compareValues, createSortEntries, SortEntry } from '../utils/sort';

export type SnapshotCallback = (snapshot: DataSnapshot, previousChildKey?: string | null) => void;

interface SubscriptionEntry {
  callback: SnapshotCallback;
  unsubscribe: () => void;
}

/**
 * Expand path-like keys in an update object into nested structure.
 * Multi-path updates treat keys with '/' as paths.
 * E.g., { 'child/increment': 42 } becomes { child: { increment: 42 } }
 */
function expandPathKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (key.includes('/')) {
      // Path-like key - expand into nested structure
      const segments = key.split('/').filter(s => s.length > 0);
      let current = result;
      for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i];
        if (!(segment in current) || typeof current[segment] !== 'object' || current[segment] === null) {
          current[segment] = {};
        }
        current = current[segment] as Record<string, unknown>;
      }
      current[segments[segments.length - 1]] = value;
    } else {
      // Regular key - just assign
      result[key] = value;
    }
  }

  return result;
}

/**
 * Deep merge two objects, with source overwriting target.
 * Handles nested path expansions correctly.
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (value === null) {
      // null = delete
      delete result[key];
    } else if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      // Both are objects - deep merge
      result[key] = deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      // Overwrite
      result[key] = value;
    }
  }

  return result;
}

/** A pending write operation that hasn't been ACKed yet */
export interface PendingWriteEntry {
  requestId: string;
  relativePath: string;  // Relative to this View's path ('/' for the view itself)
  value: unknown;
  operation: 'set' | 'update' | 'delete';
}

export class View {
  /** The absolute path this View is subscribed to */
  readonly path: string;

  /** Query parameters for this View (ordering, limits, ranges) */
  private _queryParams: QueryParams | null;

  /** Event callbacks organized by event type */
  private eventCallbacks = new Map<EventType, SubscriptionEntry[]>();

  /** Child keys in sorted order (computed from display cache) */
  private _orderedChildren: string[] = [];

  /** Server cache: what the server has told us (baseline) */
  private _serverCache: unknown = null;

  /** Whether we've received the initial snapshot from the server */
  private _hasReceivedInitialSnapshot = false;

  /** Pending write operations that haven't been ACKed yet (for local-first) */
  private _pendingWriteData: PendingWriteEntry[] = [];

  /** Cached display value (server + pending writes merged) - invalidated when either changes */
  private _displayCacheValid = false;
  private _displayCache: unknown = null;

  constructor(path: string, queryParams?: QueryParams) {
    this.path = normalizePath(path);
    this._queryParams = queryParams ?? null;
  }

  /** Get the current query parameters */
  get queryParams(): QueryParams | null {
    return this._queryParams;
  }

  /**
   * Update query parameters and re-sort cached data.
   * Returns true if queryParams actually changed.
   */
  updateQueryParams(newQueryParams?: QueryParams): boolean {
    const newParams = newQueryParams ?? null;

    // Check if params actually changed
    if (this.queryParamsEqual(this._queryParams, newParams)) {
      return false;
    }

    this._queryParams = newParams;

    // Invalidate display cache and re-sort
    this._displayCacheValid = false;
    this.recomputeOrderedChildren();

    return true;
  }

  /**
   * Compare two QueryParams objects for equality.
   */
  private queryParamsEqual(a: QueryParams | null, b: QueryParams | null): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;

    // Compare all relevant fields
    return (
      a.orderBy === b.orderBy &&
      a.orderByChild === b.orderByChild &&
      a.limitToFirst === b.limitToFirst &&
      a.limitToLast === b.limitToLast &&
      a.startAt === b.startAt &&
      a.startAtKey === b.startAtKey &&
      a.endAt === b.endAt &&
      a.endAtKey === b.endAtKey &&
      a.equalTo === b.equalTo &&
      a.equalToKey === b.equalToKey
    );
  }

  // ============================================
  // Subscription Management
  // ============================================

  /**
   * Add a callback for an event type.
   * Returns an unsubscribe function.
   */
  addCallback(eventType: EventType, callback: SnapshotCallback): () => void {
    if (!this.eventCallbacks.has(eventType)) {
      this.eventCallbacks.set(eventType, []);
    }

    const unsubscribe = () => {
      this.removeCallback(eventType, callback);
    };

    this.eventCallbacks.get(eventType)!.push({ callback, unsubscribe });
    return unsubscribe;
  }

  /**
   * Remove a specific callback for an event type.
   */
  removeCallback(eventType: EventType, callback: SnapshotCallback): void {
    const entries = this.eventCallbacks.get(eventType);
    if (!entries) return;

    const index = entries.findIndex((entry) => entry.callback === callback);
    if (index !== -1) {
      entries.splice(index, 1);
    }

    // Clean up empty arrays
    if (entries.length === 0) {
      this.eventCallbacks.delete(eventType);
    }
  }

  /**
   * Remove all callbacks for an event type.
   */
  removeAllCallbacks(eventType: EventType): void {
    this.eventCallbacks.delete(eventType);
  }

  /**
   * Get all subscribed event types.
   */
  getEventTypes(): EventType[] {
    return Array.from(this.eventCallbacks.keys());
  }

  /**
   * Get callbacks for a specific event type.
   */
  getCallbacks(eventType: EventType): SubscriptionEntry[] {
    return this.eventCallbacks.get(eventType) ?? [];
  }

  /**
   * Check if there are any callbacks registered.
   */
  hasCallbacks(): boolean {
    return this.eventCallbacks.size > 0;
  }

  /**
   * Check if there's a callback for a specific event type.
   */
  hasCallbacksForType(eventType: EventType): boolean {
    const entries = this.eventCallbacks.get(eventType);
    return entries !== undefined && entries.length > 0;
  }

  // ============================================
  // Cache Management (Dual Cache: Server + Pending Writes)
  // ============================================

  /**
   * Set the server cache (what the server told us).
   * This is the baseline before pending writes are applied.
   * Deep clones the value to ensure each View has its own copy.
   */
  setServerCache(value: unknown): void {
    // Deep clone to ensure this View has its own copy (important for multi-view)
    this._serverCache = this.deepClone(value);
    this._hasReceivedInitialSnapshot = true;
    this.invalidateDisplayCache();
  }

  /**
   * Get the server cache (baseline without pending writes).
   */
  getServerCache(): unknown {
    return this._serverCache;
  }

  /**
   * Get the display cache (server + pending writes merged).
   * This is what should be shown to the user.
   */
  getDisplayCache(): unknown {
    if (!this._displayCacheValid) {
      this._displayCache = this.computeMergedCache();
      this._displayCacheValid = true;
    }
    return this._displayCache;
  }

  /**
   * Alias for getDisplayCache() - this is what callbacks receive.
   */
  getCache(): unknown {
    return this.getDisplayCache();
  }

  /**
   * Invalidate the display cache (call when serverCache or pendingWrites change).
   */
  private invalidateDisplayCache(): void {
    this._displayCacheValid = false;
    this.recomputeOrderedChildren();
  }

  /**
   * Compute the merged cache (serverCache + pendingWrites), with query constraints applied.
   */
  private computeMergedCache(): unknown {
    let result: unknown;

    if (this._pendingWriteData.length === 0) {
      result = this._serverCache;
    } else {
      // Deep clone server cache to avoid mutations
      result = this.deepClone(this._serverCache);

      // Apply each pending write in order
      for (const write of this._pendingWriteData) {
        result = this.applyWrite(result, write);
      }
    }

    // Apply query constraints (range filtering and limits) to the merged result
    return this.applyQueryConstraints(result);
  }

  /**
   * Apply query constraints (range filtering and limits) to data.
   * This ensures the displayCache only contains data matching the query.
   */
  private applyQueryConstraints(data: unknown): unknown {
    // No constraints to apply if no query params or data isn't an object
    if (!this._queryParams) {
      return data;
    }

    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return data;
    }

    const obj = data as Record<string, unknown>;

    // Check if we have any filtering/limiting to do
    const hasRangeFilter =
      this._queryParams.startAt !== undefined ||
      this._queryParams.startAfter !== undefined ||
      this._queryParams.endAt !== undefined ||
      this._queryParams.endBefore !== undefined ||
      this._queryParams.equalTo !== undefined;
    const hasLimit =
      this._queryParams.limitToFirst !== undefined ||
      this._queryParams.limitToLast !== undefined;

    if (!hasRangeFilter && !hasLimit) {
      return data;
    }

    // Get sorted entries
    let entries = createSortEntries(obj, this._queryParams);

    // Apply range filters (startAt, endAt, startAfter, endBefore, equalTo)
    if (hasRangeFilter) {
      entries = this.filterByRange(entries);
    }

    // Apply limits (limitToFirst, limitToLast)
    if (hasLimit) {
      entries = this.applyLimits(entries);
    }

    // Convert back to object
    if (entries.length === 0) {
      return null;
    }

    const result: Record<string, unknown> = {};
    for (const entry of entries) {
      result[entry.key] = entry.value;
    }

    return result;
  }

  /**
   * Filter entries by range constraints (startAt, endAt, startAfter, endBefore, equalTo).
   */
  private filterByRange(entries: SortEntry[]): SortEntry[] {
    if (!this._queryParams) return entries;

    const {
      orderBy,
      startAt, startAtKey,
      startAfter, startAfterKey,
      endAt, endAtKey,
      endBefore, endBeforeKey,
      equalTo, equalToKey
    } = this._queryParams;

    // For orderByKey, the startAt/endAt values are compared against the key directly
    const isOrderByKey = orderBy === 'key';

    return entries.filter(entry => {
      // For orderByKey, compare against key; otherwise compare against sortValue
      const compareValue = isOrderByKey ? entry.key : entry.sortValue;
      const compareFn = isOrderByKey
        ? (a: unknown, b: unknown) => compareKeys(a as string, b as string)
        : compareValues;

      // equalTo filter - most restrictive, check first
      if (equalTo !== undefined) {
        const cmp = compareFn(compareValue, equalTo);
        if (cmp !== 0) return false;
        if (equalToKey !== undefined && !isOrderByKey) {
          const keyCmp = compareKeys(entry.key, equalToKey);
          if (keyCmp !== 0) return false;
        }
        return true;
      }

      // startAt filter (inclusive)
      if (startAt !== undefined) {
        const cmp = compareFn(compareValue, startAt);
        if (cmp < 0) return false;
        if (cmp === 0 && startAtKey !== undefined && !isOrderByKey) {
          const keyCmp = compareKeys(entry.key, startAtKey);
          if (keyCmp < 0) return false;
        }
      }

      // startAfter filter (exclusive)
      if (startAfter !== undefined) {
        const cmp = compareFn(compareValue, startAfter);
        if (cmp < 0) return false;
        if (cmp === 0) {
          if (startAfterKey !== undefined && !isOrderByKey) {
            const keyCmp = compareKeys(entry.key, startAfterKey);
            if (keyCmp <= 0) return false;
          } else {
            // startAfter without key means exclude all with same value
            return false;
          }
        }
      }

      // endAt filter (inclusive)
      if (endAt !== undefined) {
        const cmp = compareFn(compareValue, endAt);
        if (cmp > 0) return false;
        if (cmp === 0 && endAtKey !== undefined && !isOrderByKey) {
          const keyCmp = compareKeys(entry.key, endAtKey);
          if (keyCmp > 0) return false;
        }
      }

      // endBefore filter (exclusive)
      if (endBefore !== undefined) {
        const cmp = compareFn(compareValue, endBefore);
        if (cmp > 0) return false;
        if (cmp === 0) {
          if (endBeforeKey !== undefined && !isOrderByKey) {
            const keyCmp = compareKeys(entry.key, endBeforeKey);
            if (keyCmp >= 0) return false;
          } else {
            // endBefore without key means exclude all with same value
            return false;
          }
        }
      }

      return true;
    });
  }

  /**
   * Apply limit constraints (limitToFirst, limitToLast) to entries.
   * Entries are already sorted, so we just slice.
   */
  private applyLimits(entries: SortEntry[]): SortEntry[] {
    if (!this._queryParams) return entries;

    const { limitToFirst, limitToLast } = this._queryParams;

    if (limitToFirst !== undefined) {
      return entries.slice(0, limitToFirst);
    }

    if (limitToLast !== undefined) {
      return entries.slice(-limitToLast);
    }

    return entries;
  }

  /**
   * Apply a single write operation to a value.
   */
  private applyWrite(base: unknown, write: PendingWriteEntry): unknown {
    const { relativePath, value, operation } = write;

    if (operation === 'delete') {
      if (relativePath === '/') {
        return null;
      }
      return this.deleteAtPath(base, relativePath);
    }

    if (operation === 'set') {
      if (relativePath === '/') {
        return value;
      }
      return this.setAtPath(base, relativePath, value);
    }

    if (operation === 'update') {
      // Expand path-like keys (e.g., 'child/increment' -> { child: { increment: ... } })
      const expanded = expandPathKeys(value as Record<string, unknown>);

      if (relativePath === '/') {
        // Merge at root using deep merge (handles nested structures correctly)
        if (base === null || base === undefined || typeof base !== 'object') {
          base = {};
        }
        return deepMerge(base as Record<string, unknown>, expanded);
      }
      // Get current value at path, merge, set back
      const current = getValueAtPath(base, relativePath);
      let merged: unknown;
      if (current && typeof current === 'object' && !Array.isArray(current)) {
        merged = deepMerge(current as Record<string, unknown>, expanded);
      } else {
        merged = expanded;
      }
      return this.setAtPath(base, relativePath, merged);
    }

    return base;
  }

  /**
   * Set a value at a path in an object, creating intermediate objects as needed.
   */
  private setAtPath(obj: unknown, path: string, value: unknown): unknown {
    if (path === '/') return value;

    const segments = path.split('/').filter(s => s.length > 0);
    if (segments.length === 0) return value;

    // Ensure we have an object to work with
    const result = (obj === null || obj === undefined || typeof obj !== 'object')
      ? {}
      : { ...(obj as object) };

    let current: Record<string, unknown> = result as Record<string, unknown>;
    for (let i = 0; i < segments.length - 1; i++) {
      const key = segments[i];
      if (current[key] === null || current[key] === undefined || typeof current[key] !== 'object') {
        current[key] = {};
      } else {
        current[key] = { ...(current[key] as object) };
      }
      current = current[key] as Record<string, unknown>;
    }

    const lastKey = segments[segments.length - 1];
    current[lastKey] = value;

    return result;
  }

  /**
   * Delete a value at a path in an object.
   */
  private deleteAtPath(obj: unknown, path: string): unknown {
    if (path === '/' || obj === null || obj === undefined || typeof obj !== 'object') {
      return null;
    }

    const segments = path.split('/').filter(s => s.length > 0);
    if (segments.length === 0) return null;

    const result = { ...(obj as object) } as Record<string, unknown>;

    if (segments.length === 1) {
      delete result[segments[0]];
      return Object.keys(result).length > 0 ? result : null;
    }

    // Navigate to parent and delete
    let current: Record<string, unknown> = result;
    for (let i = 0; i < segments.length - 1; i++) {
      const key = segments[i];
      if (current[key] === null || current[key] === undefined || typeof current[key] !== 'object') {
        return result; // Path doesn't exist
      }
      current[key] = { ...(current[key] as object) };
      current = current[key] as Record<string, unknown>;
    }

    delete current[segments[segments.length - 1]];
    return result;
  }

  /**
   * Deep clone a value.
   */
  private deepClone(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => this.deepClone(v));
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = this.deepClone(v);
    }
    return result;
  }

  /**
   * Recompute ordered children from display cache.
   */
  private recomputeOrderedChildren(): void {
    const displayCache = this.getDisplayCache();
    if (displayCache && typeof displayCache === 'object' && !Array.isArray(displayCache)) {
      this._orderedChildren = getSortedKeys(displayCache as Record<string, unknown>, this.queryParams);
    } else {
      this._orderedChildren = [];
    }
  }

  /**
   * Get a value from the display cache at a relative or absolute path.
   * If the path is outside this View's scope, returns undefined.
   */
  getCacheValue(path: string): { value: unknown; found: boolean } {
    const normalized = normalizePath(path);
    const displayCache = this.getDisplayCache();

    // Check if the requested path is within this View's scope
    if (normalized === this.path) {
      // Exact match - return full cache
      if (displayCache !== undefined && displayCache !== null) {
        return { value: displayCache, found: true };
      }
      // Even if cache is null/undefined, if we have received initial snapshot, we "found" null
      if (this._hasReceivedInitialSnapshot || this._pendingWriteData.length > 0) {
        // Convert undefined to null (null = no data at path)
        return { value: displayCache ?? null, found: true };
      }
      return { value: undefined, found: false };
    }

    // Check if path is a descendant of this View's path
    if (normalized.startsWith(this.path + '/') || this.path === '/') {
      const relativePath = this.path === '/'
        ? normalized
        : normalized.slice(this.path.length);

      if (this._hasReceivedInitialSnapshot || this._pendingWriteData.length > 0) {
        const extractedValue = getValueAtPath(displayCache, relativePath);
        // Convert undefined to null (null = no data at path)
        return { value: extractedValue ?? null, found: true };
      }
    }

    return { value: undefined, found: false };
  }

  /**
   * Update a child value in the SERVER cache.
   * relativePath should be relative to this View's path.
   * Called when server events (put/patch) arrive.
   */
  updateServerCacheChild(relativePath: string, value: unknown): void {
    if (relativePath === '/') {
      // Full replacement
      this.setServerCache(value);
      return;
    }

    // Extract child key from relative path
    const segments = relativePath.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) return;

    // Ensure serverCache is an object
    if (this._serverCache === null || this._serverCache === undefined || typeof this._serverCache !== 'object') {
      this._serverCache = {};
    }

    const cache = this._serverCache as Record<string, unknown>;

    if (segments.length === 1) {
      // Direct child update
      if (value === null) {
        delete cache[segments[0]];
      } else {
        cache[segments[0]] = value;
      }
    } else {
      // Nested update
      if (value === null) {
        setValueAtPath(cache, relativePath, undefined);
      } else {
        const childKey = segments[0];
        if (!(childKey in cache)) {
          cache[childKey] = {};
        }
        setValueAtPath(cache, relativePath, value);
      }
    }

    this.invalidateDisplayCache();
  }

  /**
   * Remove a child from the SERVER cache.
   */
  removeServerCacheChild(relativePath: string): void {
    this.updateServerCacheChild(relativePath, null);
  }

  /**
   * Check if we've received the initial snapshot.
   */
  get hasReceivedInitialSnapshot(): boolean {
    return this._hasReceivedInitialSnapshot;
  }

  // ============================================
  // Ordered Children
  // ============================================

  /**
   * Get the ordered children keys.
   */
  get orderedChildren(): string[] {
    return [...this._orderedChildren];
  }

  /**
   * Get the previous sibling key for a given key.
   * Returns null if the key is first or not found.
   */
  getPreviousChildKey(key: string): string | null {
    const idx = this._orderedChildren.indexOf(key);
    if (idx <= 0) return null;
    return this._orderedChildren[idx - 1];
  }

  /**
   * Check if a key exists in the ordered children.
   */
  hasChild(key: string): boolean {
    return this._orderedChildren.includes(key);
  }

  // ============================================
  // Query Helpers
  // ============================================

  /**
   * Check if this View has query parameters.
   */
  hasQuery(): boolean {
    if (!this.queryParams) return false;
    return !!(
      this.queryParams.limitToFirst ||
      this.queryParams.limitToLast ||
      this.queryParams.startAt !== undefined ||
      this.queryParams.endAt !== undefined ||
      this.queryParams.equalTo !== undefined ||
      this.queryParams.orderBy ||
      this.queryParams.orderByChild
    );
  }

  /**
   * Check if this View has limit constraints.
   */
  hasLimit(): boolean {
    if (!this.queryParams) return false;
    return !!(this.queryParams.limitToFirst || this.queryParams.limitToLast);
  }

  /**
   * Check if this View loads all data (no limits, no range filters).
   * A View that loads all data can serve as a "complete" cache for child paths.
   */
  loadsAllData(): boolean {
    if (!this.queryParams) return true; // No query params = loads all data

    const hasLimit = !!(this.queryParams.limitToFirst || this.queryParams.limitToLast);
    const hasRangeFilter =
      this.queryParams.startAt !== undefined ||
      this.queryParams.endAt !== undefined ||
      this.queryParams.equalTo !== undefined ||
      this.queryParams.startAfter !== undefined ||
      this.queryParams.endBefore !== undefined;

    return !hasLimit && !hasRangeFilter;
  }

  // ============================================
  // Pending Writes (for local-first)
  // ============================================

  /**
   * Get current pending write IDs (to include in pw field).
   */
  getPendingWriteIds(): string[] {
    // Filter out volatile writes (empty requestId)
    return this._pendingWriteData
      .filter(w => w.requestId !== '')
      .map(w => w.requestId);
  }

  /**
   * Add a pending write with its data.
   * This is used for local-first writes - the write is applied to displayCache immediately.
   */
  addPendingWriteData(
    requestId: string,
    relativePath: string,
    value: unknown,
    operation: 'set' | 'update' | 'delete'
  ): void {
    this._pendingWriteData.push({ requestId, relativePath, value, operation });
    this.invalidateDisplayCache();
  }

  /**
   * Remove a pending write by request ID (on ack or nack).
   * Returns true if the write was found and removed.
   */
  removePendingWrite(requestId: string): boolean {
    const idx = this._pendingWriteData.findIndex(w => w.requestId === requestId);
    if (idx === -1) return false;
    this._pendingWriteData.splice(idx, 1);
    this.invalidateDisplayCache();
    return true;
  }

  /**
   * Clear all pending writes.
   */
  clearPendingWrites(): void {
    if (this._pendingWriteData.length > 0) {
      this._pendingWriteData = [];
      this.invalidateDisplayCache();
    }
  }

  /**
   * Check if this View has pending writes.
   */
  hasPendingWrites(): boolean {
    // Only count non-volatile writes (those with a requestId)
    return this._pendingWriteData.some(w => w.requestId !== '');
  }

  /**
   * Get the pending write data (for debugging/testing).
   */
  getPendingWriteData(): PendingWriteEntry[] {
    return [...this._pendingWriteData];
  }

  /**
   * Check if a specific write is pending.
   */
  isWritePending(requestId: string): boolean {
    return this._pendingWriteData.some(w => w.requestId === requestId);
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Clear the server cache but preserve callbacks and pending writes.
   * Used during reconnection.
   */
  clearServerCache(): void {
    this._serverCache = null;
    this._hasReceivedInitialSnapshot = false;
    this.invalidateDisplayCache();
    // Note: pending writes are preserved for retry on reconnect
  }

  /**
   * Clear everything - used when unsubscribing completely.
   */
  clear(): void {
    this.eventCallbacks.clear();
    this._serverCache = null;
    this._orderedChildren = [];
    this._hasReceivedInitialSnapshot = false;
    this._pendingWriteData = [];
    this._displayCacheValid = false;
    this._displayCache = null;
  }
}
