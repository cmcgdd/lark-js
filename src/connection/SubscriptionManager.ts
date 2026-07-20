/**
 * SubscriptionManager - manages Views and routes events to callbacks.
 *
 * Refactored to use View-based architecture:
 * - Each subscription path has a single View
 * - Each View maintains its own cache and ordered children
 * - No shared global cache
 *
 * Handles the delta-based protocol where server sends 'put' and 'patch' events.
 * Client generates child_added, child_changed, child_removed, child_moved events locally.
 */

import type { DataSnapshot } from '../DataSnapshot';
import { EventType } from '../protocol/constants';
import { EventMessage, PutEventMessage, PatchEventMessage, QueryParams } from '../protocol/messages';
import { getValueAtPath, joinPath, normalizePath } from '../utils/path';
import { getSortValue } from '../utils/sort';
import { View, SnapshotCallback } from './View';

export { SnapshotCallback } from './View';

export class SubscriptionManager {
  // viewKey (path:queryIdentifier) -> View
  // Each unique path+query combination gets its own View
  private views = new Map<string, View>();

  // path -> Set of queryIdentifiers for that path
  // Used to find all Views at a path when events arrive
  private pathToQueryIds = new Map<string, Set<string>>();

  // Tag counter for generating unique tags per non-default query
  // Tags are client-local and used to route server events to correct View
  private nextTag = 1;

  // tag -> viewKey mapping for routing tagged events
  private tagToViewKey = new Map<number, string>();

  // viewKey -> tag mapping for unsubscribe
  private viewKeyToTag = new Map<string, number>();

  // Callback to send subscribe message to server
  private sendSubscribe: ((path: string, queryParams?: QueryParams, tag?: number) => Promise<void>) | null = null;

  // Callback to send unsubscribe message to server (includes queryParams and tag for server to identify subscription)
  private sendUnsubscribe: ((path: string, queryParams?: QueryParams, tag?: number) => Promise<void>) | null = null;

  // Callback to create DataSnapshot from event data
  private createSnapshot:
    | ((path: string, value: unknown, volatile: boolean, serverTimestamp?: number, orderedKeys?: string[]) => DataSnapshot)
    | null = null;

  /**
   * Initialize the manager with server communication callbacks.
   */
  initialize(options: {
    sendSubscribe: (path: string, queryParams?: QueryParams, tag?: number) => Promise<void>;
    sendUnsubscribe: (path: string, queryParams?: QueryParams, tag?: number) => Promise<void>;
    createSnapshot: (path: string, value: unknown, volatile: boolean, serverTimestamp?: number, orderedKeys?: string[]) => DataSnapshot;
  }): void {
    this.sendSubscribe = options.sendSubscribe;
    this.sendUnsubscribe = options.sendUnsubscribe;
    this.createSnapshot = options.createSnapshot;
  }

  /**
   * Create a view key from path and query identifier.
   */
  private makeViewKey(path: string, queryIdentifier: string): string {
    return `${path}:${queryIdentifier}`;
  }

  /**
   * Get all Views at a given path (across all query identifiers).
   */
  private getViewsAtPath(path: string): View[] {
    const queryIds = this.pathToQueryIds.get(path);
    if (!queryIds || queryIds.size === 0) {
      return [];
    }

    const views: View[] = [];
    for (const queryId of queryIds) {
      const viewKey = this.makeViewKey(path, queryId);
      const view = this.views.get(viewKey);
      if (view) {
        views.push(view);
      }
    }
    return views;
  }

  /**
   * Subscribe to events at a path.
   * Returns an unsubscribe function.
   */
  subscribe(path: string, eventType: EventType, callback: SnapshotCallback, queryParams?: QueryParams, queryIdentifier?: string): () => void {
    const normalizedPath = path;
    const queryId = queryIdentifier ?? 'default';
    const viewKey = this.makeViewKey(normalizedPath, queryId);
    const isNonDefaultQuery = queryId !== 'default';

    // Get or create View for this path+query combination
    let view = this.views.get(viewKey);
    const isNewView = !view;
    let queryParamsChanged = false;
    let tag: number | undefined;

    if (!view) {
      view = new View(normalizedPath, queryParams);
      this.views.set(viewKey, view);

      // Track this query ID for the path
      if (!this.pathToQueryIds.has(normalizedPath)) {
        this.pathToQueryIds.set(normalizedPath, new Set());
      }
      this.pathToQueryIds.get(normalizedPath)!.add(queryId);

      // Generate tag for non-default queries
      if (isNonDefaultQuery) {
        tag = this.nextTag++;
        this.tagToViewKey.set(tag, viewKey);
        this.viewKeyToTag.set(viewKey, tag);
      }
    } else {
      // Check if queryParams changed - update View to match latest subscription
      // (This should rarely happen since same queryId means same query)
      queryParamsChanged = view.updateQueryParams(queryParams);
      // Get existing tag for this view
      tag = this.viewKeyToTag.get(viewKey);
    }

    // Add callback to view
    const unsubscribe = view.addCallback(eventType, callback);

    // Wrap unsubscribe to handle cleanup
    const wrappedUnsubscribe = () => {
      this.unsubscribeCallback(normalizedPath, eventType, callback, queryId);
    };

    // If this is a new view or queryParams changed, send subscribe to server
    // (We no longer send event types - server sends all data changes, client filters locally)
    // BUT only if there's no ancestor with a complete view (loadsAllData) that covers this path
    if (isNewView || queryParamsChanged) {
      // Check if an ancestor has a complete view that can provide data for this path
      // If so, we don't need our own server subscription
      const hasAncestorComplete = this.hasAncestorCompleteView(normalizedPath);

      if (!hasAncestorComplete) {
        // Fire and forget - we don't wait for the server
        // Include tag for non-default queries
        this.sendSubscribe?.(normalizedPath, view.queryParams ?? undefined, tag).catch((err) => {
          console.error('Failed to subscribe:', err);
        });
      }
    }

    // If the View already has cached data, fire initial events to the new callback
    // This ensures new subscribers get current state even if View already existed
    if (!isNewView && view.hasReceivedInitialSnapshot) {
      this.fireInitialEventsToCallback(view, eventType, callback);
    }

    return wrappedUnsubscribe;
  }

  /**
   * Fire initial events to a newly added callback from cached data.
   * This ensures new subscribers get current state even if View already existed.
   */
  private fireInitialEventsToCallback(
    view: View,
    eventType: EventType,
    callback: SnapshotCallback
  ): void {
    const cache = view.getCache();

    if (eventType === 'value') {
      // Fire value event with full cached data
      // Pass orderedChildren so forEach() iterates in correct order
      const snapshot = this.createSnapshot?.(view.path, cache, false, undefined, view.orderedChildren);
      if (snapshot) {
        try {
          callback(snapshot, undefined);
        } catch (err) {
          console.error('Error in value subscription callback:', err);
        }
      }
    } else if (eventType === 'child_added') {
      // Fire child_added for each child in order
      const orderedChildren = view.orderedChildren;
      for (let i = 0; i < orderedChildren.length; i++) {
        const childKey = orderedChildren[i];
        const previousChildKey = i > 0 ? orderedChildren[i - 1] : null;
        const childPath = joinPath(view.path, childKey);
        const { value: childValue } = view.getCacheValue(childPath);
        const snapshot = this.createSnapshot?.(childPath, childValue, false);
        if (snapshot) {
          try {
            callback(snapshot, previousChildKey);
          } catch (err) {
            console.error('Error in child_added subscription callback:', err);
          }
        }
      }
    }
    // child_changed, child_removed, child_moved don't need initial events
  }

