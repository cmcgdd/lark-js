/**
 * Firebase v8 Compatibility Layer
 *
 * This module provides Firebase v8-style behavior for users migrating from Firebase.
 *
 * Key differences from modern API:
 * 1. on() returns the callback (not an unsubscribe function)
 * 2. off(eventType, callback, context?) removes specific listener by callback reference
 * 3. once(eventType, successCallback, cancelCallback, context?) supports callback style
 * 4. Context parameter binds `this` inside callbacks
 *
 * @example
 * ```typescript
 * import { LarkDatabase, DatabaseReference } from '@lark-sh/client/fb-v8';
 *
 * const db = new LarkDatabase('project/database', { anonymous: true });
 * await db.connect();
 *
 * const ref = db.ref('players');
 * const callback = ref.on('value', (snap) => console.log(snap.val()));
 * // callback === the function you passed in
 *
 * // Later: remove by callback reference (works from any ref at same path)
 * ref.off('value', callback);
 *
 * // With context (binds `this`):
 * ref.on('value', this.handleValue, this);
 * ref.off('value', this.handleValue, this);
 * ```
 */

import {
  LarkDatabase as ModernLarkDatabase,
  DatabaseReference as ModernDatabaseReference,
  ThenableReference as ModernThenableReference,
  DataSnapshot,
  OnDisconnect,
  LarkError,
  ConnectOptions,
  AuthInfo,
  TransactionOp,
  TransactionSetOp,
  TransactionUpdateOp,
  TransactionDeleteOp,
  TransactionConditionOp,
  TransactionObject,
  SnapshotCallback,
  QueryState,
  TransactionResult,
  ServerValue,
  generatePushId,
  isVolatilePath,
  PendingWriteManager,
} from '../index';
import type { EventType } from '../protocol/constants';
import type { QueryParams } from '../protocol/messages';
import type { TransportType } from '../connection/createTransport';

/**
 * A single callback registration with optional context.
 */
interface CallbackRegistration {
  callback: SnapshotCallback;
  context: unknown;
  unsubscribe: () => void;
}

/**
 * Global callback registry for Firebase v8 compatibility.
 * In Firebase v8, callbacks are tracked at the path+query level.
 * The same callback can be registered multiple times with different contexts.
 *
 * Structure: path -> queryIdentifier -> eventType -> CallbackRegistration[]
 */
type CallbackRegistry = Map<string, Map<string, Map<string, CallbackRegistration[]>>>;

/**
 * Firebase v8 compatible DatabaseReference.
 * Wraps the modern DatabaseReference with v8-style on/off behavior.
 */
export class DatabaseReference {
  private readonly _modernRef: ModernDatabaseReference;
  private readonly _db: LarkDatabase;

  constructor(db: LarkDatabase, modernRef: ModernDatabaseReference) {
    this._db = db;
    this._modernRef = modernRef;
  }

  // ============================================
  // Properties (delegated)
  // ============================================

  get path(): string {
    return this._modernRef.path;
  }

  get key(): string | null {
    return this._modernRef.key;
  }

  get parent(): DatabaseReference | null {
    const modernParent = this._modernRef.parent;
    if (!modernParent) return null;
    return new DatabaseReference(this._db, modernParent);
  }

  get root(): DatabaseReference {
    return new DatabaseReference(this._db, this._modernRef.root);
  }

  get database(): LarkDatabase {
    return this._db;
  }

  /**
   * Get the underlying reference for a query.
   * For queries, returns a reference without query constraints.
   */
  get ref(): DatabaseReference {
    return new DatabaseReference(this._db, this._modernRef.ref);
  }

  get queryIdentifier(): string {
    return this._modernRef.queryIdentifier;
  }

  // ============================================
  // Navigation
  // ============================================

  child(path: string): DatabaseReference {
    return new DatabaseReference(this._db, this._modernRef.child(path));
  }

  // ============================================
  // Write Operations (delegated)
  // ============================================

  async set(value: unknown): Promise<void> {
    return this._modernRef.set(value);
  }

  async update(values: Record<string, unknown>): Promise<void> {
    return this._modernRef.update(values);
  }

