import { describe, it, expect } from 'vitest';
import { View } from '../connection/View';

describe('View Pending Writes', () => {
  describe('pending write tracking', () => {
    it('starts with no pending writes', () => {
      const view = new View('/users');
      expect(view.getPendingWriteIds()).toEqual([]);
      expect(view.hasPendingWrites()).toBe(false);
    });

    it('adds pending writes with data', () => {
      const view = new View('/users');
      view.addPendingWriteData('r1', '/alice', { name: 'Alice' }, 'set');
      view.addPendingWriteData('r2', '/bob', { name: 'Bob' }, 'set');

      expect(view.hasPendingWrites()).toBe(true);
      expect(view.getPendingWriteIds()).toContain('r1');
      expect(view.getPendingWriteIds()).toContain('r2');
      expect(view.getPendingWriteIds().length).toBe(2);
    });

    it('checks if specific write is pending', () => {
      const view = new View('/users');
      view.addPendingWriteData('r1', '/alice', { name: 'Alice' }, 'set');

      expect(view.isWritePending('r1')).toBe(true);
      expect(view.isWritePending('r2')).toBe(false);
    });

    it('removes pending writes', () => {
      const view = new View('/users');
      view.addPendingWriteData('r1', '/alice', { name: 'Alice' }, 'set');
      view.addPendingWriteData('r2', '/bob', { name: 'Bob' }, 'set');

      const removed = view.removePendingWrite('r1');
      expect(removed).toBe(true);
      expect(view.isWritePending('r1')).toBe(false);
      expect(view.isWritePending('r2')).toBe(true);
    });

    it('returns false when removing non-existent write', () => {
      const view = new View('/users');
      const removed = view.removePendingWrite('r1');
      expect(removed).toBe(false);
    });

    it('clears all pending writes', () => {
      const view = new View('/users');
      view.addPendingWriteData('r1', '/alice', { name: 'Alice' }, 'set');
      view.addPendingWriteData('r2', '/bob', { name: 'Bob' }, 'set');
      view.addPendingWriteData('r3', '/charlie', { name: 'Charlie' }, 'set');

      view.clearPendingWrites();

      expect(view.hasPendingWrites()).toBe(false);
      expect(view.getPendingWriteIds()).toEqual([]);
    });

    it('allows duplicate request IDs (for different operations)', () => {
      const view = new View('/users');
      // In the new system, multiple writes with same ID are allowed
      // (though normally shouldn't happen)
      view.addPendingWriteData('r1', '/alice', { name: 'Alice' }, 'set');
      view.addPendingWriteData('r1', '/bob', { name: 'Bob' }, 'set');

      // Both are stored
      expect(view.getPendingWriteData().length).toBe(2);
    });
  });

  describe('dual-cache system', () => {
    it('starts with null server cache', () => {
      const view = new View('/users');
      expect(view.getCache()).toBeNull();
    });

    it('setServerCache sets server cache and marks initial snapshot received', () => {
      const view = new View('/users');
      expect(view.hasReceivedInitialSnapshot).toBe(false);

      view.setServerCache({ alice: { name: 'Alice' } });

      expect(view.hasReceivedInitialSnapshot).toBe(true);
      expect(view.getCache()).toEqual({ alice: { name: 'Alice' } });
    });

    it('getDisplayCache returns serverCache when no pending writes', () => {
      const view = new View('/users');
      view.setServerCache({ alice: { name: 'Alice' } });

      expect(view.getDisplayCache()).toEqual({ alice: { name: 'Alice' } });
    });

    it('getDisplayCache merges pending writes with serverCache', () => {
      const view = new View('/users');
      view.setServerCache({ alice: { name: 'Alice' } });
      view.addPendingWriteData('r1', '/bob', { name: 'Bob' }, 'set');

      expect(view.getDisplayCache()).toEqual({
        alice: { name: 'Alice' },
        bob: { name: 'Bob' },
      });
    });

    it('getDisplayCache handles update operation', () => {
      const view = new View('/users/alice');
      view.setServerCache({ name: 'Alice', score: 10 });
      view.addPendingWriteData('r1', '/', { score: 100, level: 5 }, 'update');

      expect(view.getDisplayCache()).toEqual({ name: 'Alice', score: 100, level: 5 });
    });

    it('getDisplayCache handles delete operation', () => {
      const view = new View('/users');
      view.setServerCache({ alice: { name: 'Alice' }, bob: { name: 'Bob' } });
      view.addPendingWriteData('r1', '/bob', null, 'delete');

      expect(view.getDisplayCache()).toEqual({ alice: { name: 'Alice' } });
    });

    it('removePendingWrite updates displayCache', () => {
      const view = new View('/users');
      view.setServerCache({ alice: { name: 'Alice' } });
      view.addPendingWriteData('r1', '/bob', { name: 'Bob' }, 'set');

      // Bob is in display cache
      expect(view.getDisplayCache()).toEqual({
        alice: { name: 'Alice' },
        bob: { name: 'Bob' },
      });

      // Remove the pending write
      view.removePendingWrite('r1');

      // Bob is gone
      expect(view.getDisplayCache()).toEqual({ alice: { name: 'Alice' } });
    });
  });

  describe('cleanup', () => {
    it('clearServerCache clears server cache but preserves pending writes', () => {
      const view = new View('/users');
      view.setServerCache({ user1: { name: 'Alice' } });
      view.addPendingWriteData('r1', '/user2', { name: 'Bob' }, 'set');

      view.clearServerCache();

      // Server cache is cleared
      expect(view.hasReceivedInitialSnapshot).toBe(false);
      // But pending writes preserved
      expect(view.hasPendingWrites()).toBe(true);
      expect(view.isWritePending('r1')).toBe(true);
    });

    it('clear() clears everything', () => {
      const view = new View('/users');
      view.setServerCache({ user1: { name: 'Alice' } });
      view.addPendingWriteData('r1', '/user2', { name: 'Bob' }, 'set');

      view.clear();

      expect(view.getCache()).toBeNull();
      expect(view.hasPendingWrites()).toBe(false);
      expect(view.hasReceivedInitialSnapshot).toBe(false);
    });
  });
});