  /**
   * Remove a specific callback from a subscription.
   */
  unsubscribeCallback(path: string, eventType: EventType, callback: SnapshotCallback, queryIdentifier?: string): void {
    const queryId = queryIdentifier ?? 'default';
    const viewKey = this.makeViewKey(path, queryId);
    const view = this.views.get(viewKey);
    if (!view) return;

    // Capture queryParams and tag before removing the view
    const queryParams = view.queryParams ?? undefined;
    const tag = this.viewKeyToTag.get(viewKey);

    view.removeCallback(eventType, callback);

    // If no more callbacks for this view, remove it entirely
    if (!view.hasCallbacks()) {
      this.views.delete(viewKey);

      // Remove from pathToQueryIds
      const queryIds = this.pathToQueryIds.get(path);
      if (queryIds) {
        queryIds.delete(queryId);
        if (queryIds.size === 0) {
          this.pathToQueryIds.delete(path);
        }
      }

      // Clean up tag mappings
      if (tag !== undefined) {
        this.tagToViewKey.delete(tag);
        this.viewKeyToTag.delete(viewKey);
      }

      // Send unsubscribe for this specific View (with its queryParams and tag)
      this.sendUnsubscribe?.(path, queryParams, tag).catch((err) => {
        console.error('Failed to unsubscribe:', err);
      });
    }
  }

  /**
   * Remove all subscriptions of a specific event type at a path.
   * This affects ALL Views at the path (across all query identifiers).
   */
  unsubscribeEventType(path: string, eventType: EventType): void {
    const normalizedPath = path;
    const queryIds = this.pathToQueryIds.get(normalizedPath);
    if (!queryIds) return;

    // Iterate over a copy since we may delete during iteration
    for (const queryId of Array.from(queryIds)) {
      const viewKey = this.makeViewKey(normalizedPath, queryId);
      const view = this.views.get(viewKey);
      if (!view) continue;

      // Capture queryParams before potentially removing the view
      const queryParams = view.queryParams ?? undefined;

      view.removeAllCallbacks(eventType);

      if (!view.hasCallbacks()) {
        // View is now empty - remove it and send unsubscribe
        this.views.delete(viewKey);
        queryIds.delete(queryId);

        this.sendUnsubscribe?.(normalizedPath, queryParams).catch((err) => {
          console.error('Failed to unsubscribe:', err);
        });
      }
      // If view still has callbacks, keep the subscription - server sends all data changes
    }

    // Clean up pathToQueryIds if empty
    if (queryIds.size === 0) {
      this.pathToQueryIds.delete(normalizedPath);
    }
  }

  /**
   * Remove ALL subscriptions at a path.
   * This affects ALL Views at the path (across all query identifiers).
   */
  unsubscribeAll(path: string): void {
    const normalizedPath = path;
    const queryIds = this.pathToQueryIds.get(normalizedPath);
    if (!queryIds || queryIds.size === 0) return;

    // Remove all Views at this path and send unsubscribe for each
    for (const queryId of queryIds) {
      const viewKey = this.makeViewKey(normalizedPath, queryId);
      const view = this.views.get(viewKey);
      if (view) {
        // Capture queryParams before clearing
        const queryParams = view.queryParams ?? undefined;
        view.clear();
        this.views.delete(viewKey);

        // Send unsubscribe for this specific View
        this.sendUnsubscribe?.(normalizedPath, queryParams).catch((err) => {
          console.error('Failed to unsubscribe:', err);
        });
      }
    }
    this.pathToQueryIds.delete(normalizedPath);
  }

  /**
   * Handle an incoming event message from the server.
   * Server sends 'put' or 'patch' events; we generate child_* events client-side.
   * Volatile events use `x: true` flag on patch events.
   */
  handleEvent(message: EventMessage): void {
    if (message.ev === 'put') {
      this.handlePutEvent(message);
    } else if (message.ev === 'patch') {
      this.handlePatchEvent(message);
    } else {
      console.warn('Unknown event type:', (message as { ev: string }).ev);
    }
  }

  /**
   * Get View by tag. Returns undefined if tag not found.
   */
  private getViewByTag(tag: number): View | undefined {
    const viewKey = this.tagToViewKey.get(tag);
    if (!viewKey) return undefined;
    return this.views.get(viewKey);
  }

  /**
   * Handle a 'put' event - single path change.
   * Routes to specific View by tag if present, otherwise to default View at path.
   */
  private handlePutEvent(message: PutEventMessage): void {
    const subscriptionPath = message.sp;
    const relativePath = message.p;
    const value = message.v;
    const isVolatile = message.x ?? false;
    const serverTimestamp = message.ts;
    const tag = message.tag;

    // Skip if no value to apply
    if (value === undefined) return;

    // Route by tag if present
    if (tag !== undefined) {
      const view = this.getViewByTag(tag);
      if (view) {
        this.applyServerUpdateToView(view, [{ relativePath, value }], isVolatile, serverTimestamp);
      }
      return;
    }

    // No tag - route to default View at this path
    const defaultViewKey = this.makeViewKey(subscriptionPath, 'default');
    const view = this.views.get(defaultViewKey);
    if (view) {
      this.applyServerUpdateToView(view, [{ relativePath, value }], isVolatile, serverTimestamp);
    }
  }

  /**
   * Handle a 'patch' event - multi-path change.
   * Routes to specific View by tag if present, otherwise to default View at path.
   */
  private handlePatchEvent(message: PatchEventMessage): void {
    const subscriptionPath = message.sp;
    const basePath = message.p;
    const patches = message.v;
    const isVolatile = message.x ?? false;
    const serverTimestamp = message.ts;
    const tag = message.tag;

    // Skip if no patches to apply
    if (!patches) return;

    // Build updates array from patches
    const updates: Array<{ relativePath: string; value: unknown }> = [];
    for (const [relativePath, patchValue] of Object.entries(patches)) {
      // Build the full relative path from base + relativePath
      let fullRelativePath: string;
      if (basePath === '/') {
        fullRelativePath = relativePath.startsWith('/') ? relativePath : '/' + relativePath;
      } else {
        fullRelativePath = joinPath(basePath, relativePath);
      }
      updates.push({ relativePath: fullRelativePath, value: patchValue });
    }

    // Route by tag if present
    if (tag !== undefined) {
      const view = this.getViewByTag(tag);
      if (view) {
        this.applyServerUpdateToView(view, updates, isVolatile, serverTimestamp);
      }
      return;
    }

    // No tag - route to default View at this path
    const defaultViewKey = this.makeViewKey(subscriptionPath, 'default');
    const view = this.views.get(defaultViewKey);
    if (view) {
      this.applyServerUpdateToView(view, updates, isVolatile, serverTimestamp);
    }
  }