  async remove(): Promise<void> {
    return this._modernRef.remove();
  }

  push(): ThenableReference;
  push(value: unknown): ThenableReference;
  push(value?: unknown): ThenableReference {
    const modernThenable = value === undefined
      ? this._modernRef.push()
      : this._modernRef.push(value);
    return new ThenableReference(this._db, modernThenable);
  }

  async setWithPriority(value: unknown, priority: number | string): Promise<void> {
    return this._modernRef.setWithPriority(value, priority);
  }

  setPriority(priority: number | string | null): Promise<void> {
    return this._modernRef.setPriority(priority);
  }

  async transaction(
    updateFunction: (currentValue: unknown) => unknown,
    maxRetries?: number
  ): Promise<TransactionResult> {
    return this._modernRef.transaction(updateFunction, maxRetries);
  }

  // ============================================
  // Read Operations
  // ============================================

  async get(): Promise<DataSnapshot> {
    return this._modernRef.get();
  }

  /**
   * Read data once.
   *
   * Supports both promise style and Firebase v8 callback style:
   * - `once('value')` - returns Promise<DataSnapshot>
   * - `once('value', callback)` - calls callback with snapshot, returns Promise
   * - `once('value', callback, cancelCallback)` - also handles errors
   * - `once('value', callback, cancelCallback, context)` - binds `this` to context
   */
  once(eventType?: EventType): Promise<DataSnapshot>;
  once(
    eventType: EventType,
    successCallback: SnapshotCallback,
    cancelCallback?: (error: Error) => void,
    context?: unknown
  ): Promise<DataSnapshot>;
  once(
    eventType: EventType = 'value',
    successCallback?: SnapshotCallback,
    cancelCallback?: (error: Error) => void,
    context?: unknown
  ): Promise<DataSnapshot> {
    const promise = this._modernRef.once(eventType);

    if (successCallback) {
      // Firebase v8 callback style - bind context if provided
      const boundCallback = context ? successCallback.bind(context) : successCallback;
      promise.then(
        (snapshot) => boundCallback(snapshot),
        (error) => {
          if (cancelCallback) {
            const boundCancel = context ? cancelCallback.bind(context) : cancelCallback;
            boundCancel(error);
          }
        }
      );
    }

    return promise;
  }

  // ============================================
  // Subscriptions (Firebase v8 style)
  // ============================================

  /**
   * Subscribe to events at this location.
   *
   * **Firebase v8 behavior**: Returns the callback function (not an unsubscribe function).
   * Use `off(eventType, callback, context?)` to remove the listener.
   *
   * Note: Callbacks are tracked globally by path, so off() on any ref at the same
   * path can remove this callback by reference.
   *
   * @param eventType - The event type to listen for
   * @param callback - The callback to invoke
   * @param cancelCallbackOrContext - Optional cancel callback or context
   * @param context - Optional context to bind `this` in callback
   * @returns The callback function (for use with off())
   */
  on(
    eventType: EventType,
    callback: SnapshotCallback,
    cancelCallbackOrContext?: ((error: Error) => void) | unknown,
    context?: unknown
  ): SnapshotCallback {
    // Handle overloaded parameters: on(type, cb, context) or on(type, cb, cancelCb, context)
    let cancelCallback: ((error: Error) => void) | undefined;
    let actualContext: unknown;

    if (typeof cancelCallbackOrContext === 'function') {
      cancelCallback = cancelCallbackOrContext as (error: Error) => void;
      actualContext = context;
    } else {
      actualContext = cancelCallbackOrContext;
    }

    // Create bound callback if context provided
    const boundCallback = actualContext ? callback.bind(actualContext) : callback;

    // Subscribe using modern API with the bound callback
    const unsubscribe = this._modernRef.on(eventType, boundCallback);

    // Store in the global callback registry (keyed by path and queryIdentifier)
    // We store the original callback and context so off() can match them
    this._db._registerCallback(this.path, this.queryIdentifier, eventType, callback, actualContext, unsubscribe);

    // Return the original callback (Firebase v8 behavior)
    return callback;
  }

