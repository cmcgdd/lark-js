/**
 * DatabaseReference - a reference to a specific path in the database.
 * Immutable - navigation returns new references.
 */

import type { DataSnapshot } from './DataSnapshot';
import type { LarkDatabase } from './LarkDatabase';
import { LarkError } from './LarkError';
import { OnDisconnect } from './OnDisconnect';
import { ErrorCode, EventType } from './protocol/constants';
import { QueryParams, TxConditionOp, TxOperation } from './protocol/messages';
import { coerceArrays } from './utils/coerce';
import { hashValue, isPrimitive } from './utils/hash';
import { getKey, getParentPath, joinPath, normalizePath } from './utils/path';
import { generatePushId } from './utils/pushid';
import { validateKey, validatePath, validateWriteData } from './utils/validation';

/**
 * Check if a path is under .info (read-only system paths).
 */
function isInfoPath(path: string): boolean {
  return path === '/.info' || path.startsWith('/.info/');
}

/**
 * Throw if attempting to write to a .info path.
 */
function validateNotInfoPath(path: string, operation: string): void {
  if (isInfoPath(path)) {
    throw new LarkError(
      ErrorCode.INVALID_PATH,
      `Cannot ${operation} on .info paths - they are read-only system paths`
    );
  }
}

/** Result of a transaction operation */
export interface TransactionResult {
  /** Whether the transaction was committed (always true on success) */
  committed: boolean;
  /** Snapshot of the data after the transaction */
  snapshot: DataSnapshot;
}

/** Default maximum retries for optimistic transactions */
const DEFAULT_MAX_RETRIES = 25;

export type SnapshotCallback = (snapshot: DataSnapshot, previousChildKey?: string | null) => void;

export interface QueryState {
  orderBy?: 'key' | 'priority' | 'child' | 'value';
  orderByChildPath?: string;
  limitToFirst?: number;
  limitToLast?: number;
  startAt?: { value: unknown; key?: string };
  startAfter?: { value: unknown; key?: string };
  endAt?: { value: unknown; key?: string };
  endBefore?: { value: unknown; key?: string };
  equalTo?: { value: unknown; key?: string };
}

/**
 * Wire protocol constants for query params.
 * Used to build the queryIdentifier.
 */
const WIRE_PROTOCOL_CONSTANTS = {
  INDEX_START_VALUE: 'sp',
  INDEX_START_NAME: 'sn',
  INDEX_START_IS_INCLUSIVE: 'sin',
  INDEX_END_VALUE: 'ep',
  INDEX_END_NAME: 'en',
  INDEX_END_IS_INCLUSIVE: 'ein',
  LIMIT: 'l',
  VIEW_FROM: 'vf',
  INDEX: 'i',
} as const;

/**
 * Convert an object to a unique sorted-key string for consistent comparison.
 * Keys are sorted alphabetically and serialized as JSON.
 */
function objectToUniqueKey(obj: Record<string, unknown>): string {
  const sortedKeys = Object.keys(obj).sort();
  const sorted: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sorted[key] = obj[key];
  }
  return JSON.stringify(sorted);
}

export class DatabaseReference {
  private readonly _db: LarkDatabase;
  private readonly _path: string;
  private readonly _query: QueryState;

  constructor(db: LarkDatabase, path: string, query: QueryState = {}) {
    this._db = db;
    this._path = normalizePath(path);
    this._query = query;
  }

  /**
   * The path of this reference.
   */
  get path(): string {
    return this._path;
  }

  /**
   * The last segment of the path (the "key"), or null for root.
   */
  get key(): string | null {
    return getKey(this._path);
  }

  /**
   * Get a reference to the parent node, or null if this is root.
   */
  get parent(): DatabaseReference | null {
    if (this._path === '/') return null;
    const parentPath = getParentPath(this._path);
    return new DatabaseReference(this._db, parentPath);
  }

  /**
   * Get a reference to the root of the database.
   */
  get root(): DatabaseReference {
    return new DatabaseReference(this._db, '');
  }

  /**
   * Get the LarkDatabase instance this reference belongs to.
   */
  get database(): LarkDatabase {
    return this._db;
  }

  /**
   * Get the underlying reference for a query.
   * For queries (created via orderBy*, limitTo*, startAt, etc.), this returns
   * a reference to the same path without query constraints.
   * For non-query references, this returns the reference itself.
   */
  get ref(): DatabaseReference {
    // If this reference has no query constraints, return itself
    if (Object.keys(this._query).length === 0) {
      return this;
    }
    // Return a new reference to the same path without query constraints
    return new DatabaseReference(this._db, this._path);
  }