  /**
   * Detect and fire child_moved events for children that changed position OR sort value.
   *
   * child_moved fires for ANY priority/sort value change, regardless of whether
   * the position actually changes.
   *
   * IMPORTANT: child_moved should only fire for children whose VALUE or PRIORITY changed.
   * Children that are merely "displaced" by another child moving should NOT fire child_moved.
   *
   * @param affectedChildren - Only check these children for moves. If not provided,
   *                           checks all children (for full snapshots where we compare values).
   * @param previousDisplayCache - Previous display cache for comparing sort values
   * @param currentDisplayCache - Current display cache for comparing sort values
   */
  private detectAndFireMoves(
    view: View,
    previousOrder: string[],
    currentOrder: string[],
    previousPositions: Map<string, number>,
    currentPositions: Map<string, number>,
    previousChildSet: Set<string>,
    currentChildSet: Set<string>,
    childMovedSubs: Array<{ callback: SnapshotCallback }>,
    isVolatile: boolean,
    serverTimestamp?: number,
    affectedChildren?: Set<string>,
    previousDisplayCache?: Record<string, unknown> | null,
    currentDisplayCache?: Record<string, unknown> | null
  ): void {
    if (childMovedSubs.length === 0) return;

    // Determine which children to check for moves
    // For delta updates, only check children that were actually modified
    // For full snapshots, affectedChildren will contain children with changed values
    const childrenToCheck = affectedChildren ?? new Set(currentOrder);

    const queryParams = view.queryParams;

    // For each affected child that exists in both old and new, check if position or sort value changed
    for (const key of childrenToCheck) {
      if (!previousChildSet.has(key) || !currentChildSet.has(key)) {
        continue; // Skip newly added or removed children
      }

      const oldPos = previousPositions.get(key);
      const newPos = currentPositions.get(key);

      if (oldPos === undefined || newPos === undefined) {
        continue;
      }

      // Check if the relative order changed
      const oldPrevKey = oldPos > 0 ? previousOrder[oldPos - 1] : null;
      const newPrevKey = newPos > 0 ? currentOrder[newPos - 1] : null;

      let positionChanged = oldPrevKey !== newPrevKey;

      // Also check if sort value changed
      // Case 2003: fire child_moved for ANY priority change (when ordering by priority)
      // For orderByChild, only fire if position actually changed
      let sortValueChanged = false;
      let isPriorityOrdering = false;
      if (previousDisplayCache && currentDisplayCache) {
        const prevValue = previousDisplayCache[key];
        const currValue = currentDisplayCache[key];
        const prevSortValue = getSortValue(prevValue, queryParams);
        const currSortValue = getSortValue(currValue, queryParams);
        // Compare sort values - use JSON.stringify for deep comparison
        sortValueChanged = JSON.stringify(prevSortValue) !== JSON.stringify(currSortValue);

        // Check if we're ordering by priority (default when no orderBy, or explicit orderByPriority)
        // Note: When queryParams exists but orderBy is undefined, we default to priority ordering
        isPriorityOrdering = !queryParams?.orderBy || queryParams.orderBy === 'priority';
      }

      // Behavior:
      // - For priority ordering: child_moved fires when priority changes
      // - For orderByChild/orderByValue/orderByKey: child_moved only fires if position changes
      // - child_moved does NOT fire for children merely "displaced" by other children moving
      //
      // For delta updates (affectedChildren provided): the affected child's value changed
      // For full snapshots (affectedChildren undefined): only fire if this child's sort value changed
      let shouldFire: boolean;
      if (affectedChildren) {
        // Delta update - this child was modified
        // Fire if position changed, or if priority changed (for priority ordering)
        shouldFire = positionChanged || (isPriorityOrdering && sortValueChanged);
      } else {
        // Full snapshot - only fire if this child's own sort value changed
        // (and only for priority ordering, per Case 2003)
        shouldFire = isPriorityOrdering && sortValueChanged;
      }

      if (shouldFire) {
        this.fireChildMoved(view, key, childMovedSubs, newPrevKey, isVolatile, serverTimestamp);
      }
    }
  }

  /**
   * Fire child_added callbacks for a child key.
   */
  private fireChildAdded(
    view: View,
    childKey: string,
    subs: Array<{ callback: SnapshotCallback }>,
    previousChildKey: string | null,
    isVolatile: boolean,
    serverTimestamp?: number
  ): void {
    if (subs.length === 0) return;

    const childPath = joinPath(view.path, childKey);
    const { value: childValue } = view.getCacheValue(childPath);
    const snapshot = this.createSnapshot?.(childPath, childValue, isVolatile, serverTimestamp);

    if (snapshot) {
      for (const entry of subs) {
        try {
          entry.callback(snapshot, previousChildKey);
        } catch (err) {
          console.error('Error in child_added subscription callback:', err);
        }
      }
    }
  }

  /**
   * Fire child_changed callbacks for a child key.
   */
  private fireChildChanged(
    view: View,
    childKey: string,
    subs: Array<{ callback: SnapshotCallback }>,
    previousChildKey: string | null,
    isVolatile: boolean,
    serverTimestamp?: number
  ): void {
    if (subs.length === 0) return;

    const childPath = joinPath(view.path, childKey);
    const { value: childValue } = view.getCacheValue(childPath);
    const snapshot = this.createSnapshot?.(childPath, childValue, isVolatile, serverTimestamp);

    if (snapshot) {
      for (const entry of subs) {
        try {
          entry.callback(snapshot, previousChildKey);
        } catch (err) {
          console.error('Error in child_changed subscription callback:', err);
        }
      }
    }
  }

  /**
   * Fire child_removed callbacks for a child key.
   */
  private fireChildRemoved(
    view: View,
    childKey: string,
    subs: Array<{ callback: SnapshotCallback }>,
    isVolatile: boolean,
    serverTimestamp?: number,
    previousValue?: unknown
  ): void {
    if (subs.length === 0) return;

    const childPath = joinPath(view.path, childKey);
    // Pass the previous value for removed children, not null
    const snapshot = this.createSnapshot?.(childPath, previousValue ?? null, isVolatile, serverTimestamp);

    if (snapshot) {
      for (const entry of subs) {
        try {
          // previousChildKey is not meaningful for removed children
          entry.callback(snapshot, undefined);
        } catch (err) {
          console.error('Error in child_removed subscription callback:', err);
        }
      }
    }
  }

  /**
   * Fire child_moved callbacks for a child key.
   */
  private fireChildMoved(
    view: View,
    childKey: string,
    subs: Array<{ callback: SnapshotCallback }>,
    previousChildKey: string | null,
    isVolatile: boolean,
    serverTimestamp?: number
  ): void {
    if (subs.length === 0) return;

    const childPath = joinPath(view.path, childKey);
    const { value: childValue } = view.getCacheValue(childPath);
    const snapshot = this.createSnapshot?.(childPath, childValue, isVolatile, serverTimestamp);

    if (snapshot) {
      for (const entry of subs) {
        try {
          entry.callback(snapshot, previousChildKey);
        } catch (err) {
          console.error('Error in child_moved subscription callback:', err);
        }
      }
    }
  }

