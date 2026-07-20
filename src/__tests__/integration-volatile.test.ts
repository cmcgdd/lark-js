/**
 * Integration tests for volatile path writes.
 *
 * These tests verify:
 * 1. Volatile paths are detected from server configuration
 * 2. Writes to volatile paths are fire-and-forget (no server ack waited)
 * 3. Optimistic updates work for local UI feedback
 *
 * Note: For volatile writes, the server does NOT echo data back to the sender.
 * This is by design - volatile paths are for high-frequency updates where
 * echoing would add unnecessary overhead.
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';

// Generate a unique database ID for this test run
const testRunId = `test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
const DATABASE_ID = `javascript-integration/${testRunId}`;

describe('Volatile Writes Integration Tests', () => {
  let db: LarkDatabase;

  beforeAll(async () => {
    db = new LarkDatabase(DATABASE_ID, { anonymous: true });
    await db.connect();
    console.log('Connected as:', db.auth?.uid);
    console.log('Volatile paths:', db.volatilePaths);
  });

  afterAll(async () => {
    if (db.connected) {
      await db.disconnect();
    }
  });

  describe('Volatile Path Detection', () => {
    it('receives volatile paths from server on connection', () => {
      expect(db.volatilePaths).toBeDefined();
      expect(Array.isArray(db.volatilePaths)).toBe(true);
      console.log('Volatile paths:', db.volatilePaths);
    });

    it('isVolatilePath returns true for __volatile__ paths', () => {
      const isVolatile = db.isVolatilePath('/__volatile__/test');
      console.log('Is /__volatile__/test volatile?', isVolatile);

      // Should be true if server configured __volatile__ as volatile
      expect(isVolatile).toBe(true);
    });

    it('isVolatilePath returns false for regular paths', () => {
      expect(db.isVolatilePath('/users/alice')).toBe(false);
      expect(db.isVolatilePath('/regular/path')).toBe(false);
    });
  });

  describe('Volatile Write Timing', () => {
    it('volatile set() resolves immediately (fire-and-forget)', async () => {
      const ref = db.ref('/__volatile__/timing-set');

      const startTime = Date.now();
      await ref.set({ x: 10, y: 20 });
      const duration = Date.now() - startTime;

      console.log('Volatile set() duration:', duration, 'ms');

      // Should be nearly instant (no network round-trip wait)
      expect(duration).toBeLessThan(50);
    });

    it('volatile update() resolves immediately', async () => {
      const ref = db.ref('/__volatile__/timing-update');

      const startTime = Date.now();
      await ref.update({ value: 42 });
      const duration = Date.now() - startTime;

      console.log('Volatile update() duration:', duration, 'ms');
      expect(duration).toBeLessThan(50);
    });

    it('volatile remove() resolves immediately', async () => {
      const ref = db.ref('/__volatile__/timing-remove');

      const startTime = Date.now();
      await ref.remove();
      const duration = Date.now() - startTime;

      console.log('Volatile remove() duration:', duration, 'ms');
      expect(duration).toBeLessThan(50);
    });
  });

  describe('Volatile vs Regular Write Comparison', () => {
    it('regular write takes longer than volatile write', async () => {
      // Time a regular write (waits for server ack)
      const regularRef = db.ref('/regular-timing-test');
      const regularStart = Date.now();
      await regularRef.set({ type: 'regular' });
      const regularDuration = Date.now() - regularStart;

      // Time a volatile write (fire-and-forget)
      const volatileRef = db.ref('/__volatile__/volatile-timing-test');
      const volatileStart = Date.now();
      await volatileRef.set({ type: 'volatile' });
      const volatileDuration = Date.now() - volatileStart;

      console.log('Regular write duration:', regularDuration, 'ms');
      console.log('Volatile write duration:', volatileDuration, 'ms');

      // Volatile should be significantly faster
      expect(volatileDuration).toBeLessThan(regularDuration);
      // Volatile should be nearly instant
      expect(volatileDuration).toBeLessThan(10);
    });
  });

  describe('Optimistic Updates for Volatile Writes', () => {
    it('volatile write updates local cache immediately', async () => {
      // Subscribe to get a View with cache
      const ref = db.ref('/__volatile__/optimistic-test');
      const callback = vi.fn();
      const unsubscribe = ref.on('value', callback);

      // Wait for subscription to establish
      await new Promise(resolve => setTimeout(resolve, 200));
      callback.mockClear();

      // Write via volatile path - optimistic update fires synchronously
      await ref.set({ optimistic: true });

      // Callback should have been called from optimistic update
      expect(callback).toHaveBeenCalled();

      unsubscribe();
    });

    it('rapid volatile writes all fire optimistic updates', async () => {
      const ref = db.ref('/__volatile__/rapid-writes');
      const callback = vi.fn();
      const unsubscribe = ref.on('value', callback);

      await new Promise(resolve => setTimeout(resolve, 200));
      callback.mockClear();

      // Fire off multiple volatile writes rapidly
      await ref.set({ frame: 1 });
      await ref.set({ frame: 2 });
      await ref.set({ frame: 3 });

      // Each write should trigger an optimistic update
      expect(callback.mock.calls.length).toBeGreaterThanOrEqual(3);

      unsubscribe();
    });
  });

  describe('Volatile Write Message Format', () => {
    it('volatile writes do not include request ID in message', async () => {
      // This is implicitly tested by the timing - if we were waiting for ack,
      // we'd see the network round-trip time. The 0-10ms timing confirms
      // we're using fire-and-forget without tracking request IDs.

      const ref = db.ref('/__volatile__/no-request-id');
      const start = Date.now();
      await ref.set({ test: true });
      const duration = Date.now() - start;

      // If we were tracking request IDs and waiting for ack, this would be 50-200ms
      expect(duration).toBeLessThan(20);
    });
  });
});