  /**
   * Check if this reference/query is equal to another.
   * Two references are equal if they have the same database, path, and query constraints.
   */
  isEqual(other: DatabaseReference | null): boolean {
    if (!other) return false;
    if (this._db !== other._db) return false;
    if (this._path !== other._path) return false;
    // Compare query constraints
    return JSON.stringify(this._query) === JSON.stringify(other._query);
  }

  /**
   * Get the unique identifier for this query's parameters.
   * Used to differentiate multiple queries on the same path.
   *
   * Returns "default" for non-query references (no constraints).
   * Returns a sorted JSON string of wire-format params for queries.
   *
   * Used for wire protocol and subscription deduplication.
   */
  get queryIdentifier(): string {
    // Build wire-format query object
    const queryObj: Record<string, unknown> = {};

    // Index (orderBy)
    if (this._query.orderBy === 'key') {
      queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX] = '.key';
    } else if (this._query.orderBy === 'value') {
      queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX] = '.value';
    } else if (this._query.orderBy === 'priority') {
      queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX] = '.priority';
    } else if (this._query.orderBy === 'child' && this._query.orderByChildPath) {
      queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX] = this._query.orderByChildPath;
    }

    // Start constraint (startAt or startAfter)
    // Convert undefined to null for wire protocol
    if (this._query.startAt !== undefined) {
      queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX_START_VALUE] = this._query.startAt.value ?? null;
      if (this._query.startAt.key !== undefined) {
        queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX_START_NAME] = this._query.startAt.key;
      }
      queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX_START_IS_INCLUSIVE] = true;
    } else if (this._query.startAfter !== undefined) {
      queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX_START_VALUE] = this._query.startAfter.value ?? null;
      // Use [MAX_NAME] sentinel when startAfter is used without a key
      queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX_START_NAME] = this._query.startAfter.key ?? '[MAX_NAME]';
      queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX_START_IS_INCLUSIVE] = false;
    }

    // End constraint (endAt or endBefore)
    // Convert undefined to null for wire protocol
    if (this._query.endAt !== undefined) {
      queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX_END_VALUE] = this._query.endAt.value ?? null;
      if (this._query.endAt.key !== undefined) {
        queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX_END_NAME] = this._query.endAt.key;
      }
      queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX_END_IS_INCLUSIVE] = true;
    } else if (this._query.endBefore !== undefined) {
      queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX_END_VALUE] = this._query.endBefore.value ?? null;
      // Use [MIN_NAME] sentinel when endBefore is used without a key
      queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX_END_NAME] = this._query.endBefore.key ?? '[MIN_NAME]';
      queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX_END_IS_INCLUSIVE] = false;
    }

    // equalTo is startAt + endAt with same value
    if (this._query.equalTo !== undefined) {
      queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX_START_VALUE] = this._query.equalTo.value;
      queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX_END_VALUE] = this._query.equalTo.value;
      queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX_START_IS_INCLUSIVE] = true;
      queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX_END_IS_INCLUSIVE] = true;
      if (this._query.equalTo.key !== undefined) {
        queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX_START_NAME] = this._query.equalTo.key;
        queryObj[WIRE_PROTOCOL_CONSTANTS.INDEX_END_NAME] = this._query.equalTo.key;
      }
    }

    // Limit
    if (this._query.limitToFirst !== undefined) {
      queryObj[WIRE_PROTOCOL_CONSTANTS.LIMIT] = this._query.limitToFirst;
      queryObj[WIRE_PROTOCOL_CONSTANTS.VIEW_FROM] = 'l'; // left (first)
    } else if (this._query.limitToLast !== undefined) {
      queryObj[WIRE_PROTOCOL_CONSTANTS.LIMIT] = this._query.limitToLast;
      queryObj[WIRE_PROTOCOL_CONSTANTS.VIEW_FROM] = 'r'; // right (last)
    }

    // If no constraints, return "default"
    if (Object.keys(queryObj).length === 0) {
      return 'default';
    }

    // Return sorted unique key
    return objectToUniqueKey(queryObj);
  }

  /**
   * Get the data at this location. Alias for once('value').
   * Alternative to once('value') for reading data.
   */
  async get(): Promise<DataSnapshot> {
    return this.once('value');
  }

  // ============================================
  // Navigation
  // ============================================

  /**
   * Get a reference to a child path.
   */
  child(path: string): DatabaseReference {
    validatePath(path, 'child');
    const childPath = joinPath(this._path, path);
    return new DatabaseReference(this._db, childPath);
  }

  // ============================================
  // Write Operations
  // ============================================

  /**
   * Set the data at this location, overwriting any existing data.
   *
   * For volatile paths (high-frequency updates), this is fire-and-forget
   * and resolves immediately without waiting for server confirmation.
   *
   * @param value - The value to write
   */
  async set(value: unknown): Promise<void> {
    validateNotInfoPath(this._path, 'set');
    validateWriteData(value, 'set');
    if (this._db.isVolatilePath(this._path)) {
      this._db._sendVolatileSet(this._path, value);
      return;
    }
    await this._db._sendSet(this._path, value);
  }

  /**
   * Update specific children at this location without overwriting other children.
   *
   * Also supports multi-path updates when keys look like paths
   * (start with '/'). In this mode, each path is written atomically as a transaction.
   *
   * @example
   * ```javascript
   * // Normal update (merge at single path)
   * await ref.update({ score: 10, name: 'Riley' });
   *
   * // Multi-path update (atomic writes to multiple paths)
   * await db.ref().update({
   *   '/users/alice/score': 100,
   *   '/users/bob/score': 200,
   *   '/leaderboard/alice': null  // null = delete
   * });
   * ```
   *
   * @param values - The values to update
   */
  async update(values: Record<string, unknown>): Promise<void> {
    validateNotInfoPath(this._path, 'update');

    // Validate all keys and values
    for (const [key, value] of Object.entries(values)) {
      if (key.includes('/')) {
        // Path-like key (contains /) - validate as path
        validatePath(key, 'update');
      } else {
        // Regular key - validate as key
        validateKey(key, 'update');
      }
      if (value !== null) {
        validateWriteData(value, 'update');
      }
    }

    // Check if any key looks like a path (starts with '/')
    const hasPathKeys = Object.keys(values).some((key) => key.startsWith('/'));

    if (hasPathKeys) {
      // Multi-path mode: use transaction for atomic writes
      // Note: Transactions are NOT volatile (need reliability for atomicity)
      const ops: TxOperation[] = [];

      for (const [key, value] of Object.entries(values)) {
        // Resolve path relative to this ref
        const fullPath = key.startsWith('/')
          ? joinPath(this._path, key)
          : joinPath(this._path, key);
        const normalizedPath = normalizePath(fullPath) || '/';

        if (value === null) {
          // null = delete
          ops.push({ o: 'd', p: normalizedPath });
        } else {
          // set the value (not merge)
          ops.push({ o: 's', p: normalizedPath, v: value });
        }
      }

      await this._db._sendTransaction(ops);
    } else {
      // Normal update (merge at single path)
      if (this._db.isVolatilePath(this._path)) {
        this._db._sendVolatileUpdate(this._path, values);
        return;
      }
      await this._db._sendUpdate(this._path, values);
    }
  }

  /**
   * Remove the data at this location.
   *
   * For volatile paths, this is fire-and-forget.
   */
  async remove(): Promise<void> {
    validateNotInfoPath(this._path, 'remove');
    if (this._db.isVolatilePath(this._path)) {
      this._db._sendVolatileDelete(this._path);
      return;
    }
    await this._db._sendDelete(this._path);
  }

  /**
   * Generate a new child location with a unique key and optionally set its value.
   *
   * Returns a ThenableReference - an object that is both a DatabaseReference
   * AND a Promise. You can access reference properties immediately (like `.key`)
   * and also await the result.
   *
   * If value is provided, the promise resolves after the write completes.
   * If no value is provided, the promise resolves immediately.
   *
   * @example
   * ```javascript
   * // Without value - returns ThenableReference, resolves immediately
   * const pushed = ref.push();
   * console.log(pushed.key); // "-Abc123..." (available immediately)
   * await pushed; // Resolves immediately to the same reference
   *
   * // With value - returns ThenableReference, resolves after write
   * const pushed2 = ref.push({ name: 'Alice' });
   * console.log(pushed2.key); // "-Xyz789..." (available immediately)
   * await pushed2; // Waits for write to complete
   * ```
   */
  push(): ThenableReference;
  push(value: unknown): ThenableReference;
  push(value?: unknown): ThenableReference {
    validateNotInfoPath(this._path, 'push');
    // Always generate key locally
    const key = generatePushId();
    const childRef = this.child(key);

    if (value === undefined) {
      // No value - return ThenableReference that resolves immediately
      return new ThenableReference(this._db, childRef.path);
    }

    // Value provided - do the set and create promise that resolves after
    const setPromise = childRef.set(value) as Promise<void>;
    const writePromise = setPromise.then(() => childRef);

    return new ThenableReference(this._db, childRef.path, writePromise);
  }

  /**
   * Set the data with a priority value for ordering.
   *
   * For objects: injects `.priority` into the value object.
   * For primitives: wraps as `{ '.value': primitive, '.priority': priority }`.
   *
   * Uses { '.value': value, '.priority': priority } format for the wire protocol.
   *
   * @param value - The value to write
   * @param priority - The priority for ordering
   */
  async setWithPriority(value: unknown, priority: number | string): Promise<void> {
    validateNotInfoPath(this._path, 'setWithPriority');
    validateWriteData(value, 'setWithPriority');
    if (typeof priority === 'string') {
      validateWriteData(priority, 'setWithPriority (priority)');
    }

    // Setting null/undefined with priority - just set the value (priority is lost)
    if (value === null || value === undefined) {
      await this._db._sendSet(this._path, value);
      return;
    }

    // Primitives (number, string, boolean) get wrapped in { '.value': x, '.priority': y }
    if (typeof value !== 'object' || Array.isArray(value)) {
      const wrappedValue = { '.value': value, '.priority': priority };
      await this._db._sendSet(this._path, wrappedValue);
      return;
    }

    // Objects get .priority injected directly
    const valueWithPriority = { ...(value as Record<string, unknown>), '.priority': priority };
    await this._db._sendSet(this._path, valueWithPriority);
  }

  /**
   * Set the priority of the data at this location.
   * Uses cached value for optimistic behavior (local effects are immediate).
   * The optimistic update happens synchronously, Promise resolves after server ack.
   */
  setPriority(priority: number | string | null): Promise<void> {
    validateNotInfoPath(this._path, 'setPriority');

    // Get cached value for optimistic behavior (no network fetch needed)
    const { value: cachedValue, found } = this._db._getCachedValue(this._path);

    // If not in cache, we need to fall back to async fetch
    if (!found) {
      return this.once().then(snapshot => {
        const actualValue = snapshot.val();
        if (actualValue === null || actualValue === undefined) {
          return this._db._sendSet(this._path, { '.priority': priority });
        }
        return this.setWithPriority(actualValue, priority as number | string);
      });
    }

    // Extract the actual value from the cached data
    // Cached data might be wrapped as { '.value': x, '.priority': y } for primitives
    // or as { key: val, '.priority': y } for objects
    let actualValue: unknown;
    if (cachedValue === null || cachedValue === undefined) {
      // Null value in cache
      actualValue = null;
    } else if (typeof cachedValue === 'object' && !Array.isArray(cachedValue)) {
      const obj = cachedValue as Record<string, unknown>;
      // Check for wrapped primitive: { '.value': x, '.priority': y }
      if ('.value' in obj && Object.keys(obj).every(k => k === '.value' || k === '.priority')) {
        actualValue = obj['.value'];
      } else {
        // Object - extract value without .priority
        const { '.priority': _oldPriority, ...rest } = obj;
        actualValue = Object.keys(rest).length > 0 ? rest : null;
      }
    } else {
      // Primitive value (no wrapper)
      actualValue = cachedValue;
    }

    if (actualValue === null || actualValue === undefined) {
      // No data exists, just set priority on empty object
      return this._db._sendSet(this._path, { '.priority': priority });
    }

    // setWithPriority does the optimistic update synchronously, returns Promise for ack
    return this.setWithPriority(actualValue, priority as number | string);
  }

  /**
   * Atomically modify the data at this location using optimistic concurrency.
   *
   * The update function receives the current value and should return the new
   * value. If the data changed on the server before the write could be
   * committed, the function is called again with the new value, and the
   * process repeats until successful or the maximum retries are exceeded.
   *
   * @example
   * ```javascript
   * // Increment a counter atomically
   * const result = await ref.transaction(currentValue => {
   *   return (currentValue || 0) + 1;
   * });
   * console.log('New value:', result.snapshot.val());
   * ```
   *
   * @param updateFunction - Function that receives current value and returns new value.
   *                         Return undefined to abort the transaction.
   * @param maxRetries - Maximum number of retries (default: 25)
   * @returns TransactionResult with committed status and final snapshot
   */
  async transaction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateFunction: (currentValue: any) => any,
    maxRetries: number = DEFAULT_MAX_RETRIES
  ): Promise<TransactionResult> {
    validateNotInfoPath(this._path, 'transaction');
    let retries = 0;

    while (retries < maxRetries) {
      // Step 1: Read current value
      const currentSnapshot = await this.once();
      const currentValue = currentSnapshot.val();  // Stripped value for user callback
      const rawValue = currentSnapshot.exportVal(); // Raw value for condition check

      // Step 2: Call update function
      const newValue = updateFunction(currentValue);

      // Step 3: If undefined returned, abort
      if (newValue === undefined) {
        return {
          committed: false,
          snapshot: currentSnapshot,
        };
      }

      // Step 4: Build condition based on RAW value type (includes priority metadata)
      // Primitives use direct value comparison, complex values use hash
      let condition: TxConditionOp;
      if (isPrimitive(rawValue)) {
        condition = { o: 'c', p: this._path, v: rawValue };
      } else {
        // Hash the coerced form so it matches the server, which hashes its
        // integer-keyed maps in their rendered (array) shape.
        const hash = await hashValue(coerceArrays(rawValue));
        condition = { o: 'c', p: this._path, h: hash };
      }

      // Step 5: Build transaction with condition + set
      // Preserves priority unless explicitly changed, so if the old value had
      // priority and the new value is a primitive, wrap it to preserve the priority
      let valueToSet = newValue;
      const existingPriority = currentSnapshot.getPriority();
      if (existingPriority !== null && isPrimitive(newValue) && newValue !== null) {
        valueToSet = { '.priority': existingPriority, '.value': newValue };
      }
      const ops: TxOperation[] = [condition, { o: 's', p: this._path, v: valueToSet }];

      try {
        // Step 6: Try to commit
        await this._db._sendTransaction(ops);

        // Success! Read back the value for the result snapshot
        const finalSnapshot = await this.once();
        return {
          committed: true,
          snapshot: finalSnapshot,
        };
      } catch (error) {
        // Step 7: If condition failed, retry
        if (error instanceof LarkError && error.code === ErrorCode.CONDITION_FAILED) {
          retries++;
          continue;
        }
        // Other errors should propagate
        throw error;
      }
    }

    // Max retries exceeded
    throw new LarkError(
      'max_retries_exceeded',
      `Transaction failed after ${maxRetries} retries`
    );
  }

  // ============================================
  // Read Operations
  // ============================================

  /**
   * Read the data at this location once.
   *
   * For 'value' events, this fetches data directly from the server.
   * For child events ('child_added', 'child_changed', 'child_removed', 'child_moved'),
   * this subscribes, waits for the first event, then unsubscribes.
   *
   * @param eventType - The event type
   * @returns Promise that resolves to the DataSnapshot
   */
  once(eventType: EventType = 'value'): Promise<DataSnapshot> {
    if (eventType === 'value') {
      // Use the optimized direct fetch for 'value' events
      return this._db._sendOnce(this._path, this._buildQueryParams());
    }

    // For child events, subscribe and wait for the first event
    return new Promise((resolve) => {
      const unsubscribe = this.on(eventType, (snapshot) => {
        unsubscribe();
        resolve(snapshot);
      });
    });
  }

  // ============================================
  // Subscriptions
  // ============================================

  /**
   * Subscribe to events at this location.
   * Returns an unsubscribe function.
   */
  on(eventType: EventType, callback: SnapshotCallback): () => void {
    return this._db._subscribe(this._path, eventType, callback, this._buildQueryParams(), this.queryIdentifier);
  }

  /**
   * Unsubscribe from events.
   *
   * - `off()` - removes ALL listeners at this path
   * - `off('value')` - removes all 'value' listeners at this path
   *
   * Note: To unsubscribe a specific callback, use the unsubscribe function
   * returned by `on()`.
   *
   * @param eventType - Optional event type to unsubscribe from
   */
  off(eventType?: EventType): void {
    if (eventType) {
      // Remove all callbacks for this event type
      this._db._unsubscribeEventType(this._path, eventType);
    } else {
      // Remove all callbacks at this path
      this._db._unsubscribeAll(this._path);
    }
  }

  // ============================================
  // OnDisconnect
  // ============================================

  /**
   * Get an OnDisconnect handler for this location.
   */
  onDisconnect(): OnDisconnect {
    return new OnDisconnect(this._db, this._path);
  }

  // ============================================
  // Query Modifiers
  // ============================================

  /**
   * Order results by key.
   */
  orderByKey(): DatabaseReference {
    this._validateNoOrderBy('orderByKey');
    // orderByKey doesn't allow key parameters on startAt/endAt/equalTo
    this._validateNoKeyParameterForOrderByKey('orderByKey');
    // orderByKey requires string values for startAt/endAt/equalTo (validate if already set)
    this._validateStringValuesForOrderByKey('orderByKey');
    return new DatabaseReference(this._db, this._path, {
      ...this._query,
      orderBy: 'key',
    });
  }

  /**
   * Order results by priority.
   */
  orderByPriority(): DatabaseReference {
    this._validateNoOrderBy('orderByPriority');
    return new DatabaseReference(this._db, this._path, {
      ...this._query,
      orderBy: 'priority',
    });
  }

  /**
   * Order results by a child key.
   */
  orderByChild(path: string): DatabaseReference {
    this._validateNoOrderBy('orderByChild');
    // Validate path doesn't contain reserved $ prefixes
    if (path.startsWith('$') || path.includes('/$')) {
      throw new LarkError(
        ErrorCode.INVALID_PATH,
        `orderByChild: Invalid path '${path}'. Paths cannot contain '$' prefix (reserved for internal use)`
      );
    }
    return new DatabaseReference(this._db, this._path, {
      ...this._query,
      orderBy: 'child',
      orderByChildPath: path,
    });
  }

  /**
   * Order results by value.
   */
  orderByValue(): DatabaseReference {
    this._validateNoOrderBy('orderByValue');
    return new DatabaseReference(this._db, this._path, {
      ...this._query,
      orderBy: 'value',
    });
  }

  /**
   * Limit to the first N results.
   */
  limitToFirst(limit: number): DatabaseReference {
    // Validate limit is a positive integer
    if (limit === undefined || limit === null) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        'Query.limitToFirst: a limit must be provided'
      );
    }
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        'Query.limitToFirst: limit must be a positive integer'
      );
    }
    if (this._query.limitToFirst !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        'Query.limitToFirst: limitToFirst() cannot be called multiple times'
      );
    }
    if (this._query.limitToLast !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        'Query.limitToFirst: cannot use limitToFirst() with limitToLast()'
      );
    }
    return new DatabaseReference(this._db, this._path, {
      ...this._query,
      limitToFirst: limit,
    });
  }

  /**
   * Limit to the last N results.
   */
  limitToLast(limit: number): DatabaseReference {
    // Validate limit is a positive integer
    if (limit === undefined || limit === null) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        'Query.limitToLast: a limit must be provided'
      );
    }
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        'Query.limitToLast: limit must be a positive integer'
      );
    }
    if (this._query.limitToLast !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        'Query.limitToLast: limitToLast() cannot be called multiple times'
      );
    }
    if (this._query.limitToFirst !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        'Query.limitToLast: cannot use limitToLast() with limitToFirst()'
      );
    }
    return new DatabaseReference(this._db, this._path, {
      ...this._query,
      limitToLast: limit,
    });
  }

  /**
   * Start at a specific value/key.
   * If no value is provided, starts at the beginning (null priority).
   */
  startAt(value?: unknown, key?: string): DatabaseReference {
    if (this._query.startAt !== undefined || this._query.startAfter !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        'Query.startAt: startAt()/startAfter() cannot be called multiple times'
      );
    }
    if (this._query.equalTo !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        'Query.startAt: cannot use startAt() with equalTo()'
      );
    }
    this._validateQueryValue('startAt', value, key);
    return new DatabaseReference(this._db, this._path, {
      ...this._query,
      startAt: { value, key },
    });
  }

  /**
   * Start after a specific value/key (exclusive).
   * Like startAt() but excludes the starting point.
   */
  startAfter(value?: unknown, key?: string): DatabaseReference {
    if (this._query.startAfter !== undefined || this._query.startAt !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        'Query.startAfter: startAfter()/startAt() cannot be called multiple times'
      );
    }
    if (this._query.equalTo !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        'Query.startAfter: cannot use startAfter() with equalTo()'
      );
    }
    this._validateQueryValue('startAfter', value, key);
    return new DatabaseReference(this._db, this._path, {
      ...this._query,
      startAfter: { value, key },
    });
  }

  /**
   * End at a specific value/key.
   * If no value is provided, ends at the end (null priority).
   */
  endAt(value?: unknown, key?: string): DatabaseReference {
    if (this._query.endAt !== undefined || this._query.endBefore !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        'Query.endAt: endAt()/endBefore() cannot be called multiple times'
      );
    }
    if (this._query.equalTo !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        'Query.endAt: cannot use endAt() with equalTo()'
      );
    }
    this._validateQueryValue('endAt', value, key);
    return new DatabaseReference(this._db, this._path, {
      ...this._query,
      endAt: { value, key },
    });
  }

  /**
   * End before a specific value/key (exclusive).
   * Like endAt() but excludes the ending point.
   */
  endBefore(value?: unknown, key?: string): DatabaseReference {
    if (this._query.endBefore !== undefined || this._query.endAt !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        'Query.endBefore: endBefore()/endAt() cannot be called multiple times'
      );
    }
    if (this._query.equalTo !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        'Query.endBefore: cannot use endBefore() with equalTo()'
      );
    }
    this._validateQueryValue('endBefore', value, key);
    return new DatabaseReference(this._db, this._path, {
      ...this._query,
      endBefore: { value, key },
    });
  }

  /**
   * Filter to items equal to a specific value.
   */
  equalTo(value: unknown, key?: string): DatabaseReference {
    if (this._query.equalTo !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        'Query.equalTo: equalTo() cannot be called multiple times'
      );
    }
    if (this._query.startAt !== undefined || this._query.startAfter !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        'Query.equalTo: cannot use equalTo() with startAt()/startAfter()'
      );
    }
    if (this._query.endAt !== undefined || this._query.endBefore !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        'Query.equalTo: cannot use equalTo() with endAt()/endBefore()'
      );
    }
    this._validateQueryValue('equalTo', value, key);
    return new DatabaseReference(this._db, this._path, {
      ...this._query,
      equalTo: { value, key },
    });
  }

  // ============================================
  // Query Validation Helpers
  // ============================================

  /**
   * Validate that no orderBy has been set yet.
   */
  private _validateNoOrderBy(methodName: string): void {
    if (this._query.orderBy !== undefined) {
      const existingMethod =
        this._query.orderBy === 'child'
          ? `orderByChild('${this._query.orderByChildPath}')`
          : `orderBy${this._query.orderBy.charAt(0).toUpperCase()}${this._query.orderBy.slice(1)}()`;
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        `Query.${methodName}: cannot use ${methodName}() with ${existingMethod}`
      );
    }
  }

  /**
   * Validate that no key parameter has been set on startAt/endAt/equalTo.
   * Used when calling orderByKey() after startAt/endAt/equalTo.
   */
  private _validateNoKeyParameterForOrderByKey(methodName: string): void {
    if (this._query.startAt?.key !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        `Query.${methodName}: when using orderByKey(), you cannot specify a key parameter in startAt()`
      );
    }
    if (this._query.startAfter?.key !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        `Query.${methodName}: when using orderByKey(), you cannot specify a key parameter in startAfter()`
      );
    }
    if (this._query.endAt?.key !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        `Query.${methodName}: when using orderByKey(), you cannot specify a key parameter in endAt()`
      );
    }
    if (this._query.endBefore?.key !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        `Query.${methodName}: when using orderByKey(), you cannot specify a key parameter in endBefore()`
      );
    }
    if (this._query.equalTo?.key !== undefined) {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        `Query.${methodName}: when using orderByKey(), you cannot specify a key parameter in equalTo()`
      );
    }
  }

  /**
   * Validate that startAt/endAt/equalTo values are strings.
   * Used when calling orderByKey() after startAt/endAt/equalTo.
   */
  private _validateStringValuesForOrderByKey(methodName: string): void {
    if (this._query.startAt !== undefined && typeof this._query.startAt.value !== 'string') {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        `Query.${methodName}: when using orderByKey(), startAt() value must be a string`
      );
    }
    if (this._query.startAfter !== undefined && typeof this._query.startAfter.value !== 'string') {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        `Query.${methodName}: when using orderByKey(), startAfter() value must be a string`
      );
    }
    if (this._query.endAt !== undefined && typeof this._query.endAt.value !== 'string') {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        `Query.${methodName}: when using orderByKey(), endAt() value must be a string`
      );
    }
    if (this._query.endBefore !== undefined && typeof this._query.endBefore.value !== 'string') {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        `Query.${methodName}: when using orderByKey(), endBefore() value must be a string`
      );
    }
    if (this._query.equalTo !== undefined && typeof this._query.equalTo.value !== 'string') {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        `Query.${methodName}: when using orderByKey(), equalTo() value must be a string`
      );
    }
  }

  /**
   * Validate value and key types for query methods (startAt, endAt, equalTo, etc.)
   */
  private _validateQueryValue(methodName: string, value: unknown, key?: string): void {
    // Validate key parameter format if provided
    if (key !== undefined) {
      this._validateKeyFormat(methodName, key);
    }

    // orderByKey: requires string value, no key parameter
    if (this._query.orderBy === 'key') {
      // Value must be a string for orderByKey (null is also not allowed)
      if (typeof value !== 'string') {
        throw new LarkError(
          ErrorCode.INVALID_QUERY,
          `Query.${methodName}: when using orderByKey(), the value must be a string`
        );
      }
      // Key parameter is not allowed with orderByKey (the value IS the key)
      if (key !== undefined) {
        throw new LarkError(
          ErrorCode.INVALID_QUERY,
          `Query.${methodName}: when using orderByKey(), you cannot specify a key parameter`
        );
      }
      return;
    }

    // orderByPriority: booleans not allowed (only null, number, string)
    if (this._query.orderBy === 'priority') {
      if (typeof value === 'boolean') {
        throw new LarkError(
          ErrorCode.INVALID_QUERY,
          `Query.${methodName}: when using orderByPriority(), the value must be a valid priority (null, number, or string)`
        );
      }
    }

    // General validation: objects not allowed as values (arrays are objects too)
    // This applies to orderByChild and default ordering
    if (value !== null && typeof value === 'object') {
      throw new LarkError(
        ErrorCode.INVALID_QUERY,
        `Query.${methodName}: the value argument cannot be an object`
      );
    }
  }

  /**
   * Validate that a key is a valid key format.
   * Delegates to the shared validation utility.
   */
  private _validateKeyFormat(methodName: string, key: string): void {
    validateKey(key, `Query.${methodName}`);
  }

  // ============================================
  // Internal Helpers
  // ============================================

  /**
   * Build query parameters for wire protocol.
   */
  private _buildQueryParams(): QueryParams | undefined {
    const params: QueryParams = {};
    let hasParams = false;

    // Order by
    if (this._query.orderBy === 'key') {
      params.orderBy = 'key';
      hasParams = true;
    } else if (this._query.orderBy === 'priority') {
      params.orderBy = 'priority';
      hasParams = true;
    } else if (this._query.orderBy === 'child') {
      params.orderBy = 'child';
      if (this._query.orderByChildPath) {
        params.orderByChild = this._query.orderByChildPath;
      }
      hasParams = true;
    } else if (this._query.orderBy === 'value') {
      params.orderBy = 'value';
      hasParams = true;
    }

    // Limits
    if (this._query.limitToFirst !== undefined) {
      params.limitToFirst = this._query.limitToFirst;
      hasParams = true;
    }

    if (this._query.limitToLast !== undefined) {
      params.limitToLast = this._query.limitToLast;
      hasParams = true;
    }

    // Range queries
    // Convert undefined to null for wire protocol
    if (this._query.startAt !== undefined) {
      params.startAt = this._query.startAt.value ?? null;
      if (this._query.startAt.key !== undefined) {
        params.startAtKey = this._query.startAt.key;
      }
      hasParams = true;
    }

    if (this._query.startAfter !== undefined) {
      params.startAfter = this._query.startAfter.value ?? null;
      if (this._query.startAfter.key !== undefined) {
        params.startAfterKey = this._query.startAfter.key;
      }
      hasParams = true;
    }

    if (this._query.endAt !== undefined) {
      params.endAt = this._query.endAt.value ?? null;
      if (this._query.endAt.key !== undefined) {
        params.endAtKey = this._query.endAt.key;
      }
      hasParams = true;
    }

    if (this._query.endBefore !== undefined) {
      params.endBefore = this._query.endBefore.value ?? null;
      if (this._query.endBefore.key !== undefined) {
        params.endBeforeKey = this._query.endBefore.key;
      }
      hasParams = true;
    }

    if (this._query.equalTo !== undefined) {
      params.equalTo = this._query.equalTo.value ?? null;
      if (this._query.equalTo.key !== undefined) {
        params.equalToKey = this._query.equalTo.key;
      }
      hasParams = true;
    }

    return hasParams ? params : undefined;
  }

  /**
   * Returns the absolute URL for this database location.
   * Format: https://{database}--{project}.larkdb.net/path/to/data
   */
  toString(): string {
    const baseUrl = this._db._getBaseUrl();
    // For root, just return base URL; otherwise append path (path already has leading slash)
    if (this._path === '/') {
      return baseUrl;
    }
    return `${baseUrl}${this._path}`;
  }

  /**
   * Returns the URL for JSON serialization.
   * This allows refs to be serialized with JSON.stringify().
   */
  toJSON(): string {
    return this.toString();
  }
}

/**
 * A reference that is also a Promise - returned by push().
 *
 * This allows patterns like:
 * ```javascript
 * const pushed = ref.push();
 * console.log(pushed.key); // Key available immediately
 * await pushed; // Wait for write to complete
 * ```
 */
export class ThenableReference extends DatabaseReference implements PromiseLike<DatabaseReference> {
  private readonly _promise: Promise<DatabaseReference>;

  constructor(
    db: LarkDatabase,
    path: string,
    promise?: Promise<DatabaseReference>
  ) {
    super(db, path);
    // If no promise provided, resolve immediately with this reference
    this._promise = promise ?? Promise.resolve(this);
  }

  then<TResult1 = DatabaseReference, TResult2 = never>(
    onfulfilled?: ((value: DatabaseReference) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): Promise<TResult1 | TResult2> {
    return this._promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | undefined | null
  ): Promise<DatabaseReference | TResult> {
    return this._promise.catch(onrejected);
  }
}