  /**
   * Handle subscription revocation due to auth change.
   * The server has already removed the subscription, so we just clean up locally.
   * This is different from unsubscribeAll which sends an unsubscribe message.
   */
  handleSubscriptionRevoked(path: string): void {
    const normalizedPath = path;
    const queryIds = this.pathToQueryIds.get(normalizedPath);
    if (!queryIds || queryIds.size === 0) return;

    // Remove all Views at this path locally (don't send unsubscribe, server already revoked)
    for (const queryId of queryIds) {
      const viewKey = this.makeViewKey(normalizedPath, queryId);
      const view = this.views.get(viewKey);
      if (view) {
        // Clean up tag mappings
        const tag = this.viewKeyToTag.get(viewKey);
        if (tag !== undefined) {
          this.tagToViewKey.delete(tag);
          this.viewKeyToTag.delete(viewKey);
        }
        view.clear();
        this.views.delete(viewKey);
      }
    }
    this.pathToQueryIds.delete(normalizedPath);
  }

  /**
   * Clear all subscriptions (e.g., on disconnect).
   */
  clear(): void {
    for (const view of this.views.values()) {
      view.clear();
    }
    this.views.clear();
    this.pathToQueryIds.clear();
    this.tagToViewKey.clear();
    this.viewKeyToTag.clear();
    this.nextTag = 1;
  }

  /**
   * Check if there are any subscriptions at a path (across all query identifiers).
   */
  hasSubscriptions(path: string): boolean {
    const queryIds = this.pathToQueryIds.get(path);
    return queryIds !== undefined && queryIds.size > 0;
  }

  /**
   * Check if a path is "covered" by an active subscription that has received data.
   *
   * A path is covered if:
   * - There's an active subscription at that exact path that has data, OR
   * - There's an active subscription at an ancestor path that has data
   *
   * Note: Any subscription type (value, child_added, child_moved, etc.) receives
   * the initial snapshot from the server and thus has cached data.
   */
  isPathCovered(path: string): boolean {
    const normalized = normalizePath(path);

    // Check exact match
    if (this.hasActiveSubscriptionWithData(normalized)) {
      return true;
    }

    // Check ancestors - walk up the path tree
    const segments = normalized.split('/').filter((s) => s.length > 0);

    for (let i = segments.length - 1; i >= 0; i--) {
      const ancestorPath = i === 0 ? '/' : '/' + segments.slice(0, i).join('/');
      if (this.hasActiveSubscriptionWithData(ancestorPath)) {
        return true;
      }
    }

    // Check root
    if (normalized !== '/' && this.hasActiveSubscriptionWithData('/')) {
      return true;
    }

    return false;
  }

  /**
   * Check if there's an active subscription at a path that has data.
   * A View has data if it has received the initial snapshot OR has pending writes.
   * Any subscription type (value, child_added, child_moved, etc.) counts.
   */
  private hasActiveSubscriptionWithData(path: string): boolean {
    const views = this.getViewsAtPath(path);
    // A View has data if it received initial snapshot OR has pending writes (optimistic)
    return views.some(view => view.hasCallbacks() && (view.hasReceivedInitialSnapshot || view.hasPendingWrites()));
  }

  /**
   * Check if any ancestor path has a "complete" View (one that loadsAllData).
   * A complete View has no limits and no range filters, so it contains all data
   * for its subtree. Child subscriptions can use the ancestor's data instead
   * of creating their own server subscription.
   */
  hasAncestorCompleteView(path: string): boolean {
    const normalized = normalizePath(path);
    const segments = normalized.split('/').filter((s) => s.length > 0);

    // Walk up the path tree checking ancestors
    for (let i = segments.length - 1; i >= 0; i--) {
      const ancestorPath = i === 0 ? '/' : '/' + segments.slice(0, i).join('/');
      const views = this.getViewsAtPath(ancestorPath);
      for (const view of views) {
        if (view.hasCallbacks() && view.loadsAllData() && view.hasReceivedInitialSnapshot) {
          return true;
        }
      }
    }

    // Check root separately if not already checked
    if (normalized !== '/') {
      const rootViews = this.getViewsAtPath('/');
      for (const view of rootViews) {
        if (view.hasCallbacks() && view.loadsAllData() && view.hasReceivedInitialSnapshot) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get a cached value if the path is covered by an active subscription.
   * Returns the value from the first View that has it (typically the default/unfiltered one).
   */
  getCachedValue(path: string): { value: unknown; found: boolean } {
    const normalized = normalizePath(path);

    // First check if the path is covered by a subscription
    if (!this.isPathCovered(normalized)) {
      return { value: undefined, found: false };
    }

    // Try to find a View that covers this path
    // Check exact match first - try all Views at this path
    const exactViews = this.getViewsAtPath(normalized);
    for (const view of exactViews) {
      const result = view.getCacheValue(normalized);
      if (result.found) {
        return result;
      }
    }

    // Check ancestors
    const segments = normalized.split('/').filter((s) => s.length > 0);
    for (let i = segments.length - 1; i >= 0; i--) {
      const ancestorPath = i === 0 ? '/' : '/' + segments.slice(0, i).join('/');
      const ancestorViews = this.getViewsAtPath(ancestorPath);
      for (const view of ancestorViews) {
        // Any subscription with data (initial snapshot or pending writes) can provide cached values
        if (view.hasCallbacks() && (view.hasReceivedInitialSnapshot || view.hasPendingWrites())) {
          const result = view.getCacheValue(normalized);
          if (result.found) {
            return result;
          }
        }
      }
    }

    // Check root
    if (normalized !== '/') {
      const rootViews = this.getViewsAtPath('/');
      for (const view of rootViews) {
        // Any subscription with data (initial snapshot or pending writes) can provide cached values
        if (view.hasCallbacks() && (view.hasReceivedInitialSnapshot || view.hasPendingWrites())) {
          const result = view.getCacheValue(normalized);
          if (result.found) {
            return result;
          }
        }
      }
    }

    return { value: undefined, found: false };
  }

  /**
   * Get the cache size (for testing/debugging).
   * Returns the number of Views.
   */
  get cacheSize(): number {
    return this.views.size;
  }

  /**
   * Clear only the cache, preserving subscription registrations.
   * Used when preparing for reconnect - we keep subscriptions but will get fresh data.
   */
  clearCacheOnly(): void {
    for (const view of this.views.values()) {
      view.clearServerCache();
    }
  }

  /**
   * Re-subscribe to all active subscriptions.
   * Used after reconnecting to restore subscriptions on the server.
   */
  async resubscribeAll(): Promise<void> {
    for (const view of this.views.values()) {
      if (view.hasCallbacks()) {
        try {
          await this.sendSubscribe?.(view.path, view.queryParams ?? undefined);
        } catch (err) {
          console.error(`Failed to resubscribe to ${view.path}:`, err);
          // Continue with other subscriptions even if one fails
        }
      }
    }
  }

  /**
   * Get information about active subscriptions (for debugging).
   */
  getActiveSubscriptions(): Array<{ path: string; eventTypes: EventType[]; queryParams?: QueryParams }> {
    const result: Array<{ path: string; eventTypes: EventType[]; queryParams?: QueryParams }> = [];

    for (const view of this.views.values()) {
      const eventTypes = view.getEventTypes();
      const queryParams = view.queryParams ?? undefined;
      result.push({ path: view.path, eventTypes, queryParams });
    }

    return result;
  }

  /**
   * Get a View by path (for testing/debugging).
   * Returns the first View at this path (default query identifier).
   */
  getView(path: string): View | undefined {
    // Try default query identifier first
    const defaultView = this.views.get(this.makeViewKey(path, 'default'));
    if (defaultView) return defaultView;

    // Otherwise return any View at this path
    const views = this.getViewsAtPath(path);
    return views.length > 0 ? views[0] : undefined;
  }

  // ============================================
  // Shared Write Application (used by server events and optimistic writes)
  // ============================================

  /**
   * Recursively sort object keys for consistent comparison.
   * This ensures {a:1, b:2} and {b:2, a:1} compare as equal.
   * Uses simple alphabetical sorting since we're just checking data equality,
   * not display order.
   */
  private sortKeysForComparison(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.sortKeysForComparison(item));
    }

    // Create a new object with keys in sorted order
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const sorted: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      sorted[key] = this.sortKeysForComparison(obj[key]);
    }
    return sorted;
  }

