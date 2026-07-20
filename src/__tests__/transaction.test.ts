import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseReference } from '../DatabaseReference';
import { LarkDatabase } from '../LarkDatabase';
import { LarkError } from '../LarkError';
import { DataSnapshot } from '../DataSnapshot';
import type { TxOperation, TxConditionValueOp, TxConditionHashOp } from '../protocol/messages';

// Helper to create a mock DataSnapshot with all required methods
const createMockSnapshot = (value: unknown, exists = true) => ({
  val: () => value,
  exportVal: () => value, // Raw value (same as val for non-priority data)
  exists: () => exists,
  getPriority: () => null,
} as unknown as DataSnapshot);

// Mock LarkDatabase
const createMockDb = () => {
  return {
    _sendSet: vi.fn().mockResolvedValue(undefined),
    _sendUpdate: vi.fn().mockResolvedValue(undefined),
    _sendDelete: vi.fn().mockResolvedValue(undefined),
    _sendPush: vi.fn().mockResolvedValue('-PushKey123'),
    _sendOnce: vi.fn().mockResolvedValue(createMockSnapshot(5)),
    _sendOnDisconnect: vi.fn().mockResolvedValue(undefined),
    _sendTransaction: vi.fn().mockResolvedValue(undefined),
    _subscribe: vi.fn().mockReturnValue(() => {}),
    _unsubscribeEventType: vi.fn(),
    _unsubscribeAll: vi.fn(),
    _getBaseUrl: vi.fn().mockReturnValue('https://db.lark.sh/test/db'),
    isVolatilePath: vi.fn().mockReturnValue(false), // Default: not volatile
  } as unknown as LarkDatabase;
};