describe('View Sorting', () => {
  describe('orderByChild sorting', () => {
    it('sorts children by child field value', () => {
      const view = new View('/users', { orderByChild: 'score' });
      view.setServerCache({
        user1: { name: 'Alice', score: 10 },
        user2: { name: 'Bob', score: 20 },
        user3: { name: 'Charlie', score: 30 },
      });

      expect(view.orderedChildren).toEqual(['user1', 'user2', 'user3']);
    });

    it('re-sorts when nested child value changes', () => {
      const view = new View('/users', { orderByChild: 'score' });
      view.setServerCache({
        user1: { name: 'Alice', score: 10 },
        user2: { name: 'Bob', score: 20 },
        user3: { name: 'Charlie', score: 30 },
      });

      expect(view.orderedChildren).toEqual(['user1', 'user2', 'user3']);

      // Update user1's score to be highest
      view.updateServerCacheChild('/user1/score', 100);

      // user1 should now be last
      expect(view.orderedChildren).toEqual(['user2', 'user3', 'user1']);
    });

    it('detects position changes correctly', () => {
      const view = new View('/items', { orderByChild: 'priority' });
      view.setServerCache({
        a: { priority: 1 },
        b: { priority: 2 },
        c: { priority: 3 },
        d: { priority: 4 },
      });

      const prevOrder = view.orderedChildren;
      expect(prevOrder).toEqual(['a', 'b', 'c', 'd']);

      // Move 'a' to after 'c'
      view.updateServerCacheChild('/a/priority', 3.5);

      const newOrder = view.orderedChildren;
      expect(newOrder).toEqual(['b', 'c', 'a', 'd']);

      // Check previousChildKey
      expect(view.getPreviousChildKey('a')).toBe('c');
    });
  });
});