  /**
   * Unsubscribe from events.
   *
   * **Firebase v8 behavior**: Can remove specific listeners by callback reference.
   *
   * - `off()` - removes all listeners on this specific query (or all queries if base ref)
   * - `off('value')` - removes all 'value' listeners on this specific query
   * - `off('value', callback)` - removes callback (any context) from ANY query at this path
   * - `off('value', callback, context)` - removes specific callback+context combo
   */
  off(eventType?: EventType, callback?: SnapshotCallback, context?: unknown): void {
    this._db._unregisterCallback(this.path, this.queryIdentifier, eventType, callback, context);
  }

  // ============================================
  // OnDisconnect
  // ============================================

  onDisconnect(): OnDisconnect {
    return this._modernRef.onDisconnect();
  }

  // ============================================
  // Query Modifiers
  // ============================================

  orderByKey(): DatabaseReference {
    return new DatabaseReference(this._db, this._modernRef.orderByKey());
  }

  orderByPriority(): DatabaseReference {
    return new DatabaseReference(this._db, this._modernRef.orderByPriority());
  }

  orderByChild(path: string): DatabaseReference {
    return new DatabaseReference(this._db, this._modernRef.orderByChild(path));
  }

  orderByValue(): DatabaseReference {
    return new DatabaseReference(this._db, this._modernRef.orderByValue());
  }

  limitToFirst(limit: number): DatabaseReference {
    return new DatabaseReference(this._db, this._modernRef.limitToFirst(limit));
  }

  limitToLast(limit: number): DatabaseReference {
    return new DatabaseReference(this._db, this._modernRef.limitToLast(limit));
  }

  startAt(value?: unknown, key?: string): DatabaseReference {
    return new DatabaseReference(this._db, this._modernRef.startAt(value, key));
  }

  startAfter(value?: unknown, key?: string): DatabaseReference {
    return new DatabaseReference(this._db, this._modernRef.startAfter(value, key));
  }

  endAt(value?: unknown, key?: string): DatabaseReference {
    return new DatabaseReference(this._db, this._modernRef.endAt(value, key));
  }

  endBefore(value?: unknown, key?: string): DatabaseReference {
    return new DatabaseReference(this._db, this._modernRef.endBefore(value, key));
  }

  equalTo(value: unknown, key?: string): DatabaseReference {
    return new DatabaseReference(this._db, this._modernRef.equalTo(value, key));
  }

  // ============================================
  // Utility
  // ============================================

  isEqual(other: DatabaseReference | null): boolean {
    if (!other) return false;
    return this._modernRef.isEqual(other._modernRef);
  }

  toString(): string {
    return this._modernRef.toString();
  }

  toJSON(): string {
    return this._modernRef.toJSON();
  }
}

/**
 * Firebase v8 compatible ThenableReference.
 */
export class ThenableReference extends DatabaseReference implements PromiseLike<DatabaseReference> {
  private readonly _modernThenable: ModernThenableReference;

  constructor(db: LarkDatabase, modernThenable: ModernThenableReference) {
    super(db, modernThenable);
    this._modernThenable = modernThenable;
  }

  then<TResult1 = DatabaseReference, TResult2 = never>(
    onfulfilled?: ((value: DatabaseReference) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): Promise<TResult1 | TResult2> {
    // Wrap the result in our compat DatabaseReference
    return this._modernThenable.then(
      onfulfilled ? (ref) => onfulfilled(new DatabaseReference(this.database, ref)) : undefined,
      onrejected
    );
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | undefined | null
  ): Promise<DatabaseReference | TResult> {
    return this._modernThenable.catch(onrejected).then(
      (ref) => new DatabaseReference(this.database, ref as ModernDatabaseReference)
    );
  }
}

/**
 * Firebase v8 compatible LarkDatabase.
 * Returns Firebase v8 compatible references.
 */
export class LarkDatabase {
  private readonly _modernDb: ModernLarkDatabase;

  /**
   * Global callback registry for Firebase v8 compatibility.
   * Structure: path -> eventType -> callback -> unsubscribe function
   */
  private readonly _callbackRegistry: CallbackRegistry = new Map();