describe('DatabaseReference.transaction()', () => {
  describe('callback-style transaction (optimistic concurrency)', () => {
    it('reads current value and commits new value with primitive (uses v field)', async () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'counter');

      // Mock returns 5 (primitive), we increment to 6
      const result = await ref.transaction((current) => {
        return (current as number) + 1;
      });

      // Should have called once() to read current value
      expect(db._sendOnce).toHaveBeenCalled();

      // Should have sent transaction with condition using 'v' field for primitives
      const txCall = (db._sendTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(txCall).toHaveLength(2);

      // Condition should use 'v' for primitive value
      const condition = txCall[0] as TxConditionValueOp;
      expect(condition.o).toBe('c');
      expect(condition.p).toBe('/counter');
      expect(condition.v).toBe(5);
      expect('h' in condition).toBe(false);

      // Set operation
      expect(txCall[1]).toEqual({ o: 's', p: '/counter', v: 6 });

      expect(result.committed).toBe(true);
    });

    it('uses hash (h field) for complex object values', async () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'user');

      // Mock returns a complex object
      (db._sendOnce as ReturnType<typeof vi.fn>).mockResolvedValue(
        createMockSnapshot({ name: 'Riley', age: 40, location: 'Overland Park' })
      );

      const result = await ref.transaction((current) => {
        return { ...(current as object), age: 41 };
      });

      const txCall = (db._sendTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(txCall).toHaveLength(2);

      // Condition should use 'h' for complex object
      const condition = txCall[0] as TxConditionHashOp;
      expect(condition.o).toBe('c');
      expect(condition.p).toBe('/user');
      expect('h' in condition).toBe(true);
      expect(typeof condition.h).toBe('string');
      expect(condition.h.length).toBe(64); // SHA-256 hex = 64 chars
      expect('v' in condition).toBe(false);

      expect(result.committed).toBe(true);
    });

    it('uses hash (h field) for array values', async () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'items');

      // Mock returns an array
      (db._sendOnce as ReturnType<typeof vi.fn>).mockResolvedValue(
        createMockSnapshot([1, 2, 3])
      );

      const result = await ref.transaction((current) => {
        return [...(current as number[]), 4];
      });

      const txCall = (db._sendTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];

      // Condition should use 'h' for array
      const condition = txCall[0] as TxConditionHashOp;
      expect(condition.o).toBe('c');
      expect('h' in condition).toBe(true);
      expect(condition.h.length).toBe(64);
      expect('v' in condition).toBe(false);
    });

    it('uses v field for null values', async () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'data');

      // Mock returns null
      (db._sendOnce as ReturnType<typeof vi.fn>).mockResolvedValue(
        createMockSnapshot(null, false)
      );

      const result = await ref.transaction((current) => {
        return { initialized: true };
      });

      const txCall = (db._sendTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];

      // Condition should use 'v' for null (it's a primitive)
      const condition = txCall[0] as TxConditionValueOp;
      expect(condition.o).toBe('c');
      expect(condition.v).toBe(null);
      expect('h' in condition).toBe(false);
    });

    it('uses v field for string values', async () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'name');

      (db._sendOnce as ReturnType<typeof vi.fn>).mockResolvedValue(
        createMockSnapshot('Alice')
      );

      await ref.transaction((current) => 'Bob');

      const txCall = (db._sendTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const condition = txCall[0] as TxConditionValueOp;
      expect(condition.v).toBe('Alice');
      expect('h' in condition).toBe(false);
    });

    it('uses v field for boolean values', async () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'flag');

      (db._sendOnce as ReturnType<typeof vi.fn>).mockResolvedValue(
        createMockSnapshot(false)
      );

      await ref.transaction((current) => true);

      const txCall = (db._sendTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const condition = txCall[0] as TxConditionValueOp;
      expect(condition.v).toBe(false);
      expect('h' in condition).toBe(false);
    });

    it('aborts when update function returns undefined', async () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'counter');

      const result = await ref.transaction(() => {
        return undefined; // Abort
      });

      expect(result.committed).toBe(false);
      expect(db._sendTransaction).not.toHaveBeenCalled();
    });

    it('retries on condition_failed error', async () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'counter');

      // First read returns 5
      // Second read returns 7 (someone else changed it)
      let readCount = 0;
      (db._sendOnce as ReturnType<typeof vi.fn>).mockImplementation(() => {
        readCount++;
        return Promise.resolve(createMockSnapshot(readCount === 1 ? 5 : 7));
      });

      // First transaction fails with condition_failed
      // Second succeeds
      let txCount = 0;
      (db._sendTransaction as ReturnType<typeof vi.fn>).mockImplementation(() => {
        txCount++;
        if (txCount === 1) {
          return Promise.reject(new LarkError('condition_failed', 'Value changed'));
        }
        return Promise.resolve(undefined);
      });

      const result = await ref.transaction((current) => {
        return (current as number) + 1;
      });

      // Should have retried
      expect(readCount).toBe(3); // Initial read + retry read + final read for snapshot
      expect(txCount).toBe(2);
      expect(result.committed).toBe(true);

      // Second attempt should have new value
      expect(db._sendTransaction).toHaveBeenLastCalledWith([
        { o: 'c', p: '/counter', v: 7 },
        { o: 's', p: '/counter', v: 8 },
      ]);
    });

    it('throws max_retries_exceeded after too many retries', async () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'counter');

      // Always fail with condition_failed
      (db._sendTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(
        new LarkError('condition_failed', 'Value changed')
      );

      await expect(ref.transaction((current) => current, 3)).rejects.toThrow(
        'Transaction failed after 3 retries'
      );
    });

    it('propagates non-condition errors', async () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'counter');

      (db._sendTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(
        new LarkError('permission_denied', 'No access')
      );

      await expect(ref.transaction((current) => current)).rejects.toThrow('No access');
    });
  });
});

describe('DatabaseReference.update() multi-path mode', () => {
  it('uses normal update for non-path keys', async () => {
    const db = createMockDb();
    const ref = new DatabaseReference(db, 'players/abc');

    await ref.update({ score: 10, name: 'Riley' });

    expect(db._sendUpdate).toHaveBeenCalledWith('/players/abc', {
      score: 10,
      name: 'Riley',
    });
    expect(db._sendTransaction).not.toHaveBeenCalled();
  });

  it('uses transaction for path-like keys', async () => {
    const db = createMockDb();
    const ref = new DatabaseReference(db, '');

    await ref.update({
      '/users/alice/score': 100,
      '/users/bob/score': 200,
    });

    expect(db._sendUpdate).not.toHaveBeenCalled();
    expect(db._sendTransaction).toHaveBeenCalledWith([
      { o: 's', p: '/users/alice/score', v: 100 },
      { o: 's', p: '/users/bob/score', v: 200 },
    ]);
  });

  it('treats null values as delete in multi-path mode', async () => {
    const db = createMockDb();
    const ref = new DatabaseReference(db, '');

    await ref.update({
      '/users/alice': { name: 'Alice' },
      '/users/bob': null,
    });

    expect(db._sendTransaction).toHaveBeenCalledWith([
      { o: 's', p: '/users/alice', v: { name: 'Alice' } },
      { o: 'd', p: '/users/bob' },
    ]);
  });

  it('resolves paths relative to the reference', async () => {
    const db = createMockDb();
    const ref = new DatabaseReference(db, 'game');

    await ref.update({
      '/players/alice': { score: 100 },
      '/players/bob': { score: 200 },
    });

    // Paths should be relative to /game
    expect(db._sendTransaction).toHaveBeenCalledWith([
      { o: 's', p: '/game/players/alice', v: { score: 100 } },
      { o: 's', p: '/game/players/bob', v: { score: 200 } },
    ]);
  });
});

