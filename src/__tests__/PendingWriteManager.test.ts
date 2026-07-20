import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PendingWriteManager } from '../connection/PendingWriteManager';

describe('PendingWriteManager', () => {
  let manager: PendingWriteManager;

  beforeEach(() => {
    manager = new PendingWriteManager();
  });

  describe('trackWrite', () => {
    it('tracks a set operation', () => {
      manager.trackWrite('req_1', 'set', '/users/alice', { name: 'Alice' });

      expect(manager.isPending('req_1')).toBe(true);
      expect(manager.pendingCount).toBe(1);
    });

    it('tracks multiple operations', () => {
      manager.trackWrite('req_1', 'set', '/users/alice', { name: 'Alice' });
      manager.trackWrite('req_2', 'update', '/users/bob', { score: 100 });
      manager.trackWrite('req_3', 'delete', '/users/charlie');

      expect(manager.pendingCount).toBe(3);
      expect(manager.isPending('req_1')).toBe(true);
      expect(manager.isPending('req_2')).toBe(true);
      expect(manager.isPending('req_3')).toBe(true);
    });

    it('tracks delete operation without value', () => {
      manager.trackWrite('req_1', 'delete', '/users/alice');

      const pending = manager.getPendingWrites();
      expect(pending[0].value).toBeUndefined();
      expect(pending[0].operation).toBe('delete');
    });
  });

  describe('onAck', () => {
    it('removes pending write on acknowledgment', () => {
      manager.trackWrite('req_1', 'set', '/users/alice', { name: 'Alice' });

      expect(manager.isPending('req_1')).toBe(true);

      const removed = manager.onAck('req_1');

      expect(removed).toBe(true);
      expect(manager.isPending('req_1')).toBe(false);
      expect(manager.pendingCount).toBe(0);
    });

    it('returns false for unknown request ID', () => {
      const removed = manager.onAck('unknown_id');
      expect(removed).toBe(false);
    });

    it('only removes the specified write', () => {
      manager.trackWrite('req_1', 'set', '/path1', 'value1');
      manager.trackWrite('req_2', 'set', '/path2', 'value2');

      manager.onAck('req_1');

      expect(manager.isPending('req_1')).toBe(false);
      expect(manager.isPending('req_2')).toBe(true);
      expect(manager.pendingCount).toBe(1);
    });
  });

  describe('onNack', () => {
    it('removes pending write on rejection', () => {
      manager.trackWrite('req_1', 'set', '/users/alice', { name: 'Alice' });

      const removed = manager.onNack('req_1');

      expect(removed).toBe(true);
      expect(manager.isPending('req_1')).toBe(false);
    });

    it('returns false for unknown request ID', () => {
      const removed = manager.onNack('unknown_id');
      expect(removed).toBe(false);
    });
  });

  describe('getPendingWrites', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns empty array when no pending writes', () => {
      const pending = manager.getPendingWrites();
      expect(pending).toEqual([]);
    });

    it('returns all pending writes', () => {
      manager.trackWrite('req_1', 'set', '/path1', 'value1');
      manager.trackWrite('req_2', 'update', '/path2', { key: 'value2' });

      const pending = manager.getPendingWrites();

      expect(pending).toHaveLength(2);
      expect(pending.map(p => p.oid)).toContain('req_1');
      expect(pending.map(p => p.oid)).toContain('req_2');
    });

    it('returns writes sorted by timestamp (oldest first)', () => {
      vi.setSystemTime(1000);
      manager.trackWrite('req_1', 'set', '/path1', 'value1');

      vi.setSystemTime(2000);
      manager.trackWrite('req_2', 'set', '/path2', 'value2');

      vi.setSystemTime(1500);
      manager.trackWrite('req_3', 'set', '/path3', 'value3');

      const pending = manager.getPendingWrites();

      expect(pending[0].oid).toBe('req_1'); // timestamp 1000
      expect(pending[1].oid).toBe('req_3'); // timestamp 1500
      expect(pending[2].oid).toBe('req_2'); // timestamp 2000
    });

    it('includes all write details', () => {
      manager.trackWrite('req_1', 'set', '/users/alice', { name: 'Alice', score: 100 });

      const pending = manager.getPendingWrites();

      expect(pending[0]).toMatchObject({
        oid: 'req_1',
        operation: 'set',
        path: '/users/alice',
        value: { name: 'Alice', score: 100 },
      });
      expect(pending[0].timestamp).toBeTypeOf('number');
    });
  });

  describe('isPending', () => {
    it('returns true for pending writes', () => {
      manager.trackWrite('req_1', 'set', '/path', 'value');

      expect(manager.isPending('req_1')).toBe(true);
    });

    it('returns false for unknown IDs', () => {
      expect(manager.isPending('unknown')).toBe(false);
    });

    it('returns false after ack', () => {
      manager.trackWrite('req_1', 'set', '/path', 'value');
      manager.onAck('req_1');

      expect(manager.isPending('req_1')).toBe(false);
    });
  });

  describe('pendingCount', () => {
    it('starts at zero', () => {
      expect(manager.pendingCount).toBe(0);
    });

    it('increments when writes are tracked', () => {
      manager.trackWrite('req_1', 'set', '/path1', 'value1');
      expect(manager.pendingCount).toBe(1);

      manager.trackWrite('req_2', 'set', '/path2', 'value2');
      expect(manager.pendingCount).toBe(2);
    });

    it('decrements when writes are acked', () => {
      manager.trackWrite('req_1', 'set', '/path1', 'value1');
      manager.trackWrite('req_2', 'set', '/path2', 'value2');
      expect(manager.pendingCount).toBe(2);

      manager.onAck('req_1');
      expect(manager.pendingCount).toBe(1);

      manager.onAck('req_2');
      expect(manager.pendingCount).toBe(0);
    });
  });

  describe('clear', () => {
    it('removes all pending writes', () => {
      manager.trackWrite('req_1', 'set', '/path1', 'value1');
      manager.trackWrite('req_2', 'set', '/path2', 'value2');
      manager.trackWrite('req_3', 'set', '/path3', 'value3');

      expect(manager.pendingCount).toBe(3);

      manager.clear();

      expect(manager.pendingCount).toBe(0);
      expect(manager.getPendingWrites()).toEqual([]);
    });
  });

  describe('removeStale', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('removes writes older than specified age', () => {
      vi.setSystemTime(1000);
      manager.trackWrite('req_1', 'set', '/path1', 'value1');

      vi.setSystemTime(2000);
      manager.trackWrite('req_2', 'set', '/path2', 'value2');

      vi.setSystemTime(5000);
      manager.trackWrite('req_3', 'set', '/path3', 'value3');

      // At time 6000, remove writes older than 2000ms (before time 4000)
      vi.setSystemTime(6000);
      const removed = manager.removeStale(2000);

      expect(removed).toBe(2); // req_1 (at 1000) and req_2 (at 2000) are stale
      expect(manager.isPending('req_1')).toBe(false);
      expect(manager.isPending('req_2')).toBe(false);
      expect(manager.isPending('req_3')).toBe(true);
      expect(manager.pendingCount).toBe(1);
    });

    it('returns 0 when no stale writes', () => {
      vi.setSystemTime(1000);
      manager.trackWrite('req_1', 'set', '/path', 'value');

      vi.setSystemTime(1500);
      const removed = manager.removeStale(1000); // Nothing older than 500ms

      expect(removed).toBe(0);
      expect(manager.pendingCount).toBe(1);
    });

    it('returns 0 when no pending writes', () => {
      const removed = manager.removeStale(1000);
      expect(removed).toBe(0);
    });
  });

  describe('operation types', () => {
    it('tracks all operation types correctly', () => {
      manager.trackWrite('req_set', 'set', '/path', 'value');
      manager.trackWrite('req_update', 'update', '/path', { key: 'value' });
      manager.trackWrite('req_delete', 'delete', '/path');
      manager.trackWrite('req_tx', 'transaction', '/counter', 42);

      const pending = manager.getPendingWrites();
      const operations = pending.map(p => p.operation);

      expect(operations).toContain('set');
      expect(operations).toContain('update');
      expect(operations).toContain('delete');
      expect(operations).toContain('transaction');
    });
  });
});
