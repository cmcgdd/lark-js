import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SubscriptionManager } from '../connection/SubscriptionManager';
import { DataSnapshot } from '../DataSnapshot';
import { LarkDatabase } from '../LarkDatabase';

describe('SubscriptionManager Pending Writes', () => {
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

  describe('findViewsForWritePath', () => {
    it('returns empty array when no Views exist', () => {
      const views = manager.findViewsForWritePath('/users/alice');
      expect(views).toEqual([]);
    });

    it('finds View with exact path match', () => {
      manager.subscribe('/users/alice', 'value', vi.fn());

      const views = manager.findViewsForWritePath('/users/alice');
      expect(views.length).toBe(1);
      expect(views[0].path).toBe('/users/alice');
    });

    it('finds View when write path is descendant of View path', () => {
      manager.subscribe('/users', 'value', vi.fn());

      const views = manager.findViewsForWritePath('/users/alice/score');
      expect(views.length).toBe(1);
      expect(views[0].path).toBe('/users');
    });

    it('finds View when write path is ancestor of View path', () => {
      // Writing to /users affects View at /users/alice because
      // the write data may contain data for the child path
      manager.subscribe('/users/alice', 'value', vi.fn());

      const views = manager.findViewsForWritePath('/users');
      expect(views.length).toBe(1);
      expect(views[0].path).toBe('/users/alice');
    });

    it('finds root View for any path', () => {
      manager.subscribe('/', 'value', vi.fn());

      const views = manager.findViewsForWritePath('/users/alice/score');
      expect(views.length).toBe(1);
      expect(views[0].path).toBe('/');
    });

    it('finds multiple Views that cover the path', () => {
      manager.subscribe('/', 'value', vi.fn());
      manager.subscribe('/users', 'value', vi.fn());
      manager.subscribe('/users/alice', 'value', vi.fn());

      const views = manager.findViewsForWritePath('/users/alice/score');
      expect(views.length).toBe(3);
    });

    it('does not find Views for unrelated paths', () => {
      manager.subscribe('/messages', 'value', vi.fn());

      const views = manager.findViewsForWritePath('/users/alice');
      expect(views.length).toBe(0);
    });
  });

  describe('getPendingWriteIdsForPath', () => {
    it('returns empty array when no Views cover the path', () => {
      const ids = manager.getPendingWriteIdsForPath('/users/alice');
      expect(ids).toEqual([]);
    });

    it('returns empty array when View has no pending writes', () => {
      manager.subscribe('/users', 'value', vi.fn());

      const ids = manager.getPendingWriteIdsForPath('/users/alice');
      expect(ids).toEqual([]);
    });

    it('returns pending write IDs from covering View', () => {
      manager.subscribe('/users', 'value', vi.fn());
      const view = manager.getView('/users');
      view?.setServerCache({});
      view?.addPendingWriteData('r1', '/alice', { name: 'Alice' }, 'set');
      view?.addPendingWriteData('r2', '/bob', { name: 'Bob' }, 'set');

      const ids = manager.getPendingWriteIdsForPath('/users/alice');
      expect(ids).toContain('r1');
      expect(ids).toContain('r2');
      expect(ids.length).toBe(2);
    });

    it('returns union of pending writes from multiple Views', () => {
      manager.subscribe('/users', 'value', vi.fn());
      manager.subscribe('/users/alice', 'value', vi.fn());

      const usersView = manager.getView('/users');
      const aliceView = manager.getView('/users/alice');

      usersView?.setServerCache({});
      aliceView?.setServerCache({});
      usersView?.addPendingWriteData('r1', '/bob', { name: 'Bob' }, 'set');
      aliceView?.addPendingWriteData('r2', '/score', 100, 'set');

      const ids = manager.getPendingWriteIdsForPath('/users/alice/score');
      expect(ids).toContain('r1');
      expect(ids).toContain('r2');
      expect(ids.length).toBe(2);
    });

    it('deduplicates IDs when same ID is in multiple Views', () => {
      manager.subscribe('/users', 'value', vi.fn());
      manager.subscribe('/users/alice', 'value', vi.fn());

      const usersView = manager.getView('/users');
      const aliceView = manager.getView('/users/alice');

      usersView?.setServerCache({});
      aliceView?.setServerCache({});
      // Same ID in both Views (shouldn't happen normally, but testing dedup)
      usersView?.addPendingWriteData('r1', '/alice', { name: 'Alice' }, 'set');
      aliceView?.addPendingWriteData('r1', '/', { name: 'Alice' }, 'set');

      const ids = manager.getPendingWriteIdsForPath('/users/alice/score');
      expect(ids.length).toBe(1);
      expect(ids[0]).toBe('r1');
    });
  });

  describe('clearPendingWrite', () => {
    it('clears pending write from all Views', () => {
      manager.subscribe('/users', 'value', vi.fn());
      manager.subscribe('/messages', 'value', vi.fn());

      const usersView = manager.getView('/users');
      const messagesView = manager.getView('/messages');

      usersView?.setServerCache({});
      messagesView?.setServerCache({});
      usersView?.addPendingWriteData('r1', '/alice', { name: 'Alice' }, 'set');
      messagesView?.addPendingWriteData('r1', '/m1', 'hello', 'set');

      manager.clearPendingWrite('r1');

      expect(usersView?.isWritePending('r1')).toBe(false);
      expect(messagesView?.isWritePending('r1')).toBe(false);
    });

    it('only clears the specified request ID', () => {
      manager.subscribe('/users', 'value', vi.fn());

      const view = manager.getView('/users');
      view?.setServerCache({});
      view?.addPendingWriteData('r1', '/alice', { name: 'Alice' }, 'set');
      view?.addPendingWriteData('r2', '/bob', { name: 'Bob' }, 'set');

      manager.clearPendingWrite('r1');

      expect(view?.isWritePending('r1')).toBe(false);
      expect(view?.isWritePending('r2')).toBe(true);
    });
  });

  describe('handleWriteNack', () => {
    it('removes pending write from affected Views', () => {
      manager.subscribe('/users', 'value', vi.fn());

      const view = manager.getView('/users');
      view?.setServerCache({ alice: { name: 'Alice' } });
      view?.addPendingWriteData('r1', '/bob', { name: 'Bob' }, 'set');

      const affectedViews = manager.handleWriteNack('r1');

      expect(affectedViews.length).toBe(1);
      expect(affectedViews[0].path).toBe('/users');
      expect(view?.isWritePending('r1')).toBe(false);
    });

    it('does not clear other pending writes', () => {
      manager.subscribe('/users', 'value', vi.fn());

      const view = manager.getView('/users');
      view?.setServerCache({ alice: { name: 'Alice' } });
      view?.addPendingWriteData('r1', '/bob', { name: 'Bob' }, 'set');
      view?.addPendingWriteData('r2', '/charlie', { name: 'Charlie' }, 'set');

      manager.handleWriteNack('r1');

      expect(view?.isWritePending('r1')).toBe(false);
      expect(view?.isWritePending('r2')).toBe(true);
    });

    it('does not affect Views without the nacked write', () => {
      manager.subscribe('/users', 'value', vi.fn());
      manager.subscribe('/messages', 'value', vi.fn());

      const usersView = manager.getView('/users');
      const messagesView = manager.getView('/messages');

      usersView?.setServerCache({ alice: { name: 'Alice' } });
      messagesView?.setServerCache({ m1: 'hello' });

      usersView?.addPendingWriteData('r1', '/bob', { name: 'Bob' }, 'set');
      messagesView?.addPendingWriteData('r2', '/m2', 'world', 'set');

      const affectedViews = manager.handleWriteNack('r1');

      expect(affectedViews.length).toBe(1);
      // messagesView should be unaffected
      expect(messagesView?.isWritePending('r2')).toBe(true);
    });

    it('returns empty array if no View has the nacked write', () => {
      manager.subscribe('/users', 'value', vi.fn());

      const affectedViews = manager.handleWriteNack('r1');

      expect(affectedViews.length).toBe(0);
    });

    it('fires callbacks if displayCache changes after NACK', () => {
      const valueCallback = vi.fn();
      manager.subscribe('/users', 'value', valueCallback);

      const view = manager.getView('/users');
      view?.setServerCache({ alice: { name: 'Alice' } });
      valueCallback.mockClear();

      // Add optimistic write
      view?.addPendingWriteData('r1', '/bob', { name: 'Bob' }, 'set');
      // Display cache now includes bob

      // NACK the write - bob should be removed from display cache
      manager.handleWriteNack('r1');

      // Callback should fire because displayCache changed
      expect(valueCallback).toHaveBeenCalledTimes(1);
      const snapshot = valueCallback.mock.calls[0][0] as DataSnapshot;
      expect(snapshot.val()).toEqual({ alice: { name: 'Alice' } });
    });
  });
});