describe('LarkDatabase.transaction()', () => {
  describe('object syntax', () => {
    it('converts object to set operations', async () => {
      const db = new LarkDatabase('test/db', { anonymous: true });

      // Mock the internal method
      const sendTxMock = vi.fn().mockResolvedValue(undefined);
      (db as unknown as { _sendTransaction: typeof sendTxMock })._sendTransaction = sendTxMock;

      await db.transaction({
        '/users/alice': { name: 'Alice' },
        '/users/bob': { name: 'Bob' },
      });

      expect(sendTxMock).toHaveBeenCalledWith([
        { o: 's', p: '/users/alice', v: { name: 'Alice' } },
        { o: 's', p: '/users/bob', v: { name: 'Bob' } },
      ]);
    });

    it('converts null to delete operations', async () => {
      const db = new LarkDatabase('test/db', { anonymous: true });

      const sendTxMock = vi.fn().mockResolvedValue(undefined);
      (db as unknown as { _sendTransaction: typeof sendTxMock })._sendTransaction = sendTxMock;

      await db.transaction({
        '/users/alice': { name: 'Alice' },
        '/temp/data': null,
      });

      expect(sendTxMock).toHaveBeenCalledWith([
        { o: 's', p: '/users/alice', v: { name: 'Alice' } },
        { o: 'd', p: '/temp/data' },
      ]);
    });
  });

  describe('array syntax', () => {
    it('converts array operations to wire format', async () => {
      const db = new LarkDatabase('test/db', { anonymous: true });

      const sendTxMock = vi.fn().mockResolvedValue(undefined);
      (db as unknown as { _sendTransaction: typeof sendTxMock })._sendTransaction = sendTxMock;

      await db.transaction([
        { op: 'set', path: '/users/alice/name', value: 'Alice' },
        { op: 'update', path: '/metadata', value: { lastUpdated: '2024-01-01' } },
        { op: 'delete', path: '/temp/data' },
        { op: 'condition', path: '/counter', value: 5 },
      ]);

      expect(sendTxMock).toHaveBeenCalledWith([
        { o: 's', p: '/users/alice/name', v: 'Alice' },
        { o: 'u', p: '/metadata', v: { lastUpdated: '2024-01-01' } },
        { o: 'd', p: '/temp/data' },
        { o: 'c', p: '/counter', v: 5 },
      ]);
    });

    it('normalizes paths', async () => {
      const db = new LarkDatabase('test/db', { anonymous: true });

      const sendTxMock = vi.fn().mockResolvedValue(undefined);
      (db as unknown as { _sendTransaction: typeof sendTxMock })._sendTransaction = sendTxMock;

      await db.transaction([
        { op: 'set', path: 'users/alice', value: 'test' }, // No leading slash
        { op: 'set', path: '/users//bob/', value: 'test' }, // Extra slashes
      ]);

      expect(sendTxMock).toHaveBeenCalledWith([
        { o: 's', p: '/users/alice', v: 'test' },
        { o: 's', p: '/users/bob', v: 'test' },
      ]);
    });

    it('uses hash for condition with complex object value', async () => {
      const db = new LarkDatabase('test/db', { anonymous: true });

      const sendTxMock = vi.fn().mockResolvedValue(undefined);
      (db as unknown as { _sendTransaction: typeof sendTxMock })._sendTransaction = sendTxMock;

      await db.transaction([
        { op: 'condition', path: '/user', value: { name: 'Alice', age: 30 } },
        { op: 'set', path: '/user/age', value: 31 },
      ]);

      const txCall = sendTxMock.mock.calls[0][0];
      expect(txCall).toHaveLength(2);

      // Condition should use 'h' for complex object
      const condition = txCall[0] as TxConditionHashOp;
      expect(condition.o).toBe('c');
      expect(condition.p).toBe('/user');
      expect('h' in condition).toBe(true);
      expect(condition.h.length).toBe(64);
      expect('v' in condition).toBe(false);

      // Set should be unchanged
      expect(txCall[1]).toEqual({ o: 's', p: '/user/age', v: 31 });
    });

    it('uses v for condition with primitive value', async () => {
      const db = new LarkDatabase('test/db', { anonymous: true });

      const sendTxMock = vi.fn().mockResolvedValue(undefined);
      (db as unknown as { _sendTransaction: typeof sendTxMock })._sendTransaction = sendTxMock;

      await db.transaction([
        { op: 'condition', path: '/counter', value: 5 },
        { op: 'set', path: '/counter', value: 6 },
      ]);

      expect(sendTxMock).toHaveBeenCalledWith([
        { o: 'c', p: '/counter', v: 5 },
        { o: 's', p: '/counter', v: 6 },
      ]);
    });

    it('accepts a DataSnapshot as condition value and uses exportVal() for hashing', async () => {
      const db = new LarkDatabase('test/db', { anonymous: true });

      const sendTxMock = vi.fn().mockResolvedValue(undefined);
      (db as unknown as { _sendTransaction: typeof sendTxMock })._sendTransaction = sendTxMock;

      // Create a real DataSnapshot with a complex object
      const snapshot = new DataSnapshot(
        { name: 'Alice', age: 30 },
        '/user',
        db
      );

      await db.transaction([
        { op: 'condition', path: '/user', value: snapshot },
        { op: 'set', path: '/user/age', value: 31 },
      ]);

      const txCall = sendTxMock.mock.calls[0][0];
      const condition = txCall[0] as TxConditionHashOp;
      expect(condition.o).toBe('c');
      expect(condition.p).toBe('/user');
      expect('h' in condition).toBe(true);
      expect(condition.h.length).toBe(64);
      expect('v' in condition).toBe(false);
    });

    it('accepts a DataSnapshot with primitive value and uses v field', async () => {
      const db = new LarkDatabase('test/db', { anonymous: true });

      const sendTxMock = vi.fn().mockResolvedValue(undefined);
      (db as unknown as { _sendTransaction: typeof sendTxMock })._sendTransaction = sendTxMock;

      const snapshot = new DataSnapshot(42, '/counter', db);

      await db.transaction([
        { op: 'condition', path: '/counter', value: snapshot },
        { op: 'set', path: '/counter', value: 43 },
      ]);

      expect(sendTxMock).toHaveBeenCalledWith([
        { o: 'c', p: '/counter', v: 42 },
        { o: 's', p: '/counter', v: 43 },
      ]);
    });

    it('DataSnapshot condition uses raw data with priority metadata for hashing', async () => {
      const db = new LarkDatabase('test/db', { anonymous: true });

      const sendTxMock = vi.fn().mockResolvedValue(undefined);
      (db as unknown as { _sendTransaction: typeof sendTxMock })._sendTransaction = sendTxMock;

      // Data with priority metadata — exportVal() returns this as-is,
      // but val() would strip the .priority wrapper
      const rawData = { name: 'Alice', '.priority': 5 };
      const snapshot = new DataSnapshot(rawData, '/user', db);

      // Verify val() strips priority but exportVal() preserves it
      expect(snapshot.val()).toEqual({ name: 'Alice' });
      expect(snapshot.exportVal()).toEqual({ name: 'Alice', '.priority': 5 });

      await db.transaction([
        { op: 'condition', path: '/user', value: snapshot },
        { op: 'set', path: '/user', value: { name: 'Alice', '.priority': 10 } },
      ]);

      const txCall = sendTxMock.mock.calls[0][0];
      const condition = txCall[0] as TxConditionHashOp;

      // Hash should be based on exportVal() (with priority), not val() (stripped)
      // Compute expected hash from raw data with priority
      const { hashValue } = await import('../utils/hash');
      const expectedHash = await hashValue(rawData);
      expect(condition.h).toBe(expectedHash);
    });
  });
});
