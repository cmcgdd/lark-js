import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SubscriptionManager } from '../connection/SubscriptionManager';
import { DataSnapshot } from '../DataSnapshot';
import { LarkDatabase } from '../LarkDatabase';

describe('SubscriptionManager Optimistic Writes', () => {
  let manager: SubscriptionManager;
  let mockDb: LarkDatabase;

  beforeEach(() => {
    mockDb = {} as LarkDatabase;
    manager = new SubscriptionManager();
    manager.initialize({
      sendSubscribe: vi.fn().mockResolvedValue(undefined),
      sendUnsubscribe: vi.fn().mockResolvedValue(undefined),
      createSnapshot: (path, value, volatile, serverTimestamp) =>
        new DataSnapshot(value, path, mockDb, { volatile, serverTimestamp }),
    });
  });

  // Helper to set up a View with initial data
  const setupViewWithData = (path: string, data: unknown) => {
    manager.subscribe(path, 'value', vi.fn());
    const view = manager.getView(path);
    view?.setServerCache(data);
    return view;
  };

  describe('applyOptimisticWrite with set operation', () => {
    it('updates cache immediately', () => {
      setupViewWithData('/users', { alice: { name: 'Alice' } });

      manager.applyOptimisticWrite('/users/bob', { name: 'Bob' }, 'r1', 'set');

      const { value } = manager.getCachedValue('/users/bob');
      expect(value).toEqual({ name: 'Bob' });
    });

    it('fires value event with updated data', () => {
      const valueCallback = vi.fn();
      manager.subscribe('/users', 'value', valueCallback);
      const view = manager.getView('/users');
      view?.setServerCache({ alice: { name: 'Alice' } });

      // Clear the initial callback
      valueCallback.mockClear();

      manager.applyOptimisticWrite('/users/bob', { name: 'Bob' }, 'r1', 'set');

      expect(valueCallback).toHaveBeenCalledTimes(1);
      const snapshot = valueCallback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.val()).toEqual({
        alice: { name: 'Alice' },
        bob: { name: 'Bob' },
      });
    });

    it('fires child_added for new child', () => {
      const childAddedCallback = vi.fn();
      manager.subscribe('/users', 'child_added', childAddedCallback);
      const view = manager.getView('/users');
      view?.setServerCache({ alice: { name: 'Alice' } });

      // Clear initial events
      childAddedCallback.mockClear();

      manager.applyOptimisticWrite('/users/bob', { name: 'Bob' }, 'r1', 'set');

      expect(childAddedCallback).toHaveBeenCalledTimes(1);
      const snapshot = childAddedCallback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.key).toBe('bob');
      expect(snapshot.val()).toEqual({ name: 'Bob' });
    });

    it('fires child_changed for existing child update', () => {
      const childChangedCallback = vi.fn();
      manager.subscribe('/users', 'child_changed', childChangedCallback);
      const view = manager.getView('/users');
      view?.setServerCache({ alice: { name: 'Alice' } });

      manager.applyOptimisticWrite('/users/alice', { name: 'Alice Updated' }, 'r1', 'set');

      expect(childChangedCallback).toHaveBeenCalledTimes(1);
      const snapshot = childChangedCallback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.key).toBe('alice');
      expect(snapshot.val()).toEqual({ name: 'Alice Updated' });
    });

    it('fires child_changed for nested property update', () => {
      const childChangedCallback = vi.fn();
      manager.subscribe('/users', 'child_changed', childChangedCallback);
      const view = manager.getView('/users');
      view?.setServerCache({ alice: { name: 'Alice', score: 10 } });

      manager.applyOptimisticWrite('/users/alice/score', 100, 'r1', 'set');

      expect(childChangedCallback).toHaveBeenCalledTimes(1);
      const snapshot = childChangedCallback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.key).toBe('alice');
    });

    it('returns affected Views', () => {
      setupViewWithData('/users', { alice: { name: 'Alice' } });

      const affected = manager.applyOptimisticWrite('/users/bob', { name: 'Bob' }, 'r1', 'set');

      expect(affected.length).toBe(1);
      expect(affected[0].path).toBe('/users');
    });

    it('updates multiple Views covering the path', () => {
      setupViewWithData('/', { users: { alice: { name: 'Alice' } } });
      setupViewWithData('/users', { alice: { name: 'Alice' } });

      const affected = manager.applyOptimisticWrite('/users/bob', { name: 'Bob' }, 'r1', 'set');

      expect(affected.length).toBe(2);

      // Both caches should be updated
      const { value: rootValue } = manager.getCachedValue('/users/bob');
      expect(rootValue).toEqual({ name: 'Bob' });
    });

    it('works even before initial snapshot (dual-cache system)', () => {
      const valueCallback = vi.fn();
      manager.subscribe('/users', 'value', valueCallback);
      // Don't set server cache - no initial snapshot yet

      const affected = manager.applyOptimisticWrite('/users/bob', { name: 'Bob' }, 'r1', 'set');

      // With dual-cache, optimistic writes work before initial snapshot
      expect(affected.length).toBe(1);
      expect(valueCallback).toHaveBeenCalledTimes(1);
      const snapshot = valueCallback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.val()).toEqual({ bob: { name: 'Bob' } });
    });
  });

  describe('applyOptimisticWrite with update operation', () => {
    it('merges fields into existing data', () => {
      setupViewWithData('/users/alice', { name: 'Alice', score: 10 });

      manager.applyOptimisticWrite('/users/alice', { score: 100, level: 5 }, 'r1', 'update');

      const { value } = manager.getCachedValue('/users/alice');
      expect(value).toEqual({ name: 'Alice', score: 100, level: 5 });
    });

    it('fires value event with merged data', () => {
      const valueCallback = vi.fn();
      manager.subscribe('/users/alice', 'value', valueCallback);
      const view = manager.getView('/users/alice');
      view?.setServerCache({ name: 'Alice', score: 10 });
      valueCallback.mockClear();

      manager.applyOptimisticWrite('/users/alice', { score: 100 }, 'r1', 'update');

      expect(valueCallback).toHaveBeenCalledTimes(1);
      const snapshot = valueCallback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.val()).toEqual({ name: 'Alice', score: 100 });
    });

    it('fires child_changed for each affected child', () => {
      const childChangedCallback = vi.fn();
      manager.subscribe('/users', 'child_changed', childChangedCallback);
      const view = manager.getView('/users');
      view?.setServerCache({ alice: { score: 10 }, bob: { score: 20 } });

      // Update at /users level with multiple children
      manager.applyOptimisticWrite('/users', { alice: { score: 100 }, bob: { score: 200 } }, 'r1', 'update');

      expect(childChangedCallback).toHaveBeenCalledTimes(2);
    });

    it('fires child_added for new children in update', () => {
      const childAddedCallback = vi.fn();
      manager.subscribe('/users', 'child_added', childAddedCallback);
      const view = manager.getView('/users');
      view?.setServerCache({ alice: { score: 10 } });
      childAddedCallback.mockClear();

      manager.applyOptimisticWrite('/users', { bob: { score: 20 } }, 'r1', 'update');

      expect(childAddedCallback).toHaveBeenCalledTimes(1);
      const snapshot = childAddedCallback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.key).toBe('bob');
    });

    it('handles null values as deletions', () => {
      setupViewWithData('/users', { alice: { name: 'Alice' }, bob: { name: 'Bob' } });

      manager.applyOptimisticWrite('/users', { bob: null }, 'r1', 'update');

      const { value } = manager.getCachedValue('/users/bob');
      expect(value).toBeNull(); // Deleted values are null in cache (Firebase compatibility)
    });
  });

  describe('applyOptimisticWrite with delete operation', () => {
    it('removes data from cache', () => {
      setupViewWithData('/users', { alice: { name: 'Alice' }, bob: { name: 'Bob' } });

      manager.applyOptimisticWrite('/users/bob', null, 'r1', 'delete');

      const { value } = manager.getCachedValue('/users/bob');
      expect(value).toBeNull(); // Deleted values are null in cache (Firebase compatibility)
    });

    it('fires child_removed event', () => {
      const childRemovedCallback = vi.fn();
      manager.subscribe('/users', 'child_removed', childRemovedCallback);
      const view = manager.getView('/users');
      view?.setServerCache({ alice: { name: 'Alice' }, bob: { name: 'Bob' } });

      manager.applyOptimisticWrite('/users/bob', null, 'r1', 'delete');

      expect(childRemovedCallback).toHaveBeenCalledTimes(1);
      const snapshot = childRemovedCallback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.key).toBe('bob');
    });

    it('fires value event with remaining data', () => {
      const valueCallback = vi.fn();
      manager.subscribe('/users', 'value', valueCallback);
      const view = manager.getView('/users');
      view?.setServerCache({ alice: { name: 'Alice' }, bob: { name: 'Bob' } });
      valueCallback.mockClear();

      manager.applyOptimisticWrite('/users/bob', null, 'r1', 'delete');

      expect(valueCallback).toHaveBeenCalledTimes(1);
      const snapshot = valueCallback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.val()).toEqual({ alice: { name: 'Alice' } });
    });
  });

  describe('applyOptimisticWrite with ordering', () => {
    it('maintains sorted order after set', () => {
      manager.subscribe('/items', 'value', vi.fn(), { orderBy: 'child', orderByChild: 'priority' });
      const view = manager.getView('/items');
      view?.setServerCache({
        a: { priority: 1 },
        c: { priority: 3 },
      });

      manager.applyOptimisticWrite('/items/b', { priority: 2 }, 'r1', 'set');

      expect(view?.orderedChildren).toEqual(['a', 'b', 'c']);
    });

    it('fires child_moved when sort position changes', () => {
      const childMovedCallback = vi.fn();
      manager.subscribe('/items', 'child_moved', childMovedCallback, { orderBy: 'child', orderByChild: 'priority' });
      const view = manager.getView('/items');
      view?.setServerCache({
        a: { priority: 1 },
        b: { priority: 2 },
        c: { priority: 3 },
      });

      // Move 'a' to the end by changing its priority
      manager.applyOptimisticWrite('/items/a/priority', 10, 'r1', 'set');

      // When 'a' moves from first to last, both 'a' and 'b' have their previousChildKey change
      expect(childMovedCallback).toHaveBeenCalled();
      const movedKeys = childMovedCallback.mock.calls.map(
        (call) => (call[0] as DataSnapshot).key
      );
      expect(movedKeys).toContain('a'); // 'a' moved from first to last
    });

    it('passes correct previousChildKey for child_added', () => {
      const childAddedCallback = vi.fn();
      manager.subscribe('/items', 'child_added', childAddedCallback, { orderBy: 'child', orderByChild: 'priority' });
      const view = manager.getView('/items');
      view?.setServerCache({
        a: { priority: 1 },
        c: { priority: 3 },
      });
      childAddedCallback.mockClear();

      manager.applyOptimisticWrite('/items/b', { priority: 2 }, 'r1', 'set');

      expect(childAddedCallback).toHaveBeenCalledTimes(1);
      const previousChildKey = childAddedCallback.mock.calls[0][1];
      expect(previousChildKey).toBe('a'); // 'b' comes after 'a'
    });
  });

  describe('applyOptimisticWrite edge cases', () => {
    it('returns empty array when no Views cover the path', () => {
      setupViewWithData('/messages', { m1: 'hello' });

      const affected = manager.applyOptimisticWrite('/users/alice', { name: 'Alice' }, 'r1', 'set');

      expect(affected.length).toBe(0);
    });

    it('handles root path write', () => {
      setupViewWithData('/', { old: 'data' });

      manager.applyOptimisticWrite('/', { new: 'data' }, 'r1', 'set');

      const { value } = manager.getCachedValue('/');
      expect(value).toEqual({ new: 'data' });
    });

    it('handles empty update object', () => {
      setupViewWithData('/users/alice', { name: 'Alice' });

      // Empty update should be a no-op
      manager.applyOptimisticWrite('/users/alice', {}, 'r1', 'update');

      const { value } = manager.getCachedValue('/users/alice');
      expect(value).toEqual({ name: 'Alice' });
    });
  });

  describe('deduplication with key ordering', () => {
    it('deduplicates when server echoes data with different key order', () => {
      const valueCallback = vi.fn();
      manager.subscribe('/player', 'value', valueCallback);
      const view = manager.getView('/player');

      // Set initial data (simulating server snapshot)
      view?.setServerCache({ x: 10, y: 20, z: 30 });
      valueCallback.mockClear();

      // Optimistic write with keys in one order
      manager.applyOptimisticWrite('/player', { abc: 1, def: 2, ghi: 3 }, 'r1', 'set');
      expect(valueCallback).toHaveBeenCalledTimes(1);
      valueCallback.mockClear();

      // Server echoes back the SAME data but with keys in different order
      // This simulates Go's random map iteration order
      manager.handleEvent({
        ev: 'put',
        sp: '/player',
        p: '/',
        v: { ghi: 3, abc: 1, def: 2 }, // Different key order, same data
      });

      // Should NOT fire again - data is the same, just different key order
      expect(valueCallback).toHaveBeenCalledTimes(0);
    });

    it('deduplicates with many keys in different order', () => {
      const valueCallback = vi.fn();
      manager.subscribe('/player', 'value', valueCallback);
      const view = manager.getView('/player');
      view?.setServerCache({});
      valueCallback.mockClear();

      // Create object with 25 keys (enough that random order is likely different)
      const largeObject: Record<string, { value: number; name: string }> = {};
      for (let i = 0; i < 25; i++) {
        const key = `key_${String.fromCharCode(97 + (i % 26))}_${i.toString().padStart(3, '0')}`;
        largeObject[key] = { value: i, name: `Item ${i}` };
      }

      // Optimistic write
      manager.applyOptimisticWrite('/player', largeObject, 'r1', 'set');
      expect(valueCallback).toHaveBeenCalledTimes(1);
      valueCallback.mockClear();

      // Server echoes back with shuffled keys (simulating Go's random map order)
      const keys = Object.keys(largeObject);
      const shuffledKeys = [...keys].sort(() => Math.random() - 0.5);
      const shuffledObject: Record<string, { value: number; name: string }> = {};
      for (const key of shuffledKeys) {
        shuffledObject[key] = largeObject[key];
      }

      manager.handleEvent({
        ev: 'put',
        sp: '/player',
        p: '/',
        v: shuffledObject,
      });

      // Should NOT fire again - data is the same, just different key order
      expect(valueCallback).toHaveBeenCalledTimes(0);
    });

    it('deduplicates nested objects with different key order', () => {
      const valueCallback = vi.fn();
      manager.subscribe('/player', 'value', valueCallback);
      const view = manager.getView('/player');
      view?.setServerCache({});
      valueCallback.mockClear();

      // Optimistic write with nested structure
      const data = {
        position: { x: 10, y: 20, z: 30 },
        stats: { health: 100, mana: 50 },
        inventory: { sword: 1, shield: 1 },
      };
      manager.applyOptimisticWrite('/player', data, 'r1', 'set');
      expect(valueCallback).toHaveBeenCalledTimes(1);
      valueCallback.mockClear();

      // Server echoes back with all keys shuffled (including nested)
      manager.handleEvent({
        ev: 'put',
        sp: '/player',
        p: '/',
        v: {
          inventory: { shield: 1, sword: 1 },
          position: { z: 30, x: 10, y: 20 },
          stats: { mana: 50, health: 100 },
        },
      });

      // Should NOT fire again - data is the same
      expect(valueCallback).toHaveBeenCalledTimes(0);
    });

    it('fires event when data actually changes after pending write is cleared', () => {
      const valueCallback = vi.fn();
      manager.subscribe('/player', 'value', valueCallback);
      const view = manager.getView('/player');
      view?.setServerCache({ x: 10, y: 20 });
      valueCallback.mockClear();

      // Optimistic write
      manager.applyOptimisticWrite('/player', { abc: 1, def: 2 }, 'r1', 'set');
      expect(valueCallback).toHaveBeenCalledTimes(1);
      valueCallback.mockClear();

      // Server sends DIFFERENT data - but pending write dominates until ack/nack
      manager.handleEvent({
        ev: 'put',
        sp: '/player',
        p: '/',
        v: { abc: 1, def: 999 }, // def changed from optimistic write
      });

      // With dual-cache system, pending write 'r1' still dominates displayCache
      // Server data is stored in serverCache, but displayCache = serverCache + pendingWrites
      // So displayCache is still { abc: 1, def: 2 } from the pending write
      // No callback fires until the pending write is cleared
      expect(valueCallback).toHaveBeenCalledTimes(0);

      // Clear the pending write (simulating ack) - now server data shows through
      manager.clearPendingWrite('r1');

      // Now callback should fire because displayCache changed from { abc: 1, def: 2 } to { abc: 1, def: 999 }
      expect(valueCallback).toHaveBeenCalledTimes(1);
      const snapshot = valueCallback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.val()).toEqual({ abc: 1, def: 999 });
    });
  });

  describe('volatile event handling', () => {
    it('always fires for volatile events (no deduplication)', () => {
      const valueCallback = vi.fn();
      manager.subscribe('/player/position', 'value', valueCallback);
      const view = manager.getView('/player/position');
      view?.setServerCache({ x: 10, y: 20 });
      valueCallback.mockClear();

      // First volatile event
      manager.handleEvent({
        ev: 'put',
        sp: '/player/position',
        p: '/',
        v: { x: 10, y: 20 }, // Same data
        x: true, // Volatile
      });

      // SHOULD fire even though data is the same - volatile events always fire
      expect(valueCallback).toHaveBeenCalledTimes(1);
      valueCallback.mockClear();

      // Second volatile event with same data
      manager.handleEvent({
        ev: 'put',
        sp: '/player/position',
        p: '/',
        v: { x: 10, y: 20 },
        x: true,
      });

      // SHOULD fire again
      expect(valueCallback).toHaveBeenCalledTimes(1);
    });

    it('passes isVolatile flag to snapshot', () => {
      const valueCallback = vi.fn();
      manager.subscribe('/player/position', 'value', valueCallback);
      const view = manager.getView('/player/position');
      view?.setServerCache({});
      valueCallback.mockClear();

      manager.handleEvent({
        ev: 'put',
        sp: '/player/position',
        p: '/',
        v: { x: 10, y: 20 },
        x: true,
      });

      const snapshot = valueCallback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.isVolatile()).toBe(true);
    });
  });

  describe('volatile patch event handling (x: true)', () => {
    it('processes volatile patch with single subscription', () => {
      const valueCallback = vi.fn();
      manager.subscribe('/cursors', 'value', valueCallback);
      const view = manager.getView('/cursors');
      view?.setServerCache({});
      valueCallback.mockClear();

      manager.handleEvent({
        ev: 'patch',
        sp: '/cursors',
        p: '/',
        v: {
          '/player1': { x: 100, y: 200 },
        },
        x: true,
        ts: 1735945123456,
      });

      expect(valueCallback).toHaveBeenCalledTimes(1);
      const snapshot = valueCallback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.val()).toEqual({ player1: { x: 100, y: 200 } });
      expect(snapshot.isVolatile()).toBe(true);
    });

    it('processes volatile patches to multiple subscriptions separately', () => {
      const cursorsCallback = vi.fn();
      const positionsCallback = vi.fn();

      manager.subscribe('/cursors', 'value', cursorsCallback);
      manager.subscribe('/positions', 'value', positionsCallback);

      const cursorsView = manager.getView('/cursors');
      const positionsView = manager.getView('/positions');
      cursorsView?.setServerCache({});
      positionsView?.setServerCache({});
      cursorsCallback.mockClear();
      positionsCallback.mockClear();

      // Volatile patches now arrive as separate patch events per subscription
      manager.handleEvent({
        ev: 'patch',
        sp: '/cursors',
        p: '/',
        v: {
          '/player1': { x: 100, y: 200 },
          '/player2': { x: 300, y: 400 },
        },
        x: true,
        ts: 1735945123456,
      });

      manager.handleEvent({
        ev: 'patch',
        sp: '/positions',
        p: '/',
        v: {
          '/token1': { x: 50, y: 60 },
        },
        x: true,
        ts: 1735945123456,
      });

      expect(cursorsCallback).toHaveBeenCalledTimes(1);
      expect(positionsCallback).toHaveBeenCalledTimes(1);

      const cursorsSnapshot = cursorsCallback.mock.calls[0][0] as DataSnapshot;
      expect(cursorsSnapshot.val()).toEqual({
        player1: { x: 100, y: 200 },
        player2: { x: 300, y: 400 },
      });

      const positionsSnapshot = positionsCallback.mock.calls[0][0] as DataSnapshot;
      expect(positionsSnapshot.val()).toEqual({
        token1: { x: 50, y: 60 },
      });
    });

    it('includes server timestamp in snapshot', () => {
      const valueCallback = vi.fn();
      manager.subscribe('/cursors', 'value', valueCallback);
      const view = manager.getView('/cursors');
      view?.setServerCache({});
      valueCallback.mockClear();

      const serverTimestamp = 1735945123456;
      manager.handleEvent({
        ev: 'patch',
        sp: '/cursors',
        p: '/',
        v: {
          '/player1': { x: 100, y: 200 },
        },
        x: true,
        ts: serverTimestamp,
      });

      const snapshot = valueCallback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.getServerTimestamp()).toBe(serverTimestamp);
    });

    it('only affects target subscription', () => {
      const cursorsCallback = vi.fn();
      const otherCallback = vi.fn();

      manager.subscribe('/cursors', 'value', cursorsCallback);
      manager.subscribe('/other', 'value', otherCallback);

      const cursorsView = manager.getView('/cursors');
      const otherView = manager.getView('/other');
      cursorsView?.setServerCache({});
      otherView?.setServerCache({ data: 'unchanged' });
      cursorsCallback.mockClear();
      otherCallback.mockClear();

      manager.handleEvent({
        ev: 'patch',
        sp: '/cursors',
        p: '/',
        v: {
          '/player1': { x: 100, y: 200 },
        },
        x: true,
        ts: 1735945123456,
      });

      expect(cursorsCallback).toHaveBeenCalledTimes(1);
      expect(otherCallback).toHaveBeenCalledTimes(0); // Different subscription path
    });

    it('fires child_added events for new children', () => {
      const childAddedCallback = vi.fn();
      manager.subscribe('/cursors', 'child_added', childAddedCallback);
      const view = manager.getView('/cursors');
      view?.setServerCache({});
      childAddedCallback.mockClear();

      manager.handleEvent({
        ev: 'patch',
        sp: '/cursors',
        p: '/',
        v: {
          '/player1': { x: 100, y: 200 },
          '/player2': { x: 300, y: 400 },
        },
        x: true,
        ts: 1735945123456,
      });

      expect(childAddedCallback).toHaveBeenCalledTimes(2);
    });

    it('fires child_changed events for existing children', () => {
      const childChangedCallback = vi.fn();
      manager.subscribe('/cursors', 'child_changed', childChangedCallback);
      const view = manager.getView('/cursors');
      view?.setServerCache({ player1: { x: 0, y: 0 } });
      childChangedCallback.mockClear();

      manager.handleEvent({
        ev: 'patch',
        sp: '/cursors',
        p: '/',
        v: {
          '/player1': { x: 100, y: 200 },
        },
        x: true,
        ts: 1735945123456,
      });

      expect(childChangedCallback).toHaveBeenCalledTimes(1);
      const snapshot = childChangedCallback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.key).toBe('player1');
      expect(snapshot.val()).toEqual({ x: 100, y: 200 });
    });
  });
});