  static ServerValue = ServerValue;

  constructor(databaseId: string, options: ConnectOptions = {}) {
    this._modernDb = new ModernLarkDatabase(databaseId, options);
  }

  // ============================================
  // Internal: Callback Registry Management
  // ============================================

  /**
   * @internal Register a callback in the global registry.
   */
  _registerCallback(
    path: string,
    queryId: string,
    eventType: EventType,
    callback: SnapshotCallback,
    context: unknown,
    unsubscribe: () => void
  ): void {
    if (!this._callbackRegistry.has(path)) {
      this._callbackRegistry.set(path, new Map());
    }
    const pathMap = this._callbackRegistry.get(path)!;

    if (!pathMap.has(queryId)) {
      pathMap.set(queryId, new Map());
    }
    const queryMap = pathMap.get(queryId)!;

    if (!queryMap.has(eventType)) {
      queryMap.set(eventType, []);
    }
    const registrations = queryMap.get(eventType)!;

    registrations.push({ callback, context, unsubscribe });
  }

  /**
   * @internal Unregister callbacks from the global registry.
   *
   * Behavior:
   * - With callback+context: Finds and removes that specific callback+context combo from ANY query
   * - With callback only: Removes ALL registrations of that callback (any context) from ANY query
   * - Without callback: Removes all callbacks from the specified query only
   *   - If queryId is 'default' (base ref), removes from ALL queries at the path
   */
  _unregisterCallback(
    path: string,
    queryId: string,
    eventType?: EventType,
    callback?: SnapshotCallback,
    context?: unknown
  ): void {
    const pathMap = this._callbackRegistry.get(path);
    if (!pathMap) return;

    // If a specific callback is provided, search ALL queries at this path
    if (callback) {
      const hasContext = arguments.length >= 5; // context was explicitly passed

      for (const [qId, queryMap] of pathMap) {
        const eventTypes = eventType ? [eventType] : Array.from(queryMap.keys());

        for (const eType of eventTypes) {
          const registrations = queryMap.get(eType);
          if (!registrations) continue;

          // Find matching registrations
          const indicesToRemove: number[] = [];
          for (let i = 0; i < registrations.length; i++) {
            const reg = registrations[i];
            if (reg.callback === callback) {
              // If context was provided, must match; otherwise remove any context
              if (!hasContext || reg.context === context) {
                indicesToRemove.push(i);
              }
            }
          }

          // Remove in reverse order to preserve indices
          for (let i = indicesToRemove.length - 1; i >= 0; i--) {
            const idx = indicesToRemove[i];
            registrations[idx].unsubscribe();
            registrations.splice(idx, 1);
          }

          // Clean up empty arrays
          if (registrations.length === 0) {
            queryMap.delete(eType);
          }
        }

        this._cleanupEmptyMaps(path, qId);
      }
      return;
    }

    // No specific callback - remove based on queryId
    const isBaseRef = queryId === 'default';

    if (isBaseRef) {
      // Base ref: remove from ALL queries at this path
      if (!eventType) {
        // off() - remove everything at this path
        for (const [, queryMap] of pathMap) {
          for (const [, registrations] of queryMap) {
            for (const reg of registrations) {
              reg.unsubscribe();
            }
          }
        }
        this._callbackRegistry.delete(path);
      } else {
        // off('value') - remove all 'value' listeners from all queries
        for (const [qId, queryMap] of pathMap) {
          const registrations = queryMap.get(eventType);
          if (registrations) {
            for (const reg of registrations) {
              reg.unsubscribe();
            }
            queryMap.delete(eventType);
            this._cleanupEmptyMaps(path, qId);
          }
        }
      }
    } else {
      // Query ref: remove only from this specific query
      const queryMap = pathMap.get(queryId);
      if (!queryMap) return;

      if (!eventType) {
        // off() on query - remove all listeners for this query
        for (const [, registrations] of queryMap) {
          for (const reg of registrations) {
            reg.unsubscribe();
          }
        }
        pathMap.delete(queryId);
        if (pathMap.size === 0) {
          this._callbackRegistry.delete(path);
        }
      } else {
        // off('value') on query - remove all 'value' listeners for this query
        const registrations = queryMap.get(eventType);
        if (registrations) {
          for (const reg of registrations) {
            reg.unsubscribe();
          }
          queryMap.delete(eventType);
          this._cleanupEmptyMaps(path, queryId);
        }
      }
    }
  }