  /**
   * Serialize cache with sorted keys for consistent comparison.
   */
  private serializeCacheForComparison(cache: unknown): string {
    const sorted = this.sortKeysForComparison(cache);
    return JSON.stringify(sorted);
  }

  /**
   * Apply write(s) to a View's cache and fire appropriate events.
   * This is the core logic shared between server events and optimistic writes.
   *
   * @param view - The View to update
   * @param updates - Array of {relativePath, value} pairs to apply
   * @param isVolatile - Whether this is a volatile update
   * @param serverTimestamp - Optional server timestamp
   */
  private applyServerUpdateToView(
    view: View,
    updates: Array<{ relativePath: string; value: unknown }>,
    isVolatile: boolean,
    serverTimestamp?: number
  ): void {
    // Capture previous display state (for change detection)
    const previousOrder = view.orderedChildren;
    const previousChildSet = new Set(previousOrder);
    const isFirstSnapshot = !view.hasReceivedInitialSnapshot && !view.hasPendingWrites();

    // For non-volatile writes, capture previous display cache state for deduplication.
    // Volatile writes skip deduplication entirely because:
    // 1. Server does NOT echo our volatile writes back (fire-and-forget)
    // 2. Incoming volatile events are from OTHER clients and should always fire
    // 3. Skipping serialization reduces overhead on the hot path (30+ Hz updates)
    let previousCacheJson: string | null = null;
    let previousDisplayCache: Record<string, unknown> | null = null;
    if (!isVolatile) {
      const cache = view.getDisplayCache();
      previousDisplayCache = (cache && typeof cache === 'object' && !Array.isArray(cache))
        ? cache as Record<string, unknown>
        : null;
      previousCacheJson = this.serializeCacheForComparison(cache);
    }

    // Track which immediate children are affected (for child_* events)
    const affectedChildren = new Set<string>();
    let isFullSnapshot = false;

    // Apply all updates to SERVER cache (display cache is computed automatically)
    for (const { relativePath, value } of updates) {
      if (relativePath === '/') {
        // Full snapshot replacement
        view.setServerCache(value);
        isFullSnapshot = true;
      } else {
        // Extract immediate child key from the path
        const segments = relativePath.split('/').filter((s) => s.length > 0);
        if (segments.length > 0) {
          affectedChildren.add(segments[0]);
        }

        // Apply the update to server cache
        if (value === null) {
          view.removeServerCacheChild(relativePath);
        } else {
          view.updateServerCacheChild(relativePath, value);
        }
      }
    }

    // Capture current state (from display cache, which includes pending writes)
    const currentOrder = view.orderedChildren;
    const currentChildSet = new Set(currentOrder);

    // Deduplication check for non-volatile writes (skip for volatile and first snapshot)
    // This prevents duplicate events when server confirms our optimistic write.
    // Uses sorted key comparison to handle server returning keys in different order.
    if (!isVolatile && !isFirstSnapshot && previousCacheJson !== null) {
      const currentCacheJson = this.serializeCacheForComparison(view.getDisplayCache());
      if (previousCacheJson === currentCacheJson) {
        return;
      }
    }

    // Fire value callbacks
    const valueSubs = view.getCallbacks('value');
    if (valueSubs.length > 0) {
      const fullValue = view.getDisplayCache();
      // Pass orderedChildren so forEach() iterates in correct order
      const snapshot = this.createSnapshot?.(view.path, fullValue, isVolatile, serverTimestamp, view.orderedChildren);
      if (snapshot) {
        for (const entry of valueSubs) {
          try {
            entry.callback(snapshot, undefined);
          } catch (err) {
            console.error('Error in value subscription callback:', err);
          }
        }
      }
    }

    // Fire child_* events
    const childAddedSubs = view.getCallbacks('child_added');
    const childChangedSubs = view.getCallbacks('child_changed');
    const childRemovedSubs = view.getCallbacks('child_removed');
    const childMovedSubs = view.getCallbacks('child_moved');

    // Skip if no child subscriptions
    if (
      childAddedSubs.length === 0 &&
      childChangedSubs.length === 0 &&
      childRemovedSubs.length === 0 &&
      childMovedSubs.length === 0
    ) {
      return;
    }

    if (isFullSnapshot) {
      // Full snapshot - compare all children
      for (const key of currentOrder) {
        if (!previousChildSet.has(key)) {
          const prevKey = view.getPreviousChildKey(key);
          this.fireChildAdded(view, key, childAddedSubs, prevKey, isVolatile, serverTimestamp);
        }
      }
      for (const key of previousOrder) {
        if (!currentChildSet.has(key)) {
          const prevValue = previousDisplayCache?.[key];
          this.fireChildRemoved(view, key, childRemovedSubs, isVolatile, serverTimestamp, prevValue);
        }
      }
    } else {
      // Delta update - fire events for affected children
      for (const childKey of affectedChildren) {
        const wasPresent = previousChildSet.has(childKey);
        const isPresent = currentChildSet.has(childKey);

        if (!wasPresent && isPresent) {
          const prevKey = view.getPreviousChildKey(childKey);
          this.fireChildAdded(view, childKey, childAddedSubs, prevKey, isVolatile, serverTimestamp);
        } else if (wasPresent && !isPresent) {
          const prevValue = previousDisplayCache?.[childKey];
          this.fireChildRemoved(view, childKey, childRemovedSubs, isVolatile, serverTimestamp, prevValue);
        } else if (wasPresent && isPresent) {
          const prevKey = view.getPreviousChildKey(childKey);
          this.fireChildChanged(view, childKey, childChangedSubs, prevKey, isVolatile, serverTimestamp);
        }
      }
    }

    // Detect and fire child_moved events
    const previousPositions = new Map<string, number>();
    previousOrder.forEach((key, idx) => previousPositions.set(key, idx));
    const currentPositions = new Map<string, number>();
    currentOrder.forEach((key, idx) => currentPositions.set(key, idx));

    // Get current display cache for sort value comparison
    const currentCache = view.getDisplayCache();
    const currentDisplayCache = (currentCache && typeof currentCache === 'object' && !Array.isArray(currentCache))
      ? currentCache as Record<string, unknown>
      : null;

    // For delta updates, only check affected children for moves
    // For full snapshots, we pass undefined which checks all children
    this.detectAndFireMoves(
      view,
      previousOrder,
      currentOrder,
      previousPositions,
      currentPositions,
      previousChildSet,
      currentChildSet,
      childMovedSubs,
      isVolatile,
      serverTimestamp,
      isFullSnapshot ? undefined : affectedChildren,
      previousDisplayCache,
      currentDisplayCache
    );
  }

