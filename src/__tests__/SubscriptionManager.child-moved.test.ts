/**
 * Focused test for child_moved event detection with orderByChild.
 * This tests the full flow from subscription to event firing.
 */

import { describe, it, expect, vi } from 'vitest';
import { SubscriptionManager } from '../connection/SubscriptionManager';
import { DataSnapshot } from '../DataSnapshot';
import { LarkDatabase } from '../LarkDatabase';

function createMockDb() {
  return {
    ref: vi.fn(),
  } as unknown as LarkDatabase;
}

describe('SubscriptionManager child_moved with orderByChild', () => {
  it('fires child_moved when nested value change causes reorder', () => {
    const manager = new SubscriptionManager();
    const mockDb = createMockDb();

    // Track events
    const movedEvents: { key: string; prevKey: string | null | undefined }[] = [];
    const changedEvents: { key: string }[] = [];

    // Initialize with mock callbacks
    manager.initialize({
      sendSubscribe: vi.fn().mockResolvedValue(undefined),
      sendUnsubscribe: vi.fn().mockResolvedValue(undefined),
      createSnapshot: (path, value, volatile, serverTimestamp) => {
        return new DataSnapshot(value, path, mockDb, { volatile, serverTimestamp });
      },
    });

    // Subscribe with orderByChild query
    const queryParams = { orderBy: 'child' as const, orderByChild: 'score' };

    manager.subscribe('/users', 'child_moved', (snapshot, prevKey) => {
      movedEvents.push({ key: snapshot.key!, prevKey });
    }, queryParams);

    manager.subscribe('/users', 'child_changed', (snapshot) => {
      changedEvents.push({ key: snapshot.key! });
    }, queryParams);

    // Verify View has queryParams
    const view = manager.getView('/users');
    console.log('View queryParams:', view?.queryParams);
    expect(view?.queryParams).toEqual(queryParams);

    // Send initial snapshot
    manager.handleEvent({
      ev: 'put',
      sp: '/users',
      p: '/',
      v: {
        user1: { name: 'Alice', score: 10 },
        user2: { name: 'Bob', score: 20 },
        user3: { name: 'Charlie', score: 30 },
      },
    });

    // Check initial order
    console.log('Initial orderedChildren:', view?.orderedChildren);
    expect(view?.orderedChildren).toEqual(['user1', 'user2', 'user3']);

    // Clear any events from initial snapshot
    movedEvents.length = 0;
    changedEvents.length = 0;

    // Now send delta update that should cause user1 to move to the end
    console.log('Sending delta update: user1/score = 100');
    manager.handleEvent({
      ev: 'put',
      sp: '/users',
      p: '/user1/score',
      v: 100,
    });

    // Check new order
    console.log('After update orderedChildren:', view?.orderedChildren);
    console.log('Changed events:', changedEvents);
    console.log('Moved events:', movedEvents);

    // Verify order changed
    expect(view?.orderedChildren).toEqual(['user2', 'user3', 'user1']);

    // Verify child_changed fired
    expect(changedEvents).toContainEqual({ key: 'user1' });

    // Verify child_moved fired
    expect(movedEvents.length).toBeGreaterThan(0);
    expect(movedEvents).toContainEqual({ key: 'user1', prevKey: 'user3' });
  });

  it('does NOT fire child_moved when nested value changes but order stays same', () => {
    const manager = new SubscriptionManager();
    const mockDb = createMockDb();

    const movedEvents: { key: string }[] = [];
    const changedEvents: { key: string }[] = [];

    manager.initialize({
      sendSubscribe: vi.fn().mockResolvedValue(undefined),
      sendUnsubscribe: vi.fn().mockResolvedValue(undefined),
      createSnapshot: (path, value, volatile, serverTimestamp) => {
        return new DataSnapshot(value, path, mockDb, { volatile, serverTimestamp });
      },
    });

    const queryParams = { orderBy: 'child' as const, orderByChild: 'score' };

    manager.subscribe('/users', 'child_moved', (snapshot) => {
      movedEvents.push({ key: snapshot.key! });
    }, queryParams);

    manager.subscribe('/users', 'child_changed', (snapshot) => {
      changedEvents.push({ key: snapshot.key! });
    }, queryParams);

    // Initial snapshot
    manager.handleEvent({
      ev: 'put',
      sp: '/users',
      p: '/',
      v: {
        user1: { name: 'Alice', score: 10 },
        user2: { name: 'Bob', score: 20 },
        user3: { name: 'Charlie', score: 30 },
      },
    });

    movedEvents.length = 0;
    changedEvents.length = 0;

    // Update name (not score) - order should stay same
    manager.handleEvent({
      ev: 'put',
      sp: '/users',
      p: '/user2/name',
      v: 'Bobby',
    });

    const view = manager.getView('/users');
    console.log('Order after name change:', view?.orderedChildren);

    // Order should be unchanged
    expect(view?.orderedChildren).toEqual(['user1', 'user2', 'user3']);

    // child_changed should fire
    expect(changedEvents).toContainEqual({ key: 'user2' });

    // child_moved should NOT fire
    expect(movedEvents).toHaveLength(0);
  });
});