  /**
   * @internal Clean up empty nested maps in the registry.
   */
  private _cleanupEmptyMaps(path: string, queryId?: string): void {
    const pathMap = this._callbackRegistry.get(path);
    if (!pathMap) return;

    if (queryId) {
      const queryMap = pathMap.get(queryId);
      if (queryMap && queryMap.size === 0) {
        pathMap.delete(queryId);
      }
    }

    if (pathMap.size === 0) {
      this._callbackRegistry.delete(path);
    }
  }

  // ============================================
  // Connection State (delegated)
  // ============================================

  get connected(): boolean {
    return this._modernDb.connected;
  }

  get reconnecting(): boolean {
    return this._modernDb.reconnecting;
  }

  get state(): string {
    return this._modernDb.state;
  }

  get auth(): AuthInfo | null {
    return this._modernDb.auth;
  }

  get volatilePaths(): string[] {
    return this._modernDb.volatilePaths;
  }

  get transportType(): 'websocket' | 'webtransport' | null {
    return this._modernDb.transportType;
  }

  get serverTimeOffset(): number {
    return this._modernDb.serverTimeOffset;
  }

  hasPendingWrites(): boolean {
    return this._modernDb.hasPendingWrites();
  }

  getPendingWriteCount(): number {
    return this._modernDb.getPendingWriteCount();
  }

  clearPendingWrites(): void {
    this._modernDb.clearPendingWrites();
  }

  // ============================================
  // Connection Management (delegated)
  // ============================================

  async connect(): Promise<void> {
    return this._modernDb.connect();
  }

  async disconnect(): Promise<void> {
    // Clear the callback registry on disconnect
    this._callbackRegistry.clear();
    return this._modernDb.disconnect();
  }

  goOffline(): void {
    this._modernDb.goOffline();
  }

  goOnline(): void {
    this._modernDb.goOnline();
  }

  // ============================================
  // Reference Access
  // ============================================

  /**
   * Get a Firebase v8 compatible reference to a path.
   */
  ref(path: string = ''): DatabaseReference {
    return new DatabaseReference(this, this._modernDb.ref(path));
  }

  // ============================================
  // Transactions (delegated)
  // ============================================

  async transaction(operations: TransactionOp[] | TransactionObject): Promise<void> {
    return this._modernDb.transaction(operations);
  }

  // ============================================
  // Connection Events (delegated)
  // ============================================

  onConnect(callback: () => void): () => void {
    return this._modernDb.onConnect(callback);
  }

  onDisconnect(callback: () => void): () => void {
    return this._modernDb.onDisconnect(callback);
  }

  onError(callback: (error: Error) => void): () => void {
    return this._modernDb.onError(callback);
  }

  onReconnecting(callback: () => void): () => void {
    return this._modernDb.onReconnecting(callback);
  }

  onAuthStateChanged(callback: (auth: AuthInfo | null) => void): () => void {
    return this._modernDb.onAuthStateChanged(callback);
  }

  // ============================================
  // Authentication Management (delegated)
  // ============================================

  async signIn(token: string): Promise<void> {
    return this._modernDb.signIn(token);
  }

  async signOut(): Promise<void> {
    return this._modernDb.signOut();
  }
}

// Re-export types and utilities that don't need wrapping
export {
  DataSnapshot,
  OnDisconnect,
  LarkError,
  ServerValue,
  generatePushId,
  isVolatilePath,
  PendingWriteManager,
};

export type {
  ConnectOptions,
  AuthInfo,
  TransactionOp,
  TransactionSetOp,
  TransactionUpdateOp,
  TransactionDeleteOp,
  TransactionConditionOp,
  TransactionObject,
  SnapshotCallback,
  QueryState,
  TransactionResult,
  EventType,
  QueryParams,
  TransportType,
};