  // ============================================
  // Pending Writes (for local-first)
  // ============================================

  /**
   * Find all Views that cover a given write path.
   * A View covers a path if the View's path is an ancestor of or equal to the write path.
   */
  findViewsForWritePath(writePath: string): View[] {
    const normalized = normalizePath(writePath);
    const views: View[] = [];

    for (const view of this.views.values()) {
      const viewPath = view.path;
      // Check if viewPath is an ancestor of, equal to, or descendant of the write path
      if (normalized === viewPath) {
        // Exact match - write is directly at View's path
        views.push(view);
      } else if (normalized.startsWith(viewPath + '/')) {
        // Write is INSIDE View's path (write is a descendant)
        views.push(view);
      } else if (viewPath.startsWith(normalized + '/')) {
        // View is INSIDE write path (View is a descendant of write)
        // e.g., writing to /foo affects View at /foo/bar
        views.push(view);
      } else if (viewPath === '/') {
        // Root View is always affected
        views.push(view);
      } else if (normalized === '/') {
        // Write to root affects all Views
        views.push(view);
      }
    }

    return views;
  }

  /**
   * Get pending write IDs for a write path.
   * Returns the union of pending writes from all Views that cover this path.
   */
  getPendingWriteIdsForPath(writePath: string): string[] {
    const views = this.findViewsForWritePath(writePath);
    const allPendingIds = new Set<string>();

    for (const view of views) {
      for (const id of view.getPendingWriteIds()) {
        allPendingIds.add(id);
      }
    }

    return Array.from(allPendingIds);
  }

  /**
   * Track a pending write for all Views that cover the write path.
   */
  /**
   * Track a pending write by request ID.
   * Note: With the dual-cache system, this is now handled by applyOptimisticWrite
   * via addPendingWriteData. This method is kept for API compatibility but is a no-op.
   */
  trackPendingWrite(_writePath: string, _requestId: string): void {
    // No-op: tracking now happens in applyOptimisticWrite via addPendingWriteData
  }

  /**
   * Clear a pending write from all Views (on ack).
   * Fires callbacks only if displayCache changed (e.g., server modified the data).
   * With PUT-before-ACK ordering, this handles the case where server data differs from optimistic.
   */
  clearPendingWrite(requestId: string): void {
    for (const view of this.views.values()) {
      if (!view.isWritePending(requestId)) {
        continue;
      }

      // Capture previous display state
      const previousDisplayCache = view.getDisplayCache() as Record<string, unknown> | null;
      const previousCacheJson = this.serializeCacheForComparison(previousDisplayCache);
      const previousOrder = view.orderedChildren;
      const previousChildSet = new Set(previousOrder);

      // Remove the pending write
      view.removePendingWrite(requestId);

      // Check if display cache changed (server data differs from optimistic)
      const currentCacheJson = this.serializeCacheForComparison(view.getDisplayCache());
      if (previousCacheJson === currentCacheJson) {
        // No change - server data matches optimistic, nothing to do
        continue;
      }

      // Display cache changed - fire callbacks
      const currentOrder = view.orderedChildren;
      const currentChildSet = new Set(currentOrder);

      // Fire value callbacks
      const valueSubs = view.getCallbacks('value');
      if (valueSubs.length > 0) {
        const fullValue = view.getDisplayCache();
        const snapshot = this.createSnapshot?.(view.path, fullValue, false, undefined, view.orderedChildren);
        if (snapshot) {
          for (const entry of valueSubs) {
            try {
              entry.callback(snapshot, undefined);
            } catch (err) {
              console.error('Error in value subscription callback:', err);
            }
          }
        }
      }

      // Fire child_* events
      // Note: We pass skipMoves=true because moves were already fired by the optimistic write.
      // The ack just confirms the write; if server data differs, it will come via PUT event
      // which will fire the correct move events. Firing moves here causes duplicate/wrong events
      // when ACK arrives before PUT due to network ordering.
      this.fireChildEventsForAck(view, previousOrder, previousChildSet, currentOrder, currentChildSet, previousDisplayCache);
    }
  }

  /**
   * Fire child events for ACK handling, skipping child_moved.
   * This is a variant of fireChildEvents that doesn't fire moves because:
   * 1. Moves were already fired optimistically
   * 2. If server modifies data, PUT event will fire correct moves
   * 3. ACK can arrive before PUT, causing incorrect intermediate state
   */
  private fireChildEventsForAck(
    view: View,
    previousOrder: string[],
    previousChildSet: Set<string>,
    currentOrder: string[],
    currentChildSet: Set<string>,
    previousDisplayCache?: Record<string, unknown> | null
  ): void {
    const childAddedSubs = view.getCallbacks('child_added');
    const childChangedSubs = view.getCallbacks('child_changed');
    const childRemovedSubs = view.getCallbacks('child_removed');

    // Skip if no relevant subscriptions
    if (childAddedSubs.length === 0 && childChangedSubs.length === 0 && childRemovedSubs.length === 0) {
      return;
    }

    const displayCache = view.getDisplayCache() as Record<string, unknown> | null;

    // Full comparison of children
    for (const key of currentOrder) {
      if (!previousChildSet.has(key)) {
        // New child added
        if (childAddedSubs.length > 0 && displayCache) {
          const prevKey = view.getPreviousChildKey(key);
          this.fireChildAdded(view, key, childAddedSubs, prevKey, false, undefined);
        }
      } else if (previousDisplayCache && childChangedSubs.length > 0 && displayCache) {
        // Check if value changed
        const prevValue = previousDisplayCache[key];
        const currentValue = displayCache[key];
        const prevJson = this.serializeCacheForComparison(prevValue);
        const currJson = this.serializeCacheForComparison(currentValue);
        if (prevJson !== currJson) {
          const prevKey = view.getPreviousChildKey(key);
          this.fireChildChanged(view, key, childChangedSubs, prevKey, false, undefined);
        }
      }
    }

    // Removed children
    for (const key of previousOrder) {
      if (!currentChildSet.has(key)) {
        if (childRemovedSubs.length > 0) {
          const prevValue = previousDisplayCache?.[key];
          this.fireChildRemoved(view, key, childRemovedSubs, false, undefined, prevValue);
        }
      }
    }
  }

  /**
   * Handle a nack for a pending write.
   * Collects all tainted request IDs and puts affected Views into recovery mode.
   * Returns the affected Views and all tainted request IDs for local rejection.
   */
  /**
   * Handle a write NACK by removing the pending write from affected Views.
   * With the dual-cache system, this automatically reverts to server truth.
   * Returns the affected Views so callbacks can be fired if data changed.
   */
  handleWriteNack(requestId: string): View[] {
    const affectedViews: View[] = [];

    for (const view of this.views.values()) {
      if (view.isWritePending(requestId)) {
        // Capture previous display state
        const previousDisplayCache = view.getDisplayCache() as Record<string, unknown> | null;
        const previousCacheJson = this.serializeCacheForComparison(previousDisplayCache);
        const previousOrder = view.orderedChildren;
        const previousChildSet = new Set(previousOrder);

        // Remove the pending write - displayCache automatically updates
        view.removePendingWrite(requestId);

        // Capture new state
        const currentCacheJson = this.serializeCacheForComparison(view.getDisplayCache());

        // If display cache changed, fire callbacks
        if (previousCacheJson !== currentCacheJson) {
          affectedViews.push(view);

          const currentOrder = view.orderedChildren;
          const currentChildSet = new Set(currentOrder);

          // Fire value callbacks
          const valueSubs = view.getCallbacks('value');
          if (valueSubs.length > 0) {
            const fullValue = view.getDisplayCache();
            const snapshot = this.createSnapshot?.(view.path, fullValue, false, undefined, view.orderedChildren);
            if (snapshot) {
              for (const entry of valueSubs) {
                try {
                  entry.callback(snapshot, undefined);
                } catch (err) {
                  console.error('Error in value subscription callback:', err);
                }
              }
            }
          }

          // Fire child_* events
          this.fireChildEvents(view, previousOrder, previousChildSet, currentOrder, currentChildSet, '/', false, undefined, previousDisplayCache);
        }
      }
    }

    return affectedViews;
  }

  // ============================================
  // Optimistic Writes (for local-first)
  // ============================================

  /**
   * Apply an optimistic write to local cache and fire events.
   * Called before sending the write to the server.
   *
   * @param writePath - The absolute path being written to
   * @param value - The value to write (null for delete)
   * @param requestId - The request ID for pending write tracking
   * @param operation - The type of operation ('set', 'update', 'delete')
   * @returns The Views that were updated
   */
  applyOptimisticWrite(
    writePath: string,
    value: unknown,
    requestId: string,
    operation: 'set' | 'update' | 'delete'
  ): View[] {
    const normalized = normalizePath(writePath);
    const affectedViews = this.findViewsForWritePath(normalized);

    if (affectedViews.length === 0) {
      return [];
    }

    const updatedViews: View[] = [];

    for (const view of affectedViews) {
      // Calculate relative path and potentially extract value for this View
      let relativePath: string;
      let effectiveValue: unknown = value;

      if (normalized === view.path) {
        // Exact match - write is directly at View's path
        relativePath = '/';
      } else if (view.path === '/') {
        // View is at root, write is somewhere inside
        relativePath = normalized;
      } else if (normalized.startsWith(view.path + '/')) {
        // Write is INSIDE View's path (write is a descendant)
        relativePath = normalized.slice(view.path.length);
      } else if (view.path.startsWith(normalized + '/')) {
        // View is INSIDE write path (View is a descendant of write)
        // e.g., writing { a: 1, b: 2 } to /foo, View is at /foo/a
        // We need to extract the value at the path difference
        const pathDiff = view.path.slice(normalized.length); // e.g., '/a'
        effectiveValue = getValueAtPath(value, pathDiff);

        // For UPDATE operations, only affect this View if the update actually
        // contains data for this path. Otherwise skip it.
        if (operation === 'update' && effectiveValue === undefined) {
          continue;
        }

        relativePath = '/';
      } else {
        // This shouldn't happen given findViewsForWritePath logic
        continue;
      }

      // Capture previous display state for change detection
      const previousDisplayCache = view.getDisplayCache() as Record<string, unknown> | null;
      const previousOrder = view.orderedChildren;
      const previousChildSet = new Set(previousOrder);
      const previousCacheJson = this.serializeCacheForComparison(previousDisplayCache);

      // Add the pending write - this automatically updates the display cache
      view.addPendingWriteData(requestId, relativePath, effectiveValue, operation);

      // Capture new state
      const currentOrder = view.orderedChildren;
      const currentChildSet = new Set(currentOrder);
      const currentCacheJson = this.serializeCacheForComparison(view.getDisplayCache());

      // Skip if display cache didn't actually change
      if (previousCacheJson === currentCacheJson) {
        continue;
      }

      updatedViews.push(view);

      // Fire value callbacks
      const valueSubs = view.getCallbacks('value');
      if (valueSubs.length > 0) {
        const fullValue = view.getDisplayCache();
        const snapshot = this.createSnapshot?.(view.path, fullValue, false, undefined, view.orderedChildren);
        if (snapshot) {
          for (const entry of valueSubs) {
            try {
              entry.callback(snapshot, undefined);
            } catch (err) {
              console.error('Error in value subscription callback:', err);
            }
          }
        }
      }

      // Fire child_* events
      this.fireChildEvents(view, previousOrder, previousChildSet, currentOrder, currentChildSet, relativePath, false, undefined, previousDisplayCache);
    }

    return updatedViews;
  }

  /**
   * Fire child_added/child_changed/child_removed/child_moved events.
   * Extracted as helper since it's used by both server updates and optimistic writes.
   */
  private fireChildEvents(
    view: View,
    previousOrder: string[],
    previousChildSet: Set<string>,
    currentOrder: string[],
    currentChildSet: Set<string>,
    affectedPath: string,
    isVolatile: boolean,
    serverTimestamp: number | undefined,
    previousDisplayCache?: Record<string, unknown> | null
  ): void {
    const childAddedSubs = view.getCallbacks('child_added');
    const childChangedSubs = view.getCallbacks('child_changed');
    const childRemovedSubs = view.getCallbacks('child_removed');
    const childMovedSubs = view.getCallbacks('child_moved');

    // Skip if no child subscriptions
    if (
      childAddedSubs.length === 0 &&
      childChangedSubs.length === 0 &&
      childRemovedSubs.length === 0 &&
      childMovedSubs.length === 0
    ) {
      return;
    }

    const displayCache = view.getDisplayCache() as Record<string, unknown> | null;
    const affectedChildren = new Set<string>();

    // Extract immediate child from the affected path
    if (affectedPath !== '/') {
      const segments = affectedPath.split('/').filter(s => s.length > 0);
      if (segments.length > 0) {
        affectedChildren.add(segments[0]);
      }
    }

    const isFullSnapshot = affectedPath === '/';

    if (isFullSnapshot) {
      // Full snapshot - compare all children
      for (const key of currentOrder) {
        if (!previousChildSet.has(key)) {
          // New child
          if (childAddedSubs.length > 0 && displayCache) {
            const childValue = displayCache[key];
            const snapshot = this.createSnapshot?.(
              joinPath(view.path, key),
              childValue,
              isVolatile,
              serverTimestamp
            );
            if (snapshot) {
              const prevKey = view.getPreviousChildKey(key);
              for (const entry of childAddedSubs) {
                try {
                  entry.callback(snapshot, prevKey);
                } catch (err) {
                  console.error('Error in child_added callback:', err);
                }
              }
            }
          }
        } else if (previousDisplayCache && childChangedSubs.length > 0 && displayCache) {
          // Child exists in both - check if value changed
          const prevValue = previousDisplayCache[key];
          const currentValue = displayCache[key];
          const prevJson = this.serializeCacheForComparison(prevValue);
          const currJson = this.serializeCacheForComparison(currentValue);
          if (prevJson !== currJson) {
            const snapshot = this.createSnapshot?.(
              joinPath(view.path, key),
              currentValue,
              isVolatile,
              serverTimestamp
            );
            if (snapshot) {
              const prevKey = view.getPreviousChildKey(key);
              for (const entry of childChangedSubs) {
                try {
                  entry.callback(snapshot, prevKey);
                } catch (err) {
                  console.error('Error in child_changed callback:', err);
                }
              }
            }
          }
        }
      }

      // Removed children
      for (const key of previousOrder) {
        if (!currentChildSet.has(key)) {
          if (childRemovedSubs.length > 0) {
            // Pass previous value for removed children
            const prevValue = previousDisplayCache?.[key];
            const snapshot = this.createSnapshot?.(joinPath(view.path, key), prevValue ?? null, isVolatile, serverTimestamp);
            if (snapshot) {
              for (const entry of childRemovedSubs) {
                try {
                  entry.callback(snapshot, undefined);
                } catch (err) {
                  console.error('Error in child_removed callback:', err);
                }
              }
            }
          }
        }
      }
    } else {
      // Delta update - only check affected children
      // Events fire in this order: child_removed (evictions), child_added, child_removed (direct), child_changed

      // Step 1: Fire child_removed for children pushed out by limit constraints FIRST
      // These are children that were in previousOrder but aren't in currentChildSet
      // even though the affected path wasn't directly about them
      if (childRemovedSubs.length > 0) {
        for (const key of previousOrder) {
          // Skip if in affectedChildren (will be handled below)
          if (affectedChildren.has(key)) continue;
          // Skip if still present in current display
          if (currentChildSet.has(key)) continue;
          // This child was pushed out by a limit constraint - fire child_removed
          const prevValue = previousDisplayCache ? previousDisplayCache[key] : null;
          const snapshot = this.createSnapshot?.(joinPath(view.path, key), prevValue, isVolatile, serverTimestamp);
          if (snapshot) {
            for (const entry of childRemovedSubs) {
              try {
                entry.callback(snapshot, undefined);
              } catch (err) {
                console.error('Error in child_removed callback:', err);
              }
            }
          }
        }
      }

      // Step 2: Process affected children (added, removed, changed)
      for (const key of affectedChildren) {
        const wasPresent = previousChildSet.has(key);
        const isPresent = currentChildSet.has(key);

        if (!wasPresent && isPresent) {
          // child_added
          if (childAddedSubs.length > 0 && displayCache) {
            const childValue = displayCache[key];
            const snapshot = this.createSnapshot?.(
              joinPath(view.path, key),
              childValue,
              isVolatile,
              serverTimestamp
            );
            if (snapshot) {
              const prevKey = view.getPreviousChildKey(key);
              for (const entry of childAddedSubs) {
                try {
                  entry.callback(snapshot, prevKey);
                } catch (err) {
                  console.error('Error in child_added callback:', err);
                }
              }
            }
          }
        } else if (wasPresent && !isPresent) {
          // child_removed (direct removal, not eviction)
          if (childRemovedSubs.length > 0) {
            // Pass previous value for removed children
            const prevValue = previousDisplayCache ? previousDisplayCache[key] : null;
            const snapshot = this.createSnapshot?.(joinPath(view.path, key), prevValue, isVolatile, serverTimestamp);
            if (snapshot) {
              for (const entry of childRemovedSubs) {
                try {
                  entry.callback(snapshot, undefined);
                } catch (err) {
                  console.error('Error in child_removed callback:', err);
                }
              }
            }
          }
        } else if (wasPresent && isPresent) {
          // child_changed
          if (childChangedSubs.length > 0 && displayCache) {
            const childValue = displayCache[key];
            const snapshot = this.createSnapshot?.(
              joinPath(view.path, key),
              childValue,
              isVolatile,
              serverTimestamp
            );
            if (snapshot) {
              const prevKey = view.getPreviousChildKey(key);
              for (const entry of childChangedSubs) {
                try {
                  entry.callback(snapshot, prevKey);
                } catch (err) {
                  console.error('Error in child_changed callback:', err);
                }
              }
            }
          }
        }
      }

      // Step 3: Fire child_added for children that slide INTO view due to limit constraints
      // (window backfill). These are children in currentOrder but not in previousChildSet
      // and not in affectedChildren (already handled above).
      if (childAddedSubs.length > 0 && displayCache) {
        for (const key of currentOrder) {
          // Skip if was already present
          if (previousChildSet.has(key)) continue;
          // Skip if in affectedChildren (already handled in Step 2)
          if (affectedChildren.has(key)) continue;
          // This child slid into view due to limit constraint - fire child_added
          const childValue = displayCache[key];
          const snapshot = this.createSnapshot?.(
            joinPath(view.path, key),
            childValue,
            isVolatile,
            serverTimestamp
          );
          if (snapshot) {
            const prevKey = view.getPreviousChildKey(key);
            for (const entry of childAddedSubs) {
              try {
                entry.callback(snapshot, prevKey);
              } catch (err) {
                console.error('Error in child_added callback:', err);
              }
            }
          }
        }
      }
    }

    // Check for child_moved (position or sort value changes)
    if (childMovedSubs.length > 0) {
      // Build position maps for detectAndFireMoves
      const previousPositions = new Map<string, number>();
      previousOrder.forEach((key, i) => previousPositions.set(key, i));
      const currentPositions = new Map<string, number>();
      currentOrder.forEach((key, i) => currentPositions.set(key, i));

      // For delta updates, only check affected children for moves
      // For full snapshots, we pass undefined which checks all children
      this.detectAndFireMoves(
        view,
        previousOrder,
        currentOrder,
        previousPositions,
        currentPositions,
        previousChildSet,
        currentChildSet,
        childMovedSubs,
        isVolatile,
        serverTimestamp,
        isFullSnapshot ? undefined : affectedChildren,
        previousDisplayCache,
        displayCache
      );
    }
  }
}
